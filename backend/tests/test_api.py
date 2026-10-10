"""API smoke tests (FastAPI TestClient) on the Oberglatt demo tender.

The pipeline runs once per session into a temporary tenders folder; each test gets its
own copy of that tender, so tests do not depend on each other's changes.
LLM calls use the disk cache (or the rules fallback when no answer is cached).
"""
from __future__ import annotations

import json
import shutil

import pytest
from fastapi.testclient import TestClient

from app import config, pipeline, store
from app.main import app

pytestmark = pytest.mark.skipif(not config.DEMO_PDF.exists(), reason="demo PDF missing")


@pytest.fixture(scope="session")
def tenders_dir(tmp_path_factory):
    old = config.TENDERS_DIR
    d = tmp_path_factory.mktemp("tenders")
    config.TENDERS_DIR = d
    yield d
    config.TENDERS_DIR = old


@pytest.fixture(scope="session")
def client(tenders_dir):
    return TestClient(app)


@pytest.fixture(scope="session")
def base_id(client):
    r = client.post("/api/tenders/demo")
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    assert r.json()["status"] == "reading"
    assert pipeline.wait(tid, timeout=600)
    t = client.get(f"/api/tenders/{tid}").json()
    assert t["status"] == "ready", t.get("warnings")
    return tid


@pytest.fixture
def tid(base_id, tenders_dir):
    """A fresh copy of the processed demo tender."""
    new = store.new_id()
    shutil.copytree(tenders_dir / base_id, tenders_dir / new)
    p = tenders_dir / new / "state.json"
    s = json.loads(p.read_text("utf-8"))
    s["id"] = new
    p.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    return new


def _direct(client, tid):
    return client.get(f"/api/tenders/{tid}/pricing").json()["totals"]["direct"]


def _first_priced(client, tid, status=None):
    rows = client.get(f"/api/tenders/{tid}/positions", params={"filter": status or "all"}).json()["positions"]
    return next(p for p in rows if p.get("pricing"))


# ------------------------------------------------------------------ tenders


def test_health(client):
    r = client.get("/api/health").json()
    assert r["ok"] and r["modules"]["pricing"] and r["modules"]["parser"]


def test_tender_list_and_overview(client, tid):
    rows = client.get("/api/tenders").json()
    me = next(r for r in rows if r["id"] == tid)
    assert me["status"] == "ready" and me["page_count"] > 100
    assert me["open_work"]["lines_to_review"] >= 0 and me["offer_price"] > 0
    d = client.get(f"/api/tenders/{tid}").json()
    keys = [s["key"] for s in d["overview"]["steps"]]
    assert keys == ["review", "instructions", "price", "export", "outcome"]
    assert d["overview"]["totals"]["direct"] > 0
    assert d["overview"]["steps_left"] >= 1


def test_positions_groups_and_review_order(client, tid):
    r = client.get(f"/api/tenders/{tid}/positions", params={"filter": "review"}).json()
    assert r["counts"]["all"] > 100 and r["counts"]["review"] == len(r["positions"])
    directs = [(p.get("pricing") or {}).get("direct") or 0 for p in r["positions"]]
    assert directs == sorted(directs, reverse=True)  # money at risk first
    assert sum(g["count"] for g in r["groups"]) == len(r["positions"])
    allp = client.get(f"/api/tenders/{tid}/positions", params={"filter": "all", "q": "Schalldämpfer"}).json()
    assert allp["positions"] and all("source" in p and "lines" not in p["source"] for p in allp["positions"])


def test_position_detail_and_candidates(client, tid):
    p = _first_priced(client, tid, "calculated")
    d = client.get(f"/api/tenders/{tid}/positions/{p['lv_id']}").json()
    assert d["pricing"]["direct"] > 0 and d["candidates"]
    cur = [c for c in d["candidates"] if c["current"]]
    assert cur and cur[0]["diff"] == 0
    assert "labour" in d["explain_steps"]
    s = client.get(f"/api/tenders/{tid}/positions/{p['lv_id']}/candidates", params={"q": "silencer"}).json()
    assert s["search"] and s["candidates"] and all(c["line_total"] is not None for c in s["candidates"])


