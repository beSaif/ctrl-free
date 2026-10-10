"""Supplier / negotiated price lists: reading, matching, precedence, re-pricing and the API."""
from __future__ import annotations

import json

import pytest

from app import config, price_lists as PL, pricing as P, reference as R
from tests.test_pricing import example_positions, example_systems


@pytest.fixture
def lists_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PRICE_LISTS_DIR", tmp_path / "price_lists")
    return tmp_path / "price_lists"


def _csv(rows: list[str]) -> bytes:
    return ("\n".join(rows) + "\n").encode("utf-8")


def _direct(positions) -> float:
    return P.project_totals(positions, R.default_settings(), example_systems(positions))["direct"]


# ---------------------------------------------------------------- reading

def test_numbers_as_suppliers_write_them():
    assert PL._num("1'234.50") == 1234.5
    assert PL._num("1.234,50") == 1234.5
    assert PL._num("74,80") == 74.8
    assert PL._num("CHF 74.80") == 74.8
    assert PL._num("12 %") == 12
    assert PL._num("") is None and PL._num("–") is None


def test_german_headers_are_mapped_and_rows_matched():
    data, name = PL.demo_file("supplier_pricelist_demovent_2026.xlsx")
    p = PL.preview(data, name)
    m = p["mapping"]
    assert (m["article_no"], m["manufacturer"], m["model"], m["net_price"], m["list_price"], m["discount_pct"]) == \
        ("Artikel-Nr.", "Hersteller", "Typ", "Netto CHF", "Bruttopreis CHF", "Rabatt %")
    assert p["missing"] == []
    assert p["meta"]["kind"] == "supplier" and p["meta"]["supplier"] == "DemoVent AG"
    assert p["meta"]["valid_from"] == "2026-02-01"   # from "gültig ab 01.02.2026" above the header row
    by_model = {r["model"]: r for r in p["rows"]}
    assert by_model["DV-Z-100"]["matched_product_id"] == "P-AIR-001"
    assert by_model["DV-Z-100"]["match_by"] == "manufacturer+model"
    assert by_model["DV-Z-160"]["problem"] == "Not in the catalogue"
    assert by_model["SP-125"]["problem"].startswith("Unit differs")   # Stk in the list, m in the catalogue
    assert p["counts"]["matched"] == 9 and p["counts"]["unmatched"] == 3


def test_english_list_by_product_id():
    data, name = PL.demo_file("equans_negotiated_prices_2026.csv")
    p = PL.preview(data, name)
    assert p["meta"]["kind"] == "negotiated" and p["meta"]["name"] == "Equans negotiated prices 2026"
    assert p["counts"]["rows"] == 15 and p["counts"]["matched"] == 14
    assert [r["product_id"] for r in p["rows"] if r.get("problem")] == ["P-GRL-001"]


def test_net_from_list_price_and_discount_and_custom_mapping():
    data = _csv(["Code;Hersteller;Typ;Liste;Rabatt", "x1;DemoVent;DV-Z-100;100,00;20"])
    p = PL.preview(data, "list.csv", mapping={"model": "Typ", "manufacturer": "Hersteller", "list_price": "Liste",
                                              "discount_pct": "Rabatt", "article_no": "Code"})
    r = p["rows"][0]
    assert r["net_price"] == 80.0 and r["matched_product_id"] == "P-AIR-001" and r["article_no"] == "x1"


# ---------------------------------------------------------------- precedence

def _create(rows, name, kind="supplier", valid_from="2026-01-01", **kw):
    return PL.create(_csv(["product_id,net_price"] + rows), f"{name}.csv", None,
                     {"name": name, "kind": kind, "valid_from": valid_from, "supplier": "Demo"}, **kw)


def test_golden_unchanged_without_lists(lists_dir):
    pos = example_positions()
    base = _direct(pos)
    assert base == pytest.approx(372700.12, abs=0.005)
    lst = _create(["P-AIR-001,70"], "Inactive", activate=False)
    assert _direct(pos) == base
    PL.delete(lst["id"])
    assert _direct(pos) == base


