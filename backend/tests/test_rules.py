import pytest

from app.rules import RuleLibraryError, RuleSet, check_facts


def hits(ruleset, text, category="general"):
    return [(h.rule_id, h.category, h.quote) for h in ruleset.scan(text, category)]


def test_every_rule_example_behaves(ruleset):
    assert ruleset.example_failures() == []


def test_every_citation_in_the_library_is_verified(ruleset, laws):
    for where, ref in ruleset.all_law_refs():
        assert laws.resolve(ref.law, ref.article, ref.paragraph, ref.item).status == "verified", where


def test_spans_are_exact_slices_of_the_original(ruleset):
    text = "家人们，这是全网 最 好 用的精华，ＮＯ．１爆款！"
    found = ruleset.scan(text, "cosmetics")
    assert {h.quote for h in found} == {"全网 最 好 用", "ＮＯ．１"}
    for h in found:
        assert text[h.start:h.end] == h.quote


def test_exceptions_and_negation(ruleset):
    assert hits(ruleset, "最近换季，最好在晚上使用，第一次用就喜欢") == []
    assert hits(ruleset, "本品不能代替药物", "health_food") == []
    assert hits(ruleset, "本品不能治疗疾病") == []
    assert hits(ruleset, "以后不用再吃药了", "health_food") == [("MED-03", "medical_claims", "不用再吃药")]


def test_unless_sentence_skips_sourced_data(ruleset):
    assert hits(ruleset, "回购率32%（数据来源：店铺后台统计）") == []
    assert hits(ruleset, "回购率高达90%") == [("DAT-01", "unsourced_data", "回购率高达90%")]


def test_category_scoped_rules(ruleset):
    assert hits(ruleset, "加盟稳赚不赔", "franchise") == [("RET-01", "guaranteed_returns", "稳赚不赔")]
    assert hits(ruleset, "加盟稳赚不赔", "cosmetics") == []


def test_overlapping_hits_in_one_category_are_merged(ruleset):
    found = ruleset.scan("今天全网最低价", "general")
    assert len(found) == 1 and found[0].quote == "全网最低价"


def test_disclosures(ruleset):
    missing = ruleset.check_disclosures("每日一片，补充维生素C。", "health_food")
    assert missing == [{**missing[0], "present": False}] and missing[0]["id"] == "DSC-01"
    ok = ruleset.check_disclosures("每日一片。本品不能代替药物。", "health_food")
    assert ok[0]["present"] is True
    assert ruleset.check_disclosures("零风险创业", "franchise")[0]["present"] is False
    assert ruleset.check_disclosures("投资有风险，请理性评估", "franchise")[0]["present"] is True


def test_fact_mismatch_against_product_sheet():
    facts = [{"key": "核心成分", "value": "5%烟酰胺"}, {"key": "价格", "value": "到手价 129 元"},
             {"key": "功率", "value": "最大输出功率 65W"}]
    found = check_facts("含30%烟酰胺，今天到手价99元，100W快充，回购率30%不变", facts)
    assert [(f["quote"], f["expected_value"]) for f in found] == [("30%", "5%"), ("99元", "129元"), ("100W", "65W")]
    assert check_facts("5%烟酰胺，到手价129元，65W", facts) == []


def test_invalid_library_reports_readable_errors():
    with pytest.raises(RuleLibraryError) as exc:
        RuleSet.from_text("version: 1\nname: x\nproduct_categories: {general: 通用}\ncategories: []\nrules:\n"
                          "  - {id: BAD, name: x, category: nope, patterns: ['(']}\n")
    assert any("规则编号" in e or "ABS-01" in e for e in exc.value.errors)


def test_bad_regex_is_rejected():
    raw = (
        "version: '1'\nname: x\nproduct_categories: {general: 通用}\n"
        "categories:\n  - {id: c, label: 测试}\n"
        "rules:\n  - {id: ABC-01, name: x, category: c, patterns: ['(未闭合']}\n"
    )
    with pytest.raises(RuleLibraryError) as exc:
        RuleSet.from_text(raw)
    assert "不是合法的正则" in exc.value.errors[0]
