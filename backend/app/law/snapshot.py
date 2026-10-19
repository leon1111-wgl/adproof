"""Law snapshots and citation resolution.

The snapshots in ``backend/laws`` hold only articles that were read in the National Laws
and Regulations Database (flk.npc.gov.cn) and re-checked by
``scripts/verify_law_snapshot.py``. A citation that does not resolve to a snapshot
paragraph is never filled in from memory: it is returned with status ``pending``
(待核对) and no text.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

_DIGITS = "零一二三四五六七八九"


def cn_number(n: int) -> str:
    """1 → 一, 10 → 十, 13 → 十三, 28 → 二十八, 104 → 一百零四."""
    if n <= 0 or n >= 1000:
        raise ValueError(n)
    hundreds, rest = divmod(n, 100)
    tens, ones = divmod(rest, 10)
    out = ""
    if hundreds:
        out += _DIGITS[hundreds] + "百"
        if rest and tens == 0:
            out += "零"
    if tens:
        out += ("" if tens == 1 and not hundreds else _DIGITS[tens]) + "十"
    if ones:
        out += _DIGITS[ones]
    return out


@dataclass
class Citation:
    law_id: str
    article: int
    paragraph: int | None
    item: int | None
    kind: str  # basis | penalty
    status: str  # verified | pending
    label: str  # 《中华人民共和国广告法》第九条第三项
    law_title: str = ""
    short_label: str = ""  # 广告法第九条第三项
    lead: str = ""  # the paragraph text that introduces a list of items
    text: str = ""  # the cited paragraph or item, verbatim
    article_text: str = ""  # whole article, for the hover card
    version: str = ""  # 2021-04-29 修正版 · 有效
    source_name: str = ""
    source_url: str = ""
    retrieved_at: str = ""
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Article:
    number: int
    paragraphs: list[dict]

    @property
    def label(self) -> str:
        return f"第{cn_number(self.number)}条"

    def full_text(self) -> str:
        lines: list[str] = []
        for i, paragraph in enumerate(self.paragraphs):
            prefix = self.label + "　" if i == 0 else ""
            lines.append(prefix + paragraph["text"])
            lines.extend(paragraph.get("items") or [])
        return "\n".join(lines)


@dataclass
class Law:
    id: str
    title: str
    short_title: str
    type: str
    issuer: str
    promulgated: str
    effective: str
    validity: str
    source: dict
    version_history: list[str] = field(default_factory=list)
    scope_note: str = ""
    articles: dict[int, Article] = field(default_factory=dict)

    @property
    def version(self) -> str:
        return f"{self.promulgated} 公布 · {self.effective} 施行 · {self.validity}"


class LawLibrary:
    def __init__(self, laws_dir: Path):
        self.laws: dict[str, Law] = {}
        for path in sorted(Path(laws_dir).glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            articles = {a["number"]: Article(a["number"], a["paragraphs"]) for a in data["articles"]}
            law = Law(
                id=data["id"],
                title=data["title"],
                short_title=data.get("short_title", data["title"]),
                type=data.get("type", ""),
                issuer=data.get("issuer", ""),
                promulgated=data.get("promulgated", ""),
                effective=data.get("effective", ""),
                validity=data.get("validity", ""),
                source=data.get("source", {}),
                version_history=data.get("version_history", []),
                scope_note=data.get("scope_note", ""),
                articles=articles,
            )
            self.laws[law.id] = law

    # ------------------------------------------------------------------ citations
    def resolve(self, law_id: str, article: int, paragraph: int | None = None, item: int | None = None,
                kind: str = "basis") -> Citation:
        law = self.laws.get(law_id)
        label_law = f"《{law.title}》" if law else f"《{law_id}》"
        art = law.articles.get(article) if law else None
        if law is None or art is None:
            where = "法规" if law is None else "条款"
            return Citation(
                law_id=law_id, article=article, paragraph=paragraph, item=item, kind=kind, status="pending",
                label=f"{label_law}第{cn_number(article)}条", law_title=law.title if law else law_id,
                short_label=f"第{cn_number(article)}条", note=f"本地快照中没有该{where}，原文待核对",
            )
        p_index = paragraph or 1
        if p_index > len(art.paragraphs):
            return self._pending(law, art, paragraph, item, kind, "本地快照中没有该款")
        para = art.paragraphs[p_index - 1]
        items = para.get("items") or []
        if item is not None and item > len(items):
            return self._pending(law, art, paragraph, item, kind, "本地快照中没有该项")

        suffix = art.label
        if len(art.paragraphs) > 1 and paragraph is not None:
            suffix += f"第{cn_number(p_index)}款"
        if item is not None:
            suffix += f"第{cn_number(item)}项"
        text = items[item - 1] if item is not None else para["text"]
        return Citation(
            law_id=law.id, article=article, paragraph=paragraph, item=item, kind=kind, status="verified",
            label=f"{label_law}{suffix}", law_title=law.title, short_label=f"{law.short_title}{suffix}",
            lead=para["text"] if item is not None else "", text=text, article_text=art.full_text(),
            version=law.version, source_name=law.source.get("name", ""), source_url=law.source.get("url", ""),
            retrieved_at=law.source.get("retrieved_at", ""),
        )

    def _pending(self, law: Law, art: Article, paragraph, item, kind: str, note: str) -> Citation:
        return Citation(
            law_id=law.id, article=art.number, paragraph=paragraph, item=item, kind=kind, status="pending",
            label=f"《{law.title}》{art.label}", law_title=law.title, short_label=f"{law.short_title}{art.label}",
            note=note + "，原文待核对", source_url=law.source.get("url", ""),
        )

    def contains_text(self, law_id: str, article: int, fragment: str) -> bool:
        law = self.laws.get(law_id)
        art = law.articles.get(article) if law else None
        return bool(art and fragment and fragment in art.full_text())

    # ------------------------------------------------------------------ API views
    def catalog(self) -> list[dict]:
        out = []
        for law in self.laws.values():
            out.append({
                "id": law.id,
                "title": law.title,
                "short_title": law.short_title,
                "type": law.type,
                "issuer": law.issuer,
                "promulgated": law.promulgated,
                "effective": law.effective,
                "validity": law.validity,
                "version_history": law.version_history,
                "source": law.source,
                "scope_note": law.scope_note,
                "articles": [
                    {"number": a.number, "label": a.label, "text": a.full_text()}
                    for a in sorted(law.articles.values(), key=lambda a: a.number)
                ],
            })
        return out
