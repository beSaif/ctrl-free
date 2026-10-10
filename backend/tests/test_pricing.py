"""Golden check and behaviour tests for app.pricing / app.reference."""
import csv
import json

import pytest

from app import config, pricing as P, reference as R

STARTER = config.STARTER_DIR
GOLD = json.loads((STARTER / "expected_output_example.json").read_text())
GOLD_POS = {x["lv_id"]: x for x in GOLD["position_results"]}


def example_positions() -> list[dict]:
    """The 22 verified examples shaped like SPEC Positions (test data only)."""
    out = []
    with open(STARTER / "example_lv_positions.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            out.append({
                "lv_id": r["lv_id"], "system": r["system"], "system_key": r["system"].split()[1],
                "section": r["category"], "section_name": r["category"], "page": int(r["source_page"]),
                "title_de": r["description"], "title_en": r["description"],
                "quantity": float(r["quantity"]), "unit": r["unit"], "kind": "item",
                "make_hint": r["manufacturer_hint"] or None, "model_hint": r["model_hint"] or None, "offer_ref": None,
                "match": {"product_id": r["suggested_product_id"], "install_code": r["expected_install_code"],
                          "confidence": GOLD_POS[r["lv_id"]]["match_confidence"], "method": "rules"},
                "overrides": {}, "supplier_quote": None, "confirmed": None, "flagged": False,
                "source": {"page": int(r["source_page"])},
            })
    return out


def example_systems(positions) -> list[dict]:
    seen = []
    for p in positions:
        if p["system"] not in [s["label"] for s in seen]:
            code, key, *name = p["system"].split()
            seen.append({"code": code, "key": key, "name": " ".join(name), "label": p["system"], "profile": "school"})
    return seen


def example_tender() -> dict:
    pos = example_positions()
    return {"id": "t_test", "name": "Neubau Primarschule Erlenstrasse, Oberglatt", "client": "Gemeinde Oberglatt",
            "trade": "BKP 244 Lüftungsanlagen", "file_name": "BKP_244_LV_Lueftung_260804.pdf",
            "due_at": "2026-09-22T10:00:00", "profile": "school", "systems": example_systems(pos), "positions": pos,
            "instructions": [
                {"id": "i_01", "type": "Brandschutzklappen", "page": 38, "kind": "cost", "state": "open"},
                {"id": "i_02", "type": "Hygiene", "page": 40, "kind": "risk", "state": "open"},
                {"id": "i_03", "type": "Varianten", "page": 10, "kind": "scope", "state": "confirmed"},
            ],
            "pricing": R.default_settings()}


@pytest.fixture
def settings():
    return R.default_settings()


@pytest.fixture
def positions():
    return example_positions()


# ---------------------------------------------------------------- golden

def test_golden_positions(positions, settings):
    for p in positions:
        price = P.price_position(p, settings)
        g = GOLD_POS[p["lv_id"]]
        assert price is not None
        assert price["direct"] == pytest.approx(g["direct_position_cost_chf"], abs=0.01), p["lv_id"]
        assert price["material"] == pytest.approx(g["material_cost_chf"], abs=0.01)
        assert price["labour"] == pytest.approx(g["labour_cost_chf"], abs=0.01)
        assert price["hours"] == pytest.approx(g["adjusted_install_hours"], abs=0.01)
        assert price["unit_price_source"] == g["price_source"]
        status, _ = P.derive_status(p, price)
        assert status == g["status"], p["lv_id"]


