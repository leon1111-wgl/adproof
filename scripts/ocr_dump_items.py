"""Write one evaluation set as JSON for the OCR evaluation (docs/EVALUATION.md 8.1); Actions only.

Uses the same loader as the text evaluation (backend/app/evals/dataset.py), so the text, the subtitle cues and
the gold spans are exactly the ones the text path is scored on. The sequestered blind set v2 is written only
to the runner's disk for the scoring step, never printed or uploaded.

    cd backend && python ../scripts/ocr_dump_items.py --set dev --out ../ocr-work/dev.items.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.evals.dataset import load_dataset  # noqa: E402

SETS = {
    "dev": ("scripts.yaml", "dev"),
    "test": ("scripts.yaml", "test"),
    "blind_v1": ("blind.yaml", "test"),
    "blind_v2": ("blind_v2.yaml", "test"),
}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--set", required=True, choices=sorted(SETS))
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.set == "blind_v2" and not os.getenv("GITHUB_ACTIONS"):
        raise SystemExit("blind_v2 is sequestered: it is only expanded on GitHub Actions for scoring.")
    file, split = SETS[args.set]
    items = [i for i in load_dataset(ROOT / "backend/evals" / file) if i.split == split]
    out = [{
        "id": i.id, "set": args.set, "input_type": i.input_type, "text": i.text, "cues": i.cues,
        "gold": [{"category": g.category, "start": g.start, "end": g.end} for g in i.gold],
        "product": {k: i.product.get(k) for k in ("sku", "name", "brand", "category", "description", "facts")},
        "missing_disclosures": i.missing_disclosures,
    } for i in sorted(items, key=lambda x: x.id)]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"{args.set}: {len(out)} items")
    return 0


if __name__ == "__main__":
    sys.exit(main())
