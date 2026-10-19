import json

import httpx
import pytest

from app.agents import PipelineInput, ReviewPipeline, Tracer
from app.agents.evidence import EvidenceLocator, validate_findings
from app.agents.reviewers import HALLUCINATED_QUOTE, Candidate
from app.agents.rewriter import Edit, apply_edits, merge_edits
from app.llm import LLMError, MockLLM, OpenAICompatProvider
from app.llm.base import ChatResult, LLMProvider, parse_json_object

from .conftest import SERUM

SCRIPT = ("家人们，这款精华是全网最好用的，含30%烟酰胺，还能消炎祛痘！98%的姐妹都回购了，"
          "别家卖的都是智商税。用了一个星期痘印都淡了。今天到手价99元，全网最低价。")


def run(pipeline, script=SCRIPT, product=SERUM, **kwargs):
    tracer = Tracer()
    return pipeline.run(PipelineInput(product=product, script=script, **kwargs), tracer), tracer


def test_every_finding_points_at_exact_text_and_verified_law(pipeline):
    out, _ = run(pipeline)
    assert out["findings"], "expected findings"
    for f in out["findings"]:
        assert SCRIPT[f["start"]:f["end"]] == f["quote"]
        basis = [c for c in f["citations"] if c["kind"] == "basis"]
        assert basis and all(c["status"] == "verified" and c["text"] for c in basis)
    assert out["validation"]["valid"] == out["validation"]["checked"]


def test_dual_channel_findings_are_merged(pipeline):
    out, _ = run(pipeline)
    by_quote = {f["quote"]: f for f in out["findings"]}
    assert by_quote["别家卖的都是智商税"]["channels"] == ["rule", "llm"]
    assert by_quote["用了一个星期痘印都淡了"]["channels"] == ["llm"]  # implicit claim: model channel only
    assert by_quote["30%"]["channels"] == ["fact"]
    assert by_quote["30%"]["evidence"]["fact_value"] == "5%烟酰胺"


def test_category_specific_law_is_attached(pipeline):
    out, _ = run(pipeline)
    medical = next(f for f in out["findings"] if f["quote"] == "消炎")
    labels = [c["short_label"] for c in medical["citations"]]
    assert "广告法第十七条" in labels and "化妆品监督管理条例第四十三条第二款" in labels


def test_hallucinated_model_quote_is_rejected(pipeline):
    out, _ = run(pipeline, inject_hallucination=True)
    assert [r["quote"] for r in out["rejected"]] == [HALLUCINATED_QUOTE]
    assert all(f["quote"] != HALLUCINATED_QUOTE for f in out["findings"])


def test_locator_accepts_reformatted_quotes(ruleset, laws):
    locator = EvidenceLocator(ruleset, laws)
    text = "这款 最 好 用！"
    located, rejected = locator.locate(text, [{"quote": "最好用", "category": "absolute_terms"},
                                              {"quote": "不存在的话", "category": "absolute_terms"},
                                              {"quote": "最好用", "category": "made_up"}])
    assert [(c.quote, c.locate_method) for c in located] == [("最 好 用", "normalized")]
    assert rejected[0]["reason"].startswith("原文中找不到") and rejected[1]["reason"] == "未知分类 made_up"


def test_merge_prefers_rule_span_and_higher_priority_category(ruleset, laws):
    locator = EvidenceLocator(ruleset, laws)
    rule = Candidate("absolute_terms", 2, 5, "最好用", "rule", rule_id="ABS-01", rule_ids=["ABS-01"])
    model = Candidate("absolute_terms", 0, 8, "这是最好用的精华", "llm", reason="model")
    medical = Candidate("medical_claims", 9, 11, "消炎", "rule", rule_id="MED-01", rule_ids=["MED-01"])
    effect = Candidate("effect_claims", 9, 11, "消炎", "llm")
    groups = locator.merge([model, rule, medical, effect])
    findings = locator.build("这是最好用的精华，消炎", groups, "cosmetics", None)
    assert [(f["quote"], f["channels"]) for f in findings] == [("最好用", ["rule", "llm"]), ("消炎", ["rule", "llm"])]
    assert findings[1]["category"] == "medical_claims" and findings[1]["related_categories"] == ["effect_claims"]


def test_validator_drops_tampered_findings(pipeline, laws, ruleset):
    out, _ = run(pipeline)
    tampered = [dict(f) for f in out["findings"]]
    tampered[0]["quote"] = "改过的引用"
    tampered[1]["citations"] = [dict(tampered[1]["citations"][0], text="编造的法条原文")]
    valid, report = validate_findings(SCRIPT, tampered, laws, ruleset)
    assert len(valid) == len(tampered) - 2
    problems = [p for e in report["errors"] for p in e["problems"]]
    assert "引用片段与原文不一致" in problems
    assert any("引文与本地法条快照不一致" in p for p in problems)


def test_rewrite_fixes_findings_and_passes_re_review(pipeline):
    out, _ = run(pipeline)
    rewrite = out["rewrite"]
    assert rewrite["passed"] and rewrite["rounds"][0]["remaining_blocking"] == 0
    text = rewrite["text"]
    assert "5%烟酰胺" in text and "到手价129元" in text  # facts corrected from the product sheet
    assert "智商税" not in text and "全网最低价" not in text


