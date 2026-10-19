"""Re-check the local law snapshots against the National Laws and Regulations Database.

    python scripts/verify_law_snapshot.py                 # all files in backend/laws
    python scripts/verify_law_snapshot.py --report out.json

How it works: the database (flk.npc.gov.cn) exposes a "hit display" endpoint that returns
official text fragments around a search phrase inside one law version. Each snapshot
paragraph is cut into overlapping windows; a window counts as verified only if it appears
verbatim inside a fragment returned for that exact law version (the endpoint itself is
fuzzy, so "the endpoint returned something" is never treated as proof).

Needs network access and is not part of CI. Standard library only; if ``certifi`` is
installed its CA bundle is used (the python.org macOS build ships without one).
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import certifi

    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover - depends on the local Python build
    SSL_CONTEXT = ssl.create_default_context()

ENDPOINT = "https://flk.npc.gov.cn/law-search/search/hitDisplay"
LAWS_DIR = Path(__file__).resolve().parents[1] / "laws"
WINDOW = 16
STEP = 12
TAG = re.compile(r"<[^>]+>")
# The site sits behind a WAF that answers a first request with a cookie and a 307 back to
# the same URL; keeping a cookie jar and retrying is enough to get through.
OPENER = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=SSL_CONTEXT),
)


def fetch_fragments(record_id: str, phrase: str, retries: int = 4) -> list[str]:
    body = json.dumps(
        {"bbbs": record_id, "searchContent": phrase, "searchType": 2, "searchRange": 2}, ensure_ascii=False
    ).encode()
    request = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Referer": "https://flk.npc.gov.cn/search",
            "User-Agent": "Mozilla/5.0 (AdProof law snapshot verifier)",
        },
    )
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            with OPENER.open(request, timeout=30) as response:
                body_text = response.read().decode("utf-8", "replace")
            payload = json.loads(body_text)
            break
        except json.JSONDecodeError:
            # An HTML challenge page instead of JSON: wait and try again.
            if attempt == retries:
                raise
            time.sleep(delay)
            delay *= 2
        except urllib.error.HTTPError as exc:
            if attempt == retries or exc.code not in (307, 429, 500, 502, 503, 504):
                raise
            # 307 carries the WAF cookie (now in the jar): retry at once. Otherwise back off.
            time.sleep(0.5 if exc.code == 307 else delay)
            delay *= 2
        except (TimeoutError, ConnectionError, urllib.error.URLError):
            if attempt == retries:
                raise
            time.sleep(delay)
            delay *= 2
    fragments = ((payload.get("data") or {}).get("contentHitDisplay")) or []
    return [TAG.sub("", f).replace("　", "") for f in fragments]


_CN = "零一二三四五六七八九"


def article_label(n: int) -> str:
    tens, ones = divmod(n, 10)
    text = ("" if tens == 1 else _CN[tens] if tens else "") + ("十" if tens else "") + (_CN[ones] if ones else "")
    return f"第{text}条"


def windows(text: str) -> list[tuple[int, int]]:
    if len(text) <= WINDOW:
        return [(0, len(text))]
    starts = list(range(0, len(text) - WINDOW + 1, STEP))
    if starts[-1] != len(text) - WINDOW:
        starts.append(len(text) - WINDOW)
    return [(s, s + WINDOW) for s in starts]


def verify_text(record_id: str, text: str, pause: float) -> tuple[int, list[str], list[str]]:
    """Character coverage: every character must sit inside some window that appears
    verbatim in an official fragment. The endpoint cuts text into fixed-size segments,
    so windows that straddle a segment boundary are retried with shorter windows that
    end (or start) at the uncovered character."""
    covered = [False] * len(text)
    queries = 0

    def check(a: int, b: int) -> bool:
        nonlocal queries
        queries += 1
        window = text[a:b]
        fragments = fetch_fragments(record_id, window)
        time.sleep(pause)
        if any(window in f for f in fragments) or window in "".join(fragments):
            for i in range(a, b):
                covered[i] = True
            return True
        return False

    for a, b in windows(text):
        check(a, b)
    for i in range(len(text)):
        if covered[i]:
            continue
        # Longer windows rank the right fragment higher; shorter ones fit inside a segment.
        for length in (8, 12, 16, 20, 24):
            spans = [(i, min(len(text), i + length)), (max(0, i - length + 1), i + 1),
                     (max(0, i - length // 2), min(len(text), i + length // 2))]
            if any(b - a >= min(8, len(text)) and check(a, b) for a, b in spans):
                break
    missing: list[str] = []
    boundary: list[str] = []
    i = 0
    while i < len(text):
        if covered[i]:
            i += 1
            continue
        j = i
        while j < len(text) and not covered[j]:
            j += 1
        gap = text[i:j]
        # The endpoint splits text at full stops and drops the stop itself. A lone "。"
        # between two verified stretches is reported separately, not silently accepted.
        if set(gap) <= set("。") and 0 < i and j < len(text):
            boundary.append(gap)
        else:
            missing.append(gap)
        i = j
    return queries, missing, boundary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify law snapshots against flk.npc.gov.cn")
    parser.add_argument("files", nargs="*", help="snapshot files (default: every *.json in backend/laws)")
    parser.add_argument("--report", help="write a JSON report")
    parser.add_argument("--pause", type=float, default=0.6, help="seconds between requests")
    args = parser.parse_args(argv)

    files = [Path(f) for f in args.files] or sorted(LAWS_DIR.glob("*.json"))
    report: dict = {"checked_at": time.strftime("%Y-%m-%d %H:%M:%S"), "method": __doc__.strip().splitlines()[0], "laws": []}
    failures = 0
    for path in files:
        law = json.loads(path.read_text(encoding="utf-8"))
        record_id = law["source"]["record_id"]
        entry = {"id": law["id"], "title": law["title"], "record_id": record_id, "units": []}
        for article in law["articles"]:
            # The endpoint returns article text as one run: label, then paragraphs and items
            # without separators. Verifying the same run lets windows cross paragraph joins.
            label = article_label(article["number"])
            text = label + "".join(
                paragraph["text"] + "".join(paragraph.get("items") or []) for paragraph in article["paragraphs"]
            )
            checked, missing, boundary = verify_text(record_id, text, args.pause)
            ok = not missing
            failures += 0 if ok else 1
            entry["units"].append({"unit": label, "chars": len(text), "queries": checked, "verified": ok,
                                   "missing": missing, "boundary_punctuation": boundary})
            note = f" boundary punctuation: {len(boundary)}" if boundary else ""
            print(f"{'OK  ' if ok else 'MISS'} {law['short_title']} {label} ({len(text)} chars, {checked} queries){note}"
                  f"{'' if ok else ' missing: ' + ' | '.join(missing)}")
        report["laws"].append(entry)
    total = sum(len(e["units"]) for e in report["laws"])
    report["summary"] = {"units": total, "verified": total - failures, "failed": failures}
    print(f"\n{total - failures}/{total} articles verified against the official database")
    if args.report:
        Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