def test_golden_totals_and_scenarios(positions, settings):
    t = P.project_totals(positions, settings, example_systems(positions))
    s = GOLD["example_subset_summary"]
    assert t["material"] == pytest.approx(s["material_cost_chf"], abs=0.01)
    assert t["labour"] == pytest.approx(s["labour_cost_chf"], abs=0.01)
    assert t["direct"] == pytest.approx(372700.12, abs=0.005)
    assert t["cost"] == pytest.approx(414489.12, abs=0.005)
    assert t["standard_price"] == 439000
    by_name = {r["name"]: r for r in t["scenarios"]}
    for g in GOLD["recommended_bid_range"]["scenarios"]:
        r = by_name[g["scenario"]]
        assert r["bid"] == g["bid_price_chf"]
        assert r["win"] == g["estimated_win_probability"]
        assert r["expected"] == g["expected_contribution_chf"]
        assert r["margin_pct"] == g["margin_pct"]
    assert [r["name"] for r in t["scenarios"]] == ["Aggressive", "Target", "Standard", "Conservative"]
    assert sum(r["best"] for r in t["scenarios"]) == 1 and by_name["Conservative"]["best"]
    assert t["coverage"]["calculated"] == 16 and t["coverage"]["supplier_quote_required"] == 6
    assert t["budget_direct"] == pytest.approx(271261.31, abs=0.01)
    assert round(t["budget_share"], 2) == 0.73
    assert t["to_review"] == 6
    assert sum(r["direct"] for r in t["by_system"]) == pytest.approx(t["direct"], abs=0.02)
    assert sum(r["direct"] for r in t["by_category"]) == pytest.approx(t["direct"], abs=0.02)
    assert t["offer_price"] is None and t["chosen"] is None


def test_win_explain_mirrors_n07(positions, settings):
    t = P.project_totals(positions, settings, [])
    assert t["win_explain"] == ("Why 63%: it starts at 55%, plus 5 because we want the job, minus 5 for strong "
                                "competition, plus 8 because this price is 1.5% below the standard price "
                                "(CHF 439'000 at 5.5%).")
    labels = [b["label"] for b in t["buildup"]]
    assert labels[0] == "Direct cost, 22 lines"
    assert "+ Transport and equipment 2.5%" in labels and "+ Overhead 8.5%" in labels
    settings["chosen"] = "Aggressive"
    t = P.project_totals(positions, settings, [])
    assert t["offer_price"] == 426000 and t["offer"]["win"] == 0.69
    assert t["win_explain"].startswith("Why 69%")
    assert t["buildup"][-1] == {"key": "offer", "label": "Offer price", "value": 426000, "strong": True}


def test_project_costs_add_115700(positions, settings):
    base = P.project_totals(positions, settings, [])
    settings["project_costs"] = {k: True for k in settings["project_costs"]}
    t = P.project_totals(positions, settings, [])
    assert t["project_costs"] == pytest.approx(115700)
    pre_transport = lambda x: x["direct"] + x["project_costs"] + x["small_material"] + x["supplier_contingency"]
    assert pre_transport(t) - pre_transport(base) == pytest.approx(115700)
    assert t["cost"] == pytest.approx((372700.12 + 115700) * 1.025 * 1.085, abs=0.01)
    assert t["project_costs_all"] == 115700


def test_small_material_and_contingency(positions, settings):
    settings.update(include_small_material=True, include_supplier_contingency=True)
    t = P.project_totals(positions, settings, [])
    budget_mat = sum(GOLD_POS[p]["material_cost_chf"] for p in GOLD_POS if GOLD_POS[p]["price_source"] == "supplier_package")
    cat_mat = sum(GOLD_POS[p]["material_cost_chf"] for p in GOLD_POS if GOLD_POS[p]["price_source"] == "catalog")
    assert t["supplier_contingency"] == pytest.approx(budget_mat * 0.03, abs=0.01)
    assert t["small_material"] == pytest.approx(cat_mat * 0.035, abs=0.01)
    assert any(b["key"] == "small_material" for b in t["buildup"])


# ---------------------------------------------------------------- position behaviour

