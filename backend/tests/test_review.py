"""Who did what: actor attribution (X-Actor), the Changes review trail and senior reviews."""
from __future__ import annotations

from app import store
from tests.test_api import _first_priced, base_id, client, pytestmark, tenders_dir, tid  # noqa: F401  (fixtures)

LEA = {"X-Actor": "lea"}
MARCO = {"X-Actor": "marco"}


def _entry(client, tid, log_id, headers=None):
    r = client.get(f"/api/tenders/{tid}/changes", headers=headers or {}).json()
    return next(e for e in r["entries"] if e["id"] == log_id), r


def test_people_and_current_actor(client):
    r = client.get("/api/people", headers=MARCO).json()
    assert {p["id"] for p in r["people"]} >= {"lea", "marco"}
    assert r["current"]["role"] == "senior"
    assert client.get("/api/people").json()["current"] is None
    assert client.get("/api/people", headers={"X-Actor": "nobody"}).json()["current"] is None


def test_writes_are_attributed_to_the_person(client, tid):
    p = _first_priced(client, tid)
    lv = p["lv_id"]
    d = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"quantity": 3, "confirm": True}, headers=LEA).json()
    assert d["confirmed"]["by"] == "Lea Meier"
    edit = next(e for e in d["log"] if e["action"] == "edit")
    assert edit["by"] == "Lea Meier" and edit["actor"] == "lea" and edit["role"] == "junior"
    assert client.get(f"/api/tenders/{tid}").json()["updated_by"] == "Lea Meier"
    r = client.put(f"/api/tenders/{tid}/pricing", json={"overhead_pct": 9.0}, headers=MARCO).json()
    assert r["settings"]["changed_by"]["overhead_pct"]["by"] == "Marco Keller"
    iid = client.get(f"/api/tenders/{tid}/instructions", params={"filter": "all"}).json()["instructions"][0]["id"]
    ins = client.patch(f"/api/tenders/{tid}/instructions/{iid}", json={"state": "confirmed"}, headers=LEA).json()
    assert ins["confirmed_by"] == "Lea Meier"
    # code that still writes by="You" without a header stays "You" (scripts, older tests)
    d = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"flag": True}).json()
    assert d["log"][0]["by"] == "You" and "actor" not in d["log"][0]


def test_changes_trail_review_and_revert(client, tid):
    p = _first_priced(client, tid)
    lv, qty = p["lv_id"], p["pricing"]["quantity"]
    d = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"quantity": qty + 2}, headers=LEA).json()
    log_id = next(e["id"] for e in d["log"] if e["action"] == "edit")
    e, r = _entry(client, tid, log_id, LEA)
    assert e["state"] == "to_review" and e["types"] == ["quantity"] and e["by"] == "Lea Meier"
    f = e["fields"][0]
    assert f["path"] == "overrides.quantity" and f["before"] == qty and f["before_calculated"] and f["after"] == qty + 2
    assert e["impact"]["basis"] == "line" and e["impact"]["value"] > 0
    assert r["summary"]["to_review"] >= 1 and not r["me"]["can_review"]
    assert any(a["by"] == "Lea Meier" for a in r["summary"]["by_actor"])
    assert client.get(f"/api/tenders/{tid}").json()["review_trail"]["to_review"] >= 1

    # a junior may comment but not approve
    assert client.post(f"/api/tenders/{tid}/log/{log_id}/review", json={"verdict": "approved"}, headers=LEA).status_code == 403
    r = client.post(f"/api/tenders/{tid}/log/{log_id}/review", json={"verdict": "comment", "note": "Checked the plan"},
                    headers=LEA)
    assert r.status_code == 200
    # the senior approves; the review is stored on the entry and logged itself
    r = client.post(f"/api/tenders/{tid}/log/{log_id}/review", json={"verdict": "approved", "note": "ok"}, headers=MARCO)
    e = next(x for x in r.json()["entries"] if x["id"] == log_id)
    assert e["state"] == "approved" and [x["verdict"] for x in e["reviews"]] == ["comment", "approved"]
    assert e["reviews"][-1]["by"] == "Marco Keller" and e["reviews"][-1]["role"] == "senior"
    log = client.get(f"/api/tenders/{tid}/log", params={"lv_id": lv}).json()["log"]
    assert log[0]["action"] == "review" and log[0]["review_of"] == log_id and log[0]["by"] == "Marco Keller"

    # revert = the existing undo: the quantity goes back, the entry shows who reverted it
    r = client.post(f"/api/tenders/{tid}/log/{log_id}/review", json={"verdict": "reverted"}, headers=MARCO)
    e = next(x for x in r.json()["entries"] if x["id"] == log_id)
    assert e["state"] == "reverted" and e["reverted"]["by"] == "Marco Keller"
    assert client.get(f"/api/tenders/{tid}/positions/{lv}").json()["overrides"]["quantity"] is None
    assert client.post(f"/api/tenders/{tid}/log/{log_id}/review", json={"verdict": "reverted"}, headers=MARCO).status_code == 400


