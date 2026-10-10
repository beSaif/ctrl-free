"""Equivalent products across manufacturers: make rule (example / prescribed / open) and attribute comparison."""
from __future__ import annotations

from app import equivalence as E
from app import matcher


def _pos(text: str, unit: str = "pc", lv: str = "LV9001", **kw) -> dict:
    return {"lv_id": lv, "kind": "item", "text_de": text, "title_de": text.split("\n", 1)[0], "unit": unit,
            "unit_raw": "Stk", "quantity": 5.0, **kw}


VALVE = "Zuluft - Tellerventil\naus Kunststoff, mit Luftmengeneinstellung\nFabrikat   z.B Trox Hesco\nTyp   z.B Z-LVS\nGrösse Ø 10 cm"


def _rows():
    return {r["product_id"]: r for r in matcher.load_catalog()}


def test_make_named_as_example():
    r = E.make_rule(_pos(VALVE))
    assert r["kind"] == "example" and r["make"] == "Trox Hesco" and r["model"] == "Z-LVS"
    assert "Fabrikat" in r["snippet"] and "z.B" in r["wording"]
    gl = E.make_rule(_pos("Zuluftgerät\nFabrikat   Seven-Air\noder gleichwertig\nTyp   SIMPLEX"))
    assert gl["kind"] == "example" and "oder gleichwertig" in gl["snippet"]


def test_make_prescribed_explicitly_or_only_named():
    explicit = E.make_rule(_pos("Brandschutzklappe\nFabrikat   Trox Hesco (vorgeschrieben, kein Ersatz)\nGrösse Ø 10 cm"))
    assert explicit["kind"] == "prescribed" and explicit["explicit"]
    bare = E.make_rule(_pos("Volumenstromregler konstant\nFabrikat   Trox Hesco\nTyp   VFC\nDN 250"))
    assert bare["kind"] == "named" and not bare["explicit"] and bare["wording"] is None
    assert bare["make"] == "Trox Hesco" and bare["model"] == "VFC"


def test_make_left_open_or_not_named():
    assert E.make_rule(_pos("Drosselklappe\nFabrikat   ..........\nTyp   ..........\nGrösse Ø 12.5 cm"))["kind"] == "open"
    assert E.make_rule(_pos("Drosselklappe\nFabrikat und Typ sind anzugeben"))["kind"] == "open"
    assert E.make_rule(_pos("Rohrbogen 90°\nØ 10 cm"))["kind"] == "none"


def test_make_inherited_from_the_unit_a_part_belongs_to():
    unit = _pos("Zuluftgerät 1-1\nFabrikat   z.B Seven-Air\nTyp   z.B SIMPLEX", lv="LV9000")
    part = _pos("1 Leerteil", make_hint="Seven-Air", parent_lv_id="LV9000")
    r = E.make_rule(part, unit)
    assert r["kind"] == "example" and r["inherited"]


def test_compare_equivalent_product_from_another_make():
    rows = _rows()
    c = E.compare(_pos(VALVE), rows["P-AIR-001"])
    by = {r["key"]: r for r in c["rows"]}
    assert by["type"]["verdict"] == "same" and by["size"]["verdict"] == "same" and by["unit"]["verdict"] == "same"
    assert by["size"]["tender"] == "DN100" and by["size"]["snippet"] == "Grösse Ø 10 cm"
    assert by["make"]["verdict"] == "equivalent" and by["make"]["product"].startswith("DemoVent")
    assert by["material"]["verdict"] == "unknown"  # the catalogue does not state the valve's material
    assert c["verdict"] == "equivalent"
    assert c["summary"]["tender"].startswith("Trox Hesco Z-LVS") and c["summary"]["make_kind"] == "example"
    wrong = E.compare(_pos(VALVE), rows["P-AIR-002"])  # DN125
    assert wrong["verdict"] == "differs" and {r["key"]: r for r in wrong["rows"]}["size"]["verdict"] == "differs"
    exhaust = E.compare(_pos(VALVE), rows["P-AIR-003"])
    assert {r["key"]: r for r in exhaust["rows"]}["type"]["verdict"] == "differs"