def test_explain_sentences(positions, settings):
    p = positions[0]
    pr = P.price_position(p, settings)
    assert pr["explain"]["material"] == "5 pc × CHF 74.80 × (1 + 4% waste) = CHF 388.96"
    assert pr["explain"]["hours"] == ("5 pc × 0.65 h ÷ 0.88 site efficiency × 1.10 ceiling height "
                                      "× 1.07 school logistics = 4.35 h")
    assert pr["explain"]["labour"] == "4.35 h × CHF 96/h (installer) = CHF 417.30"
    assert pr["sources"]["quantity"] == "Tender p. 78"
    assert pr["sources"]["product"] == "catalog.csv row P-AIR-001"
    assert pr["factors"][0] == {"key": "site_efficiency", "label": "site efficiency", "value": 0.88,
                                "applied": 1.1364, "op": "÷"}


def test_explain_field_labour_matches_s01(positions, settings):
    p = next(x for x in positions if x["lv_id"] == "LV0006")
    pr = P.price_position(p, settings)
    steps = P.explain_field(p, pr, "labour")
    assert P.explain_title("labour", pr) == "Why the labour on this line is CHF 1'078.56"
    assert [s["text"] for s in steps] == [
        "4 pc × 2.10 h per pc (install rule SILENCER)",
        "÷ 0.88 site efficiency, × 1.10 ceiling height, × 1.07 school logistics",
        "× CHF 96 per hour (installer)",
    ]
    assert [s["value"] for s in steps] == ["8.40 h", "11.24 h", "1'078.56"]
    assert all(s["source"] for s in steps)
    assert P.explain_field(p, pr, "material")[-1]["value"] == "10'816.00"
    assert len(P.explain_field(p, pr, "hours")) == 2


def test_overrides(positions, settings):
    p = dict(positions[0])
    p["overrides"] = {"quantity": 10}
    assert P.price_position(p, settings)["material"] == pytest.approx(777.92)
    assert "Changed by you" in P.price_position(p, settings)["sources"]["quantity"]
    p["overrides"] = {"unit_price": 100.0}
    pr = P.price_position(p, settings)
    assert pr["unit_price_source"] == "manual" and pr["material"] == 520.0
    p["overrides"] = {"hours": 10.0}
    pr = P.price_position(p, settings)
    assert pr["hours"] == 10.0 and pr["labour"] == 960.0 and pr["hours_overridden"]
    assert pr["explain"]["hours"].startswith("Set by you")
    # product override brings that product's install rule
    p["overrides"] = {"product_id": "P-FIR-001"}
    pr = P.price_position(p, settings)
    assert pr["install_code"] == "FIRE_DAMPER" and pr["net_unit_cost"] == 1487.5
    p["overrides"] = {"product_id": "P-FIR-001", "install_code": "DIFFUSER"}
    assert P.price_position(p, settings)["install_code"] == "DIFFUSER"


def test_supplier_quote_and_needs_review(positions, settings):
    p = dict(next(x for x in positions if x["lv_id"] == "LV0006"))
    pr = P.price_position(p, settings)
    st, reason = P.derive_status(p, pr)
    assert st == "supplier_quote_required" and "budget price" in reason
    assert P.needs_review(p, st)
    p["supplier_quote"] = {"unit_price": 2400.0, "source": "Supplier reply.pdf p.1 pos 2"}
    pr = P.price_position(p, settings)
    assert pr["unit_price_source"] == "supplier_quote" and pr["material"] == pytest.approx(4 * 2400 * 1.04)
    st, reason = P.derive_status(p, pr)
    assert (st, reason) == ("supplier_quote_required", "Quote entered")
    assert not P.needs_review(p, st)
    # quote lines are no longer budget lines
    others = [x for x in positions if x["lv_id"] != "LV0006"]
    t = P.project_totals(others + [p], settings, [])
    assert t["budget_lines"] == 5 and t["quotes_entered"] == 1


