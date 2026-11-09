"""python -m app.redteam {generate,audit,proposals,summary,report,blind} — see app/redteam/__init__.py."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from .audit import audit_round
from .common import REDTEAM_DIR, ROUND_ID, LlamaServer, load_policy, read_json, write_json
from .generate import generate_round, parse_seeds
from .proposals import render
from . import report


def _commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def cmd_generate(a: argparse.Namespace) -> int:
    if not ROUND_ID.match(a.round):
        sys.exit(f"round id must look like r1, r2 …: {a.round!r}")
    seeds = parse_seeds(json.loads(a.seeds) if a.seeds.strip() else [], load_policy())
    categories = [c.strip() for c in a.categories.split(",") if c.strip()] or None
    server = LlamaServer(a.model_url)
    data = generate_round(server, round_id=a.round, seed=a.seed, per_product=a.per_product, near_misses=a.near_misses,
                          categories=categories, seeds=seeds,
                          generator={"label": a.model_label, "url": a.model_src, "sha256": a.model_sha})
    write_json(Path(a.out), data)
    print(f"{len(data['items'])} wordings ({len(data['dropped'])} dropped) · throughput {json.dumps(data['throughput'])}")
    return 0


def cmd_audit(a: argparse.Namespace) -> int:
    server = LlamaServer(a.model_url)
    data = audit_round(server, read_json(Path(a.round_file)), read_json(Path(a.scores)), sample=a.sample,
                       auditor={"label": a.model_label, "url": a.model_src, "sha256": a.model_sha})
    write_json(Path(a.out), data)
    print(f"audited {len(data['items'])} · label noise on the fixed sample {json.dumps(data['noise'])}")
    return 0


def cmd_proposals(a: argparse.Namespace) -> int:
    d = Path(a.dir)
    audit = d / "audit.json"
    text = render(read_json(d / "round.json"), read_json(d / "scores.json"), read_json(audit) if audit.exists() else None)
    (d / "proposals.md").write_text(text, encoding="utf-8")
    print(f"wrote {d / 'proposals.md'}")
    return 0


def cmd_summary(a: argparse.Namespace) -> int:
    """Markdown for the job summary: the pre-fix catch rate per category, false alarms, audit, throughput."""
    d = Path(a.dir)
    (d / "scores.json").exists() or sys.exit("no scores.json")
    r = report.build_round(d)
    policy = load_policy()
    c = r["counts"]
    out = [f"### 红队回合 {r['id']} · 修复前的引擎 `{r['engine']['commit'][:7]}`（规则库 {r['engine']['ruleset_version']}）", "",
           f"违规说法标出 **{c['caught']}/{c['violations']}**（另有 {c['other']} 条标成了其他分类）· "
           f"近似合规说法误报 **{c['false_alarms']}/{c['near_misses']}**", "",
           "| 分类 | 违规标出 | 近似合规误报 |", "|---|---|---|"]
    for cat, x in r["per_category"].items():
        out.append(f"| {policy['categories'][cat]['label']} | {x['caught']}/{x['violations']} | {x['false_alarms']}/{x['near_misses']} |")
    if r["audit"]:
        n = r["audit"]
        out += ["", f"模型审计（{(r['auditor'] or {}).get('label', '')}，不是人工复核）：固定抽样 {n['sampled']} 条，"
                    f"标签存疑 {n['disputed']} 条（{(n['rate'] or 0) * 100:.1f}%）"]
    out += ["", f"吞吐：生成 `{json.dumps(r['throughput']['generator'])}`；审计 `{json.dumps(r['throughput']['auditor'])}`"]
    print("\n".join(out))
    return 0


def cmd_report(a: argparse.Namespace) -> int:
    if a.check:
        if not report.check():
            print("frontend/src/redteam-report.json is stale: run `python -m app.redteam report`", file=sys.stderr)
            return 1
        print("redteam-report.json is up to date")
        return 0
    report.write()
    print(f"wrote {report.REPORT_PATH}")
    return 0


def cmd_blind(a: argparse.Namespace) -> int:
    """Span P/R/F1 on the sequestered blind set at this commit; appends metrics only (no script text) to blind_runs.json."""
    from ..evals.cli import evaluate

    result = evaluate(Path(a.dataset))
    t = result["splits"]["test"]
    m = t["span"]["micro"]
    row = {
        "commit": a.commit or _commit(), "label": a.label, "blind": a.blind,
        "ruleset_version": result["meta"]["ruleset_version"], "ruleset_hash": result["meta"]["ruleset_hash"],
        "dataset_hash": result["meta"]["dataset_hash"], "scripts": t["items"],
        "precision": m["precision"], "recall": m["recall"], "f1": m["f1"], "tp": m["tp"], "fp": m["fp"], "fn": m["fn"],
        "strict_f1": t["span_strict"]["f1"],
        "clean": t["script_level"]["clean"], "clean_flagged": t["script_level"]["clean_flagged"],
        "per_category": {c: {k: v[k] for k in ("tp", "fp", "fn", "support")} for c, v in t["span"]["per_category"].items()},
        "rewrite": {k: t["rewrite"].get(k) for k in ("scripts", "passed", "withheld")},
        "evidence": {k: t["evidence"][k] for k in ("findings_checked", "findings_valid", "citations", "citations_verified")},
    }
    path = REDTEAM_DIR / "blind_runs.json"
    data = read_json(path) if path.exists() else {"set": "backend/evals/blind_v2.yaml", "runs": []}
    data["runs"] = [r for r in data["runs"] if r["commit"] != row["commit"]] + [row]
    write_json(path, data)
    print(f"blind {row['commit'][:7]}: P {m['precision']:.3f} R {m['recall']:.3f} F1 {m['f1']:.3f} · "
          f"clean flagged {row['clean_flagged']}/{row['clean']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.redteam")
    sub = p.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="new wordings from the generator model (Actions only)")
    g.add_argument("--round", required=True)
    g.add_argument("--seed", type=int, default=1)
    g.add_argument("--per-product", type=int, default=3)
    g.add_argument("--near-misses", type=int, default=1)
    g.add_argument("--categories", default="")
    g.add_argument("--seeds", default="", help="JSON list of {category, text, kind?, product_category?}")
    g.add_argument("--model-url", default="http://127.0.0.1:8080")
    g.add_argument("--model-label", default="")
    g.add_argument("--model-src", default="")
    g.add_argument("--model-sha", default="")
    g.add_argument("--out", required=True)
    g.set_defaults(fn=cmd_generate)

    au = sub.add_parser("audit", help="model audit of a fixed sample, plus triage of misses (Actions only)")
    au.add_argument("--round-file", required=True)
    au.add_argument("--scores", required=True)
    au.add_argument("--sample", type=int, default=24)
    au.add_argument("--model-url", default="http://127.0.0.1:8080")
    au.add_argument("--model-label", default="")
    au.add_argument("--model-src", default="")
    au.add_argument("--model-sha", default="")
    au.add_argument("--out", required=True)
    au.set_defaults(fn=cmd_audit)

    pr = sub.add_parser("proposals", help="write proposals.md for a round directory")
    pr.add_argument("--dir", required=True)
    pr.set_defaults(fn=cmd_proposals)

    su = sub.add_parser("summary", help="markdown summary of a round directory")
    su.add_argument("--dir", required=True)
    su.set_defaults(fn=cmd_summary)

    rp = sub.add_parser("report", help="build frontend/src/redteam-report.json")
    rp.add_argument("--check", action="store_true")
    rp.set_defaults(fn=cmd_report)

    bl = sub.add_parser("blind", help="metrics on the sequestered blind set, appended to blind_runs.json")
    bl.add_argument("--label", required=True)
    bl.add_argument("--commit", default="")
    bl.add_argument("--blind", action=argparse.BooleanOptionalAction, default=True,
                    help="--no-blind once the set's scripts have been read")
    bl.add_argument("--dataset", default=str(Path(__file__).resolve().parents[2] / "evals" / "blind_v2.yaml"))
    bl.set_defaults(fn=cmd_blind)

    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
