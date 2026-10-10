"""Learned matches: estimators' product choices are recorded, applied to similar lines and to later tenders.

Every test uses its own empty learned store (tmp_path), so nothing leaks into other tests or the golden run.
"""
from __future__ import annotations

import copy
from collections import defaultdict

import pytest

from app import learned, store
from tests.test_api import base_id, client, pytestmark, tenders_dir, tid  # noqa: F401  (shared fixtures)


@pytest.fixture(autouse=True)
def learned_store(monkeypatch, tmp_path):
    monkeypatch.setattr(learned, "PATH_OVERRIDE", tmp_path / "learned.json")
    return tmp_path / "learned.json"


def _unmatched_group(t: dict, n: int = 3) -> list[dict]:
    """Lines without a product that share a tender wording signature (n or more)."""
    groups: dict[str, list[dict]] = defaultdict(list)
    for p in t["positions"]:
        if p.get("kind") == "item" and p.get("unit") == "pc" and not (p.get("match") or {}).get("product_id"):
            groups[learned.signature(p)[0]].append(p)
    return max((g for g in groups.values() if len(g) >= n), key=len)


def _strong_line(client, tid):
    ps = client.get(f"/api/tenders/{tid}/positions?filter=calculated").json()["positions"]
    return next(p for p in ps if (p.get("match") or {}).get("label") == "Strong" and not p["match"].get("assumptions"))


def test_empty_store_changes_nothing(client, tid):
    t = store.load(tid)
    matches = {p["lv_id"]: p["match"] for p in t["positions"] if p.get("match")}
    assert learned.apply_rules(tid, t["positions"], matches) == matches
    assert client.get("/api/learned").json() == {"rules": [], "counts": {"total": 0, "active": 0, "applied": 0}}