def test_list_price_used_with_its_source_and_old_price(lists_dir):
    pos = [p for p in example_positions() if p["match"]["product_id"] == "P-AIR-001"][:1]
    assert pos, "example data has a P-AIR-001 line"
    before = P.price_position(pos[0], R.default_settings())
    _create(["P-AIR-001,70.00"], "Equans negotiated prices 2026", kind="negotiated")
    pr = P.price_position(pos[0], R.default_settings())
    assert pr["net_unit_cost"] == 70.0 and before["net_unit_cost"] == 74.8
    assert pr["unit_price_source"] == "catalog"            # still a catalogue item for allowances
    assert pr["price_list"]["name"] == "Equans negotiated prices 2026"
    assert pr["catalog_unit_cost"] == 74.8
    assert pr["sources"]["unit_price"].startswith("Equans negotiated prices 2026 (valid from 1 Jan 2026), row 2")
    step = P.explain_field(pos[0], pr, "material")[0]["text"]
    assert "Equans negotiated prices 2026" in step and "catalogue CHF 74.80" in step
    row = R.catalog_row("P-AIR-001")
    assert row["price_list_date"] == "2026-01-01" and row["supplier"] == "Demo"
    # an estimator's unit price and a supplier quote still win over any list
    p2 = dict(pos[0], overrides={"unit_price": 60.0})
    assert P.price_position(p2, R.default_settings())["net_unit_cost"] == 60.0
    p3 = dict(pos[0], supplier_quote={"unit_price": 65.0, "source": "Reply"})
    assert P.price_position(p3, R.default_settings())["net_unit_cost"] == 65.0


def test_negotiated_beats_supplier_and_order_is_configurable(lists_dir):
    sup = _create(["P-AIR-001,72"], "Supplier list", valid_from="2026-03-01")
    neg = _create(["P-AIR-001,70"], "Negotiated", kind="negotiated", valid_from="2026-01-01")
    assert [m["id"] for m in PL.registry()] == [neg["id"], sup["id"]]   # default: negotiated first
    assert R.catalog_row("P-AIR-001")["net_cost_chf"] == 70
    PL.reorder([sup["id"], neg["id"]])
    assert R.catalog_row("P-AIR-001")["net_cost_chf"] == 72
    PL.reorder(["default"])
    assert R.catalog_row("P-AIR-001")["net_cost_chf"] == 70
    PL.update(neg["id"], {"active": False})
    assert R.catalog_row("P-AIR-001")["net_cost_chf"] == 72
    PL.update(sup["id"], {"valid_from": "2099-01-01"})           # not valid yet -> catalogue
    assert R.catalog_row("P-AIR-001")["net_cost_chf"] == 74.8
    assert "price_list" not in R.catalog_row("P-AIR-001")


def test_newer_supplier_list_first_by_default(lists_dir):
    old = _create(["P-AIR-001,73"], "Old", valid_from="2025-01-01")
    new = _create(["P-AIR-001,71"], "New", valid_from="2026-01-01")
    assert [m["id"] for m in PL.registry()] == [new["id"], old["id"]]
    assert R.catalog_row("P-AIR-001")["net_cost_chf"] == 71


def test_bad_meta_is_refused(lists_dir):
    with pytest.raises(ValueError):
        _create(["P-AIR-001,70"], "X", kind="other")
    with pytest.raises(ValueError):
        PL.create(_csv(["foo,bar", "1,2"]), "x.csv", None, {"name": "X", "kind": "supplier"})
    assert PL.registry() == []


# ---------------------------------------------------------------- API

pytest.importorskip("fastapi")
from tests.test_api import base_id, client, tenders_dir, tid  # noqa: E402,F401  (fixtures)


