"""Verified against Equans examples: compare our numbers with Equans' golden numbers.

This is an evaluation, not pipeline logic. Nothing here feeds parsing, matching or pricing:
it reads the tender as the pipeline left it, finds the parsed line behind each verified
example row (same page, same quantity and unit, best size match), prices it with the
default settings and compares with `expected_output_example.json`.

Benchmark files (optional) live in data/reference/benchmark/:
  example_lv_positions.csv, expected_output_example.json
When they are missing, verify() returns {"loaded": False, ...} ("no benchmark loaded").
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

from . import config
from . import pricing as P
from . import reference as ref
from .units import normalize_unit

BENCHMARK_DIR = config.REFERENCE_DIR / "benchmark"
EXAMPLES_FILE = "example_lv_positions.csv"
GOLDEN_FILE = "expected_output_example.json"
MONEY_TOL = 0.01

_NUM = re.compile(r"\d+(?:[.,]\d+)?")


def _load(dir_: Path | None = None) -> tuple[list[dict], dict] | None:
    d = Path(dir_ or BENCHMARK_DIR)
    ex, gold = d / EXAMPLES_FILE, d / GOLDEN_FILE
    if not ex.exists() or not gold.exists():
        return None
    with open(ex, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return rows, json.loads(gold.read_text("utf-8"))


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _nums(text: str | None) -> set[float]:
    return {float(m.replace(",", ".")) for m in _NUM.findall(text or "")}


def _attr_nums(v) -> set[float]:
    if isinstance(v, bool):
        return set()
    if isinstance(v, (int, float)):
        return {float(v)}
    if isinstance(v, str):
        return _nums(v)
    if isinstance(v, (list, tuple)):
        return set().union(*(_attr_nums(x) for x in v)) if v else set()
    if isinstance(v, dict):
        return set().union(*(_attr_nums(x) for x in v.values())) if v else set()
    return set()


def _size_score(example_desc: str, pos: dict) -> int:
    """How many of the example's numbers (DN, dimensions, thickness) the parsed line carries."""
    want = _nums(example_desc)
    have = _attr_nums(pos.get("attributes") or {})
    for t in (pos.get("title_de"), pos.get("title_en")):
        n = _nums(t)
        have |= n | {x * 10 for x in n}  # "Ø 10 cm" -> 100 mm
    return len(want & have)


def _find(row: dict, positions: list[dict], used: set[str]) -> dict | None:
    page, qty = int(row["source_page"]), _f(row["quantity"])
    unit = normalize_unit(row["unit"]) or row["unit"]
    cands = [p for p in positions
             if (p.get("page") or (p.get("source") or {}).get("page")) == page
             and qty is not None and _f(p.get("quantity")) is not None and abs(_f(p["quantity"]) - qty) < 1e-6
             and (normalize_unit(p.get("unit")) or p.get("unit")) == unit
             and p.get("lv_id") not in used]
    if not cands:
        return None
    # best size match; ties keep tender order
    return max(enumerate(cands), key=lambda ic: (_size_score(row["description"], ic[1]), -ic[0]))[1]


def verify(tender: dict, settings: dict | None = None, benchmark_dir: Path | None = None) -> dict:
    """Compare the tender's lines and subset totals with the golden example numbers.

    Pricing uses `settings` (default: the project's default settings, which is what the golden
    numbers assume), never the estimator's current what-if settings, and the standard catalogue,
    never an active supplier or negotiated price list (the golden numbers are catalogue prices)."""
    from app import price_lists
    with price_lists.using([]):
        return _verify(tender, settings, benchmark_dir)


