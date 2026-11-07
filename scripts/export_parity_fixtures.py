"""Run the backend pipeline on a fixed corpus and save its output for the browser parity test.

    cd backend && python ../scripts/export_parity_fixtures.py   # → frontend/tests/fixtures/parity.json

frontend/tests/parity.test.ts runs the TypeScript port on exactly these inputs and requires
the same findings, citations, disclosures, rewrites, diffs and counts. The fixture is
generated (gitignored); CI runs this script before `pnpm test`.

The corpus: the 60 evaluation scripts, every rule's own examples, the demo samples, the
coverage cases (frontend/tests/coverage.json), the blind set once it has been scored,
deterministic perturbations of the evaluation scripts (spacing, full-width, zero-width,
emoji, decoration, spliced sentences, other product categories) and a few edge inputs.

Offsets: the backend counts code points; the browser counts UTF-16 units. Every offset in
the output is converted here, against the text it refers to, so the test compares like with like.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.agents import PipelineInput, ReviewPipeline, Tracer  # noqa: E402
from app.agents.pipeline import summarize  # noqa: E402
from app.evals.dataset import load_dataset, load_products  # noqa: E402
from app.law import LawLibrary  # noqa: E402
from app.llm.mock import MockLLM  # noqa: E402
from app.rules import RuleSet  # noqa: E402
from app.textutil import parse_srt  # noqa: E402

BACKEND = ROOT / "backend"
OUT = ROOT / "frontend" / "tests" / "fixtures" / "parity.json"
COVERAGE = ROOT / "frontend" / "tests" / "coverage.json"
SAMPLES = ROOT / "frontend" / "src" / "samples.json"
BLIND = BACKEND / "evals" / "blind.yaml"


def u16(text: str, cp: int) -> int:
    return len(text[:cp].encode("utf-16-le")) // 2


def convert_findings(text: str, findings: list[dict]) -> None:
    for f in findings:
        f["start"], f["end"] = u16(text, f["start"]), u16(text, f["end"])


def convert(out: dict) -> dict:
    out = json.loads(json.dumps(out, ensure_ascii=False))  # findings may be shared with rewrite.remaining
    script = out["script"]
    convert_findings(script, out["findings"])
    for c in out["cues"]:
        c["char_start"], c["char_end"] = u16(script, c["char_start"]), u16(script, c["char_end"])
    rewrite = out["rewrite"]
    if rewrite:
        # edits of round 1 point into the original; new_start/new_end into the round-1 text
        round1 = script
        if rewrite["edits"]:
            pieces, cursor = [], 0
            for e in rewrite["edits"]:
                pieces.append(script[cursor:e["start"]])
                pieces.append(e["replacement"])
                cursor = e["end"]
            pieces.append(script[cursor:])
            round1 = "".join(pieces)
        for e in rewrite["edits"]:
            e["start"], e["end"] = u16(script, e["start"]), u16(script, e["end"])
            e["new_start"], e["new_end"] = u16(round1, e["new_start"]), u16(round1, e["new_end"])
        convert_findings(rewrite["text"], rewrite["remaining"])
    return out


def pipeline() -> ReviewPipeline:
    ruleset = RuleSet.load(BACKEND / "rules" / "adproof_rules.yaml")
    laws = LawLibrary(BACKEND / "laws")
    return ReviewPipeline(MockLLM(), ruleset, laws, ("rule", "llm"), 2, 6000)


def custom(category: str) -> dict:
    return {"sku": f"CUSTOM-{category}", "name": "", "brand": "", "category": category, "description": "", "facts": []}


def perturb(text: str, rng: random.Random) -> str:
    kind = rng.choice(["space", "fullwidth", "zerowidth", "emoji", "decor", "crlf", "truncate", "upper"])
    chars = list(text)
    if kind == "space":
        for _ in range(max(1, len(chars) // 12)):
            chars.insert(rng.randrange(len(chars) + 1), rng.choice([" ", "　", "\t"]))
    elif kind == "fullwidth":
        chars = [chr(ord(c) + 0xFEE0) if "!" <= c <= "~" and rng.random() < 0.7 else c for c in chars]
    elif kind == "zerowidth":
        for _ in range(max(1, len(chars) // 10)):
            chars.insert(rng.randrange(len(chars) + 1), rng.choice(["​", "‍", "﻿"]))
    elif kind == "emoji":
        for _ in range(max(1, len(chars) // 15)):
            chars.insert(rng.randrange(len(chars) + 1), rng.choice(["🔥", "👇", "💯", "✨", "😂", "👍🏻"]))
    elif kind == "decor":
        for _ in range(max(1, len(chars) // 10)):
            chars.insert(rng.randrange(len(chars) + 1), rng.choice(list("*·~_|-/—")))
    elif kind == "crlf":
        return text.replace("\n", "\r\n").replace("。", "。\n", 2)
    elif kind == "truncate":
        a = rng.randrange(len(chars))
        b = rng.randrange(a, len(chars) + 1)
        chars = chars[a:b] or chars
    elif kind == "upper":
        return text.upper()
    return "".join(chars)


def corpus(include_blind: bool) -> list[dict]:
    products = load_products()
    cases: list[dict] = []
    eval_items = load_dataset()
    for item in eval_items:
        cases.append({"id": f"eval:{item.id}", "product": item.product, "script": item.text, "cues": item.cues})
    ruleset = RuleSet.load(BACKEND / "rules" / "adproof_rules.yaml")
    for rule in ruleset.library.rules:
        category = "general" if "all" in rule.applies_to else rule.applies_to[0]
        for kind, samples in (("hit", rule.examples.hit), ("pass", rule.examples.pass_)):
            for i, sample in enumerate(samples):
                cases.append({"id": f"example:{rule.id}:{kind}{i}", "product": custom(category), "script": sample, "cues": []})
    for sku, sample in json.loads(SAMPLES.read_text(encoding="utf-8")).items():
        if "srt" in sample:
            text, cues = parse_srt(sample["srt"])
            cases.append({"id": f"sample:{sku}", "product": products[sku], "script": text, "cues": [c.to_dict() for c in cues]})
        else:
            cases.append({"id": f"sample:{sku}", "product": products[sku], "script": sample["text"].strip(), "cues": []})
    if COVERAGE.exists():
        for case in json.loads(COVERAGE.read_text(encoding="utf-8"))["cases"]:
            product = products[case["sku"]] if case.get("sku") else custom(case["category"])
            cases.append({"id": f"coverage:{case['id']}", "product": product, "script": case["text"], "cues": []})
    if include_blind and BLIND.exists():
        for item in load_dataset(BLIND):
            cases.append({"id": f"blind:{item.id}", "product": item.product, "script": item.text, "cues": item.cues})
    rng = random.Random(20261107)
    categories = list(ruleset.product_categories)
    texts = [i.text for i in eval_items if i.input_type == "text"]
    for n in range(240):
        base = rng.choice(texts)
        if n % 4 == 3:
            base = "。".join(rng.sample([s for t in rng.sample(texts, 3) for s in t.split("。") if s], 4))
        text = perturb(base, rng)
        product = rng.choice(list(products.values())) if rng.random() < 0.6 else custom(rng.choice(categories))
        cases.append({"id": f"fuzz:{n:03d}", "product": product, "script": text, "cues": [],
                      "inject": n % 17 == 0})
    edge = [
        "This serum is the best in the world, 100% guaranteed.",
        "123456789",
        "最",
        "。。。，，，",
        "全网最低价" * 3,
        ("家人们，" + "".join(t for t in texts[:20])) [:6000],
        "最🔥好用的🔥精华，保证🔥🔥有效，98%的👍🏻姐妹都回购了",
        "𠀀𠀁最好用𠀂的面霜，国家级配方",
    ]
    for i, text in enumerate(edge):
        cases.append({"id": f"edge:{i}", "product": custom("cosmetics"), "script": text, "cues": []})
    return cases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-blind", action="store_true", help="add the blind set (only after its first run is recorded)")
    args = parser.parse_args()
    pipe = pipeline()
    results = []
    for case in corpus(args.include_blind):
        out = pipe.run(PipelineInput(product=case["product"], script=case["script"], cues=case["cues"],
                                     inject_hallucination=bool(case.get("inject"))), Tracer())
        recheck = None
        if out["rewrite"] and out["rewrite"]["changed"]:
            again = pipe.review(out["rewrite"]["text"], case["product"], Tracer(), stage="终审复检")
            counts, risk = summarize(again.findings, again.disclosures)
            recheck = {"passed": again.passed(), "counts": counts, "risk_level": risk,
                       "keys": [f["key"] for f in again.findings]}
        results.append({**case, "expected": convert(out), "recheck": recheck})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"ruleset": pipe.ruleset.hash, "cases": results}, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(results)} cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