def test_page_png_and_text(client, tid):
    r = client.get(f"/api/tenders/{tid}/pages/9.png", params={"scale": 1})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.content[:4] == b"\x89PNG"
    r2 = client.get(f"/api/tenders/{tid}/pages/9.png", params={"scale": 1})  # cached
    assert r2.content == r.content
    t = client.get(f"/api/tenders/{tid}/pages/9/text").json()
    assert t["words"] and t["lines"]


# ------------------------------------------------------------------ edits, confirm, undo


def test_patch_quantity_changes_totals_and_undo(client, tid):
    p = _first_priced(client, tid, "calculated")
    before = _direct(client, tid)
    q = p["pricing"]["quantity"]
    d = client.patch(f"/api/tenders/{tid}/positions/{p['lv_id']}", json={"quantity": q * 2}).json()
    assert d["pricing"]["quantity"] == q * 2
    after = _direct(client, tid)
    assert after > before
    assert d["totals"]["direct"] == after
    entry = d["log"][0]
    assert entry["action"] == "edit" and entry["by"] == "You" and entry["before"] == {"overrides.quantity": None}
    u = client.post(f"/api/tenders/{tid}/assist/undo/{entry['id']}")
    assert u.status_code == 200
    assert _direct(client, tid) == before
    assert client.post(f"/api/tenders/{tid}/assist/undo/{entry['id']}").status_code == 409


def test_confirm_flag_and_undo(client, tid):
    rev = client.get(f"/api/tenders/{tid}/positions", params={"filter": "review"}).json()
    n0 = rev["counts"]["review"]
    lv = rev["positions"][0]["lv_id"]
    d = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"confirm": True}).json()
    assert d["confirmed"]["by"] == "You" and not d["needs_review"]
    assert client.get(f"/api/tenders/{tid}/positions", params={"filter": "review"}).json()["counts"]["review"] == n0 - 1
    log_id = d["log"][0]["id"]
    client.post(f"/api/tenders/{tid}/undo/{log_id}")
    d2 = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d2["confirmed"] is None and d2["needs_review"]
    d3 = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"flag": True}).json()
    assert d3["flagged"] and d3["needs_review"]


def test_change_product_and_reset(client, tid):
    p = _first_priced(client, tid, "calculated")
    d = client.get(f"/api/tenders/{tid}/positions/{p['lv_id']}").json()
    other = next((c for c in d["candidates"] if not c["current"] and c["line_total"] is not None), None)
    if other is None:
        pytest.skip("no alternative candidate")
    d2 = client.patch(f"/api/tenders/{tid}/positions/{p['lv_id']}",
                      json={"product_id": other["product_id"], "variant_reason": "gleichwertig"}).json()
    assert d2["pricing"]["product_id"] == other["product_id"]
    assert d2["pricing"]["direct"] == other["line_total"]
    d3 = client.patch(f"/api/tenders/{tid}/positions/{p['lv_id']}", json={"reset": True}).json()
    assert d3["pricing"]["direct"] == d["pricing"]["direct"]
    assert client.patch(f"/api/tenders/{tid}/positions/{p['lv_id']}", json={"product_id": "NOPE"}).status_code == 400


def test_supplier_quote_on_line(client, tid):
    p = _first_priced(client, tid, "supplier_quote_required")
    d = client.patch(f"/api/tenders/{tid}/positions/{p['lv_id']}",
                     json={"quote_unit_price": 100.0, "quote_source": "Mail 10 Sep"}).json()
    assert d["pricing"]["unit_price_source"] == "supplier_quote" and not d["needs_review"]


# ------------------------------------------------------------------ instructions, pricing


def test_instructions_patch(client, tid):
    r = client.get(f"/api/tenders/{tid}/instructions", params={"filter": "all"}).json()
    assert "counts" in r
    if not r["instructions"]:
        pytest.skip("no instructions extracted")
    iid = r["instructions"][0]["id"]
    d = client.patch(f"/api/tenders/{tid}/instructions/{iid}", json={"state": "confirmed"}).json()
    assert d["state"] == "confirmed" and d["confirmed_by"] == "You"