def test_changing_a_product_teaches_a_rule_and_offers_similar_lines(client, tid):
    group = _unmatched_group(store.load(tid))
    first, rest = group[0], [p["lv_id"] for p in group[1:]]
    r = client.patch(f"/api/tenders/{tid}/positions/{first['lv_id']}", json={"product_id": "P-FIR-004", "variant_reason": "Same part"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["similar"]["count"] == len(rest) and d["similar"]["lv_ids"] == rest
    assert d["learned_rule"]["product_id"] == "P-FIR-004"
    rules = client.get("/api/learned").json()["rules"]
    assert len(rules) == 1
    rule = rules[0]
    entry = next(e for e in d["log"] if e["action"] == "edit")
    assert rule["from"]["lv_id"] == first["lv_id"] and rule["from"]["by"] == entry["by"] and rule["from"]["exists"]
    assert rule["times_confirmed"] == 1 and rule["active"] and rule["note"] == "Same part"
    assert "per pc" in rule["label"] and rule["wording_de"]

    res = client.post(f"/api/tenders/{tid}/positions/{first['lv_id']}/apply-similar")
    assert res.status_code == 200, res.text
    res = res.json()
    assert res["applied"] == len(rest) and res["position"]["similar"]["count"] == 0
    t = store.load(tid)
    assert all(p["overrides"].get("product_id") == "P-FIR-004" for p in t["positions"] if p["lv_id"] in rest)
    assert {e["batch"] for e in t["log"] if e.get("batch") == res["batch"]} == {res["batch"]}
    assert client.get("/api/learned").json()["rules"][0]["times_applied"] == len(rest)

    # undo of the batch puts the lines back and forgets the applications, not the rule
    u = client.post(f"/api/tenders/{tid}/undo/{res['log_id']}")
    assert u.status_code == 200 and len(u.json()["undone"]) == len(rest)
    t = store.load(tid)
    assert not any(p["overrides"].get("product_id") for p in t["positions"] if p["lv_id"] in rest)
    rule = client.get("/api/learned").json()["rules"][0]
    assert rule["times_applied"] == 0 and rule["times_confirmed"] == 1


def test_undo_of_the_change_forgets_the_rule(client, tid):
    first = _unmatched_group(store.load(tid))[0]
    d = client.patch(f"/api/tenders/{tid}/positions/{first['lv_id']}", json={"product_id": "P-FIR-004"}).json()
    entry = next(e for e in d["log"] if e["action"] == "edit")
    assert len(client.get("/api/learned").json()["rules"]) == 1
    client.post(f"/api/tenders/{tid}/undo/{entry['id']}")
    assert client.get("/api/learned").json()["rules"] == []


def test_reset_forgets_what_the_line_taught(client, tid):
    first = _unmatched_group(store.load(tid))[0]
    client.patch(f"/api/tenders/{tid}/positions/{first['lv_id']}", json={"product_id": "P-FIR-004"})
    client.patch(f"/api/tenders/{tid}/positions/{first['lv_id']}", json={"reset": True})
    assert client.get("/api/learned").json()["rules"] == []


def test_confirming_teaches_only_matches_that_needed_the_estimator(client, tid):
    strong = _strong_line(client, tid)
    client.patch(f"/api/tenders/{tid}/positions/{strong['lv_id']}", json={"confirm": True})
    assert client.get("/api/learned").json()["rules"] == []
    ps = client.get(f"/api/tenders/{tid}/positions?filter=assumption_applied").json()["positions"]
    close = next(p for p in ps if (p.get("match") or {}).get("product_id") and p["match"]["label"] == "Close")
    client.patch(f"/api/tenders/{tid}/positions/{close['lv_id']}", json={"confirm": True})
    rules = client.get("/api/learned").json()["rules"]
    assert len(rules) == 1 and rules[0]["product_id"] == close["match"]["product_id"]
    client.patch(f"/api/tenders/{tid}/positions/{close['lv_id']}", json={"unconfirm": True})
    assert client.get("/api/learned").json()["rules"] == []


def test_learned_rules_come_first_on_a_later_tender(client, tid):
    group = _unmatched_group(store.load(tid))
    client.patch(f"/api/tenders/{tid}/positions/{group[0]['lv_id']}", json={"product_id": "P-FIR-004"})
    # "upload the same tender again": the matcher's output for a new tender, learned rules applied after it
    t = store.load(tid)
    later = "t_later1"
    positions = copy.deepcopy(t["positions"])
    matches = {p["lv_id"]: p["match"] for p in positions if p.get("match")}
    out = learned.apply_rules(later, positions, matches)
    hit = [lv for lv, m in out.items() if m.get("method") == "learned"]
    assert sorted(hit) == sorted(p["lv_id"] for p in group)
    m = out[group[1]["lv_id"]]
    assert m["product_id"] == "P-FIR-004" and m["label"] == "Strong" and not m["assumptions"]
    assert m["learned"]["lv_id"] == group[0]["lv_id"] and m["learned"]["tender_id"] == tid
    assert m["reason"].startswith(f"Learned from {t['name']} {group[0]['lv_id']}, chosen by ")
    assert m["rules_pick"]["product_id"] is None  # what the code would have picked stays visible
    assert m["candidates"][0]["product_id"] == "P-FIR-004" and m["candidates"][0]["tag"] == "learned"
    rule = client.get("/api/learned").json()["rules"][0]
    assert rule["times_applied"] == len(group)
    # applying the same tender twice does not count twice
    learned.apply_rules(later, positions, matches)
    assert client.get("/api/learned").json()["rules"][0]["times_applied"] == len(group)


def test_a_rule_overridden_more_than_confirmed_stops_applying(client, tid):
    group = _unmatched_group(store.load(tid))
    a, b, c = group[0]["lv_id"], group[1]["lv_id"], group[2]["lv_id"]
    client.patch(f"/api/tenders/{tid}/positions/{a}", json={"product_id": "P-FIR-004"})
    # the next lines come back learned (as on a later tender), and the estimator picks another product twice
    with store.edit(tid) as t:
        positions = t["positions"]
        out = learned.apply_rules(tid, positions, {p["lv_id"]: p["match"] for p in positions if p.get("match")})
        for p in positions:
            if p["lv_id"] in (b, c):
                p["match"] = out[p["lv_id"]]
    client.patch(f"/api/tenders/{tid}/positions/{b}", json={"product_id": "P-FIR-002"})
    rules = {r["product_id"]: r for r in client.get("/api/learned").json()["rules"]}
    assert rules["P-FIR-004"]["times_overridden"] == 1 and rules["P-FIR-004"]["active"]  # 1 taught vs 1 override
    client.patch(f"/api/tenders/{tid}/positions/{c}", json={"product_id": "P-FIR-002"})
    rules = {r["product_id"]: r for r in client.get("/api/learned").json()["rules"]}
    assert rules["P-FIR-004"]["times_overridden"] == 2 and not rules["P-FIR-004"]["active"]
    assert rules["P-FIR-004"]["stopped"] == "overridden"
    assert learned.best_rule(learned.signature(group[0])[0], learned.load_rules())["product_id"] == "P-FIR-002"


def test_disable_and_delete_a_rule(client, tid):
    first = _unmatched_group(store.load(tid))[0]
    client.patch(f"/api/tenders/{tid}/positions/{first['lv_id']}", json={"product_id": "P-FIR-004"})
    rid = client.get("/api/learned").json()["rules"][0]["id"]
    r = client.patch(f"/api/learned/{rid}", json={"enabled": False})
    assert r.status_code == 200 and r.json()["active"] is False and r.json()["stopped"] == "disabled"
    t = store.load(tid)
    out = learned.apply_rules("t_other", t["positions"], {p["lv_id"]: p["match"] for p in t["positions"] if p.get("match")})
    assert not any(m.get("method") == "learned" for m in out.values())
    assert client.delete(f"/api/learned/{rid}").status_code == 200
    assert client.get("/api/learned").json()["rules"] == []
    assert client.delete(f"/api/learned/{rid}").status_code == 404


def test_apply_similar_needs_a_decision_first(client, tid):
    first = _unmatched_group(store.load(tid))[0]
    assert client.get(f"/api/tenders/{tid}/positions/{first['lv_id']}").json()["similar"] is None
    assert client.post(f"/api/tenders/{tid}/positions/{first['lv_id']}/apply-similar").status_code == 400


def test_line_detail_shows_comparison_and_make_rule(client, tid):
    p = _strong_line(client, tid)
    d = client.get(f"/api/tenders/{tid}/positions/{p['lv_id']}").json()
    assert d["comparison"]["product_id"] == d["product"]["product_id"]
    assert d["make_rule"]["kind"] in ("example", "prescribed", "open", "none")
    assert d["match"]["comparison"]["verdict"] in ("same", "equivalent", "differs", "unknown")
    assert all("comparison" in c for c in d["candidates"])
    cands = client.get(f"/api/tenders/{tid}/positions/{p['lv_id']}/candidates?q=valve").json()["candidates"]
    assert cands and all("comparison" in c for c in cands)