def test_statuses(positions, settings):
    base = positions[0]
    ev = lambda **kw: P.evaluate_position({**base, **kw}, settings)
    assert ev(kind="subtotal")["status"] == "non_priceable"
    assert ev(kind="text_only")["status"] == "non_priceable"
    r = ev(quantity=None)
    assert r["status"] == "insufficient_information" and r["pricing"] is None and r["needs_review"]
    assert ev(quantity=0)["status"] == "insufficient_information"
    r = ev(match={"product_id": None, "candidates": [{"product_id": "P-AIR-002", "score": 0.4}]})
    assert r["status"] == "review_required" and "0.40" in r["status_reason"]
    assert ev(match={**base["match"], "confidence": 0.3})["status"] == "review_required"
    r = ev(match={**base["match"], "confidence": 0.6})
    assert r["status"] == "assumption_applied" and r["needs_review"]
    assert ev(match={**base["match"], "assumptions": ["finish assumed white"]})["status"] == "assumption_applied"
    assert ev(offer_ref="P241783")["status"] == "supplier_quote_required"
    r = ev(status="out_of_scope", status_reason="bauseits")
    assert r["status"] == "out_of_scope" and r["status_reason"] == "bauseits" and not r["needs_review"]
    r = ev(overrides={"status": "out_of_scope"})
    assert r["status"] == "out_of_scope" and r["status_reason"] == "Set by you"
    # manual product pick counts as confident
    r = ev(match={**base["match"], "confidence": 0.3}, overrides={"product_id": "P-AIR-001"})
    assert r["status"] == "calculated"
    # confirmed clears, flagged forces
    assert not ev(match={**base["match"], "confidence": 0.6}, confirmed={"by": "You", "at": "x"})["needs_review"]
    assert ev(flagged=True)["needs_review"]
    # product not in catalogue
    assert ev(match={"product_id": "P-NOPE"})["status"] == "review_required"
    assert ev(match={"product_id": "P-NOPE"}, overrides={"unit_price": 10})["pricing"]["material"] == 52.0


def test_excluded_lines_not_in_totals(positions, settings):
    ps = [dict(p) for p in positions]
    ps[0]["overrides"] = {"status": "out_of_scope"}
    ps.append({"lv_id": "LV9999", "kind": "subtotal", "title_de": "Total Kanäle B", "system": ps[0]["system"]})
    t = P.project_totals(ps, settings, [])
    assert t["direct"] == pytest.approx(372700.12 - 806.26, abs=0.01)
    assert t["coverage"]["out_of_scope"] == 1 and t["coverage"]["non_priceable"] == 1
    assert t["lines_priced"] == 21


def test_settings_factors_and_profile(positions, settings):
    p = positions[0]
    school = P.price_position(p, settings, "school")
    hall = P.price_position(p, settings, "sports_hall")
    assert hall["hours"] == pytest.approx(5 * 0.65 / 0.88 * 1.25 * 1.07, abs=0.01)
    assert "sports hall ceiling height" in hall["explain"]["hours"]
    systems = [{"label": p["system"], "profile": "sports_hall"}]
    assert P.project_totals([p], settings, systems)["labour"] == hall["labour"]
    settings["factors"]["site_efficiency"] = 1.0
    settings["material_waste_pct"] = 0
    pr = P.price_position(p, settings)
    assert pr["hours"] < school["hours"] and pr["material"] == 374.0


def test_partial_settings_merge(positions):
    t = P.project_totals(positions, {"margins": {"Target": 4.0}}, [])
    assert t["direct"] == pytest.approx(372700.12) and len(t["scenarios"]) == 4


# ---------------------------------------------------------------- reference

def test_default_settings():
    s = R.default_settings()
    assert s["margins"] == {"Aggressive": 2.5, "Target": 4.0, "Standard": 5.5, "Conservative": 6.5}
    assert (s["competition"], s["appetite"], s["sensitivity"], s["ref_win"]) == (-0.05, 0.05, 0.05, 0.55)
    assert s["overhead_pct"] == 8.5 and s["transport_pct"] == 2.5 and s["material_waste_pct"] == 4.0
    assert not any(s["project_costs"].values())
    assert R.factor_label("mounting_height_school") == "ceiling height"


