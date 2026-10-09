"""Deterministic pricing engine for the Equans Oberglatt case.

Reproduces every number in expected_output_example.json (22 positions,
subset summary and the 3 bid scenarios). The LLM only picks product_id and
install_code; everything below is plain arithmetic.

Usage: python pricing_engine.py [package_dir]
"""
import json, math, sys
from pathlib import Path
import pandas as pd

D = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
catalog = pd.read_csv(D / "catalog.csv").set_index("product_id")
prod = pd.read_csv(D / "productivity.csv").set_index("install_code")
params = json.load(open(D / "project_parameters.json"))
F, A, C = params["productivity_factors"], params["allowances"], params["commercial"]


def factor(install_code, overrides=None):
    """Product of project factors for one install rule. site_efficiency is inverted."""
    keys = str(prod.loc[install_code, "factor_keys"]).split("|")
    f, trail = 1.0, []
    for k in filter(None, keys):
        k = (overrides or {}).get(k, k)  # e.g. swap mounting_height_school -> _sports_hall
        v = 1 / F[k] if k == "site_efficiency" else F[k]
        f *= v
        trail.append((k, round(v, 4)))
    return f, trail


def price_position(lv_id, qty, product_id, install_code, overrides=None):
    p, r = catalog.loc[product_id], prod.loc[install_code]
    mat = qty * p.net_cost_chf * (1 + A["material_waste_pct"] / 100)
    f, trail = factor(install_code, overrides)
    hours = qty * r.base_hours_per_unit * f
    lab = hours * r.default_hourly_rate_chf
    return {
        "lv_id": lv_id, "matched_product_id": product_id, "install_code": install_code,
        "quantity": qty, "net_unit_cost_chf": p.net_cost_chf,
        "material_cost_chf": round(mat, 2), "adjusted_install_hours": round(hours, 2),
        "labour_cost_chf": round(lab, 2), "direct_position_cost_chf": round(mat + lab, 2),
        "price_source": p.source_type,
        "status": "supplier_quote_required" if str(p.supplier_quote_required).lower() == "true" else "calculated",
        # traceability: every operand of the formula
        "explain": {
            "material": f"{qty} x {p.net_cost_chf} x (1 + {A['material_waste_pct']}%)",
            "hours": f"{qty} x {r.base_hours_per_unit} h x factors {trail}",
            "labour": f"{round(hours, 4)} h x {r.default_hourly_rate_chf} CHF/h ({r.labour_role})",
        },
    }


def cost_baseline(direct):
    # Matches the golden subset: transport/equipment on direct cost, then overhead.
    # NOTE for the full LV also add engineering, commissioning, hygiene, documentation
    # (project_costs) and decide on small_material / supplier contingency. Ask Equans.
    return direct * (1 + A["transport_equipment_pct"] / 100) * (1 + C["overhead_pct"] / 100)


def bid_scenarios(baseline):
    b = params["stretch_bid_optimization"]
    ref_price = baseline / (1 - C["target_margin_pct"] / 100)  # price at the standard 5.5% margin
    out = []
    for name, m in b["scenario_margins_pct"].items():
        bid = math.ceil(baseline / (1 - m / 100) / C["round_to_chf"]) * C["round_to_chf"]
        rel_pct = (bid / ref_price - 1) * 100
        p = (b["reference_win_probability"] + b["strategic_appetite_adjustment"]
             + b["competition_adjustment"] - b["price_sensitivity_probability_points_per_1pct_price"] * rel_pct)
        p = min(max(p, b["minimum_probability"]), b["maximum_probability"])
        out.append({"scenario": name, "bid_price_chf": bid, "margin_pct": m,
                    "estimated_win_probability": round(p, 2),
                    "expected_contribution_chf": round(p * (bid - baseline), 2)})
    return out


if __name__ == "__main__":
    ex = pd.read_csv(D / "example_lv_positions.csv")
    gold = json.load(open(D / "expected_output_example.json"))
    g = {x["lv_id"]: x for x in gold["position_results"]}
    res = [price_position(r.lv_id, r.quantity, r.suggested_product_id, r.expected_install_code) for r in ex.itertuples()]
    ok = sum(abs(x["direct_position_cost_chf"] - g[x["lv_id"]]["direct_position_cost_chf"]) < 0.05
             and x["status"] == g[x["lv_id"]]["status"] for x in res)
    print(f"positions matching golden output: {ok}/{len(res)}")
    direct = sum(x["material_cost_chf"] + x["labour_cost_chf"] for x in res)
    base = cost_baseline(direct)
    print(f"direct {direct:,.2f} (gold {gold['example_subset_summary']['direct_cost_chf']:,})")
    print(f"baseline {base:,.2f} (gold {gold['example_subset_summary']['cost_baseline_chf']:,})")
    for s, gs in zip(bid_scenarios(base), gold["recommended_bid_range"]["scenarios"]):
        print(s, "| gold:", gs["bid_price_chf"], gs["estimated_win_probability"], gs["expected_contribution_chf"])
    print("\nexample explain for LV0001:", json.dumps(res[0]["explain"], indent=1))