def _verify(tender: dict, settings: dict | None, benchmark_dir: Path | None) -> dict:
    data = _load(benchmark_dir)
    if data is None:
        return {"loaded": False, "message": "No benchmark loaded", "rows": [], "summary": None}
    examples, gold = data
    s = ref.merge_settings(settings) if settings else ref.default_settings()
    gold_pos = {g["lv_id"]: g for g in gold.get("position_results") or []}
    positions = tender.get("positions") or []
    systems = tender.get("systems") or []
    profile = tender.get("profile") or "school"

    rows, matched, used = [], [], set()
    for ex in examples:
        g = gold_pos.get(ex["lv_id"], {})
        golden_direct = _f(g.get("direct_position_cost_chf"))
        pos = _find(ex, positions, used)
        row = {"example_id": ex["lv_id"], "page": int(ex["source_page"]), "description": ex["description"],
               "quantity": _f(ex["quantity"]), "unit": ex["unit"],
               "our_lv_id": None, "found": False,
               "our_product_id": None, "golden_product_id": ex.get("suggested_product_id") or None,
               "product_ok": False,
               "our_install_code": None, "golden_install_code": ex.get("expected_install_code") or None,
               "install_ok": False,
               "our_direct": None, "golden_direct": golden_direct, "direct_ok": False,
               "our_status": None, "golden_status": g.get("status") or ex.get("ground_truth_status"),
               "status_ok": False}
        if pos is not None:
            used.add(pos["lv_id"])
            matched.append(pos)
            ev = P.evaluate_position(pos, s, P.position_profile(pos, systems, profile))
            price = ev.get("pricing")
            pid = P.effective_product_id(pos)
            code = price["install_code"] if price else P.effective_install_code(pos, ref.catalog_row(pid))
            direct = price["direct"] if price else None
            row.update(
                our_lv_id=pos["lv_id"], found=True,
                our_product_id=pid, product_ok=bool(pid) and pid == row["golden_product_id"],
                our_install_code=code, install_ok=bool(code) and code == row["golden_install_code"],
                our_direct=direct,
                direct_ok=direct is not None and golden_direct is not None and abs(direct - golden_direct) <= MONEY_TOL,
                our_status=ev["status"], status_ok=ev["status"] == row["golden_status"],
                # an active price list replaces the catalogue price the examples were computed with
                price_list=((price or {}).get("price_list") or {}).get("name"),
            )
        rows.append(row)

    totals = P.project_totals(matched, s, systems, profile)
    gsum = gold.get("example_subset_summary") or {}
    ours_sc = {r["name"]: r for r in totals["scenarios"]}
    sc_rows = []
    for gs in (gold.get("recommended_bid_range") or {}).get("scenarios") or []:
        o = ours_sc.get(gs["scenario"])
        ok = bool(o) and (o["bid"] == gs["bid_price_chf"] and abs(o["margin_pct"] - gs["margin_pct"]) < 1e-9
                          and abs(o["win"] - gs["estimated_win_probability"]) < 1e-9
                          and abs(o["expected"] - gs["expected_contribution_chf"]) <= MONEY_TOL)
        sc_rows.append({"scenario": gs["scenario"], "ok": ok,
                        "our_bid": o["bid"] if o else None, "golden_bid": gs["bid_price_chf"],
                        "our_win": o["win"] if o else None, "golden_win": gs["estimated_win_probability"],
                        "our_expected": o["expected"] if o else None,
                        "golden_expected": gs["expected_contribution_chf"]})

    def _eq(a, b):
        return a is not None and b is not None and abs(a - b) <= MONEY_TOL

    summary = {
        "total": len(rows),
        "found": sum(r["found"] for r in rows),
        "product_ok": sum(r["product_ok"] for r in rows),
        "install_ok": sum(r["install_ok"] for r in rows),
        "direct_ok": sum(r["direct_ok"] for r in rows),
        "status_ok": sum(r["status_ok"] for r in rows),
        "price_list_rows": sum(1 for r in rows if r.get("price_list") and not r["direct_ok"]),
        "subset_direct_ours": totals["direct"],
        "subset_direct_golden": _f(gsum.get("direct_cost_chf")),
        "subset_direct_ok": _eq(totals["direct"], _f(gsum.get("direct_cost_chf"))),
        "subset_cost_ours": totals["cost"],
        "subset_cost_golden": _f(gsum.get("cost_baseline_chf")),
        "subset_cost_ok": _eq(totals["cost"], _f(gsum.get("cost_baseline_chf"))),
        "scenarios_ok": bool(sc_rows) and all(r["ok"] for r in sc_rows),
        "scenarios": sc_rows,
    }
    return {"loaded": True, "source": gold.get("source_tender_file"), "scope": gold.get("scope"),
            "rows": rows, "summary": summary}
