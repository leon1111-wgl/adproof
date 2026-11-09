"""Red-team rounds: generator plumbing, the audit's fixed sample and noise rate, proposals' citations, the page data.

No model runs here: llama.cpp's server is replaced by an httpx MockTransport. Real rounds run on Actions only."""

from __future__ import annotations

import json

import httpx
import pytest

from app.redteam import report
from app.redteam.audit import audit_round, noise, sample_ids, verdict
from app.redteam.common import TARGETS, LlamaServer, clean_wording, load_policy, write_json
from app.redteam.generate import generate_round, parse_seeds
from app.redteam.proposals import render


def fake_server(reply) -> tuple[LlamaServer, list[dict]]:
    """A llama-server stand-in: `reply(body)` returns the JSON object the model 'wrote'."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        content = json.dumps(reply(body), ensure_ascii=False)
        return httpx.Response(200, json={
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 300, "completion_tokens": 80},
            "timings": {"prompt_per_second": 40.0, "predicted_per_second": 6.5},
        })

    return LlamaServer("http://llama", transport=httpx.MockTransport(handler)), seen


def test_clean_wording_keeps_copy_and_drops_junk():
    assert clean_wording("“1. 家人们这个真的绝了，闭眼入”") == "家人们这个真的绝了，闭眼入"
    assert clean_wording("- 喝完整个人都轻快了  ") == "喝完整个人都轻快了"
    assert clean_wording("ok") is None
    assert clean_wording("hello world, english only") is None
    assert clean_wording("长" * 81) is None
    assert clean_wording(None) is None


def test_seeds_are_validated():
    policy = load_policy()
    seeds = parse_seeds([{"category": "medical_claims", "text": "我妈喝了三个月，血压稳稳的", "product_category": "food"}], policy)
    assert seeds == [{"category": "medical_claims", "kind": "violation", "text": "我妈喝了三个月，血压稳稳的", "product_category": "food"}]
    with pytest.raises(ValueError):
        parse_seeds([{"category": "fact_mismatch", "text": "到手价只要九块九"}], policy)
    with pytest.raises(ValueError):
        parse_seeds([{"category": "medical_claims", "text": "ok"}], policy)
    with pytest.raises(ValueError):
        parse_seeds([{"category": "medical_claims", "text": "我妈喝了三个月血压稳了", "kind": "gold"}], policy)
    with pytest.raises(ValueError):
        parse_seeds({"category": "medical_claims"}, policy)


def test_generate_round_ids_products_seeds_and_dedupe():
    n = {"i": 0}

    def reply(body):
        n["i"] += 1
        assert body["response_format"]["type"] == "json_schema"
        assert "不要用最直白的词" in body["messages"][1]["content"]
        return {"violations": [f"家人们第{n['i']}句这个真的很不一样", "重复的一句话术内容", "x"],
                "near_misses": [f"建议第{n['i']}次用量少一点"]}

    server, seen = fake_server(reply)
    seeds = [{"category": "endorsement", "kind": "violation", "text": "营养师天天带着它上班", "product_category": "health_food"}]
    data = generate_round(server, round_id="r7", seed=3, per_product=3, near_misses=1, seeds=seeds)
    assert len(seen) == 2 * len(TARGETS)  # two products per category
    assert data["items"][0]["id"] == "r7-seed-01" and data["items"][0]["source"] == "seed"
    # the seed is shown to the generator as a style example for its own category only
    assert sum("营养师天天带着它上班" in b["messages"][1]["content"] for b in seen) == 2
    ids = [i["id"] for i in data["items"]]
    assert len(ids) == len(set(ids))
    texts = [i["text"] for i in data["items"]]
    assert texts.count("重复的一句话术内容") == 1  # duplicates across calls are dropped
    assert any(d["why"] == "duplicate" for d in data["dropped"]) and any(d["why"] == "not usable copy" for d in data["dropped"])
    for item in data["items"]:
        assert item["product_category"] in TARGETS[item["category"]] or item["source"] == "seed"
    assert data["throughput"]["generation_tok_s_median"] == 6.5
    # same round id and seed → same products
    server2, seen2 = fake_server(reply)
    again = generate_round(server2, round_id="r7", seed=3, per_product=3, near_misses=1, seeds=seeds)
    assert [i["sku"] for i in again["items"]] == [i["sku"] for i in data["items"]]


ROUND = {
    "round": "r9", "seed": 1, "created_at": "2026-11-10T00:00:00+00:00", "generator": {"label": "fake"},
    "items": [
        {"id": "r9-MED-v1", "source": "generated", "category": "medical_claims", "kind": "violation",
         "text": "我妈喝了三个月，血压稳稳的", "product_category": "food", "sku": "NOAH-TEA"},
        {"id": "r9-END-v1", "source": "generated", "category": "endorsement", "kind": "violation",
         "text": "营养师天天带着它上班", "product_category": "health_food", "sku": "IRIS-VC"},
        {"id": "r9-ABS-v1", "source": "generated", "category": "absolute_terms", "kind": "violation",
         "text": "全网最好用的精华", "product_category": "cosmetics", "sku": "MIA-SERUM"},
        {"id": "r9-ABS-n1", "source": "generated", "category": "absolute_terms", "kind": "near_miss",
         "text": "最好睡前洁面后用", "product_category": "cosmetics", "sku": "MIA-SERUM"},
    ],
}


def _score(caught, flagged, findings=()):
    outcome = "clean" if caught is None and not flagged else "false_alarm" if caught is None else "caught" if caught else "other" if flagged else "missed"
    return {"caught": caught, "outcome": outcome, "flagged": flagged, "findings": list(findings)}


SCORES = {
    "engine": {"commit": "a" * 40, "ruleset_version": "2026.11.07", "ruleset_hash": "x"},
    "items": {
        "r9-MED-v1": _score(False, False),
        "r9-END-v1": _score(False, False),
        "r9-ABS-v1": _score(True, True, [{"category": "absolute_terms", "rule_id": "ABS-01", "quote": "全网最好用", "citations": []}]),
        "r9-ABS-n1": _score(None, True, [{"category": "absolute_terms", "rule_id": "ABS-01", "quote": "最好", "citations": []}]),
    },
}


def test_audit_sample_is_fixed_and_independent_of_the_engine():
    ids = [f"r9-x-{i}" for i in range(40)]
    a = sample_ids("r9", ids, 10)
    assert a == sample_ids("r9", list(reversed(ids)), 10)  # order does not matter
    assert a != sample_ids("r10", ids, 10)
    assert len(a) == 10 and sample_ids("r9", ids[:3], 10) == sorted(ids[:3])


def test_verdicts_and_noise_rate():
    v = {"kind": "violation", "category": "medical_claims"}
    nm = {"kind": "near_miss", "category": "absolute_terms"}
    assert verdict(v, ["medical_claims", "effect_claims"]) == "agree"
    assert verdict(v, ["effect_claims"]) == "other"
    assert verdict(v, []) == "none"
    assert verdict(nm, []) == "agree" and verdict(nm, ["absolute_terms"]) == "disagree"
    audited = {"a": {"kind": "violation", "verdict": "agree"}, "b": {"kind": "violation", "verdict": "none"},
               "c": {"kind": "near_miss", "verdict": "disagree"}, "d": {"kind": "violation", "verdict": "none"}}
    n = noise(audited, ["a", "b", "c"])  # d is triage only: not in the sample, not in the rate
    assert (n["sampled"], n["disputed"], n["rate"]) == (3, 2, 0.6667)
    assert n["by_kind"]["violation"] == {"sampled": 2, "disputed": 1}


def test_audit_round_samples_and_triages():
    def reply(body):
        text = body["messages"][1]["content"]
        assert "分类口径" in body["messages"][0]["content"] and body["temperature"] == 0.0
        if "营养师" in text:
            return {"violates": [], "reason": "只是生活描述"}
        if "最好睡前" in text:
            return {"violates": [], "reason": "用法建议"}
        return {"violates": ["medical_claims", "not_a_category"], "reason": "暗示降血压"}

    server, seen = fake_server(reply)
    out = audit_round(server, ROUND, SCORES, sample=2)
    assert out["sample"] == sample_ids("r9", [i["id"] for i in ROUND["items"]], 2)
    # every miss and the false alarm are triaged even when not sampled
    assert {"r9-MED-v1", "r9-END-v1", "r9-ABS-n1"} <= set(out["items"])
    assert out["items"]["r9-MED-v1"]["violates"] == ["medical_claims"]  # unknown ids dropped
    assert out["items"]["r9-END-v1"]["verdict"] == "none"
    assert out["items"]["r9-ABS-n1"]["verdict"] == "agree"
    assert out["noise"]["sampled"] == 2
    assert "不是人工复核" in out["note"]


def test_proposals_cite_only_what_applies_and_is_verified():
    text = render(ROUND, SCORES, None)
    assert "r9-MED-v1" in text and "r9-END-v1" in text and "r9-ABS-n1" in text
    assert "r9-ABS-v1 |" not in text  # caught: not a proposal
    med = next(line for line in text.splitlines() if line.startswith("| r9-MED-v1"))
    assert "广告法第十七条" in med and "食品安全法第七十三条" in med
    assert "化妆品" not in med and "第十八条" not in med  # cosmetics and health-food articles don't apply to food
    end = next(line for line in text.splitlines() if line.startswith("| r9-END-v1"))
    assert "广告法第十八条第一款第五项" in end and "第二十四条" not in end
    assert "待核对" not in text


def test_report_marks_which_rule_commit_fixed_which_miss(tmp_path):
    d = tmp_path / "r9"
    write_json(d / "round.json", ROUND)
    write_json(d / "scores.json", SCORES)
    fixed = json.loads(json.dumps(SCORES))
    fixed["engine"]["commit"] = "b" * 40
    fixed["items"]["r9-MED-v1"] = _score(True, True, [{"category": "medical_claims", "rule_id": "MED-06", "quote": "血压稳稳的", "citations": []}])
    fixed["items"]["r9-ABS-n1"] = _score(None, False)
    write_json(d / "rescores.json", [fixed])
    write_json(d / "decisions.json", {"items": {"r9-END-v1": {"decision": "reject", "reason": "需要人判断"}}})
    data = report.build(tmp_path)
    r = data["rounds"][0]
    by_id = {i["id"]: i for i in r["items"]}
    assert r["counts"] == {"violations": 3, "caught": 1, "other": 0, "missed": 2, "near_misses": 1, "false_alarms": 1, "seeds": 0}
    assert by_id["r9-MED-v1"]["fixed_in"] == {"commit": "b" * 40, "ruleset_version": "2026.11.07", "rules": ["MED-06"]}
    assert by_id["r9-ABS-n1"]["fixed_in"]["commit"] == "b" * 40
    assert by_id["r9-END-v1"]["fixed_in"] is None and by_id["r9-END-v1"]["decision"]["decision"] == "reject"
    assert by_id["r9-ABS-v1"]["fixed_in"] is None and by_id["r9-ABS-v1"]["now"] == "caught"
    assert r["rule_commits"][0]["caught"] == 2 and r["rule_commits"][0]["false_alarms"] == 0


def test_committed_page_data_is_current():
    assert report.check(), "run `python -m app.redteam report` and commit frontend/src/redteam-report.json"
