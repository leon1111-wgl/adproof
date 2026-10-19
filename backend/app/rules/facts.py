"""Fact consistency: numbers in the script must match the product sheet.

"含30%烟酰胺" in a script whose product sheet says "5%烟酰胺" is a checkable claim, not a
judgement call: the evidence is the script span plus the product fact it contradicts.
The check is deliberately conservative. A number is flagged only when the same clause
names an attribute from the product sheet, the units agree, and no fact with that unit
carries the same value.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..textutil import normalize

_UNITS = {
    "毫升": "ml", "ml": "ml", "千克": "kg", "公斤": "kg", "kg": "kg", "克": "g", "g": "g",
    "元": "元", "块": "元", "%": "%", "小时": "小时", "h": "小时", "天": "天", "片": "片", "粒": "粒",
    "袋": "袋", "课时": "节", "节": "节", "分贝": "db", "db": "db", "mah": "mah", "厘米": "cm", "cm": "cm",
    "毫米": "mm", "mm": "mm", "瓦": "w", "w": "w",
}
NUM_UNIT = re.compile(r"(\d+(?:\.\d+)?)(毫升|ml|千克|公斤|kg|克|g|元|块|%|小时|h|天|片|粒|袋|课时|节|分贝|db|mah|厘米|cm|毫米|mm|瓦|w)(?![a-z])")
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")
# Words that mark a price clause even when the product sheet key is just "价格".
_PRICE_WORDS = {"价", "到手", "券后", "只要", "仅需", "售价", "直播间"}
# Units that name the attribute on their own (W is power, dB here is noise reduction).
_SELF_DESCRIBING = {"w", "mah", "db"}
# Words next to a number that do not name an attribute.
_SKIP_WORDS = {"今天", "现在", "直播", "直播间", "只要", "仅需", "大约", "左右", "以上", "以下", "每份", "每天", "一共"}


@dataclass
class Fact:
    key: str
    value: str
    number: float
    unit: str
    raw_number: str
    keywords: list[str]


def parse_facts(facts: list[dict]) -> list[Fact]:
    parsed: list[Fact] = []
    for fact in facts or []:
        key = str(fact.get("key", "")).strip()
        value = str(fact.get("value", "")).strip()
        norm_value = normalize(value).text
        for match in NUM_UNIT.finditer(norm_value):
            unit = _UNITS[match.group(2)]
            keywords = {normalize(key).text} if key else set()
            # attribute words written right next to the number: "5%烟酰胺", "续航30小时"
            after = _CJK_RUN.match(norm_value, match.end())
            if after:
                keywords.add(after.group(0)[:6])
            before = re.search(r"[一-鿿]{2,6}$", norm_value[: match.start()])
            if before:
                keywords.add(before.group(0))
            keywords = {k for k in keywords if k and k not in _SKIP_WORDS}
            if unit == "元":
                keywords |= _PRICE_WORDS
            parsed.append(Fact(key, value, float(match.group(1)), unit, match.group(1), sorted(keywords, key=len, reverse=True)))
    return parsed


def check_facts(text: str, facts: list[dict]) -> list[dict]:
    """Return mismatches as dicts with original offsets and the contradicting fact."""
    known = parse_facts(facts)
    if not known:
        return []
    norm = normalize(text)
    out: list[dict] = []
    for match in NUM_UNIT.finditer(norm.text):
        unit = _UNITS[match.group(2)]
        same_unit = [f for f in known if f.unit == unit]
        if not same_unit:
            continue
        value = float(match.group(1))
        if any(abs(f.number - value) < 1e-9 for f in same_unit):
            continue
        s, e = match.span()
        clause_start = max((norm.text.rfind(ch, 0, s) for ch in ",。!?;\n:、"), default=-1) + 1
        ends = [i for i in (norm.text.find(ch, e) for ch in ",。!?;\n:、") if i >= 0]
        clause = norm.text[clause_start : min(ends) if ends else len(norm.text)]
        related = [f for f in same_unit if any(kw in clause for kw in f.keywords)]
        if not related and unit in _SELF_DESCRIBING and len(same_unit) == 1:
            related = same_unit  # "100W" can only be the power, whatever words surround it
        if not related:
            continue
        fact = related[0]
        start, end = norm.to_original(s, e)
        quote = text[start:end]
        out.append({
            "start": start,
            "end": end,
            "quote": quote,
            "fact_key": fact.key,
            "fact_value": fact.value,
            "script_value": quote,
            "expected_value": quote.replace(match.group(1), fact.raw_number, 1),
            "script_number": match.group(1),
            "expected_number": fact.raw_number,
        })
    return out