def test_senior_changes_count_as_reviewed_and_undo_still_works(client, tid):
    p = _first_priced(client, tid)
    lv = p["lv_id"]
    d = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"hours": 9.5}, headers=MARCO).json()
    log_id = d["log"][0]["id"]
    e, _ = _entry(client, tid, log_id)
    assert e["state"] == "approved" and e["state_why"] == "made_by_senior" and e["types"] == ["hours"]
    r = client.post(f"/api/tenders/{tid}/undo/{log_id}", headers=LEA)
    assert r.status_code == 200 and r.json()["undone"][0]["by"] == "Lea Meier"
    e, _ = _entry(client, tid, log_id)
    assert e["state"] == "reverted" and e["reverted"]["by"] == "Lea Meier"


def test_ai_decisions_and_bulk_approve(client, tid):
    r = client.get(f"/api/tenders/{tid}/changes").json()
    ai = [e for e in r["entries"] if e["by"] == "AI"]
    assert ai and all(e["id"].startswith("ai:") for e in ai)
    low = [e for e in ai if e["ai"]["low"]]
    assert low and all(e["state"] == "to_review" for e in low)
    assert r["summary"]["ai_to_review"] == len(low)
    assert client.post(f"/api/tenders/{tid}/log/{low[0]['id']}/review", json={"verdict": "reverted"},
                       headers=MARCO).status_code == 400
    ids = [e["id"] for e in low[:3]]
    r = client.post(f"/api/tenders/{tid}/log/review", json={"log_ids": ids, "verdict": "approved"}, headers=MARCO).json()
    assert all(e["state"] == "approved" for e in r["entries"] if e["id"] in ids)
    assert r["summary"]["ai_to_review"] == len(low) - len(ids)
    t = store.load(tid)
    assert t["ai_reviews"][ids[0][3:]][0]["by"] == "Marco Keller"
    # the export checklist lists what is still unreviewed
    pts = {p["key"]: p for p in client.get(f"/api/tenders/{tid}/export/checklist").json()["open_points"]}
    assert pts["reviews"]["ok"] is False


def test_assist_change_records_who_said_ok(client, tid):
    p = _first_priced(client, tid, "supplier_quote_required")
    r = client.post(f"/api/tenders/{tid}/quotes/apply", headers=LEA,
                    json={"proposals": [{"lv_id": p["lv_id"], "unit_price": 123.0, "source": "reply.pdf"}]}).json()
    log_id = r["log_ids"][0]
    e, _ = _entry(client, tid, log_id)
    assert e["by"] == "Assist" and e["approved_by"] == "Lea Meier" and e["types"] == ["quotes"]
    assert e["fields"][0]["path"] == "supplier_quote.unit_price" and e["fields"][0]["after"] == 123.0
