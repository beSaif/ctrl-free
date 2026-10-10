"""Parser tests against the Oberglatt starter tender (skipped when the PDF is not present).

Run: cd backend && uv run pytest tests/test_parser.py -q
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.config import DEMO_PDF  # noqa: E402
from app.parser import parse_tender  # noqa: E402
from app.units import normalize_unit, parse_number  # noqa: E402

pytestmark = pytest.mark.skipif(not DEMO_PDF.exists(), reason="starter-package tender PDF not present")


@pytest.fixture(scope="module")
def parsed():
    t0 = time.perf_counter()
    calls = []
    res = parse_tender(DEMO_PDF, progress=lambda i, n: calls.append((i, n)))
    res["_elapsed"] = time.perf_counter() - t0
    res["_progress"] = calls
    return res


def _find(positions, page, qty, unit="pc"):
    return [p for p in positions if p["page"] == page and p["quantity"] == qty and p["unit"] == unit]


# ----------------------------------------------------------------------------- units

def test_units_and_numbers():
    assert parse_number("1'200") == 1200
    assert parse_number("2`900") == 2900
    assert parse_number("12.5") == 12.5
    assert parse_number("12,5") == 12.5
    assert parse_number("abc") is None
    assert normalize_unit("Stk.") == "pc"
    assert normalize_unit("Stück") == "pc"
    assert normalize_unit("m²") == "m2"
    assert normalize_unit("lfm") == "m"
    assert normalize_unit("Std.") == "h"
    assert normalize_unit("psch") == "LS"
    assert normalize_unit("Anlage") == "system"
    assert normalize_unit("RTU") is None


# ----------------------------------------------------------------------------- document level

def test_speed_and_progress(parsed):
    assert parsed["_elapsed"] < 5.0
    assert parsed["page_count"] == 202
    assert parsed["_progress"][-1] == (202, 202)
    assert set(parsed["pages_text"]) == set(range(1, 203))


def test_conditions_and_engineer_pages(parsed):
    assert parsed["conditions_pages"] == list(range(1, 67))
    eng = set(parsed["engineer_list_pages"])
    assert {75, 76, 182, 183} <= eng
    # engineer lists (quantities at line start) never become positions
    assert not [p for p in parsed["positions"] if p["page"] in eng]


def test_systems(parsed):
    systems = {s["key"]: s for s in parsed["systems"]}
    assert list(systems) == ["LA01", "LA02", "LA03", "LA04", "LA05", "244.06"]
    assert systems["LA01"]["label"] == "244.01 LA01 Nebenräume UG"
    assert systems["LA04"]["label"] == "244.04 LA04 Schulzimmer OG"     # key only in the footer
    assert systems["LA05"]["profile"] == "sports_hall"
    assert systems["LA05"]["lot"] == 2
    assert systems["LA01"]["lot"] == 1
    assert all(s["profile"] == "school" for k, s in systems.items() if k != "LA05")
    # pp. 181-195 carry a copied "244.03 LA03" page header but belong to the Turnhalle
    assert systems["LA05"]["pages"] == [174, 195]
    assert systems["244.06"]["pages"][0] == 196
    for p in parsed["positions"]:
        if 181 <= p["page"] <= 195:
            assert p["system_key"] == "LA05"


# ----------------------------------------------------------------------------- recall on the 22 examples

def test_recall_22_examples(parsed):
    from scripts.eval_parser import match_examples
    results = match_examples(parsed["positions"])
    misses = [r["lv_id"] for r, hit, _ in results if hit is None]
    assert not misses, f"missed examples: {misses}"
    assert len(results) == 22


def test_all_quantity_lines_found(parsed):
    items = [p for p in parsed["positions"] if p["kind"] in ("item", "lump_sum")]
    with_qty = [p for p in items if p["quantity"] is not None]
    assert len(with_qty) >= 240
    assert len(items) - len(with_qty) <= 10


# ----------------------------------------------------------------------------- golden position LV0001 (p. 78)

def test_supply_valve_block(parsed):
    (p,) = _find(parsed["positions"], 78, 5.0)
    assert p["title_de"].startswith("Zuluft-Tellerventil aus Kunststoff")
    assert p["title_de"].endswith("Ø 10 cm")
    assert p["variant_de"] == "Ø 10 cm"
    assert p["unit_raw"] == "Stk" and p["kind"] == "item"
    assert p["system"] == "244.01 LA01 Nebenräume UG" and p["system_key"] == "LA01"
    assert p["section"] == "C" and p["section_name"] == "Armaturen und Instrumente"
    assert p["make_hint"] == "Trox Hesco" and p["model_hint"] == "Z-LVS"
    assert p["attributes"]["dn_mm"] == 100
    assert p["attributes"]["material"] == "plastic"
    assert p["text_de"].splitlines()[0] == "Zuluft - Tellerventil"
    roles = [ln["role"] for ln in p["source"]["lines"]]
    assert roles.count("qty") == 1 and roles.count("other_qty") == 1
    # the sibling size shares the block text
    (p2,) = _find(parsed["positions"], 78, 6.0)
    assert p2["attributes"]["dn_mm"] == 125 and p2["variant_de"] == "Ø 12.5 cm"
    assert p2["source"]["block_bbox"] == p["source"]["block_bbox"]
    assert int(p2["lv_id"][2:]) == int(p["lv_id"][2:]) + 1


def test_examples_attributes(parsed):
    pos = parsed["positions"]
    (fire,) = _find(pos, 79, 4.0)[:1]
    assert fire["attributes"]["fire_class"] == "EI90-S" and fire["attributes"]["dn_mm"] == 100
    sil = [p for p in _find(pos, 80, 4.0) if p["attributes"].get("dims_mm")]
    assert sil and sil[0]["attributes"]["dims_mm"] == [400, 300, 1250]
    vav = _find(pos, 164, 10.0)[0]
    assert vav["attributes"]["dn_mm"] == 125 and vav["model_hint"] == "TVR-D"
    ins = _find(pos, 169, 52.0, "m2")[0]
    assert ins["attributes"]["thickness_mm"] == 30
    seal = _find(pos, 170, 4.0)[0]
    assert seal["attributes"]["dims_mm"] == [300, 200] and seal["attributes"]["fire_class"] == "EI30"


def test_offer_reference_and_null_quantity(parsed):
    pos = parsed["positions"]
    assert any(p["page"] == 78 and p["offer_ref"] == "P241783" for p in pos)
    # unit printed but quantity column empty -> quantity None (insufficient information later)
    assert any(p["page"] == 169 and p["unit"] == "m2" and p["quantity"] is None for p in pos)
    # air handling unit heading (Turnhalle writes "Stk" without quantity)
    ahu = [p for p in pos if p["system_key"] == "LA05" and p["attributes"].get("device")]
    assert ahu and ahu[0]["offer_ref"] and ahu[0]["quantity"] is None


def test_subtotals(parsed):
    subs = [p for p in parsed["positions"] if p["kind"] == "subtotal"]
    assert any(p["title_de"] == 'Total Kanäle "B"' for p in subs)
    assert all(p["quantity"] is None and p["unit"] is None for p in subs)
    assert all(p["lv_id"].startswith("ST") for p in subs)


def test_pdf_order(parsed):
    """Every row carries its index in the LV stream: unique, and it follows pages and systems as printed."""
    pos = parsed["positions"]
    order = [p["pdf_order"] for p in pos]
    assert all(isinstance(o, int) and o >= 0 for o in order)
    assert len(set(order)) == len(order)
    printed = sorted(pos, key=lambda p: p["pdf_order"])
    pages = [p["page"] for p in printed]
    assert pages == sorted(pages)
    # a system's rows are one run in printed order, in the order the systems are listed
    runs = [s for i, s in enumerate(p["system"] for p in printed) if i == 0 or printed[i - 1]["system"] != s]
    assert runs == [s["label"] for s in parsed["systems"] if s["label"] in runs]
    assert len(runs) == len(set(runs))
    # the section subtotal ("Total Kanäle B") closes its section: it comes after the section's lines
    sub = next(p for p in pos if p["title_de"] == 'Total Kanäle "B"')
    same = [p for p in pos if p["system"] == sub["system"] and p["section"] == sub["section"] and p["kind"] != "subtotal"]
    assert same and all(p["pdf_order"] < sub["pdf_order"] for p in same)


# ----------------------------------------------------------------------------- schema / geometry

def test_position_schema_and_geometry(parsed):
    pos = parsed["positions"]
    lv_ids = [p["lv_id"] for p in pos if p["kind"] != "subtotal"]
    st_ids = [p["lv_id"] for p in pos if p["kind"] == "subtotal"]
    assert lv_ids == [f"LV{i:04d}" for i in range(1, len(lv_ids) + 1)]
    assert st_ids == [f"ST{i:03d}" for i in range(1, len(st_ids) + 1)]
    # component links point at existing LV rows
    lv_set = set(lv_ids)
    for p in pos:
        assert p.get("parent_lv_id") is None or p["parent_lv_id"] in lv_set
    keys = {"lv_id", "system", "system_key", "section", "section_name", "page", "text_de", "title_de",
            "variant_de", "quantity", "unit", "unit_raw", "kind", "make_hint", "model_hint", "offer_ref",
            "attributes", "source"}
    allowed_units = {"pc", "m", "m2", "m3", "kg", "h", "LS", "system", "day", None}
    for p in pos:
        assert keys <= set(p), p["lv_id"]
        assert p["kind"] in {"item", "lump_sum", "text_only", "subtotal"}
        assert p["unit"] in allowed_units
        assert p["title_de"]
        src = p["source"]
        assert src["page"] == p["page"]
        w, h = src["page_size"]
        x0, y0, x1, y1 = src["block_bbox"]
        assert 0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h
        if src["qty_bbox"]:
            qx0, qy0, qx1, qy1 = src["qty_bbox"]
            assert x0 - 1 <= qx0 and qx1 <= x1 + 1 and y0 - 1 <= qy0 and qy1 <= y1 + 1
        assert src["lines"] and all({"text", "bbox", "role"} <= set(ln) for ln in src["lines"])
