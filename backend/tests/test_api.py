SRT = (
    "1\n00:00:00,000 --> 00:00:03,000\nJack降噪耳机来了\n\n"
    "2\n00:00:03,000 --> 00:00:06,500\n单次续航12小时，同价位吊打所有竞品\n\n"
    "3\n00:00:06,500 --> 00:00:10,000\n降噪深度35dB，到手价299元\n"
)


def submit(client, headers, product_id, **body):
    r = client.post("/api/reviews", json={"product_id": product_id, **body}, headers=headers)
    assert r.status_code == 201, r.text
    review = client.get(f"/api/reviews/{r.json()['id']}", headers=headers).json()
    assert review["status"] == "pending", review.get("error")
    return review


def test_login_and_roles(client, login):
    assert client.post("/api/auth/login", json={"email": "mia@adproof.demo", "password": "wrong"}).status_code == 401
    assert client.get("/api/reviews").status_code == 401
    me = client.get("/api/auth/me", headers=login("leon@adproof.demo")).json()
    assert me["role"] == "admin"
    demo = client.get("/api/auth/demo-accounts").json()
    assert {a["name"] for a in demo["accounts"]} == {"Leon", "Mia", "Emma", "Jack"}


def test_demo_data_is_seeded_with_decisions(client, login):
    rows = client.get("/api/reviews", headers=login("mia@adproof.demo")).json()["items"]
    assert {r["status"] for r in rows} == {"pending", "approved", "rejected"}
    assert client.get("/api/evals/runs", headers=login("mia@adproof.demo")).json(), "startup eval run missing"


def test_text_review_end_to_end(client, login, product_id):
    emma = login("emma@adproof.demo")
    review = submit(client, emma, product_id["MIA-SERUM"],
                    content="这款精华是全网最好用的，含30%烟酰胺，还能消炎。今天到手价129元。")
    quotes = {f["quote"]: f for f in review["findings"]}
    assert set(quotes) == {"全网最好用", "30%", "消炎"}
    text = review["source_text"]
    for f in review["findings"]:
        assert text[f["start"]:f["end"]] == f["quote"]
        assert f["citations"][0]["status"] == "verified"
    assert review["ruleset_hash"] and review["run_id"]
    assert [a["agent"] for a in review["agents"]][:4] == ["selling_points", "rule_review", "model_review",
                                                          "evidence_locator"] or \
        {a["agent"] for a in review["agents"][:4]} == {"selling_points", "rule_review", "model_review", "evidence_locator"}
    assert review["rewrite"]["passed"] is True
    assert review["permissions"]["can_decide"] is False  # submitter's own view


def test_srt_review_maps_findings_to_timestamps(client, login, product_id):
    review = submit(client, login("jack@adproof.demo"), product_id["JACK-EARBUDS"], input_type="srt", content=SRT)
    assert len(review["cues"]) == 3
    by_quote = {f["quote"]: f for f in review["findings"]}
    assert by_quote["12小时"]["cue"]["start"] == "00:00:03,000"
    assert by_quote["12小时"]["evidence"]["expected_value"] == "8小时"
    assert by_quote["吊打所有竞品"]["cue"]["index"] == 2


def test_bad_srt_is_rejected(client, login, product_id):
    r = client.post("/api/reviews", json={"product_id": product_id["JACK-EARBUDS"], "input_type": "srt",
                                          "content": "1\n没有时间轴"}, headers=login("emma@adproof.demo"))
    assert r.status_code == 422 and "字幕" in r.json()["detail"]


def test_four_eyes_and_operator_limits(client, login, product_id):
    emma, mia = login("emma@adproof.demo"), login("mia@adproof.demo")
    review = submit(client, mia, product_id["MIA-SERUM"], content="全网最低价，快来买")
    r = client.post(f"/api/reviews/{review['id']}/decision", json={"decision": "approve", "version": "rewrite"}, headers=mia)
    assert r.status_code == 403 and "四眼原则" in r.json()["detail"]
    r = client.post(f"/api/reviews/{review['id']}/decision", json={"decision": "reject", "note": "不行"}, headers=emma)
    assert r.status_code == 403
    r = client.post("/api/reviews", json={"product_id": product_id["MIA-SERUM"], "content": "x",
                                          "inject_hallucination": True}, headers=emma)
    assert r.status_code == 403