def test_pricing_put_changes_offer_and_reset(client, tid):
    g = client.get(f"/api/tenders/{tid}/pricing").json()
    assert g["changed_count"] == 0
    std0 = g["totals"]["standard_price"]
    r = client.put(f"/api/tenders/{tid}/pricing", json={"chosen": "Target", "overhead_pct": 12.0}).json()
    assert r["totals"]["offer_price"] and r["totals"]["standard_price"] > std0
    assert r["settings"]["changed_by"]["overhead_pct"]["by"] == "You"
    assert r["changed_count"] == 1
    # factor change recalculates every line
    labour0 = r["totals"]["labour"]
    r2 = client.put(f"/api/tenders/{tid}/pricing", json={"factors": {"site_efficiency": 0.8}}).json()
    assert r2["totals"]["labour"] > labour0
    assert r2["settings"]["factors"]["school_logistics"] == g["settings"]["factors"]["school_logistics"]
    r3 = client.post(f"/api/tenders/{tid}/pricing/reset").json()
    assert r3["changed_count"] == 0 and r3["settings"]["chosen"] == "Target"
    assert r3["totals"]["standard_price"] == std0


def test_pricing_effects_and_reset_one_setting(client, tid):
    g = client.get(f"/api/tenders/{tid}/pricing").json()
    assert g["effects"] == {} and g["default_totals"]["cost"] == g["totals"]["cost"]
    assert g["sources"]["overhead_pct"].startswith("project_parameters.json")
    r = client.put(f"/api/tenders/{tid}/pricing",
                   json={"overhead_pct": 10.0, "factors": {"site_efficiency": 0.8}}).json()
    assert set(r["effects"]) == {"overhead_pct", "factors.site_efficiency"}
    assert all(v > 0 for v in r["effects"].values())
    assert r["default_totals"]["cost"] == g["totals"]["cost"]
    r2 = client.post(f"/api/tenders/{tid}/pricing/reset", json={"keys": ["factors.site_efficiency"]}).json()
    assert r2["changed"] == ["overhead_pct"] and list(r2["effects"]) == ["overhead_pct"]
    assert r2["settings"]["factors"]["site_efficiency"] == g["settings"]["factors"]["site_efficiency"]
    assert r2["settings"]["overhead_pct"] == 10.0
    assert client.post(f"/api/tenders/{tid}/pricing/reset", json={"keys": ["nope"]}).status_code == 400


# ------------------------------------------------------------------ exports, submit, outcome, results


def test_exports(client, tid):
    x = client.get(f"/api/tenders/{tid}/export/xlsx")
    assert x.status_code == 200 and x.content[:2] == b"PK"
    assert x.headers["content-type"].startswith("application/vnd.openxmlformats")
    pdf = client.get(f"/api/tenders/{tid}/export/report.pdf")
    assert pdf.status_code == 200 and pdf.content[:4] == b"%PDF" and pdf.headers["content-type"] == "application/pdf"
    sia = client.get(f"/api/tenders/{tid}/export/sia")
    assert sia.status_code == 200 and len(sia.content) > 100
    ck = client.get(f"/api/tenders/{tid}/export/checklist").json()
    assert ck["open_points"]


def test_submit_outcome_results(client, tid):
    client.put(f"/api/tenders/{tid}/pricing", json={"chosen": "Target"})
    s = client.post(f"/api/tenders/{tid}/submit").json()
    assert s["status"] == "submitted" and s["offer_price_final"]
    t = store.load(tid)
    assert t["submission"]["option"] == "Target" and t["submission"]["calls"]["competition"]["label"] == "Strong"
    o = client.put(f"/api/tenders/{tid}/outcome",
                   json={"result": "lost", "winning_price": 1_000_000, "bidders": 5, "rank": 2}).json()
    assert o["status"] == "awarded"
    res = client.get("/api/results").json()
    row = next(r for r in res["rows"] if r["id"] == tid)
    assert row["winning_price"] == 1_000_000 and row["gap_pct"] is not None
    assert res["needed"] == 3


def test_reference(client):
    r = client.get("/api/reference").json()
    assert r["catalog"] and r["rules"] and r["parameters"]


