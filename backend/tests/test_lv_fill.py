"""Filled tender (the original LV PDF with our prices): numbers are read back out of the PDF."""
from __future__ import annotations

import json
import shutil

import pymupdf
import pytest
from fastapi.testclient import TestClient

from app import config, lv_fill, pipeline, store
from app import pricing as P
from app import verification
from app.main import app

pytestmark = pytest.mark.skipif(not config.DEMO_PDF.exists(), reason="demo PDF missing")


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    old = config.TENDERS_DIR
    config.TENDERS_DIR = tmp_path_factory.mktemp("tenders_lv")
    yield TestClient(app)
    config.TENDERS_DIR = old


@pytest.fixture(scope="module")
def base_id(client):
    tid = client.post("/api/tenders/demo").json()["id"]
    assert pipeline.wait(tid, timeout=600)
    client.put(f"/api/tenders/{tid}/pricing", json={"chosen": "Target"})
    return tid


@pytest.fixture
def tid(base_id):
    new = store.new_id()
    shutil.copytree(config.TENDERS_DIR / base_id, config.TENDERS_DIR / new)
    p = config.TENDERS_DIR / new / "state.json"
    s = json.loads(p.read_text("utf-8"))
    s["id"] = new
    p.write_text(json.dumps(s, ensure_ascii=False), "utf-8")
    return new


def _qty_line(p: dict) -> tuple[int, list]:
    place = lv_fill._qty_place(p)
    assert place, p["lv_id"]
    return place


def _written(doc, page: int, bbox, x0: float, x1: float) -> str:
    """Text written in a column on the line of `bbox` (page numbers of the original tender)."""
    clip = pymupdf.Rect(x0, bbox[1] - 1, x1, bbox[3] + 1)
    return " ".join(w[4] for w in doc[page - 1 + 1].get_text("words", clip=clip))  # +1: cover page


def test_filled_lv_writes_every_priced_line(client, tid):
    r = client.get(f"/api/tenders/{tid}/export/lv-filled.pdf")
    assert r.status_code == 200 and r.content[:4] == b"%PDF" and r.headers["content-type"] == "application/pdf"
    assert "attachment" in r.headers["content-disposition"]
    doc = pymupdf.open("pdf", r.content)
    orig = pymupdf.open(str(store.pdf_path(tid)))
    summary = client.get(f"/api/tenders/{tid}/export/lv-filled/summary").json()
    assert doc.page_count == orig.page_count + summary["cover_pages"] == summary["page_count"]

    t = store.load(tid)
    totals = pipeline.view(t)["totals"]
    prices = lv_fill.selling_prices(t, totals)
    positions = prices["positions"]
    priced = [p for p in positions if p.get("kind") != "subtotal" and P.included(p["status"], p["pricing"])
              and P.effective_quantity(p)]
    assert summary["filled"] == len(priced) == len(prices["lines"]) > 20
    # the LV adds up to the offer price (up to rounding unit prices to the cent)
    assert summary["offer"] == totals["offer_price"]
    assert abs(summary["lv_sum"] - summary["offer"]) < 0.01 * len(priced) * 50
    assert summary["lv_sum"] == pytest.approx(sum(v["amount"] for v in prices["lines"].values()), abs=0.005)

    for p in priced:
        page, bbox = _qty_line(p)
        cols = lv_fill._columns(orig[page - 1])
        v = prices["lines"][p["lv_id"]]
        assert _written(doc, page, bbox, *cols["amount"]) == lv_fill.chf(v["amount"]), p["lv_id"]
        assert _written(doc, page, bbox, *cols["price"]) == lv_fill.chf(v["unit_price"]), p["lv_id"]
        # amount = quantity x unit price, unit price = direct x k / quantity
        assert v["amount"] == round(P.effective_quantity(p) * v["unit_price"], 2)
        assert v["unit_price"] == round(p["pricing"]["direct"] * prices["k"] / P.effective_quantity(p), 2)

    # lines without a price carry a marker instead of a number
    open_lines = [p for p in positions if p["lv_id"] not in prices["lines"] and lv_fill._marker(p)]
    assert sum(summary["open_by_marker"].values()) == summary["open"] == len(open_lines)
    for p in open_lines[:25]:
        page, bbox = _qty_line(p)
        cols = lv_fill._columns(orig[page - 1])
        assert _written(doc, page, bbox, *cols["amount"]) == lv_fill._marker(p), p["lv_id"]

    # the summary pages in front of the LV carry the LV sum
    front = " ".join(doc[n - 1].get_text() for n in summary["front_pages"])
    assert lv_fill.chf(summary["lv_sum"]) in front
    assert "Filled tender (LV)" in doc[0].get_text() and t["id"] in doc[0].get_text()
    assert store.load(tid)["exported"].get("lv_filled")


