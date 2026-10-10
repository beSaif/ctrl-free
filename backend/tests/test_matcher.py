"""Matcher: normalization, shortlist, pick (rules and fake LLM), golden 22/22."""
from __future__ import annotations

import copy

import pytest

from app import config, llm, matcher
from scripts.eval_matcher import build_example_positions
from tests.test_llm_misc import FakeClient, fake_llm, offline  # noqa: F401  (fixtures)


@pytest.fixture(scope="module")
def ex():
    ps, gt = build_example_positions()
    return ps, {r["lv_id"]: r for r in gt}


def P(text, qty=1, unit="pc", variant=None, lv="X1"):
    return {"lv_id": lv, "text_de": text, "quantity": qty, "unit": unit, "variant_de": variant, "kind": "item"}


# --------------------------------------------------------------------------- normalize

@pytest.mark.parametrize("text,variant,expect", [
    ("Zuluft - Tellerventil\naus Kunststoff\nGrösse Ø 10 cm Stk 5", None, {"type": "supply air valve", "dn_mm": 100, "material": "plastic"}),
    ("Abluft - Tellerventil\nGrösse Ø 10 cm Stk 5\nØ 12.5 cm Stk 6", "Ø 12.5 cm", {"type": "exhaust air valve", "dn_mm": 125}),
    ("Brandschutzklappen eingemauert\nFeuerwiderstandsklasse EI 90-S\nGrösse (B x H) 10 Ø cm Stk 4", None, {"type": "fire damper", "dn_mm": 100, "fire_class": "EI90-S"}),
    ("Schalldämpfer\nB x H x L 40 x 30 x 125 cm\nDruckverlust 30Pa Stk 4", None, {"type": "silencer rectangular", "dims_mm": [400, 300, 1250]}),
    ("Durchdringungen durch brandabschnittsbildende Decken\nEI30\nFür Lüftungskanäle Abmessungen B x H (mm)\n300 x 200 Stk 4", None,
     {"type": "fire penetration seal rectangular", "dims_mm": [300, 200], "fire_class": "EI30"}),
    ("Thermische Aussendämmung 60/10\naus 60 mm Mineralwollplatten\nmit Alu-Folie, gestiftet m2 12", None, {"thickness_mm": 60}),
    ("Fabrikat z.B. Trox Hesco\nTyp z.B. TVR-D\nMod. DN Vmin. Vmax. P\ncm m3/h m3/h Pa\nTVR-D 12.5 60 200 150 Stk 10\nTVR-D 16 120 400 150 Stk 6",
     "TVR-D 16 120 400 150", {"type": "VAV variable volume flow controller circular", "dn_mm": 160}),
    ("Einkanal-Volumenstromregler für konstanten Vol.strom\nMod. DN V P\nmm m3/h Pa\n....... 250 100 150 Stk 6", "....... 250 100 150",
     {"type": "CAV constant volume flow controller circular", "dn_mm": 250}),
    ("Anschlusswinkle für Befestigung an Wand oder Decke\n50x50x35x2.5mm, 8 Stück pro Durchführung\nAnzahl Durchführungen Stk 8", None,
     {"type": "connection angle set support", "dims_mm": None}),
    ("Lüftungsrohr für Erdverlegung\nØ 250 mm, Bogen 45° Stk 2", "Ø 250 mm, Bogen 45°", {"type": "circular bend", "dn_mm": 250, "angle_deg": 45}),
])
def test_normalize(text, variant, expect):
    a = matcher.normalize(P(text, variant=variant))
    for k, v in expect.items():
        assert a[k] == v, (k, a)


def test_own_row_found_from_quantity_when_no_variant():
    p = P("Zuluft - Tellerventil\nGrösse Ø 10 cm Stk 5\nØ 12.5 cm Stk 6", qty=6)
    assert matcher.normalize(p)["dn_mm"] == 125


# --------------------------------------------------------------------------- shortlist

def test_shortlist_lv0001_reads_like_the_playbook(ex):
    ps, _ = ex
    c = matcher.shortlist(ps[0], None)
    assert len(c) == 5 and c[0]["product_id"] == "P-AIR-001"
    assert c[0]["why"] == "Type and size match (Ø 10 cm = DN100)"
    whys = {x["product_id"]: x["why"] for x in matcher.shortlist(ps[0], None, k=56)}
    assert whys["P-AIR-002"] == "Right type, wrong size: tender says Ø 10 cm"
    assert whys["P-AIR-003"] == "Right size, but exhaust, not supply"
    assert whys["P-FIR-001"] == "Same size, different product type"


def test_shortlist_drops_wrong_units(ex):
    ps, _ = ex
    lv16 = next(p for p in ps if p["lv_id"] == "LV0016")
    rows = {r["product_id"]: r for r in matcher.load_catalog()}
    assert all(rows[c["product_id"]]["unit"] == "m2" for c in matcher.shortlist(lv16, None))
    assert matcher.shortlist(P("Montage und Transport", unit="LS"), None) == []


# --------------------------------------------------------------------------- pick (rules)

