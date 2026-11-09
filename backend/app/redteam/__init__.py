"""Red-team rounds (v1.2): new evasive wordings each round, scored by the reviewer before anyone fixes anything.

    generate   an open-weight model (GLM-4-9B-0414, llama.cpp on the Actions CPU) writes wordings per violation
               category plus clean near-misses                                   → round.json
    score      the browser engine at this commit reviews every wording            → scores.json
               (frontend/scripts/redteam-score.ts; the same code the static demo runs)
    audit      a model of a third family (Qwen3-4B-Instruct-2507) labels a fixed random sample, and every miss for
               triage; the disagreement rate on the sample is the label-noise rate  → audit.json
    proposals  misses and false alarms as a reviewable list with the citations the category would carry
                                                                                  → proposals.md
    decisions  the author accepts or rejects each proposal (decisions.json); accepted ones become rule changes in
               their own commit, and `score --append` records which rule commit caught which miss (rescores.json)
    report     everything above, per round, for the 红队回合 page                   → frontend/src/redteam-report.json

Models run only on GitHub Actions (.github/workflows/redteam.yml). Model output never becomes a rule, a gold label or a
citation by itself; the only number quoted as quality is span P/R/F1 on the sequestered blind set (evals/blind_v2.yaml).
"""
