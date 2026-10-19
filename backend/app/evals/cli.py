"""Evaluate the pipeline on the annotated dataset (used as the CI gate).

    python -m app.evals.cli                                   # print the report
    python -m app.evals.cli --gate 0.80 --rewrite-gate 0.90   # exit 1 below the thresholds
    python -m app.evals.cli --report eval-report.json

Gates apply to the test split. Two invariants are always enforced, with or without
--gate: every reported span must equal the script text, and every citation shown as
verified must resolve to the local law snapshot.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from ..agents import ReviewPipeline
from ..config import get_settings
from ..law import LawLibrary
from ..llm import build_provider
from ..rules import RuleSet
from .dataset import DATASET_PATH, dataset_hash, load_dataset
from .runner import run_eval

LABELS = {
    "absolute_terms": "绝对化用语",
    "authority_endorsement": "国家机关名义",
    "medical_claims": "疾病治疗与医疗用语",
    "effect_claims": "效果保证与虚构效果",
    "unsourced_data": "数据无出处",
    "disparagement": "贬低其他经营者",
    "guaranteed_returns": "收益或结果保证",
    "fact_mismatch": "与商品资料不符",
}


def build_pipeline() -> tuple[ReviewPipeline, dict]:
    settings = get_settings()
    provider = build_provider(settings)
    ruleset = RuleSet.load(settings.rules_path)
    laws = LawLibrary(settings.laws_dir)
    pipeline = ReviewPipeline(provider, ruleset, laws, settings.review_channels, settings.rewrite_max_rounds,
                              settings.max_script_chars)
    meta = {"provider": provider.name, "model": provider.model, "ruleset_version": ruleset.version,
            "ruleset_hash": ruleset.hash}
    return pipeline, meta


def evaluate(dataset: Path = DATASET_PATH) -> dict:
    pipeline, meta = build_pipeline()
    started = time.perf_counter()
    result = run_eval(pipeline, load_dataset(dataset))
    result["meta"] = {**meta, "dataset_hash": dataset_hash(dataset), "items": len(result["cases"]),
                      "elapsed_ms": int((time.perf_counter() - started) * 1000),
                      "offline": meta["provider"] == "mock"}
    return result


def _fmt(v: float | None) -> str:
    return "  —  " if v is None else f"{v * 100:5.1f}%"


def print_report(result: dict) -> None:
    meta = result["meta"]
    print(f"\nAdProof eval · provider={meta['provider']} model={meta['model']} · "
          f"rules {meta['ruleset_version']} ({meta['ruleset_hash']}) · dataset {meta['dataset_hash']}")
    if meta["offline"]:
        print("离线确定性模型 + 合成数据（SYNTHETIC）：数字只说明流程按设计工作，不代表真实模型效果。")
    for split in ("dev", "test"):
        r = result["splits"][split]
        m = r["span"]["micro"]
        print("-" * 78)
        print(f"[{split}] {r['items']} 条 · 片段 P {_fmt(m['precision'])} R {_fmt(m['recall'])} F1 {_fmt(m['f1'])}"
              f" · 严格边界 F1 {_fmt(r['span_strict']['f1'])} · 定位 F1 {_fmt(r['localisation']['f1'])}")
        for cat, v in r["span"]["per_category"].items():
            if v["support"] or v["fp"]:
                print(f"    {LABELS.get(cat, cat):<14} P {_fmt(v['precision'])} R {_fmt(v['recall'])} "
                      f"F1 {_fmt(v['f1'])}  gold {v['support']:>2}  fp {v['fp']}")
        a = r["ablation"]
        print(f"    通道消融 F1：规则 {_fmt(a['rule']['f1'])} · 模型 {_fmt(a['model']['f1'])} · 双通道 {_fmt(a['both']['f1'])}")
        rw = r["rewrite"]
        print(f"    改写后复审通过 {rw['passed']}/{rw['scripts']} ({_fmt(rw['pass_rate'])}) · "
              f"金标违规被改写 {rw['gold_eliminated']}/{rw['gold_spans']} ({_fmt(rw['elimination_rate'])})")
        e = r["evidence"]
        print(f"    证据校验 {e['findings_valid']}/{e['findings_checked']} · 法条已核对 {e['citations_verified']}/{e['citations']}"
              f" · 必要声明 F1 {_fmt(r['disclosures']['f1'])} · 干净脚本误报 {r['script_level']['clean_flagged']}/{r['script_level']['clean']}")


def check_gates(result: dict, gate: float, rewrite_gate: float) -> list[str]:
    failures = []
    test = result["splits"]["test"]
    for split in ("dev", "test"):
        e = result["splits"][split]["evidence"]
        if e["findings_valid"] != e["findings_checked"]:
            failures.append(f"{split}: {e['findings_checked'] - e['findings_valid']} 条结果没有通过证据校验")
        if e["citations_verified"] != e["citations"]:
            failures.append(f"{split}: {e['citations'] - e['citations_verified']} 条法条引用未核对")
    f1 = test["span"]["micro"]["f1"]
    if f1 < gate:
        failures.append(f"test 片段 F1 {f1:.1%} < {gate:.0%}")
    pass_rate = test["rewrite"]["pass_rate"] or 0.0
    if pass_rate < rewrite_gate:
        failures.append(f"test 改写后复审通过率 {pass_rate:.1%} < {rewrite_gate:.0%}")
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AdProof span-level evaluation")
    parser.add_argument("--gate", type=float, default=0.0, help="minimum test-split span F1")
    parser.add_argument("--rewrite-gate", type=float, default=0.0, help="minimum test-split rewrite pass rate")
    parser.add_argument("--report", help="write the full report (metrics + per-case results) as JSON")
    parser.add_argument("--dataset", default=str(DATASET_PATH))
    args = parser.parse_args(argv)

    result = evaluate(Path(args.dataset))
    print_report(result)
    if args.report:
        Path(args.report).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failures = check_gates(result, args.gate, args.rewrite_gate)
    if failures:
        print("\nGATE FAILED:\n  " + "\n  ".join(failures))
        return 1
    print("\nGATE PASSED" if (args.gate or args.rewrite_gate) else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
