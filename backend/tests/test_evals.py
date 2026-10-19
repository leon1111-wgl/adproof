from collections import Counter as Tally

from app.evals.cli import check_gates, main
from app.evals.dataset import load_dataset, strip_markup
from app.evals.metrics import Counter, Span, iou, match
from app.evals.runner import changed_positions, run_eval


def test_markup_becomes_character_offsets():
    text, spans = strip_markup("这是[[absolute_terms|最好用]]的，[[fact_mismatch|30%]]烟酰胺")
    assert text == "这是最好用的，30%烟酰胺"
    assert [(s.category, text[s.start:s.end]) for s in spans] == [("absolute_terms", "最好用"), ("fact_mismatch", "30%")]


def test_dataset_integrity():
    items = load_dataset()
    assert len(items) == 60
    assert Tally(i.split for i in items) == {"dev": 30, "test": 30}
    assert sum(1 for i in items if i.input_type == "srt") >= 8
    assert sum(1 for i in items if not i.gold and not i.missing_disclosures) >= 10  # clean scripts
    for item in items:
        for g in item.gold:
            assert item.text[g.start:g.end] == g.text
        if item.cues:
            for cue in item.cues:
                assert item.text[cue["char_start"]:cue["char_end"]] == cue["text"]


def test_iou_and_one_to_one_matching():
    assert iou(Span("a", 0, 4), Span("a", 2, 6)) == 2 / 6
    gold = [Span("a", 0, 4), Span("a", 5, 9)]
    pred = [Span("a", 0, 9)]  # one long prediction cannot claim both gold spans
    pairs, fn, fp = match(gold, pred, threshold=0.4)
    assert len(pairs) == 1 and len(fn) == 1 and fp == []
    pairs, fn, fp = match([Span("a", 0, 4)], [Span("b", 0, 4)])
    assert pairs == [] and fn == [0] and fp == [0]


def test_counter_reports_micro_and_per_category():
    c = Counter()
    c.add([Span("a", 0, 2), Span("b", 5, 7)], [Span("a", 0, 2), Span("b", 10, 12)])
    report = c.report(["a", "b"])
    assert report["micro"]["tp"] == 1 and report["micro"]["fp"] == 1 and report["micro"]["fn"] == 1
    assert report["per_category"]["a"]["f1"] == 1.0 and report["per_category"]["b"]["f1"] == 0.0


def test_changed_positions_from_diff():
    diff = [{"op": "equal", "a": "ab", "b": "ab"}, {"op": "replace", "a": "cd", "b": "x"},
            {"op": "insert", "a": "", "b": "y"}, {"op": "delete", "a": "e", "b": ""}]
    assert changed_positions(diff) == {2, 3, 4}


def test_offline_eval_invariants(pipeline):
    result = run_eval(pipeline, load_dataset())
    for split in ("dev", "test"):
        report = result["splits"][split]
        assert report["evidence"]["validity"] == 1.0
        assert report["evidence"]["citation_verified_rate"] == 1.0
        assert report["evidence"]["pending_basis"] == 0
        assert report["ablation"]["both"]["f1"] >= max(report["ablation"]["rule"]["f1"], report["ablation"]["model"]["f1"])
    # Regression floor for the offline pipeline; see docs/EVALUATION.md before changing it.
    assert result["splits"]["test"]["span"]["micro"]["f1"] >= 0.80
    assert not check_gates(result, 0.80, 0.90)


def test_cli_gate_exit_codes(tmp_path):
    report = tmp_path / "report.json"
    assert main(["--gate", "0.80", "--rewrite-gate", "0.90", "--report", str(report)]) == 0
    assert report.exists()
    assert main(["--gate", "0.99"]) == 1