# ------------------------------------------------------------------ assist


def test_assist_command_plans_without_changing_state(client, tid):
    rev = client.get(f"/api/tenders/{tid}/positions", params={"filter": "review"}).json()
    lv = rev["positions"][0]["lv_id"]
    before = store.load(tid)
    tray = client.get(f"/api/tenders/{tid}/assist").json()
    assert set(tray) >= {"needs_ok", "working_on", "done"}
    r = client.post(f"/api/tenders/{tid}/assist/command",
                    json={"text": "Confirm this line", "scope": "line", "lv_id": lv}).json()
    assert r["kind"] == "plan" and r["plan_id"] and r["plan"][0]["lv_id"] == lv
    assert r["effect"]["direct_before"] == r["effect"]["direct_after"]
    after = store.load(tid)
    assert after["positions"] == before["positions"] and after["log"] == before["log"]
    # applying it confirms the line, logged by Assist, undoable as one batch
    a = client.post(f"/api/tenders/{tid}/assist/plans/{r['plan_id']}/apply").json()
    assert a["applied"] == 1
    d = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d["confirmed"]["by"] == "Assist"
    client.post(f"/api/tenders/{tid}/assist/undo/{a['undo_id']}")
    assert client.get(f"/api/tenders/{tid}/positions/{lv}").json()["confirmed"] is None


def test_assist_quantity_plan_and_explain(client, tid):
    p = _first_priced(client, tid, "calculated")
    before = _direct(client, tid)
    r = client.post(f"/api/tenders/{tid}/assist/command",
                    json={"text": f"Set the quantity of {p['lv_id']} to 99", "scope": "tender"}).json()
    assert r["kind"] == "plan" and r["plan"][0]["action"] == "set_quantity"
    assert r["effect"]["direct_after"] != r["effect"]["direct_before"]
    assert _direct(client, tid) == before  # not applied
    e = client.post(f"/api/tenders/{tid}/assist/command",
                    json={"text": "Why is the labour on this line so high?", "scope": "line", "lv_id": p["lv_id"]}).json()
    assert e["kind"] == "explain" and e["explain"]["steps"]
    x = client.get(f"/api/tenders/{tid}/explain/{p['lv_id']}", params={"field": "hours"}).json()
    assert x["steps"] and x["field"] == "hours"


def test_upload_other_pdf_runs_without_lines(client):
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Ausschreibung Lüftung, Einreichung bis 1. Dezember 2026")
    data = doc.tobytes()
    r = client.post("/api/tenders", files={"file": ("small.pdf", data, "application/pdf")},
                    data={"name": "Small tender", "client": "Gemeinde X"})
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["name"] == "Small tender" and set(s["user_fields"]) == {"name", "client"}
    assert pipeline.wait(s["id"], timeout=120)
    d = client.get(f"/api/tenders/{s['id']}").json()
    assert d["status"] == "ready" and d["name"] == "Small tender" and d["page_count"] == 1
    assert client.get(f"/api/tenders/{s['id']}/positions").json()["positions"] == []
    assert client.post("/api/tenders", files={"file": ("x.pdf", b"nope", "application/pdf")}).status_code == 400
    assert client.delete(f"/api/tenders/{s['id']}").status_code == 200
    assert client.get(f"/api/tenders/{s['id']}").status_code == 404
    assert client.delete(f"/api/tenders/{s['id']}").status_code == 404


def _inject_reply(tid, factors=(0.95, 1.1)):
    """Store a supplier-reply proposal like quotes/read would (without reading a file)."""
    from app import assist

    t = store.load(tid)
    v = pipeline.view(t)
    sq = [p for p in v["positions"] if p["status"] == "supplier_quote_required" and p.get("pricing")][:len(factors)]
    raw = {p["lv_id"]: p for p in t["positions"]}
    items = [assist._quote_item(t, v, raw[p["lv_id"]], round(p["pricing"]["net_unit_cost"] * f, 2), "Supplier reply.pdf p.1")
             for p, f in zip(sq, factors)]
    with store.edit(tid, by=None, touch=False) as t2:
        assist._assist_state(t2)["proposals"].append(
            {"id": "pr_test", "kind": "supplier_reply", "state": "open", "source": "Supplier reply.pdf",
             "received_at": store.now(), "title": f"Fill {len(items)} quotes", "items": items})
    return items


