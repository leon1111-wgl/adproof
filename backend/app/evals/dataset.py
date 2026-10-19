"""Evaluation dataset: inline markup → plain script + character-level gold spans.

Markup is ``[[category|text]]``. Writing annotations inline (instead of hand-typed
offsets) is what keeps 120+ character offsets correct; ``load_dataset`` re-checks every
span against the plain text anyway.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from ..textutil import parse_srt

BACKEND_DIR = Path(__file__).resolve().parents[2]
DATASET_PATH = BACKEND_DIR / "evals" / "scripts.yaml"
PRODUCTS_PATH = BACKEND_DIR / "seed" / "products.json"
MARK = re.compile(r"\[\[([a-z_]+)\|(.+?)\]\]", re.S)


@dataclass
class GoldSpan:
    category: str
    start: int
    end: int
    text: str


@dataclass
class EvalItem:
    id: str
    split: str
    product: dict
    input_type: str
    text: str
    cues: list[dict]
    gold: list[GoldSpan]
    missing_disclosures: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)


def strip_markup(marked: str) -> tuple[str, list[GoldSpan]]:
    out: list[str] = []
    spans: list[GoldSpan] = []
    cursor = 0
    length = 0
    for match in MARK.finditer(marked):
        before = marked[cursor:match.start()]
        out.append(before)
        length += len(before)
        category, text = match.group(1), match.group(2)
        spans.append(GoldSpan(category, length, length + len(text), text))
        out.append(text)
        length += len(text)
        cursor = match.end()
    out.append(marked[cursor:])
    plain = "".join(out)
    if "[[" in plain or "]]" in plain:
        raise ValueError(f"标注格式错误：{plain[:80]}")
    return plain, spans


def load_products(path: Path = PRODUCTS_PATH) -> dict[str, dict]:
    return {p["sku"]: p for p in json.loads(path.read_text(encoding="utf-8"))}


def load_dataset(path: Path = DATASET_PATH, products_path: Path = PRODUCTS_PATH) -> list[EvalItem]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    products = load_products(products_path)
    items: list[EvalItem] = []
    seen: set[str] = set()
    for raw in data["items"]:
        if raw["id"] in seen:
            raise ValueError(f"评测用例编号重复：{raw['id']}")
        seen.add(raw["id"])
        input_type = raw.get("input_type", "text")
        marked = raw["marked"]
        cues: list[dict] = []
        if input_type == "srt":
            # Parse the subtitles with markup kept inside cue text, then strip it; the
            # cue offsets are recomputed on the clean subtitles.
            joined_marked, _ = parse_srt(marked)
            text, gold = strip_markup(joined_marked)
            clean_raw, _ = strip_markup(marked)
            text_again, cue_objs = parse_srt(clean_raw)
            if text_again != text:
                raise ValueError(f"{raw['id']}：字幕解析前后文本不一致")
            cues = [c.to_dict() for c in cue_objs]
        else:
            text, gold = strip_markup(marked)
        for span in gold:
            if text[span.start:span.end] != span.text:
                raise ValueError(f"{raw['id']}：标注位置错误 {span}")
        items.append(EvalItem(
            id=raw["id"], split=raw["split"], product=products[raw["product"]], input_type=input_type,
            text=text, cues=cues, gold=gold, missing_disclosures=raw.get("missing_disclosures") or [],
            tags=raw.get("tags") or [],
        ))
    return items


def dataset_hash(path: Path = DATASET_PATH) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]
