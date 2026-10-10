"""Deterministic pricing: position prices, statuses, project totals and bid scenarios.

Generalises ``research/pricing_engine.py`` (same arithmetic, same rounding, so the
22 golden examples reproduce exactly). Pure functions on plain dicts; the only
I/O is reading cached reference data through ``app.reference``.

    material = quantity × net unit cost × (1 + waste %)
    hours    = quantity × base hours per unit × Π factors   (site_efficiency applied as 1/value)
    labour   = hours × hourly rate
    direct   = material + labour                       (each rounded to 2 dp at output)
    cost     = (direct + extras) × (1 + transport %) × (1 + overhead %)
    bid(m)   = ceil(cost / (1 - m) / round_to) × round_to
    win(m)   = clamp(ref_win + appetite + competition - sensitivity × % above standard price)
"""
from __future__ import annotations

import math

from app import reference as ref

STATUSES = ["calculated", "supplier_quote_required", "assumption_applied", "review_required",
            "insufficient_information", "out_of_scope", "non_priceable"]
STATUS_LABELS = {
    "calculated": ("Priced", "Kalkuliert"),
    "assumption_applied": ("Priced, with a guess", "Mit Annahme"),
    "supplier_quote_required": ("Ask supplier", "Lieferantenofferte"),
    "review_required": ("Check this", "Prüfen"),
    "insufficient_information": ("Missing info", "Angaben fehlen"),
    "out_of_scope": ("Not priced", "Nicht kalkuliert"),
    "non_priceable": ("Not priced", "Nicht kalkuliert"),
}
REVIEW_STATUSES = {"review_required", "assumption_applied", "insufficient_information"}
EXCLUDED_STATUSES = {"out_of_scope", "non_priceable"}
CONFIDENT, WEAK = 0.75, 0.5
PRICE_SOURCE_WORDS = {"catalog": "catalogue net price", "supplier_package": "supplier package budget price",
                      "supplier_quote": "supplier quote", "manual": "entered by you"}


# ---------------------------------------------------------------- formatting

def swiss(n: float | int | None, dp: int = 2) -> str:
    """439000 -> "439'000", 1078.56 -> "1'078.56"."""
    if n is None:
        return ""
    s = f"{float(n):,.{dp}f}".replace(",", "'")
    return "0" + s[2:] if s.startswith("-0") and float(s.replace("'", "")) == 0 else s


def fmt_qty(q: float | None) -> str:
    if q is None:
        return ""
    q = float(q)
    if q == int(q):
        return swiss(q, 0)
    return swiss(q, 3).rstrip("0").rstrip(".")


def fmt_pct(p: float) -> str:
    p = float(p)
    return f"{p:.0f}%" if p == int(p) else f"{p:g}%"


def _half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def _pts(v: float) -> int:
    return _half_up(abs(v) * 100)