def test_golden_lines_carry_the_computed_selling_price(client, tid):
    """The verified example lines (LV0001-type): the number in the PDF is our computed one."""
    t = store.load(tid)
    ver = verification.verify(t)
    if not ver["loaded"]:
        pytest.skip("no benchmark loaded")
    pdf = client.get(f"/api/tenders/{tid}/export/lv-filled.pdf", params={"inline": 1})
    assert "inline" in pdf.headers["content-disposition"]
    assert not (store.load(tid).get("exported") or {}).get("lv_filled")  # the preview is not an export
    doc = pymupdf.open("pdf", pdf.content)
    orig = pymupdf.open(str(store.pdf_path(tid)))
    totals = pipeline.view(t)["totals"]
    k = totals["offer_price"] / totals["direct"]
    by_id = {p["lv_id"]: p for p in P.evaluate_positions(t["positions"], t["pricing"], t["systems"], t.get("profile") or "school")}
    checked = 0
    for row in ver["rows"]:
        p = by_id.get(row["our_lv_id"])
        if not p or not P.included(p["status"], p["pricing"]):
            continue
        q = P.effective_quantity(p)
        unit = round(p["pricing"]["direct"] * k / q, 2)
        page, bbox = _qty_line(p)
        cols = lv_fill._columns(orig[page - 1])
        assert _written(doc, page, bbox, *cols["price"]) == lv_fill.chf(unit), p["lv_id"]
        assert _written(doc, page, bbox, *cols["amount"]) == lv_fill.chf(round(q * unit, 2)), p["lv_id"]
        checked += 1
    assert checked >= 15


def test_estimator_override_reaches_the_filled_lv(client, tid):
    t = store.load(tid)
    totals = pipeline.view(t)["totals"]
    before = lv_fill.selling_prices(t, totals)
    lv = next(iter(before["lines"]))
    r = client.patch(f"/api/tenders/{tid}/positions/{lv}", json={"unit_price": 12345.0})
    assert r.status_code == 200
    s1 = client.get(f"/api/tenders/{tid}/export/lv-filled/summary").json()
    t = store.load(tid)
    after = lv_fill.selling_prices(t, pipeline.view(t)["totals"])
    assert after["lines"][lv]["unit_price"] != before["lines"][lv]["unit_price"]
    assert s1["lv_sum"] == after["sum"]
    png = client.get(f"/api/tenders/{tid}/export/lv-filled/pages/{s1['preview_pages'][1]}.png", params={"scale": 0.5})
    assert png.status_code == 200 and png.content[:4] == b"\x89PNG"
    assert client.get(f"/api/tenders/{tid}/export/lv-filled/pages/999.png").status_code == 404


def test_group_totals():
    """'Total "C"' sums the section, 'Total 244.xx' the system, other totals the lines since
    the previous total; 'Total aller X' starts at the first line about X."""
    sy = "244.01 LA01 Test"

    def pos(lv, sec, text, kind="item"):
        return {"lv_id": lv, "system": sy, "section": sec, "text_de": text, "title_de": text, "kind": kind,
                "status": "non_priceable" if kind == "subtotal" else "calculated"}

    ps = [pos("L1", "B", "Kanal"), pos("S1", "B", 'Zwischentotal "Kanäle"', "subtotal"),
          pos("L2", "C", "Gitter"), pos("L3", "C", "Volumenstromregler eckig"), pos("L4", "C", "TVR-D 12.5"),
          pos("S2", "C", "Total aller Einkanal-Volumenstromregler", "subtotal"),
          pos("S3", "C", 'Total Armaturen und Instrumente "C"', "subtotal"),
          pos("S4", "C", "Total 244.01 LA01 Test", "subtotal")]
    lines = {"L1": 10.0, "L2": 1.0, "L3": 100.0, "L4": 1000.0}
    g = lv_fill._group_values(ps, {"lines": {k: {"amount": v} for k, v in lines.items()}})
    assert g["S1"]["amount"] == 10.0 and g["S1"]["scope"] == "group"
    assert g["S2"]["amount"] == 1100.0
    assert g["S3"]["amount"] == 1101.0 and g["S3"]["scope"] == "section"
    assert g["S4"]["amount"] == 1111.0 and g["S4"]["scope"] == "system"
