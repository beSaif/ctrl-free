"""Several suppliers answer the same request: each reply is its own offer, the estimator picks per line or per
request, can switch later and undo."""
from __future__ import annotations

import pytest

from app import pipeline, quotes, store
from tests.test_api import base_id, client, pytestmark, tenders_dir, tid  # noqa: F401  (fixtures)

LEA = {"X-Actor": "lea"}


@pytest.fixture(scope="module")
def demo_replies(tmp_path_factory):
    return quotes.make_demo_replies(tmp_path_factory.mktemp("replies"))


def _read_both(client, tid, demo_replies):
    first, _, competitor = demo_replies
    r = client.post(f"/api/tenders/{tid}/quotes/read", files=[
        ("files", (first.name, first.read_bytes(), "application/pdf")),
        ("files", (competitor.name, competitor.read_bytes(), "application/pdf")),
    ])
    assert r.status_code == 200, r.text
    return r.json()


def _offers(client, tid, lv):
    return client.get(f"/api/tenders/{tid}/positions/{lv}").json()["offers"]


def test_supplier_is_read_from_letterhead_and_email(demo_replies):
    assert [quotes.supplier_of(p, p.name, use_llm=False) for p in demo_replies] == [
        "DemoAcoustic AG", "DemoControl GmbH", "Akustik Demo Partner AG"]
    eml = b"From: Hans Muster <hans@kulissenbau.example>\nSubject: Offerte\n\nPos 1 400 x 300 4 Stk 2'300.00\n"
    assert quotes.supplier_of(eml, "reply.eml", use_llm=False) == "Hans Muster"
    pasted = b"Von: offerten@kulissenbau.example\nPos 1 ...\nFreundliche Gruesse\nKulissenbau Muster GmbH\n"
    assert quotes.supplier_of(pasted, "Pasted text", use_llm=False) == "Kulissenbau Muster GmbH"
    assert quotes.supplier_of(b"Pos 1 1'000.00", "acme_offer.txt", use_llm=False) == "acme offer"


def test_two_replies_become_two_offers_best_is_cheapest(client, tid, demo_replies):
    before = store.load(tid)["positions"]
    r = _read_both(client, tid, demo_replies)
    assert store.load(tid)["positions"] == before  # reading never changes a price
    sup = [x["supplier"] for x in r["replies"]]
    assert sup == ["DemoAcoustic AG", "Akustik Demo Partner AG"] and all(x["count"] for x in r["replies"])
    assert len({x["proposal_id"] for x in r["replies"]}) == 2
    by_sup: dict[str, dict] = {}
    for it in r["proposals"]:
        by_sup.setdefault(it["supplier"], {})[it["lv_id"]] = it["unit_price"]
    shared = sorted(set(by_sup["DemoAcoustic AG"]) & set(by_sup["Akustik Demo Partner AG"]))
    assert len(shared) == 2 and len(by_sup["DemoAcoustic AG"]) == 3  # the competitor skipped one line
    for lv in shared:
        offers = _offers(client, tid, lv)
        assert len(offers) == 2 and not any(o["chosen"] for o in offers)
        cheap = min(offers, key=lambda o: o["unit_price"])
        assert [o for o in offers if o["best"]] == [cheap]
        assert all(o["notes"] and o["line_total"] == round(o["unit_price"] * o["quantity"], 2) for o in offers)
        assert all(o["delta_vs_budget"] is not None for o in offers)
    # per request: DemoAcoustic covers every line with an offer, so it is the cheapest complete supplier
    g = client.get(f"/api/tenders/{tid}/positions/{shared[0]}").json()["quote_group"]["offers"]
    full = {s["supplier"]: s for s in g["suppliers"]}
    assert g["lines"] == 3 and full["DemoAcoustic AG"]["covers_all"] and full["DemoAcoustic AG"]["cheapest"]
    assert full["Akustik Demo Partner AG"]["lines"] == 2 and not full["Akustik Demo Partner AG"]["covers_all"]
    assert g["cheapest_supplier"] == "DemoAcoustic AG"
    assert g["cheapest_each_total"] <= full["DemoAcoustic AG"]["total"]
    tray = client.get(f"/api/tenders/{tid}/assist").json()
    assert {p["id"] for p in tray["needs_ok"]} >= {x["proposal_id"] for x in r["replies"]}


