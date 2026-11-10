"""Copy the pinned PP-OCRv5 files for the 图片 / 截图 input into a built site (GitHub Actions only).

The page loads the OCR weights from its own site, not from Hugging Face: Hugging Face's web application
firewall answered headless Chromium on Actions with a CAPTCHA (CreditLens runs 42776613837, 42777096938),
so a page that fetched from Hugging Face could not be tested there. This step downloads each file once
from the pinned revision, checks size and SHA-256 against frontend/src/ocr/pins.json (equal to
backend/evals/ocr/protocol.json, see tests/ocr.test.ts) and writes it under the site; the page checks the
SHA-256 again before running anything.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--into", required=True, type=Path, help="e.g. frontend/public/models/pp-ocrv5")
    args = parser.parse_args(argv)
    if not os.getenv("GITHUB_ACTIONS"):
        raise SystemExit("Downloads model weights; runs on GitHub Actions only (no weights are kept on a developer machine).")
    pins = json.loads((ROOT / "frontend/src/ocr/pins.json").read_text(encoding="utf-8"))
    weights = pins["weights"]
    args.into.mkdir(parents=True, exist_ok=True)
    for name, spec in weights["files"].items():
        request = Request(weights["base_url"] + name, headers={"User-Agent": "AdProof site build (https://github.com/leon1111-wgl/adproof)"})
        with urlopen(request, timeout=120) as response:
            raw = response.read(spec["bytes"] + 1)
        digest = hashlib.sha256(raw).hexdigest()
        if len(raw) != spec["bytes"] or digest != spec["sha256_hex"]:
            raise SystemExit(f"{name}: size or SHA-256 differs from the pinned file")
        (args.into / name).write_bytes(raw)
        print(json.dumps({"file": name, "bytes": len(raw), "sha256": digest}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
