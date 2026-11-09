"""The 红队回合 page's data (frontend/src/redteam-report.json), built only from committed files:

    evals/redteam/r*/round.json      what the generator wrote (with run.json: which Actions run, commit, models)
    evals/redteam/r*/scores.json     the engine before any fix of that round
    evals/redteam/r*/audit.json      the model audit (fixed sample + triage)
    evals/redteam/r*/decisions.json  the author's accept / reject per proposal
    evals/redteam/r*/rescores.json   the engine after each rule commit
    evals/redteam/blind_runs.json    span P/R/F1 on the sequestered blind set, per commit (metrics only)

`report --check` fails when the committed page data is stale (CI runs it).
"""

from __future__ import annotations

import json
from pathlib import Path

from ..config import BACKEND_DIR
from .common import REDTEAM_DIR, TARGETS, read_json

REPORT_PATH = BACKEND_DIR.parent / "frontend" / "src" / "redteam-report.json"


def _maybe(path: Path):
    return read_json(path) if path.exists() else None


def _ok(item: dict, s: dict) -> bool:
    return bool(s["caught"]) if item["kind"] == "violation" else not s["flagged"]


def fixed_in(item: dict, rescores: list[dict]) -> dict | None:
    """The rule commit from which a miss stays caught (or a false alarm stays unflagged) through the latest rescore.
    A fix that a later rule commit undid is not a fix: then there is none. Rescores are taken in time order."""
    ordered = sorted(rescores, key=lambda r: r["engine"].get("scored_at", ""))
    found = None
    for r in ordered:
        s = r["items"].get(item["id"])
        if s is None:
            continue
        if not _ok(item, s):
            found = None
        elif found is None:
            found = {"commit": r["engine"]["commit"], "ruleset_version": r["engine"]["ruleset_version"],
                     "rules": sorted({f["rule_id"] for f in s["findings"] if f["rule_id"] and f["category"] == item["category"]})}
    return found


def build_round(d: Path) -> dict:
    rnd = read_json(d / "round.json")
    scores = read_json(d / "scores.json")
    audit = _maybe(d / "audit.json")
    decisions = (_maybe(d / "decisions.json") or {}).get("items", {})
    rescores = sorted(_maybe(d / "rescores.json") or [], key=lambda r: r["engine"].get("scored_at", ""))
    run = _maybe(d / "run.json") or {}
    latest = rescores[-1] if rescores else None
    items = []
    per_cat = {c: {"violations": 0, "caught": 0, "near_misses": 0, "false_alarms": 0} for c in TARGETS}
    for it in rnd["items"]:
        s = scores["items"][it["id"]]
        pc = per_cat.setdefault(it["category"], {"violations": 0, "caught": 0, "near_misses": 0, "false_alarms": 0})
        if it["kind"] == "violation":
            pc["violations"] += 1
            pc["caught"] += bool(s["caught"])
        else:
            pc["near_misses"] += 1
            pc["false_alarms"] += bool(s["flagged"])
        a = (audit or {}).get("items", {}).get(it["id"])
        bad_before = (it["kind"] == "violation" and not s["caught"]) or (it["kind"] == "near_miss" and s["flagged"])
        now = latest["items"].get(it["id"]) if latest else None
        items.append({
            "id": it["id"], "kind": it["kind"], "category": it["category"], "product_category": it["product_category"],
            "source": it["source"], "text": it["text"], "outcome": s["outcome"],
            "findings": [{"rule_id": f["rule_id"], "category": f["category"], "quote": f["quote"]} for f in s["findings"]],
            "audit": {k: a[k] for k in ("verdict", "violates", "sampled", "triage")} if a else None,
            "decision": decisions.get(it["id"]),
            "fixed_in": fixed_in(it, rescores) if bad_before else None,
            "now": now["outcome"] if now else s["outcome"],
        })
    v = [i for i in items if i["kind"] == "violation"]
    n = [i for i in items if i["kind"] == "near_miss"]
    return {
        "id": rnd["round"],
        "created_at": rnd["created_at"],
        "seed": rnd["seed"],
        "run": run,
        "generator": rnd.get("generator", {}),
        "auditor": (audit or {}).get("auditor"),
        "engine": scores["engine"],
        "throughput": {"generator": rnd.get("throughput"), "auditor": (audit or {}).get("throughput")},
        "counts": {
            "violations": len(v), "caught": sum(i["outcome"] == "caught" for i in v),
            "other": sum(i["outcome"] == "other" for i in v), "missed": sum(i["outcome"] == "missed" for i in v),
            "near_misses": len(n), "false_alarms": sum(i["outcome"] == "false_alarm" for i in n),
            "seeds": sum(i["source"] == "seed" for i in items),
        },
        "per_category": {c: x for c, x in per_cat.items() if x["violations"] or x["near_misses"]},
        "audit": (audit or {}).get("noise"),
        "rule_commits": [{**r["engine"], "caught": sum(1 for i in v if r["items"].get(i["id"], {}).get("caught")),
                          "false_alarms": sum(1 for i in n if r["items"].get(i["id"], {}).get("flagged"))}
                         for r in rescores],
        "items": items,
    }


def build(redteam_dir: Path = REDTEAM_DIR) -> dict:
    rounds = sorted((p for p in redteam_dir.glob("r*") if (p / "scores.json").exists()),
                    key=lambda p: int(p.name[1:]) if p.name[1:].isdigit() else 0)
    return {
        "rounds": [build_round(d) for d in rounds],
        "blind": _maybe(redteam_dir / "blind_runs.json"),
    }


def dump(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=1) + "\n"


def write(path: Path = REPORT_PATH) -> None:
    path.write_text(dump(build()), encoding="utf-8")


def check(path: Path = REPORT_PATH) -> bool:
    return path.exists() and path.read_text(encoding="utf-8") == dump(build())
