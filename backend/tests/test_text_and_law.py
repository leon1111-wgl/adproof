import json

import pytest

from app.law import cn_number
from app.textutil import SRTError, cue_for_span, normalize, parse_srt


def test_normalize_maps_back_to_original_offsets():
    text = "这是全网 最 好 用的ＮＯ．１精华"
    norm = normalize(text)
    assert norm.text == "这是全网最好用的no.1精华"
    s = norm.text.index("最好用")
    start, end = norm.to_original(s, s + 3)
    assert text[start:end] == "最 好 用"


def test_normalize_drops_symbols_only_between_chinese_characters():
    assert normalize("最*好·用").text == "最好用"
    assert normalize("7-10天").text == "7-10天"  # a range keeps its dash


def test_parse_srt_joins_cues_and_keeps_offsets():
    raw = "1\n00:00:01,000 --> 00:00:03,500\n第一句\n\n2\n00:00:03,500 --> 00:00:06,000\n<i>第二句</i>\n"
    text, cues = parse_srt(raw)
    assert text == "第一句\n第二句"
    assert [c.text for c in cues] == ["第一句", "第二句"]
    second = cues[1].to_dict()
    assert text[second["char_start"]:second["char_end"]] == "第二句"
    assert second["start"] == "00:00:03,500"
    cue = cue_for_span([c.to_dict() for c in cues], 4, 6)
    assert cue["index"] == 2 and cue["start_ms"] == 3500


def test_parse_srt_rejects_blocks_without_timing():
    with pytest.raises(SRTError):
        parse_srt("1\n没有时间轴的字幕\n")


def test_chinese_numerals():
    assert [cn_number(n) for n in (1, 9, 10, 13, 28, 55, 73, 104)] == ["一", "九", "十", "十三", "二十八", "五十五", "七十三", "一百零四"]


def test_citations_resolve_to_verified_snapshot_text(laws):
    c = laws.resolve("advertising_law", 9, 1, 3)
    assert c.status == "verified"
    assert c.label == "《中华人民共和国广告法》第九条第三项"
    assert c.text == "（三）使用“国家级”、“最高级”、“最佳”等用语；"
    assert c.source_url.startswith("https://flk.npc.gov.cn/")
    assert "第九条　广告不得有下列情形：" in c.article_text
    multi = laws.resolve("advertising_law", 28, 2, 4)
    assert multi.label.endswith("第二十八条第二款第四项")


def test_unknown_article_is_pending_and_has_no_text(laws):
    c = laws.resolve("advertising_law", 16, 1, 1)  # not in the local snapshot
    assert c.status == "pending" and c.text == "" and "待核对" in c.note
    assert laws.resolve("unknown_law", 1).status == "pending"


def test_snapshots_record_their_official_source(laws):
    for law in laws.laws.values():
        assert law.source["name"] == "国家法律法规数据库"
        assert law.source["record_id"] and law.source["retrieved_at"]
    food = laws.laws["food_safety_law"]
    assert food.promulgated == "2025-09-12"  # the 2025 amendment, not the 2021 text


def test_verification_report_covers_every_snapshot_article(laws):
    from app.config import BACKEND_DIR

    report = json.loads((BACKEND_DIR.parent / "docs" / "validation" / "law-snapshot-verification.json").read_text("utf-8"))
    checked = {(law["id"], unit["unit"]) for law in report["laws"] for unit in law["units"]}
    for law in laws.laws.values():
        for article in law.articles.values():
            assert (law.id, article.label) in checked