def test_choose_switch_and_undo(client, tid, demo_replies):
    r = _read_both(client, tid, demo_replies)
    comp = next(x["proposal_id"] for x in r["replies"] if x["supplier"].startswith("Akustik"))
    first = next(x["proposal_id"] for x in r["replies"] if x["supplier"].startswith("DemoAcoustic"))
    lv = next(it["lv_id"] for it in r["proposals"] if it["proposal_id"] == comp)
    offers = _offers(client, tid, lv)
    dear = next(o for o in offers if o["proposal_id"] == first)
    cheap = next(o for o in offers if o["proposal_id"] == comp)
    direct0 = client.get(f"/api/tenders/{tid}/pricing").json()["totals"]["direct"]

    a = client.post(f"/api/tenders/{tid}/quotes/choose", json={"lv_id": lv, "proposal_id": first}, headers=LEA).json()
    assert a["applied"] == 1
    d = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d["supplier_quote"]["unit_price"] == dear["unit_price"] and "DemoAcoustic AG" in d["supplier_quote"]["source"]
    assert d["supplier_quote"]["by"] == "Lea Meier" and d["log"][0]["by"] == "Lea Meier"
    assert [o["chosen"] for o in d["offers"] if o["proposal_id"] == first] == [True]
    assert len(d["offers"]) == 2  # the other offer stays as an alternative
    # the competitor's offer for this line no longer waits in the tray; its other line still does
    tray = client.get(f"/api/tenders/{tid}/assist").json()
    comp_open = [x["lv_id"] for p in tray["needs_ok"] if p["id"] == comp for x in p["items"]]
    assert lv not in comp_open and comp_open

    b = client.post(f"/api/tenders/{tid}/quotes/choose", json={"lv_id": lv, "proposal_id": comp}, headers=LEA).json()
    d = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d["supplier_quote"]["unit_price"] == cheap["unit_price"]
    assert [o["proposal_id"] for o in d["offers"] if o["chosen"]] == [comp]

    client.post(f"/api/tenders/{tid}/undo/{b['undo_id']}")
    d = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d["supplier_quote"]["unit_price"] == dear["unit_price"]
    assert [o["proposal_id"] for o in d["offers"] if o["chosen"]] == [first]

    client.post(f"/api/tenders/{tid}/undo/{a['undo_id']}")
    d = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d["supplier_quote"] is None and not any(o["chosen"] for o in d["offers"])
    assert client.get(f"/api/tenders/{tid}/pricing").json()["totals"]["direct"] == direct0
    tray = client.get(f"/api/tenders/{tid}/assist").json()
    assert any(x["lv_id"] == lv for p in tray["needs_ok"] if p["id"] == comp for x in p["items"])


def test_group_actions_cheapest_each_and_one_supplier(client, tid, demo_replies):
    r = _read_both(client, tid, demo_replies)
    lvs = sorted({it["lv_id"] for it in r["proposals"]})
    group = client.get(f"/api/tenders/{tid}/positions/{lvs[0]}").json()["quote_group"]["id"]
    best = {lv: min(_offers(client, tid, lv), key=lambda o: o["unit_price"]) for lv in lvs}

    a = client.post(f"/api/tenders/{tid}/quotes/choose", json={"group": group, "cheapest": True}).json()
    assert a["applied"] == len(lvs)
    v = pipeline.view(store.load(tid))
    for lv in lvs:
        assert v["by_lv"][lv]["supplier_quote"]["unit_price"] == best[lv]["unit_price"]
        assert v["by_lv"][lv]["supplier_quote"]["supplier"] == best[lv]["supplier"]

    b = client.post(f"/api/tenders/{tid}/quotes/choose", json={"group": group, "supplier": "demoacoustic ag"}).json()
    v = pipeline.view(store.load(tid))
    assert all(v["by_lv"][lv]["supplier_quote"]["supplier"] == "DemoAcoustic AG" for lv in lvs)
    assert b["applied"] == sum(1 for lv in lvs if best[lv]["supplier"] != "DemoAcoustic AG")

    client.post(f"/api/tenders/{tid}/undo/{b['undo_id']}")
    client.post(f"/api/tenders/{tid}/undo/{a['undo_id']}")
    v = pipeline.view(store.load(tid))
    assert all(v["by_lv"][lv]["supplier_quote"] is None for lv in lvs)
    assert client.post(f"/api/tenders/{tid}/quotes/choose", json={"group": group}).status_code == 400


def test_one_bad_file_does_not_stop_the_others(client, tid, demo_replies):
    good = demo_replies[0]
    r = client.post(f"/api/tenders/{tid}/quotes/read", files=[
        ("files", ("broken.pdf", b"%PDF-1.4 not really a pdf", "application/pdf")),
        ("files", (good.name, good.read_bytes(), "application/pdf")),
    ])
    assert r.status_code == 200, r.text
    rep = r.json()["replies"]
    assert rep[0]["error"] and "damaged" in rep[0]["error"] and rep[1]["count"] == 3 and not rep[1]["error"]


def test_second_reply_of_same_supplier_replaces_its_open_offer(client, tid, demo_replies):
    pdf = demo_replies[0]
    for _ in range(2):
        client.post(f"/api/tenders/{tid}/quotes/read", files={"file": (pdf.name, pdf.read_bytes(), "application/pdf")})
    t = store.load(tid)
    items = [x for p in t["assist"]["proposals"] for x in p["items"]]
    lv = items[0]["lv_id"]
    assert len(_offers(client, tid, lv)) == 1