def test_import_reference(tmp_path, monkeypatch):
    for f in R.FILES.values():
        (tmp_path / f).write_bytes((config.REFERENCE_DIR / f).read_bytes())
    monkeypatch.setattr(R, "REFERENCE_DIR", tmp_path)
    R.clear_cache()
    try:
        cat = (tmp_path / "catalog.csv").read_text().replace("P-AIR-001,Air terminal,Supply valve,DemoVent,DV-Z-100,Supply air valve DN100,pc,85,12,74.8",
                                                             "P-AIR-001,Air terminal,Supply valve,DemoVent,DV-Z-100,Supply air valve DN100,pc,85,12,80.0")
        entry = R.import_reference("catalog", cat.encode())
        assert entry["kind"] == "catalog" and entry["version"] == 2 and entry["rows"] > 40
        assert R.catalog_row("P-AIR-001")["net_cost_chf"] == 80.0
        assert list((tmp_path / "history").iterdir())
        with pytest.raises(ValueError, match="missing columns"):
            R.import_reference("catalog", b"product_id,foo\nX,1\n")
        with pytest.raises(ValueError, match="must be a number"):
            R.import_reference("catalog", cat.replace(",80.0,", ",abc,").encode())
        with pytest.raises(ValueError, match="install rules that do not exist"):
            R.import_reference("catalog", cat.replace(",DIFFUSER,catalog", ",NOPE,catalog", 1).encode())
        with pytest.raises(ValueError, match="unknown site factor"):
            R.import_reference("rules", (tmp_path / "productivity.csv").read_text().replace("school_logistics\n", "moon_gravity\n", 1).encode())
        params = json.loads((tmp_path / "project_parameters.json").read_text())
        params["commercial"]["overhead_pct"] = 9.0
        R.import_reference("parameters", json.dumps(params).encode())
        assert R.default_settings()["overhead_pct"] == 9.0
        del params["commercial"]
        with pytest.raises(ValueError, match="commercial"):
            R.import_reference("parameters", json.dumps(params).encode())
        with pytest.raises(ValueError, match="Unknown reference kind"):
            R.import_reference("foo", b"")
        assert len(R.reference_versions()) == 2
    finally:
        monkeypatch.undo()
        R.clear_cache()


def test_setting_effects(positions, settings):
    base = P.project_totals(positions, settings)["cost"]
    s = {**settings, "overhead_pct": 10.0, "margins": {**settings["margins"], "Target": 5.0},
         "project_costs": {**settings["project_costs"], "hygiene": True}}
    now = P.project_totals(positions, s)["cost"]
    eff = P.setting_effects(positions, s, ["overhead_pct", "margins.Target", "project_costs.hygiene"])
    assert "margins.Target" not in eff  # a margin does not change the cost
    assert eff["overhead_pct"] == round(now - P.project_totals(positions, {**s, "overhead_pct": 8.5})["cost"], 2)
    assert eff["project_costs.hygiene"] == round(now - P.project_totals(positions, {**s, "project_costs": settings["project_costs"]})["cost"], 2)
    assert eff["project_costs.hygiene"] == pytest.approx(18000 * 1.025 * 1.10, abs=0.01)
    assert now > base
    # a site factor changes every line's hours, so its effect comes from re-pricing the lines
    f = {**settings, "factors": {**settings["factors"], "site_efficiency": 0.8}}
    e2 = P.setting_effects(positions, f, ["factors.site_efficiency"])
    assert e2["factors.site_efficiency"] == round(P.project_totals(positions, f)["cost"] - base, 2) > 0


def test_setting_sources():
    assert R.setting_source("overhead_pct") == "project_parameters.json commercial.overhead_pct"
    assert R.setting_source("margins.Standard").endswith("commercial.target_margin_pct")
    assert R.setting_source("margins.Target").endswith("scenario_margins_pct.Target")
    assert R.setting_source("factors.site_efficiency").endswith("productivity_factors.site_efficiency")
    assert "hygiene_inspection_chf" in R.setting_source("project_costs.hygiene")