def _num(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


# ---------------------------------------------------------------- effective inputs

def _ov(position: dict) -> dict:
    return position.get("overrides") or {}


def effective_quantity(position: dict) -> float | None:
    q = _num(_ov(position).get("quantity"))
    return q if q is not None else _num(position.get("quantity"))


def effective_product_id(position: dict) -> str | None:
    return _ov(position).get("product_id") or (position.get("match") or {}).get("product_id") or None


def effective_install_code(position: dict, product: dict | None = None) -> str | None:
    if _ov(position).get("install_code"):
        return _ov(position)["install_code"]
    if _ov(position).get("product_id") and product and product.get("install_code"):
        # a manually changed product brings its own install rule
        return product["install_code"]
    return (position.get("match") or {}).get("install_code") or (product or {}).get("install_code") or None


def factor_trail(install_code: str | None, settings: dict, system_profile: str = "school") -> list[dict]:
    """Factors for one install rule, in rule order. Value is the setting; applied is what multiplies."""
    rule = ref.rule_row(install_code)
    if not rule:
        return []
    swap = ref.PROFILE_FACTOR_SWAP.get(system_profile or "school", {})
    factors = settings.get("factors") or {}
    out = []
    for k in rule["factor_keys"]:
        k = swap.get(k, k)
        v = float(factors[k])
        inv = k in ref.INVERTED_FACTORS
        out.append({"key": k, "label": ref.factor_label(k), "value": v,
                    "applied": round(1 / v if inv else v, 4), "op": "÷" if inv else "×", "_mult": 1 / v if inv else v})
    return out


def _unit_word(unit: str | None) -> str:
    return unit or "unit"


# ---------------------------------------------------------------- position pricing

def price_position(position: dict, settings: dict, system_profile: str = "school") -> dict | None:
    """SPEC PositionPrice for one position, or None when there is no product or no quantity."""
    s = ref.merge_settings(settings)
    ov = _ov(position)
    qty = effective_quantity(position)
    pid = effective_product_id(position)
    if not pid or qty is None or qty <= 0:
        return None
    product = ref.catalog_row(pid)

    # unit price: manual > supplier quote > catalogue (catalog | supplier_package)
    quote = position.get("supplier_quote") or {}
    if _num(ov.get("unit_price")) is not None:
        unit_cost, price_src = _num(ov["unit_price"]), "manual"
        src_text = "Entered by you"
    elif _num(quote.get("unit_price")) is not None:
        unit_cost, price_src = _num(quote["unit_price"]), "supplier_quote"
        src_text = "Supplier quote" + (f": {quote['source']}" if quote.get("source") else "")
    elif product is not None:
        unit_cost, price_src = float(product["net_cost_chf"]), product["source_type"]
        src_text = f"catalog.csv row {pid}" + (" (budget price)" if price_src == "supplier_package" else "")
    else:
        return None

    waste = float(s["material_waste_pct"])
    mat = qty * unit_cost * (1 + waste / 100)

    code = effective_install_code(position, product)
    rule = ref.rule_row(code)
    trail = factor_trail(code, s, system_profile) if rule else []
    f = 1.0
    for t in trail:
        f *= t["_mult"]
    base_h = float(rule["base_hours_per_unit"]) if rule else 0.0
    rate = float(rule["default_hourly_rate_chf"]) if rule else 0.0
    role = rule["labour_role"] if rule else None
    calc_hours = qty * base_h * f
    hours_ov = _num(ov.get("hours"))
    hours = hours_ov if hours_ov is not None else calc_hours
    lab = hours * rate

    unit = position.get("unit") or (product or {}).get("unit") or (rule or {}).get("unit")
    material, labour, direct = round(mat, 2), round(lab, 2), round(mat + lab, 2)
    factors = [{k: v for k, v in t.items() if k != "_mult"} for t in trail]

    # plain-word explain sentences
    q, u = fmt_qty(qty), _unit_word(unit)
    fac_words = " ".join(f"{t['op']} {t['value']:.2f} {t['label']}" for t in factors)
    if hours_ov is not None:
        hours_txt = f"Set by you: {swiss(hours)} h (the install rule gives {swiss(calc_hours)} h)"
    elif rule:
        hours_txt = f"{q} {u} × {swiss(base_h)} h" + (f" {fac_words}" if fac_words else "") + f" = {swiss(calc_hours)} h"
    else:
        hours_txt = "No install rule for this line, so no hours"
    explain = {
        "material": f"{q} {u} × CHF {swiss(unit_cost)} × (1 + {fmt_pct(waste)} waste) = CHF {swiss(material)}",
        "hours": hours_txt,
        "labour": (f"{swiss(hours)} h × CHF {swiss(rate, 0)}/h ({role}) = CHF {swiss(labour)}" if rule
                   else f"No install rule, labour CHF {swiss(labour)}"),
        "direct": f"{swiss(material)} + {swiss(labour)} = CHF {swiss(direct)}",
    }
    page = position.get("page") or (position.get("source") or {}).get("page")
    q_src = f"Tender p. {page}" if page else "Tender"
    if _num(ov.get("quantity")) is not None:
        q_src = f"Changed by you ({q_src.lower() if not page else q_src} says {fmt_qty(position.get('quantity'))})"
    sources = {
        "product": f"catalog.csv row {pid}" if product else f"Product {pid} (not in the catalogue)",
        "unit_price": src_text,
        "install_rule": f"productivity.csv {code}" if rule else "No install rule",
        "quantity": q_src,
        "factors": "Site factors in Pricing" + (" (sports hall)" if system_profile == "sports_hall" else ""),
    }
    if hours_ov is not None:
        sources["hours"] = "Entered by you"

    return {
        "quantity": qty, "unit": unit, "product_id": pid, "install_code": code,
        "net_unit_cost": unit_cost, "unit_price_source": price_src,
        "waste_pct": waste, "material": material,
        "base_hours_per_unit": base_h, "factors": factors,
        "factor_product": round(f, 6), "calculated_hours": round(calc_hours, 2),
        "hours": round(hours, 2), "hours_overridden": hours_ov is not None,
        "rate": rate, "role": role, "labour": labour, "direct": direct,
        "category": (product or {}).get("category") or "Other",
        "explain": explain, "sources": sources,
    }


# ---------------------------------------------------------------- status

def _confidence(position: dict) -> float | None:
    m = position.get("match") or {}
    if _ov(position).get("product_id") or m.get("method") == "manual":
        return 1.0
    return _num(m.get("confidence"))


def derive_status(position: dict, price: dict | None) -> tuple[str, str]:
    """(status, plain reason) following the SPEC status table.

    Precedence:
    1. kind subtotal / text_only -> non_priceable.
    2. A status set by the estimator (``overrides.status``, optional ``overrides.status_reason``) wins.
    3. A status the parser/matcher already fixed as out_of_scope or non_priceable (e.g. "bauseits",
       other trade, headings) is kept.
    4. No quantity or quantity 0 -> insufficient_information.
    5. No price (no product) -> review_required.
    6. Top match confidence < 0.5 -> review_required.
    7. Product needs a supplier quote (catalogue flag or the tender names an offer) ->
       supplier_quote_required; once a quote (or a manual unit price) is entered the reason
       becomes "Quote entered" and the line no longer needs review.
    8. No install rule for a priced product -> review_required.
    9. Confidence 0.5–0.75 or assumptions listed on the match -> assumption_applied.
    10. Otherwise calculated.
    """
    kind = position.get("kind") or "item"
    ov = _ov(position)
    if kind == "subtotal":
        return "non_priceable", "Total line in the tender, not a priced line"
    if kind == "text_only":
        return "non_priceable", "Text only, nothing to price"
    if ov.get("status") in STATUSES:
        return ov["status"], ov.get("status_reason") or "Set by you"
    if position.get("status") in EXCLUDED_STATUSES:
        default = "Not part of this offer" if position["status"] == "out_of_scope" else "Nothing to price"
        return position["status"], position.get("status_reason") or default

    qty = effective_quantity(position)
    page = position.get("page") or (position.get("source") or {}).get("page")
    if qty is None:
        return "insufficient_information", "No quantity in the tender"
    if qty <= 0:
        return "insufficient_information", "Quantity is 0 in the tender"

    conf = _confidence(position)
    m = position.get("match") or {}
    if price is None:
        if effective_product_id(position):
            return "review_required", "Product not in the catalogue and no unit price entered"
        cands = m.get("candidates") or []
        if cands:
            best = max((_num(c.get("score")) or 0) for c in cands)
            return "review_required", f"No confident match (best {best:.2f})"
        return "review_required", "No product matched yet"
    if conf is not None and conf < WEAK:
        return "review_required", f"No confident match (best {conf:.2f})"

    product = ref.catalog_row(price["product_id"]) or {}
    needs_quote = bool(product.get("supplier_quote_required")) or bool(position.get("offer_ref"))
    if needs_quote:
        if price["unit_price_source"] == "supplier_quote":
            return "supplier_quote_required", "Quote entered"
        if price["unit_price_source"] == "manual":
            return "supplier_quote_required", "Quote entered (price entered by you)"
        if position.get("offer_ref") and not product.get("supplier_quote_required"):
            return "supplier_quote_required", f"Tender names supplier offer {position['offer_ref']}: catalogue price until a quote is entered"
        return "supplier_quote_required", "Supplier package: budget price until a quote is entered"

    if not price["install_code"] or not ref.rule_row(price["install_code"]) or price["install_code"] == "UNKNOWN":
        if not price.get("hours_overridden"):
            return "review_required", "No install rule for this product, so labour is missing"
    assumptions = m.get("assumptions") or []
    if assumptions:
        return "assumption_applied", "Assumed: " + "; ".join(str(a) for a in assumptions)
    if conf is not None and conf < CONFIDENT:
        return "assumption_applied", f"Close match ({conf:.2f}): check type and size"
    where = f"quantity from tender p. {page}" if page else "quantity from the tender"
    src = {"manual": "Unit price entered by you", "supplier_quote": "Supplier quote"}.get(
        price["unit_price_source"], "Catalogue product")
    return "calculated", f"{src}, {where}"


def has_quote(position: dict) -> bool:
    return (_num((position.get("supplier_quote") or {}).get("unit_price")) is not None
            or _num(_ov(position).get("unit_price")) is not None)


def needs_review(position: dict, status: str | None = None) -> bool:
    """True when the estimator must look at the line.

    - flagged lines always need review (the estimator asked for it);
    - otherwise confirmed lines never do;
    - review_required, assumption_applied, insufficient_information need review;
    - supplier_quote_required needs review until a supplier quote (or a manual unit price) is entered.
    """
    if position.get("flagged"):
        return True
    if position.get("confirmed"):
        return False
    st = status or position.get("status")
    if st in REVIEW_STATUSES:
        return True
    if st == "supplier_quote_required":
        return not has_quote(position)
    return False


def position_profile(position: dict, systems: list[dict] | None, default: str = "school") -> str:
    for sy in systems or []:
        if (position.get("system") and position.get("system") in (sy.get("label"), sy.get("name"))) or \
           (position.get("system_key") and position.get("system_key") == sy.get("key")):
            return sy.get("profile") or default
    return position.get("profile") or default


def evaluate_position(position: dict, settings: dict, system_profile: str = "school") -> dict:
    """Copy of the position with fresh pricing, status, status_reason and needs_review."""
    price = price_position(position, settings, system_profile)
    status, reason = derive_status(position, price)
    out = dict(position)
    out.update(pricing=price, status=status, status_reason=reason)
    out["needs_review"] = needs_review(out, status)
    return out


def evaluate_positions(positions: list[dict], settings: dict, systems: list[dict] | None = None,
                       profile: str = "school") -> list[dict]:
    return [evaluate_position(p, settings, position_profile(p, systems, profile)) for p in positions]


def included(status: str, price: dict | None) -> bool:
    """A line counts in the totals when it has a price and is not excluded."""
    return price is not None and status not in EXCLUDED_STATUSES


# ---------------------------------------------------------------- explain

def explain_field(position: dict, price: dict | None, field: str) -> list[dict]:
    """Sentence steps [{text, value, source}] for material | hours | labour | direct."""
    if price is None:
        st, reason = derive_status(position, None)
        return [{"text": f"This line has no price: {reason[0].lower() + reason[1:]}", "value": "", "source": ""}]
    q, u = fmt_qty(price["quantity"]), _unit_word(price["unit"])
    srcs = price["sources"]
    if field == "material":
        net = price["quantity"] * price["net_unit_cost"]
        return [
            {"text": f"{q} {u} × CHF {swiss(price['net_unit_cost'])} per {u} ({PRICE_SOURCE_WORDS.get(price['unit_price_source'], 'unit price')})",
             "value": swiss(net), "source": srcs["unit_price"]},
            {"text": f"+ {fmt_pct(price['waste_pct'])} material waste", "value": swiss(price["material"]),
             "source": "Allowances in Pricing"},
        ]
    hours_steps: list[dict] = []
    if price.get("hours_overridden"):
        hours_steps.append({"text": f"Hours set by you (the install rule gives {swiss(price['calculated_hours'])} h)",
                            "value": f"{swiss(price['hours'])} h", "source": "Entered by you"})
    elif ref.rule_row(price["install_code"]):
        raw = price["quantity"] * price["base_hours_per_unit"]
        hours_steps.append({"text": f"{q} {u} × {swiss(price['base_hours_per_unit'])} h per {u} (install rule {price['install_code']})",
                            "value": f"{swiss(raw)} h", "source": srcs["install_rule"]})
        if price["factors"]:
            hours_steps.append({"text": ", ".join(f"{t['op']} {t['value']:.2f} {t['label']}" for t in price["factors"]),
                                "value": f"{swiss(price['hours'])} h", "source": srcs["factors"]})
    else:
        hours_steps.append({"text": "No install rule for this line, so no hours", "value": "0.00 h", "source": "No install rule"})
    if field == "hours":
        return hours_steps
    if field == "labour":
        role = price["role"] or "no role"
        return hours_steps + [{"text": f"× CHF {swiss(price['rate'], 0)} per hour ({role})",
                               "value": swiss(price["labour"]), "source": srcs["install_rule"]}]
    if field == "direct":
        return [{"text": "Material", "value": swiss(price["material"]), "source": srcs["unit_price"]},
                {"text": "+ Labour", "value": swiss(price["labour"]), "source": srcs["install_rule"]},
                {"text": "= Line total", "value": swiss(price["direct"]), "source": ""}]
    raise ValueError(f"Unknown field '{field}'. Use material, hours, labour or direct.")


def explain_title(field: str, price: dict | None) -> str:
    if price is None:
        return "Why this line has no price"
    if field == "hours":
        return f"Why the hours on this line are {swiss(price['hours'])} h"
    val = {"material": price["material"], "labour": price["labour"], "direct": price["direct"]}.get(field, 0)
    name = {"direct": "line total"}.get(field, field)
    return f"Why the {name} on this line is CHF {swiss(val)}"


# ---------------------------------------------------------------- totals and scenarios

def _bid(cost: float, margin_pct: float, round_to: float) -> float:
    return math.ceil(cost / (1 - margin_pct / 100) / round_to) * round_to


def scenarios(cost: float, settings: dict) -> tuple[list[dict], float]:
    """Bid options (Aggressive / Target / Standard / Conservative) and the standard reference price."""
    s = ref.merge_settings(settings)
    rnd = float(s["round_to"])
    std = float(s["margins"].get("Standard", ref.load_parameters()["commercial"]["target_margin_pct"]))
    ref_price = cost / (1 - std / 100)
    rows = []
    for name, m in s["margins"].items():
        m = float(m)
        bid = _bid(cost, m, rnd)
        rel = (bid / ref_price - 1) * 100 if ref_price else 0.0
        raw = s["ref_win"] + s["appetite"] + s["competition"] - s["sensitivity"] * rel
        p = min(max(raw, s["min_win"]), s["max_win"])
        rows.append({"name": name, "margin_pct": m, "bid": int(bid) if bid == int(bid) else bid,
                     "win": round(p, 2), "profit": round(bid - cost, 2), "expected": round(p * (bid - cost), 2),
                     "best": False, "rel_pct": round(rel, 4), "_p": p, "_raw": raw, "_ec": p * (bid - cost)})
    if rows:
        max(rows, key=lambda r: r["_ec"])["best"] = True
    return rows, ref_price


def _word(v: float, plus: str, minus: str) -> str:
    if v > 0:
        return f", plus {_pts(v)} {plus}"
    if v < 0:
        return f", minus {_pts(v)} {minus}"
    return ""


def win_sentence(row: dict, settings: dict, standard_price: float, ref_price: float) -> str:
    """Mirror of N07's "Why 63%: it starts at 55%, plus 5 because we want the job, ..." sentence."""
    s = ref.merge_settings(settings)
    rel = (row["bid"] / ref_price - 1) * 100 if ref_price else 0.0
    if abs(rel) < 0.05:
        price_words = ""
    elif rel < 0:
        price_words = f", plus {s['sensitivity'] * -rel * 100:.0f} because this price is {-rel:.1f}% below the standard price"
    else:
        price_words = f", minus {s['sensitivity'] * rel * 100:.0f} because this price is {rel:.1f}% above the standard price"
    std = float(s["margins"].get("Standard", 0))
    out = (f"Why {_half_up(row['_p'] * 100)}%: it starts at {_half_up(s['ref_win'] * 100)}%"
           + _word(s["appetite"], "because we want the job", "because the job is not a priority")
           + _word(s["competition"], "for light competition", "for strong competition")
           + price_words + f" (CHF {swiss(standard_price, 0)} at {std:.1f}%)")
    if row["_raw"] > s["max_win"]:
        out += f", capped at {_half_up(s['max_win'] * 100)}%"
    elif row["_raw"] < s["min_win"]:
        out += f", floored at {_half_up(s['min_win'] * 100)}%"
    return out + "."


def project_totals(positions: list[dict], settings: dict, systems: list[dict] | None = None,
                   profile: str = "school") -> dict:
    """SPEC Totals for a tender. Prices every position afresh (never trusts stored pricing)."""
    s = ref.merge_settings(settings)
    params = ref.load_parameters()
    evaluated = []
    for p in positions:
        price = price_position(p, s, position_profile(p, systems, profile))
        status, reason = derive_status(p, price)
        evaluated.append((p, price, status, reason))

    inc = [(p, pr) for p, pr, st, _ in evaluated if included(st, pr)]
    material = round(sum(pr["material"] for _, pr in inc), 2)
    labour = round(sum(pr["labour"] for _, pr in inc), 2)
    direct = round(sum(pr["material"] + pr["labour"] for _, pr in inc), 2)

    amounts = ref.project_cost_amounts(params)
    pc_labels = ref.project_cost_labels(params)
    pc_on = s.get("project_costs") or {}
    project_costs = round(sum(a for k, a in amounts.items() if pc_on.get(k)), 2)
    catalog_material = sum(pr["material"] for _, pr in inc if pr["unit_price_source"] == "catalog")
    package_material = sum(pr["material"] for _, pr in inc if pr["unit_price_source"] == "supplier_package")
    small = round(catalog_material * s["small_material_pct"] / 100, 2) if s.get("include_small_material") else 0.0
    contingency = (round(package_material * s["supplier_contingency_pct"] / 100, 2)
                   if s.get("include_supplier_contingency") else 0.0)

    base = direct + project_costs + small + contingency
    cost = base * (1 + s["transport_pct"] / 100) * (1 + s["overhead_pct"] / 100)
    transport = base * s["transport_pct"] / 100
    overhead = cost - base - transport

    rows, ref_price = scenarios(cost, s)
    rnd = float(s["round_to"])
    standard_price = _bid(cost, float(s["margins"].get("Standard", 0)), rnd)
    standard_price = int(standard_price) if standard_price == int(standard_price) else standard_price
    chosen = next((r for r in rows if r["name"] == s.get("chosen")), None)
    shown = chosen or next((r for r in rows if r["name"] == "Target"), rows[1] if len(rows) > 1 else rows[0])
    win_explain = win_sentence(shown, s, standard_price, ref_price)

    # build-up (N07 "How the cost adds up")
    n_lines = len(inc)
    buildup = [{"key": "direct", "label": f"Direct cost, {n_lines} line{'s' if n_lines != 1 else ''}", "value": direct}]
    if project_costs:
        buildup.append({"key": "project_costs", "label": "+ Project costs switched on", "value": project_costs})
    if small:
        buildup.append({"key": "small_material", "label": f"+ Small material {s['small_material_pct']:.1f}% of catalogue material", "value": small})
    if contingency:
        buildup.append({"key": "supplier_contingency", "label": f"+ Supplier package contingency {s['supplier_contingency_pct']:.1f}%", "value": contingency})
    buildup += [
        {"key": "transport", "label": f"+ Transport and equipment {s['transport_pct']:.1f}%", "value": round(transport, 2)},
        {"key": "overhead", "label": f"+ Overhead {s['overhead_pct']:.1f}%", "value": round(overhead, 2)},
        {"key": "cost", "label": "Cost", "value": round(cost, 2), "strong": True},
        {"key": "margin", "label": f"+ {shown['name']} margin {shown['margin_pct']:.1f}%, rounded up to {swiss(rnd, 0)}",
         "value": round(shown["bid"] - cost, 2)},
        {"key": "offer", "label": "Offer price" if chosen else f"Offer price ({shown['name']}, not chosen yet)",
         "value": shown["bid"], "strong": True},
    ]

    # by system / category
    sys_order = [sy.get("label") or sy.get("name") for sy in systems or []]
    by_sys: dict[str, dict] = {}
    by_cat: dict[str, dict] = {}
    for p, pr, st, _ in evaluated:
        if st == "non_priceable":
            continue
        key = p.get("system") or "No system"
        row = by_sys.setdefault(key, {"system": key, "system_key": p.get("system_key"), "material": 0.0, "labour": 0.0,
                                      "direct": 0.0, "lines": 0, "priced": 0, "to_review": 0})
        row["lines"] += 1
        p_eval = dict(p, status=st)
        row["to_review"] += needs_review(p_eval, st)
        if included(st, pr):
            row["priced"] += 1
            row["material"] += pr["material"]
            row["labour"] += pr["labour"]
            row["direct"] += pr["material"] + pr["labour"]
            c = by_cat.setdefault(pr["category"], {"category": pr["category"], "material": 0.0, "labour": 0.0, "direct": 0.0, "lines": 0})
            c["lines"] += 1
            c["material"] += pr["material"]
            c["labour"] += pr["labour"]
            c["direct"] += pr["material"] + pr["labour"]
    for r in list(by_sys.values()) + list(by_cat.values()):
        for k in ("material", "labour", "direct"):
            r[k] = round(r[k], 2)
    by_system = sorted(by_sys.values(), key=lambda r: (sys_order.index(r["system"]) if r["system"] in sys_order else len(sys_order), r["system"]))
    by_category = sorted(by_cat.values(), key=lambda r: -r["direct"])

    coverage = {k: 0 for k in STATUSES}
    for _, _, st, _ in evaluated:
        coverage[st] = coverage.get(st, 0) + 1
    budget = [(p, pr) for p, pr in inc if pr["unit_price_source"] == "supplier_package"]
    budget_direct = round(sum(pr["material"] + pr["labour"] for _, pr in budget), 2)
    quotes = sum(1 for p, pr in inc if pr["unit_price_source"] == "supplier_quote")
    to_review = sum(1 for p, pr, st, _ in evaluated if needs_review(dict(p, status=st), st))

    out_rows = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    offer = None
    if chosen:
        offer = {"name": chosen["name"], "margin_pct": chosen["margin_pct"], "bid": chosen["bid"],
                 "win": chosen["win"], "profit": chosen["profit"], "expected": chosen["expected"]}
    return {
        "material": material, "labour": labour, "direct": direct,
        "project_costs": project_costs, "small_material": small, "supplier_contingency": contingency,
        "transport": round(transport, 2), "overhead": round(overhead, 2), "cost": round(cost, 2),
        "standard_price": standard_price, "standard_margin_pct": float(s["margins"].get("Standard", 0)),
        "scenarios": out_rows, "chosen": s.get("chosen") if chosen else None, "offer": offer,
        "offer_price": chosen["bid"] if chosen else None,
        "win_explain": win_explain, "buildup": buildup,
        "by_system": by_system, "by_category": by_category, "coverage": coverage,
        "lines_total": len(positions), "lines_priced": n_lines,
        "lines_priceable": sum(1 for _, _, st, _ in evaluated if st != "non_priceable"),
        "to_review": to_review,
        "budget_direct": budget_direct, "budget_lines": len(budget),
        "budget_share": round(budget_direct / direct, 4) if direct else 0.0,
        "quotes_entered": quotes,
        "project_costs_detail": [{"key": k, "label": pc_labels[k], "amount": round(a, 2), "on": bool(pc_on.get(k))}
                                 for k, a in amounts.items()],
        "project_costs_all": round(sum(amounts.values()), 2),
    }
