"""Regression tests for the final correctness review (one per backend fix)."""
from __future__ import annotations

from app import assist, pipeline, store
from app import pricing as P
from tests.test_api import _first_priced, base_id, client, pytestmark, tenders_dir, tid  # noqa: F401  (fixtures)


def test_line_total_is_material_plus_labour_and_totals_add_up(client, tid):
    """The line total shown is the sum of the shown (rounded) parts, and the footer is the sum of line totals."""
    v = pipeline.view(store.load(tid))
    priced = [p for p in v["positions"] if P.included(p["status"], p["pricing"])]
    for p in priced:
        pr = p["pricing"]
        assert round(pr["material"] + pr["labour"], 2) == pr["direct"], p["lv_id"]
    assert round(sum(p["pricing"]["direct"] for p in priced), 2) == v["totals"]["direct"]
    # before the fix 4 demo lines (e.g. LV0137: 1683.97 + 1314.82 shown as 2998.78) did not add up


def test_quote_undo_points_at_the_quote_not_a_later_edit(client, tid):
    p = _first_priced(client, tid, "supplier_quote_required")
    lv = p["lv_id"]
    d = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"quote_unit_price": 100.0}).json()
    quote_entry = d["supplier_quote"]["log_id"]
    d2 = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"quantity": (p["pricing"]["quantity"] or 1) + 1}).json()
    assert d2["supplier_quote"]["log_id"] == quote_entry  # not the quantity edit
    client.post(f"/api/tenders/{tid}/undo/{quote_entry}")
    d3 = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d3["supplier_quote"] is None and d3["overrides"]["quantity"] == (p["pricing"]["quantity"] or 1) + 1


def test_nan_and_infinity_are_rejected(client, tid):
    lv = _first_priced(client, tid)["lv_id"]
    h = {"content-type": "application/json"}
    r = client.patch(f"/api/tenders/{tid}/positions/{lv}", content='{"quantity": NaN}', headers=h)
    assert r.status_code in (400, 422)
    r = client.post(f"/api/tenders/{tid}/quotes/apply", headers=h,
                    content='{"proposals": [{"lv_id": "%s", "unit_price": Infinity}]}' % lv)
    assert r.status_code in (400, 422)
    r = client.put(f"/api/tenders/{tid}/pricing", content='{"overhead_pct": Infinity}', headers=h)
    assert r.status_code in (400, 422)
    assert client.get(f"/api/tenders/{tid}").status_code == 200
    assert client.get(f"/api/tenders/{tid}/positions/{lv}").status_code == 200


def test_pricing_values_that_break_the_arithmetic_are_rejected(client, tid):
    for body in ({"factors": {"site_efficiency": 0}}, {"margins": {"Target": 100}}, {"round_to": 0},
                 {"overhead_pct": -5}):
        assert client.put(f"/api/tenders/{tid}/pricing", json=body).status_code == 400, body
    assert client.get(f"/api/tenders/{tid}/pricing").status_code == 200
    assert client.get(f"/api/tenders/{tid}/positions").status_code == 200


def test_damaged_reply_pdf_is_a_clear_400(client, tid):
    r = client.post(f"/api/tenders/{tid}/quotes/read",
                    files={"file": ("reply.pdf", b"%PDF-1.4 not really a pdf", "application/pdf")})
    assert r.status_code == 400 and "damaged" in r.json()["detail"]


def test_pasted_reply_text_is_never_read_as_a_file_path(client, tid, monkeypatch, tmp_path):
    seen = []
    real = assist.read_supplier_reply

    def spy(t, data, filename):
        seen.append(data)
        return real(t, data, filename)

    monkeypatch.setattr(assist, "read_supplier_reply", spy)
    secret = tmp_path / "secret.txt"
    secret.write_text("Pos 1 Schalldämpfer 4 Stk CHF 5'150.00", "utf-8")
    r = client.post(f"/api/tenders/{tid}/quotes/read", data={"text": str(secret)})
    assert r.status_code == 200 and r.json()["proposals"] == []
    assert seen and isinstance(seen[0], bytes)