def test_assist_reply_proposal_plan_apply_undo(client, tid):
    items = _inject_reply(tid)
    if len(items) < 2:
        pytest.skip("not enough supplier lines")
    below, above = items
    tray = client.get(f"/api/tenders/{tid}/assist").json()
    assert tray["needs_ok"][0]["id"] == "pr_test" and tray["needs_ok"][0]["count"] == 2
    d = client.get(f"/api/tenders/{tid}/positions/{below['lv_id']}").json()
    assert d["assist"] and d["assist"][0]["unit_price"] == below["unit_price"]
    before = _direct(client, tid)
    r = client.post(f"/api/tenders/{tid}/assist/command",
                    json={"text": "Confirm every line where the quote is at or below budget"}).json()
    assert r["kind"] == "plan"
    acts = {p["lv_id"]: p["action"] for p in r["plan"]}
    assert acts[below["lv_id"]] == "fill_quote" and acts[above["lv_id"]] == "none"
    assert r["effect"]["direct_after"] < r["effect"]["direct_before"] == before
    assert _direct(client, tid) == before
    a = client.post(f"/api/tenders/{tid}/assist/plans/{r['plan_id']}/apply").json()
    assert a["applied"] == 2  # fill + confirm
    d = client.get(f"/api/tenders/{tid}/positions/{below['lv_id']}").json()
    assert d["supplier_quote"]["by"] == "Assist" and d["confirmed"]["by"] == "Assist"
    assert client.post(f"/api/tenders/{tid}/assist/plans/{r['plan_id']}/apply").status_code == 409
    done = client.get(f"/api/tenders/{tid}/assist").json()["done"]
    assert done[0]["undoable"]
    client.post(f"/api/tenders/{tid}/assist/undo/{done[0]['id']}")
    d = client.get(f"/api/tenders/{tid}/positions/{below['lv_id']}").json()
    assert d["supplier_quote"] is None and d["confirmed"] is None
    assert _direct(client, tid) == before


def test_quotes_apply_endpoint(client, tid):
    items = _inject_reply(tid, factors=(0.9,))
    if not items:
        pytest.skip("no supplier lines")
    r = client.post(f"/api/tenders/{tid}/quotes/apply",
                    json={"proposals": [{"lv_id": items[0]["lv_id"], "unit_price": items[0]["unit_price"],
                                         "source": "Supplier reply.pdf"}], "proposal_id": "pr_test"}).json()
    assert r["applied"] == 1 and r["lines"][0]["needs_review"] is False
    assert client.get(f"/api/tenders/{tid}/assist").json()["needs_ok"] == [] or all(
        p["id"] != "pr_test" for p in client.get(f"/api/tenders/{tid}/assist").json()["needs_ok"])
    q = client.get(f"/api/tenders/{tid}/quotes").json()
    assert "groups" in q


def test_quotes_read_demo_reply(client, tid, tmp_path):
    quotes = pipeline.mod("quotes")
    if quotes is None or not hasattr(quotes, "make_demo_replies"):
        pytest.skip("quotes.py has no demo replies")
    pdf = quotes.make_demo_replies(tmp_path)[0]
    before = store.load(tid)["positions"]
    r = client.post(f"/api/tenders/{tid}/quotes/read",
                    files={"file": (pdf.name, pdf.read_bytes(), "application/pdf")}).json()
    assert store.load(tid)["positions"] == before  # proposals only
    if not r["proposals"]:
        pytest.skip("reply did not map to this tender's lines")
    assert r["proposal_id"] and all(p["budget"] is not None and p["delta"] is not None for p in r["proposals"])
    tray = client.get(f"/api/tenders/{tid}/assist").json()
    assert any(p["id"] == r["proposal_id"] for p in tray["needs_ok"])
    a = client.post(f"/api/tenders/{tid}/assist/proposals/{r['proposal_id']}/apply").json()
    assert a["applied"] == len(r["proposals"])