def test_original_needs_false_positive_marks_before_approval(client, login, product_id):
    emma, mia = login("emma@adproof.demo"), login("mia@adproof.demo")
    review = submit(client, emma, product_id["MIA-SERUM"], content="这是我用过最好用的精华。")
    rid, key = review["id"], review["findings"][0]["key"]
    r = client.post(f"/api/reviews/{rid}/decision", json={"decision": "approve", "version": "original"}, headers=mia)
    assert r.status_code == 409 and r.json()["detail"]["findings"] == [key]
    r = client.post(f"/api/reviews/{rid}/findings/{key}/verdict", json={"verdict": "false_positive"}, headers=mia)
    assert r.status_code == 422  # a reason is required
    r = client.post(f"/api/reviews/{rid}/findings/{key}/verdict",
                    json={"verdict": "false_positive", "note": "个人体验描述，经确认可保留"}, headers=mia)
    assert r.status_code == 200
    r = client.post(f"/api/reviews/{rid}/decision", json={"decision": "approve", "version": "original"}, headers=mia)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert r.json()["final_text"] == "这是我用过最好用的精华。"
    rules = client.get("/api/rules", headers=mia).json()["rules"]
    assert next(x for x in rules if x["id"] == "ABS-01")["stats"]["false_positives"] >= 1


def test_revise_rechecks_the_edited_script(client, login, product_id):
    emma, mia = login("emma@adproof.demo"), login("mia@adproof.demo")
    review = submit(client, emma, product_id["MIA-SERUM"], content="全网最低价，还能消炎。")
    rid = review["id"]
    preview = client.post(f"/api/reviews/{rid}/recheck", json={"text": "活动价，还能消炎。"}, headers=mia).json()
    assert preview["passed"] is False and preview["findings"][0]["quote"] == "消炎"
    r = client.post(f"/api/reviews/{rid}/decision",
                    json={"decision": "revise", "final_text": "活动价，还能消炎。"}, headers=mia)
    assert r.status_code == 409
    r = client.post(f"/api/reviews/{rid}/decision",
                    json={"decision": "revise", "final_text": "今天直播间活动价，质地清爽。", "note": "人工改写"}, headers=mia)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "approved" and body["decision_version"] == "edited"
    trace = client.get(f"/api/runs/{body['run_id']}", headers=mia).json()
    assert trace["spans"][-1]["agent"] == "human_review"
    r = client.post(f"/api/reviews/{rid}/decision", json={"decision": "reject", "note": "再试"}, headers=mia)
    assert r.status_code == 409  # already decided


def test_generate_mode(client, login, product_id):
    review = submit(client, login("emma@adproof.demo"), product_id["IRIS-VC"], mode="generate", tone="safe")
    assert "本品不能代替药物" in review["source_text"]
    assert review["selling_points"] and review["counts"]["total"] == 0


def test_rules_api_validate_save_and_test(client, login, settings):
    leon, mia = login("leon@adproof.demo"), login("mia@adproof.demo")
    current = client.get("/api/rules/yaml", headers=mia).json()
    bad = client.post("/api/rules/validate", json={"yaml": current["yaml"].replace("ABS-01", "ABS-1", 1)}, headers=mia).json()
    assert bad["ok"] is False and bad["errors"]
    pending = current["yaml"].replace("{law: advertising_law, article: 13, paragraph: 1}",
                                      "{law: advertising_law, article: 13, paragraph: 1}\n      - {law: advertising_law, article: 20}")
    check = client.post("/api/rules/validate", json={"yaml": pending}, headers=mia).json()
    assert check["ok"] is True and any("待核对" in w for w in check["warnings"])
    assert client.put("/api/rules/yaml", json={"yaml": pending}, headers=mia).status_code == 403
    saved = client.put("/api/rules/yaml", json={"yaml": pending}, headers=leon).json()
    assert saved["hash"] != current["hash"]
    assert settings.rules_path.read_text(encoding="utf-8") == pending
    tested = client.post("/api/rules/test", json={"text": "别家卖的都是智商税", "product_category": "general"},
                         headers=mia).json()
    assert tested["hits"][0]["rule_id"] == "DIS-01"
    rules = client.get("/api/rules", headers=mia).json()
    dis = next(c for c in rules["categories"] if c["id"] == "disparagement")
    assert [c["status"] for c in dis["citations"] if c["kind"] == "basis"] == ["verified", "pending"]


def test_evals_and_traces_api(client, login):
    leon, mia = login("leon@adproof.demo"), login("mia@adproof.demo")
    assert client.post("/api/evals/runs", headers=mia).status_code == 403
    run = client.post("/api/evals/runs", headers=leon).json()
    detail = client.get(f"/api/evals/runs/{run['id']}", headers=mia).json()
    assert detail["offline"] is True and len(detail["cases"]) == 60
    assert detail["metrics"]["splits"]["test"]["evidence"]["validity"] == 1.0
    runs = client.get("/api/runs", headers=mia).json()
    trace = client.get(f"/api/runs/{runs[0]['id']}", headers=mia).json()
    assert trace["spans"] and {"agent", "started_ms", "latency_ms", "input", "output"} <= set(trace["spans"][0])
    assert client.get("/api/laws", headers=mia).json()[0]["source"]["name"] == "国家法律法规数据库"