def test_rules_pick_none_for_types_not_in_catalogue():
    m = matcher.match_positions([P("Regenhut\nMaterial V2A\nBxH 110 x 35 cm Stk 1")], use_llm=False)["X1"]
    assert m["product_id"] is None and m["label"] == "None"


def test_rules_pick_none_when_size_missing_from_catalogue():
    m = matcher.match_positions([P("Zuluft - Tellerventil\naus Kunststoff\nGrösse Ø 20 cm Stk 3")], use_llm=False)["X1"]
    assert m["product_id"] is None and "size" in m["reason"]


def test_text_only_and_subtotals_are_skipped():
    ps = [dict(P("Total Kanäle B"), kind="subtotal"), dict(P("Allgemeine Hinweise", lv="X2"), kind="text_only")]
    assert matcher.match_positions(ps, use_llm=False) == {}


def test_golden_22_rules_only(offline, ex):
    ps, gt = ex
    res = matcher.match_positions(ps, use_llm=False)
    for lv, m in res.items():
        assert m["product_id"] == gt[lv]["suggested_product_id"], (lv, m["reason"])
        assert m["install_code"] == gt[lv]["expected_install_code"]
        assert m["method"] == "rules" and m["label"] in ("Strong", "Close")
        assert len(m["candidates"]) == 5 and m["candidates"][0]["product_id"] == m["product_id"]
    assert res["LV0001"]["label"] == "Strong" and res["LV0001"]["confidence"] >= 0.85


def test_golden_22_with_llm_unavailable_falls_back(offline, ex):
    ps, gt = ex
    res = matcher.match_positions(ps)  # use_llm=None, offline -> cache miss -> rules
    assert sum(res[lv]["product_id"] == gt[lv]["suggested_product_id"] for lv in res) == 22


# --------------------------------------------------------------------------- pick (fake LLM)

def test_llm_pick_is_enum_constrained_and_batched(fake_llm, ex):
    ps, gt = ex
    seen = []

    def handler(name, schema, user, kw):
        assert name == "pick_products"
        out = {}
        for lv, sub in schema["properties"].items():
            enum = sub["properties"]["product_id"]["enum"]
            assert enum[-1] == "none" and len(enum) <= 6
            seen.append(lv)
            out[lv] = {"product_id": enum[0], "confidence": "high", "reason": "Type and size match", "assumptions": []}
        if "LV0005" in out:
            out["LV0005"]["assumptions"] = ["Finish not specified, galvanised assumed"]
            out["LV0005"]["confidence"] = "medium"
        if "LV0021" in out:
            out["LV0021"]["product_id"] = "none"
        return out

    fake = fake_llm(FakeClient(handler))
    res = matcher.match_positions(ps)
    assert len(fake.calls) == 3  # 22 positions, 10 per call
    assert sorted(seen) == sorted(gt)
    assert res["LV0001"]["method"] == "llm" and res["LV0001"]["label"] == "Strong" and res["LV0001"]["confidence"] == 0.92
    assert res["LV0005"]["label"] == "Close" and res["LV0005"]["assumptions"]
    assert res["LV0021"]["product_id"] is None and res["LV0021"]["label"] == "None"
    # second run is served from the cache, even offline
    config.LLM_OFFLINE = True
    try:
        res2 = matcher.match_positions(ps)
    finally:
        config.LLM_OFFLINE = False
    assert res2["LV0001"]["method"] == "cache" and len(fake.calls) == 3


def test_llm_answer_outside_candidates_is_rejected(fake_llm, ex):
    ps, _ = ex

    def handler(name, schema, user, kw):
        return {lv: {"product_id": "P-NOT-REAL", "confidence": "high", "reason": "x", "assumptions": []} for lv in schema["properties"]}

    fake_llm(FakeClient(handler))
    p = ps[0]
    r = matcher.pick(p, matcher.shortlist(p, None))
    assert r["product_id"] is None and r["label"] == "None"


def test_llm_size_disagreement_caps_confidence(fake_llm, ex):
    ps, _ = ex

    def handler(name, schema, user, kw):
        out = {}
        for lv, sub in schema["properties"].items():
            out[lv] = {"product_id": "P-AIR-002", "confidence": "high", "reason": "x", "assumptions": []}
        return out

    fake_llm(FakeClient(handler))
    p = ps[0]  # tender Ø 10 cm, P-AIR-002 is DN125
    cands = matcher.shortlist(p, None)
    assert any(c["product_id"] == "P-AIR-002" for c in cands)
    r = matcher.pick(p, cands)
    assert r["product_id"] == "P-AIR-002" and r["confidence"] <= 0.5 and r["label"] == "Weak"


def test_llm_normalize_fills_unknown_types(fake_llm):
    def handler(name, schema, user, kw):
        assert name == "normalize_types"
        return {lv: {"type_en": "rain cap"} for lv in schema["properties"]}

    fake_llm(FakeClient(handler))
    p = P("Sockelrohr V2A\nLänge 800 mm Stk 1")
    a = matcher.normalize_many([p])
    assert a["X1"]["type"] == "rain cap" and a["X1"]["type_source"] == "llm"
