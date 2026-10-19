"""Text helpers that never lose track of character offsets.

Every finding must point back to exact characters of the submitted script, so all
matching happens on a normalized copy that carries a map back to the original indices.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass

# Removed everywhere: whitespace and zero-width characters.
_ALWAYS_SKIP = set(" \t\r\f\v 　​‌‍⁠﻿")
# Removed only between two CJK characters, where they are used to dodge keyword filters
# ("最*好", "第·一"); elsewhere they may carry meaning ("7-10天").
_DECORATIVE = set("*·•~～_|^`'\"-—–/\\")
SENTENCE_END = "。!?！？;；\n"
CLAUSE_END = SENTENCE_END + ",，、:："


def is_cjk(ch: str) -> bool:
    return "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿"


@dataclass
class Normalized:
    text: str
    index: list[int]  # index[i] = position in the original text of normalized char i

    def to_original(self, start: int, end: int) -> tuple[int, int]:
        """Map a normalized half-open span back to the original text."""
        return self.index[start], self.index[end - 1] + 1


def normalize(text: str) -> Normalized:
    """NFKC (full-width to half-width), lower-case, drop whitespace and evasion symbols."""
    out: list[str] = []
    index: list[int] = []
    for i, ch in enumerate(text):
        if ch in _ALWAYS_SKIP:
            continue
        if ch in _DECORATIVE:
            prev = _prev_visible(text, i)
            nxt = _next_visible(text, i)
            if prev is not None and nxt is not None and is_cjk(prev) and is_cjk(nxt):
                continue
        for part in unicodedata.normalize("NFKC", ch).lower():
            if part in _ALWAYS_SKIP:
                continue
            out.append(part)
            index.append(i)
    return Normalized("".join(out), index)


def _prev_visible(text: str, i: int) -> str | None:
    j = i - 1
    while j >= 0 and (text[j] in _ALWAYS_SKIP or text[j] in _DECORATIVE):
        j -= 1
    return text[j] if j >= 0 else None


def _next_visible(text: str, i: int) -> str | None:
    j = i + 1
    while j < len(text) and (text[j] in _ALWAYS_SKIP or text[j] in _DECORATIVE):
        j += 1
    return text[j] if j < len(text) else None


def find_all(haystack: str, needle: str) -> list[int]:
    if not needle:
        return []
    found, start = [], 0
    while True:
        pos = haystack.find(needle, start)
        if pos < 0:
            return found
        found.append(pos)
        start = pos + 1


def sentence_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    """The sentence (split on 。！？；and newlines) that contains [start, end)."""
    a = start
    while a > 0 and text[a - 1] not in SENTENCE_END:
        a -= 1
    b = end
    while b < len(text) and text[b] not in SENTENCE_END:
        b += 1
    return a, b


def clause_bounds(text: str, start: int, end: int) -> tuple[int, int]:
    """The clause (also split on commas and colons) that contains [start, end)."""
    a = start
    while a > 0 and text[a - 1] not in CLAUSE_END:
        a -= 1
    b = end
    while b < len(text) and text[b] not in CLAUSE_END:
        b += 1
    return a, b


def estimate_tokens(text: str) -> int:
    """Rough token estimate used when a provider does not report usage (and for the
    offline model). Chinese is about one token per 1.5 characters on common tokenizers."""
    return max(1, math.ceil(len(text) / 1.5)) if text else 0


# ---------------------------------------------------------------------------- SRT
_TIME = r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
_TIMING = re.compile(_TIME + r"\s*-->\s*" + _TIME)


@dataclass
class Cue:
    index: int
    start_ms: int
    end_ms: int
    text: str
    char_start: int  # offsets into the joined script
    char_end: int

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "start": format_ms(self.start_ms),
            "end": format_ms(self.end_ms),
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "text": self.text,
            "char_start": self.char_start,
            "char_end": self.char_end,
        }


def _ms(h: str, m: str, s: str, frac: str) -> int:
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(frac.ljust(3, "0")[:3])


def format_ms(ms: int) -> str:
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, rem = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{rem:03d}"


class SRTError(ValueError):
    pass


def parse_srt(raw: str) -> tuple[str, list[Cue]]:
    """Parse SubRip text. The returned script joins cue texts with newlines; every cue
    records which characters of that script it owns, so findings can be mapped back to
    timestamps."""
    raw = raw.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    blocks = [b for b in re.split(r"\n\s*\n", raw.strip()) if b.strip()]
    cues: list[Cue] = []
    parts: list[str] = []
    cursor = 0
    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        timing_at = next((i for i, line in enumerate(lines) if _TIMING.search(line)), None)
        if timing_at is None:
            raise SRTError(f"第 {len(cues) + 1} 段字幕缺少时间轴（形如 00:00:01,000 --> 00:00:03,000）")
        match = _TIMING.search(lines[timing_at])
        start_ms = _ms(*match.groups()[:4])
        end_ms = _ms(*match.groups()[4:])
        body = "".join(line.strip() for line in lines[timing_at + 1 :])
        body = re.sub(r"</?[a-zA-Z][^>]*>", "", body)  # <i>, <font …>
        if not body:
            continue
        if cues:
            parts.append("\n")
            cursor += 1
        cues.append(Cue(len(cues) + 1, start_ms, end_ms, body, cursor, cursor + len(body)))
        parts.append(body)
        cursor += len(body)
    if not cues:
        raise SRTError("没有解析到任何字幕内容")
    return "".join(parts), cues


def cue_for_span(cues: list[dict], start: int, end: int) -> dict | None:
    """The first cue that overlaps [start, end), with the timing of every cue it touches."""
    touched = [c for c in cues if c["char_start"] < end and start < c["char_end"]]
    if not touched:
        return None
    first, last = touched[0], touched[-1]
    return {
        "index": first["index"],
        "last_index": last["index"],
        "start": first["start"],
        "end": last["end"],
        "start_ms": first["start_ms"],
        "end_ms": last["end_ms"],
    }