def test_compare_fire_class_actuator_and_length():
    rows = _rows()
    damper = _pos("Brandschutzklappe\nMit aufgebautem elektrischen Antrieb\nFeuerwiderstandsklasse EI 90-S\nGrösse Ø 10 cm")
    by = {r["key"]: r for r in E.compare(damper, rows["P-FIR-001"])["rows"]}
    assert by["fire_class"]["verdict"] == "same" and by["actuator"]["verdict"] == "same"
    silencer = _pos("Kompaktschalldämpfer\nØ 10 cm", attributes={"length_mm": 1000})
    by = {r["key"]: r for r in E.compare(silencer, rows["P-SIL-002"])["rows"]}
    assert by["length"]["verdict"] == "differs" and by["length"]["product"] == "900 mm"


def test_prescribed_make_from_another_manufacturer_goes_to_review():
    rows = _rows()
    p = _pos("Einkanal-Volumenstromregler für konstanten Vol.strom\nFabrikat   Trox Hesco (vorgeschrieben)\nTyp   VFC\nDN 250")
    m = matcher.match_positions([p], list(rows.values()), use_llm=False)[p["lv_id"]]
    assert m["product_id"] == "P-CAV-001"
    assert m["make_rule"]["kind"] == "prescribed"
    assert any("prescribes Trox Hesco VFC" in a for a in m["assumptions"])
    # the same line with "z.B." is an example: no review note
    q = _pos("Einkanal-Volumenstromregler für konstanten Vol.strom\nFabrikat   z.B. Trox Hesco\nTyp   z.B. VFC\nDN 250")
    m2 = matcher.match_positions([q], list(rows.values()), use_llm=False)[q["lv_id"]]
    assert m2["make_rule"]["kind"] == "example" and not m2["assumptions"]
    # named without any equivalence wording (LV0063, an Equans verified example priced plainly): no review note
    n = _pos("Einkanal-Volumenstromregler für konstanten Vol.strom\nFabrikat   Trox Hesco\nTyp   VFC\nDN 250")
    m3 = matcher.match_positions([n], list(rows.values()), use_llm=False)[n["lv_id"]]
    assert m3["make_rule"]["kind"] == "named" and not m3["assumptions"]
    # a product of the prescribed make is no variant
    assert E.review_note(m["make_rule"], {"manufacturer": "Trox Hesco AG"}) is None


def test_variant_rule_attached_from_the_tender_instructions():
    rows = _rows()
    ins = [{"id": "i_02", "type": "Varianten", "page": 36, "section": "3.3.4", "text_de": "… als Variante …"}]
    rule = E.make_rule(_pos("Regler\nFabrikat   Trox Hesco, vorgeschrieben\nTyp   VFC"))
    v = E.with_variant_rule(rule, ins, rows["P-CAV-001"])
    assert v["variant_needed"] and v["manufacturer_differs"] and v["variant_rule"]["page"] == 36
    ex = E.with_variant_rule(E.make_rule(_pos(VALVE)), ins, rows["P-AIR-001"])
    assert not ex["variant_needed"] and ex["manufacturer_differs"]


def test_candidates_get_comparisons():
    rows = _rows()
    cands = [dict(rows["P-AIR-001"]), dict(rows["P-AIR-002"])]
    E.add_comparisons(_pos(VALVE), cands)
    assert [c["comparison"]["verdict"] for c in cands] == ["equivalent", "differs"]


def test_same_family_other_subtype_is_equivalent_not_differs():
    # "Kontroll- und Putzdeckel 40 x 20 cm" (LV0021) vs the inspection cover 400x200: a check, not a red flag
    c = E.compare(_pos("Kontroll- und Putzdeckel\nGrösse 40 x 20 cm"), _rows()["P-FIR-004"])
    by = {r["key"]: r for r in c["rows"]}
    assert by["type"]["verdict"] == "equivalent" and "Same product family" in by["type"]["note"]
    assert by["size"]["verdict"] == "same" and c["verdict"] == "equivalent"
