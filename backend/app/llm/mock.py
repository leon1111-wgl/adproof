"""Deterministic offline model.

It answers the same JSON contracts as a real model (selling points, script writing,
semantic review), so the whole multi-agent pipeline, the UI and CI run without an API
key and always produce the same output for the same input.

What it is NOT: a stand-in for model quality. The "semantic review" below is a small set
of context patterns for implicit claims (e.g. "喝了以后血糖稳多了") that the keyword rules
do not cover. It exists to exercise the dual-channel merge, evidence location and the
hallucination guard. Numbers measured with it validate the pipeline, not a model.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from ..textutil import estimate_tokens, normalize
from .base import ChatResult, LLMProvider, Usage, extract_payload

NB = r"[^,。!?;\n]"  # one non-boundary character in normalized text

# (category, pattern on normalized text, reason). Implicit phrasings only: explicit
# keywords are the rule channel's job.
SEMANTIC_PATTERNS: list[tuple[str, str, str]] = [
    (
        "medical_claims",
        rf"(?:喝|吃|用|涂|抹|贴|泡|坚持)(?:了|完)?{NB}{{0,8}}?(?:血糖|血压|血脂|尿酸|失眠|便秘|湿疹|关节|胃病|鼻炎|三高|结节|炎症)"
        rf"{NB}{{0,6}}?(?:稳|降|好了|没了|消失|不疼|缓解|正常|下来|恢复)(?:多)?(?:了)?",
        "以使用体验暗示商品能改善疾病或症状",
    ),
    (
        "medical_claims",
        r"(?:医生|大夫|药师)(?:都)?(?:说|讲|建议|让)(?:我们)?(?:多)?(?:吃|喝|用)(?:这个|它|这款)",
        "借医生名义推荐，容易与药品混淆",
    ),
    (
        "effect_claims",
        r"一(?:抹|用|喝|吃|贴|洗|擦|涂|穿)就(?:白|瘦|好|没|掉|亮|消|退|嫩|小)",
        "暗示使用后立即见效",
    ),
    (
        "effect_claims",
        rf"(?:用|吃|喝|涂|穿|坚持)(?:了)?(?:一|两|三|半|\d+)个?(?:星期|周|月|天){NB}{{0,4}}?(?:年轻|瘦|白|没了|消失|变小|淡了)(?:了)?(?:\d+(?:斤|岁))?",
        "以个人体验暗示确定的效果",
    ),
    (
        "disparagement",
        rf"(?:别人家|别家|其他家|有些(?:商家|主播|品牌)|某些(?:商家|主播|品牌)|外面(?:卖)?的|市面上(?:那些|很多)){NB}{{0,14}}?"
        r"(?:智商税|割韭菜|偷工减料|以次充好|坑人|骗人|糊弄|黑心|劣质|没良心|不敢用)",
        "影射并贬低其他经营者",
    ),
    (
        "unsourced_data",
        rf"(?:十个(?:人)?里(?:有)?[一二三四五六七八九十]个|[七八九]成(?:以上)?的?){NB}{{0,6}}?(?:用户|顾客|宝妈|姐妹|人|老粉|回头客)?{NB}{{0,4}}?(?:回购|好评|推荐|满意|说好|有效|见效|复购)",
        "用比例说明效果，但没有给出数据出处",
    ),
    (
        "guaranteed_returns",
        r"(?:躺着|在家)(?:就能)?(?:赚钱|收钱)|闭眼(?:赚|回本)|稳稳(?:地)?(?:赚|回本)|(?:一|两|三|半)年(?:就)?回本",
        "暗示收益确定、没有风险",
    ),
    (
        "authority_endorsement",
        r"(?:国家|政府|官方)(?:都)?(?:在)?(?:推广|认可|点名|力推)(?:的)?",
        "暗示获得国家机关背书",
    ),
]
_COMPILED = [(c, re.compile(p), r) for c, p, r in SEMANTIC_PATTERNS]

AGGRESSIVE_LINES: dict[str, list[str]] = {
    "cosmetics": ["敏感肌也能用，还能消炎祛痘", "用过的姐妹98%都回购了"],
    "food": ["我爸喝了一个月血糖都稳了", "别家的代餐全是添加剂"],
    "health_food": ["比吃药还管用，全家人必备"],
    "digital": ["同价位吊打所有竞品"],
    "home": ["睡一晚就不失眠"],
    "franchise": ["加盟稳赚不赔，3个月就能回本"],
    "education": ["报名包学会，学完就能接单变现"],
}


# Relative cost of each task when a demo turns on simulated latency.
_LATENCY_FACTOR = {"selling_points": 0.6, "write_script": 1.5, "review": 1.0, "rewrite": 0.5}


def _usage(messages: list[dict[str, str]], content: str) -> Usage:
    prompt = "".join(m.get("content", "") for m in messages)
    return Usage(estimate_tokens(prompt), estimate_tokens(content), estimated=True)


class MockLLM(LLMProvider):
    name = "mock"

    def __init__(self, model: str = "adproof-offline", latency_ms: int = 0):
        self.model = model
        self.latency_ms = latency_ms  # demo only; the UI labels traces as simulated latency

    def chat(self, messages, *, task, json_mode=True, temperature=None) -> ChatResult:
        if self.latency_ms:
            time.sleep(self.latency_ms * _LATENCY_FACTOR.get(task, 1.0) / 1000)
        payload = extract_payload(messages[-1]["content"])
        handler = {
            "selling_points": self._selling_points,
            "write_script": self._write_script,
            "review": self._review,
            "rewrite": self._rewrite,
        }.get(task)
        output: dict[str, Any] = handler(payload) if handler else {}
        content = json.dumps(output, ensure_ascii=False)
        return ChatResult(content=content, usage=_usage(messages, content), model=self.model)

    # ------------------------------------------------------------------ handlers
    def _selling_points(self, payload: dict) -> dict:
        product = payload.get("product") or {}
        points = []
        for fact in (product.get("facts") or [])[:5]:
            key, value = str(fact.get("key", "")).strip(), str(fact.get("value", "")).strip()
            if key and value:
                points.append({"title": key, "detail": value, "source_field": f"facts.{key}", "evidence": value})
        return {"selling_points": points}

    def _write_script(self, payload: dict) -> dict:
        product = payload.get("product") or {}
        points = payload.get("selling_points") or []
        style = payload.get("style", "short_video")
        tone = payload.get("tone", "safe")
        category = product.get("category", "general")
        name = f"{product.get('brand', '')}{product.get('name', '')}"
        price = next((p["detail"] for p in points if "价" in p["title"]), None)
        body = [p for p in points if "价" not in p["title"]][:3]

        lines: list[str] = []
        if style == "live":
            lines.append(f"家人们，今天直播间给大家带来的是{name}。")
        else:
            lines.append(f"今天跟大家聊聊{name}。")
        for p in body:
            lines.append(f"{p['title']}：{p['detail']}。")
        if tone == "aggressive":
            lines.append("这是我用过最好用的一款，全网最低价。")
            lines.extend(f"{line}。" for line in AGGRESSIVE_LINES.get(category, []))
        if price:
            lines.append(f"今天的价格是{price}，以下单页面为准。")
        if category == "health_food" and tone != "aggressive":
            lines.append("本品不能代替药物。")
        if category == "franchise" and tone != "aggressive":
            lines.append("投资有风险，收益受选址和经营情况影响。")
        lines.append("喜欢的话可以点下方链接看看详情。" if style != "live" else "想要的家人直接点小黄车下单。")
        return {"script": "\n".join(lines)}

    def _review(self, payload: dict) -> dict:
        text = payload.get("script", "")
        norm = normalize(text)
        findings = []
        for category, pattern, reason in _COMPILED:
            for match in pattern.finditer(norm.text):
                start, end = norm.to_original(*match.span())
                findings.append({"quote": text[start:end], "category": category, "reason": reason, "confidence": 0.7})
        return {"findings": findings}

    def _rewrite(self, payload: dict) -> dict:
        # The offline rewrite is the rule template the agent already computed.
        return {"replacement": payload.get("hint", "")}
