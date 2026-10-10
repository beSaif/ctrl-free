"""LLM grouping of LV lines (app.grouping) and building positions from a plan (parser._segment_plan).

The validation / merge tests need no PDF and no LLM. The PDF tests use the committed LLM cache
for the Oberglatt starter tender (offline); they skip when the PDF or the cached answers are missing.

Run: cd backend && uv run pytest tests/test_grouping.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app import grouping, llm, pipeline  # noqa: E402
from app.config import DEMO_PDF  # noqa: E402
from app.parser import Line, parse_tender  # noqa: E402


def _ln(idx, kind, text, gap="blank", unit=None, qty=None, system_idx=0):
    ln = Line(page=1, idx=idx, bbox=[85, 100 + idx * 12, 400, 110 + idx * 12], yc=105 + idx * 12, text=text,
              desc_bbox=[85, 100 + idx * 12, 300, 110 + idx * 12], unit_raw=unit, qty_raw=qty)
    ln.kind, ln.gap, ln.system_idx = kind, gap, system_idx
    return ln


def _stream():
    return [_ln(0, "section", "ROHRE"),
            _ln(1, "text", "Fabrikat: z.B. Ventaflex"),
            _ln(2, "qty", "Rohr 3m", unit="Stk", qty="16"),
            _ln(3, "text", "Lüftungsrohr für Erdverlegung", gap="tight"),
            _ln(4, "qty", "Bogen 45°", unit="Stk", qty="2"),
            _ln(5, "text", "für Erdverlegung", gap="tight"),
            _ln(6, "total", "Total Rohre")]


GOOD = {"items": [{"qty": [2], "text": [3], "parent": None}, {"qty": [4], "text": [5], "parent": None}],
        "intros": [{"text": [1], "applies_to": [2, 4]}], "other": []}


def test_validate_accepts_a_complete_answer():
    s = _stream()
    kinds = grouping._kinds(s)
    assert grouping._validate(GOOD, [], s, kinds) is None


@pytest.mark.parametrize("bad, msg", [
    ({**GOOD, "intros": []}, "not assigned"),                                           # text 1 lost
    ({**GOOD, "other": [3]}, "more than once"),                                         # text 3 twice
    ({**GOOD, "items": [{"qty": [2], "text": [3], "parent": None}], "other": [5]}, "not in any item"),
    ({**GOOD, "items": GOOD["items"] + [{"qty": [99], "text": [], "parent": None}]}, "not a Q line"),
    ({**GOOD, "items": [{"qty": [], "text": [3], "parent": None}, GOOD["items"][1]]}, "not the parent"),
])
def test_validate_rejects_inconsistent_answers(bad, msg):
    s = _stream()
    assert msg in (grouping._validate(bad, [], s, grouping._kinds(s)) or "")


def test_tidy_drops_structure_ids_listed_as_text():
    s = _stream()
    kinds = grouping._kinds(s)
    slip = {**GOOD, "other": [0, 6]}                 # section + total lines: bookkeeping, not grouping
    assert grouping._validate(grouping._tidy(slip, [], s, kinds), [], s, kinds) is None


def test_plan_retries_once_then_leaves_the_chunk_to_rules(monkeypatch):
    calls = []

    def fake(system, user, schema, **kw):
        calls.append(user)
        return {"items": [], "intros": [], "other": []}             # never valid
    monkeypatch.setattr(llm, "call_json", fake)
    assert grouping.plan_groups(_stream()) is None
    assert len(calls) == 2 and "previous answer was invalid" in calls[1]


def test_plan_merges_one_item_intro_without_own_text(monkeypatch):
    ans = {"items": [{"qty": [2], "text": [3], "parent": None}, {"qty": [4], "text": [], "parent": None}],
           "intros": [{"text": [1], "applies_to": [2, 4]}, {"text": [5], "applies_to": [4]}], "other": []}
    monkeypatch.setattr(llm, "call_json", lambda *a, **k: ans)
    plan = grouping.plan_groups(_stream())
    assert plan.items[1] == {"qty": [4], "text": [5], "parent": None}    # "intro" of one item = its text
    assert plan.intros == [{"text": [1], "applies_to": [2, 4]}]


def test_carry_review_keeps_reviewer_work_and_renames_ids():
    def pos(lv, y, qty, **kw):
        return {"lv_id": lv, "kind": "item", "quantity": qty, "unit_raw": "Stk",
                "source": {"page": 3, "qty_bbox": [400, y, 420, y + 10]}, **kw}
    t = {"positions": [pos("LV0001", 100, 2.0, flagged=True), pos("LV0002", 200, 5.0, confirmed={"by": "x"}),
                       pos("LV0003", 300, 1.0, overrides={"unit_price": 9})],
         "instructions": [{"applies_to": ["LV0002"]}], "quote_requests": [{"lv_ids": ["LV0002", "LV0003"]}],
         "ai_reviews": {"LV0002": [1]}, "log": [{"lv_id": "LV0002", "target": {"kind": "position", "id": "LV0002"}}]}
    # new reading: a device head was added before LV0002 -> ids shift; LV0003's line is gone
    new = [pos("LV0001", 100, 2.0), pos("LV0002", 150, None), pos("LV0003", 200, 5.0)]
    lost = pipeline._carry_review(t, new)
    assert new[0]["flagged"] is True and new[2]["confirmed"] == {"by": "x"}
    assert lost == ["LV0003"]
    assert t["instructions"][0]["applies_to"] == ["LV0003"]
    assert t["quote_requests"][0]["lv_ids"] == ["LV0003", "LV0003"]
    assert list(t["ai_reviews"]) == ["LV0003"]
    assert t["log"][0]["lv_id"] == "LV0003" and t["log"][0]["target"]["id"] == "LV0003"


# ----------------------------------------------------------------------------- Oberglatt (cached LLM)

@pytest.fixture(scope="module")
def grouped():
    if not DEMO_PDF.exists():
        pytest.skip("starter-package tender PDF not present")
    res = parse_tender(DEMO_PDF, grouper=grouping.plan_groups)
    if not res.get("grouping"):
        pytest.skip("no cached LLM grouping for the starter tender")
    return res


def _by_title(res, part, page):
    return next(p for p in res["positions"] if p["page"] == page and part in (p["title_de"] or ""))


def test_all_systems_grouped_by_the_llm(grouped):
    g = grouped["grouping"]
    assert g["mode"] == "llm" and g["systems_by_llm"] == g["systems"] and not g["failed_chunks"]


def test_title_first_lines_own_the_text_below_them(grouped):
    """Rohreinlagen (p. 103): bold title + quantity first, description below."""
    m1 = _by_title(grouped, "Länge 1m", 103)
    b45 = _by_title(grouped, "Bogen 45°", 103)
    assert "als Passlänge" in m1["text_de"]
    assert "Passlänge" not in b45["text_de"] and "Lüftungsrohr" not in b45["text_de"]
    assert "für Erdverlegung" in b45["text_de"]


def test_section_intro_reaches_every_line(grouped):
    rohre = [p for p in grouped["positions"] if p["page"] == 103]
    assert len(rohre) == 7
    for p in rohre:
        assert p["offer_ref"] == "V241182" and p["make_hint"] == "Ventaflex GmbH"
        assert p["intro_de"].startswith("Rohreinlagen unter Bodenplatte")
        assert "Kontakt" not in p["text_de"]
    intro = next(t for t in grouped["text_blocks"] if t["text_de"].startswith("Rohreinlagen unter Bodenplatte"))
    assert {p["lv_id"] for p in rohre} <= set(intro["applies_to"])


def test_wie_vorbeschrieben_starts_the_next_item(grouped):
    p = next(p for p in grouped["positions"] if "wie vorbeschrieben" in (p["title_de"] or ""))
    assert p["title_de"].startswith("Kontroll- und Putzdeckel")


def test_device_without_quantity_keeps_its_components(grouped):
    dev = next(p for p in grouped["positions"] if p["title_de"] == "Zuluftgerät 4-1")
    assert dev["quantity"] is None and dev["attributes"].get("device")
    comps = [p for p in grouped["positions"] if p.get("parent_lv_id") == dev["lv_id"]]
    assert len(comps) >= 4
    assert all(p["title_de"].startswith("Zuluftgerät 4-1: ") for p in comps)


def test_same_quantity_lines_as_the_rules(grouped):
    rules = parse_tender(DEMO_PDF)
    key = lambda r: sorted((p["page"], str(p["quantity"]), str(p["unit"])) for p in r["positions"]  # noqa: E731
                           if p["kind"] != "subtotal")
    assert key(grouped) == key(rules)