def test_rewrite_appends_missing_disclosure(pipeline):
    product = {"name": "维生素C咀嚼片", "brand": "Iris营养", "category": "health_food",
               "facts": [{"key": "规格", "value": "60片/瓶"}]}
    out, _ = run(pipeline, script="每日1片，补充维生素C。", product=product)
    assert [d["present"] for d in out["disclosures"]] == [False]
    assert out["rewrite"]["text"].endswith("本品不能代替药物。") and out["rewrite"]["passed"]


def test_edit_merge_lets_clause_deletion_swallow_inner_edits():
    edits = merge_edits([Edit(4, 6, "很好", ["F2"], "replace"), Edit(0, 10, "", ["F1"], "delete_clause")])
    assert len(edits) == 1 and edits[0].strategy == "delete_clause" and edits[0].keys == ["F1", "F2"]
    text, applied = apply_edits("0123456789abc", edits)
    assert text == "abc" and applied[0]["new_start"] == 0


def test_trace_records_parallel_review_channels(pipeline):
    _, tracer = run(pipeline)
    agents = [r.agent for r in tracer.records]
    assert agents[:1] == ["selling_points"]
    assert {"rule_review", "model_review", "evidence_locator", "rewrite"} <= set(agents)
    assert all(r.status == "ok" for r in tracer.records)


def test_generate_mode_writes_a_grounded_script(pipeline):
    out, tracer = run(pipeline, script="", mode="generate", tone="safe")
    assert "5%烟酰胺" in out["script"] and out["selling_points"]
    assert all(p["evidence"] for p in out["selling_points"])
    assert out["counts"]["total"] == 0
    aggressive, _ = run(pipeline, script="", mode="generate", tone="aggressive")
    assert aggressive["counts"]["total"] >= 3


class FailingProvider(LLMProvider):
    name = "failing"
    model = "down"

    def chat(self, messages, *, task, json_mode=True, temperature=None):
        raise LLMError("upstream 503")


def test_model_channel_failure_degrades_to_rules(ruleset, laws):
    pipeline = ReviewPipeline(FailingProvider(), ruleset, laws)
    out, tracer = run(pipeline)
    assert out["channels"]["llm"] == "degraded"
    assert any(f["channels"] == ["rule"] for f in out["findings"])
    statuses = {r.agent: r.status for r in tracer.records}
    assert statuses["model_review"] == "degraded" and statuses["selling_points"] == "degraded"


def test_ungrounded_selling_points_are_dropped(ruleset, laws):
    class Inventive(MockLLM):
        def chat(self, messages, *, task, json_mode=True, temperature=None):
            if task == "selling_points":
                content = json.dumps({"selling_points": [
                    {"title": "成分", "detail": "5%烟酰胺", "source_field": "facts.核心成分", "evidence": "5%烟酰胺"},
                    {"title": "荣誉", "detail": "国际金奖", "source_field": "facts.荣誉", "evidence": "国际金奖产品"},
                ]}, ensure_ascii=False)
                return ChatResult(content)
            return super().chat(messages, task=task)

    pipeline = ReviewPipeline(Inventive(), ruleset, laws)
    out, tracer = run(pipeline)
    assert [p["title"] for p in out["selling_points"]] == ["成分"]
    span = next(r for r in tracer.records if r.agent == "selling_points")
    assert span.output["dropped"][0]["title"] == "荣誉"


def test_parse_json_object_accepts_fenced_and_embedded_json():
    assert parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json_object('结果如下：{"a": 2} 以上') == {"a": 2}
    with pytest.raises(LLMError):
        parse_json_object("没有 JSON")


def test_openai_compat_adapter_retries_without_json_mode():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if "response_format" in body:
            return httpx.Response(400, json={"error": {"message": "response_format not supported"}})
        return httpx.Response(200, json={
            "model": "doubao-test", "choices": [{"message": {"content": '{"findings": []}'}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3},
        })

    provider = OpenAICompatProvider("https://example.invalid/api/v3", "key", "ep-test",
                                    transport=httpx.MockTransport(handler))
    result = provider.chat([{"role": "user", "content": "hi"}], task="review")
    assert result.content == '{"findings": []}' and result.usage.prompt_tokens == 12
    assert [("response_format" in c) for c in calls] == [True, False]


def test_openai_compat_adapter_retries_rate_limits(monkeypatch):
    monkeypatch.setattr("app.llm.openai_compat.time.sleep", lambda _: None)
    attempts = {"n": 0}

    def handler(request):
        attempts["n"] += 1
        if attempts["n"] < 3:
            return httpx.Response(429, json={"error": "slow down"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    provider = OpenAICompatProvider("https://example.invalid/v1", "key", "m", transport=httpx.MockTransport(handler))
    result = provider.chat([{"role": "user", "content": "hi"}], task="review")
    assert attempts["n"] == 3 and result.usage.estimated