@pytest.mark.skipif(not config.DEMO_PDF.exists(), reason="demo PDF missing")
def test_api_activate_reprices_logs_and_reverts(client, tid, lists_dir):
    direct0 = client.get(f"/api/tenders/{tid}/pricing").json()["totals"]["direct"]
    r = client.post("/api/reference/price-lists/preview", data={"demo": "equans_negotiated_prices_2026.csv"})
    assert r.status_code == 200, r.text
    prev = r.json()
    eff = next(e for e in prev["effect"] if e["tender_id"] == tid)
    assert eff["direct_delta"] < 0 and eff["lines_changed"] > 0

    r = client.post("/api/reference/price-lists", data={"demo": "equans_negotiated_prices_2026.csv",
                                                        "meta": json.dumps(prev["meta"])})
    assert r.status_code == 200, r.text
    lid = r.json()["list"]["id"]
    direct1 = client.get(f"/api/tenders/{tid}/pricing").json()["totals"]["direct"]
    assert direct1 == pytest.approx(direct0 + eff["direct_delta"], abs=0.01)

    log = client.get(f"/api/tenders/{tid}/log").json()["log"]
    moved = [e for e in log if e["action"] == "price_list" and e.get("lv_id")]
    assert len(moved) == eff["lines_changed"]
    assert all(e["before"]["unit_price"] != e["after"]["unit_price"] for e in moved)
    lv = moved[0]["lv_id"]
    d = client.get(f"/api/tenders/{tid}/positions/{lv}").json()
    assert d["product"]["price_list"] == "Equans negotiated prices 2026"
    assert d["product"]["price_list_date"] == "2026-01-01"
    assert d["pricing"]["sources"]["unit_price"].startswith("Equans negotiated prices 2026 (valid from 1 Jan 2026)")

    det = client.get(f"/api/reference/price-lists/{lid}").json()
    assert det["counts"]["matched"] == 14 and det["counts"]["changes"] == 14
    assert any(x["problem"] == "Not in the catalogue" for x in det["rows_detail"])

    r = client.patch(f"/api/reference/price-lists/{lid}", json={"active": False})
    assert r.status_code == 200 and r.json()["state"] == "inactive"
    assert client.get(f"/api/tenders/{tid}/pricing").json()["totals"]["direct"] == pytest.approx(direct0, abs=0.01)
    assert client.delete(f"/api/reference/price-lists/{lid}").status_code == 200
    assert client.get(f"/api/reference/price-lists/{lid}").status_code == 404


@pytest.mark.skipif(not config.DEMO_PDF.exists(), reason="demo PDF missing")
def test_repricing_is_one_review_item_not_one_per_line(client, tid, lists_dir):
    """Switching a price list on is one decision for the senior: the re-priced lines are listed with their
    CHF effect for traceability, but only the tender-level entry waits for review."""
    before = client.get(f"/api/tenders/{tid}/changes").json()["summary"]["to_review"]
    prev = client.post("/api/reference/price-lists/preview", data={"demo": "equans_negotiated_prices_2026.csv"}).json()
    eff = next(e for e in prev["effect"] if e["tender_id"] == tid)
    r = client.post("/api/reference/price-lists", data={"demo": "equans_negotiated_prices_2026.csv",
                                                        "meta": json.dumps(prev["meta"])})
    assert r.status_code == 200, r.text
    ch = client.get(f"/api/tenders/{tid}/changes").json()
    newest = next(e for e in ch["entries"] if e["action"] == "price_list")  # entries are newest first
    pl = [e for e in ch["entries"] if e["action"] == "price_list" and e["batch"] == newest["batch"]]
    lines = [e for e in pl if e["target"]["kind"] == "position"]
    tender = [e for e in pl if e["target"]["kind"] == "tender"]
    assert len(lines) == eff["lines_changed"] and len(tender) == 1
    assert all(e["state"] == "auto" and e["state_why"] == "price_list" for e in lines)
    assert all(e["impact"]["basis"] == "line" and e["impact"]["value"] != 0 for e in lines)
    assert sum(e["impact"]["value"] for e in lines) == pytest.approx(eff["direct_delta"], abs=0.05)
    assert tender[0]["state"] == "to_review"
    assert tender[0]["impact"] == {"value": pytest.approx(eff["direct_delta"], abs=0.01), "basis": "direct"}
    assert ch["summary"]["to_review"] == before + 1

    # the verified examples use catalogue prices: the ones the list re-prices are named as such
    ver = client.get(f"/api/tenders/{tid}/verification").json()["summary"]
    assert ver["price_list_rows"] > 0 and ver["direct_ok"] + ver["price_list_rows"] == ver["total"]

    # the offer workbook writes the list's price and names the list as the price source
    import io

    import openpyxl
    lv = lines[0]["lv_id"]
    new_price = next(f["after"] for f in lines[0]["fields"] if f["path"] == "unit_price")
    wb = openpyxl.load_workbook(io.BytesIO(client.get(f"/api/tenders/{tid}/export/xlsx").content))
    row = next(r for r in wb["Offer"].iter_rows(values_only=True) if r and r[0] == lv)
    assert new_price in row and "price_list" in row
