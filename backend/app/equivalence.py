"""Equivalent products across manufacturers: what the tender asks for vs what we offer, in code.

    make_rule(position, parent=None) -> how the tender names a make for this line
    compare(position, product_row) -> {verdict, rows[{key, attribute, tender, snippet, product, verdict}], summary}
    annotate(position, match, rows_by_id, parent=None) -> match with comparison + make_rule (+ review note)
    with_variant_rule(rule, instructions, product_row) -> make_rule plus the tender's variant rule and
                                                          whether our product is a variant

A make in the tender is either an example ("z.B.", "oder gleichwertig": another manufacturer's equivalent
product is fine), named (no equivalence wording either way: offered as equivalent, not flagged, the way
Equans prices these lines), prescribed ("vorgeschrieben", "kein Ersatz": another make is a variant that
needs a reason, see the tender's Varianten rule) or left open for the bidder ("Fabrikat ......"). Verdicts per attribute: same | equivalent | differs | unknown. Deterministic: only the
tender text, the matcher's rules-only attributes and the catalogue row are used.
"""
from __future__ import annotations

import re

from . import matcher

# ---------------------------------------------------------------- make rule

EXAMPLE_RX = re.compile(
    r"\bz\.\s?B\b\.?|\bzum\s+beispiel\b|\bgleichwertig|\bo\.\s?glw\b|\bglw\.|\bod(?:er|\.)\s+gleichw|"
    r"\b(?:referenz|richt|leit)fabrikat|\bals\s+beispiel\b|\bähnlich\b", re.I)
PRESCRIBED_RX = re.compile(
    r"\bvorgeschrieben|\bvorgegeben|\bzwingend|\bkein\w*\s+(?:ersatz|alternativ\w*|variant\w*|fremdfabrikat\w*|"
    r"gleichwertig\w*)|\bausschliesslich\b|\bnur\s+(?:das\s+)?fabrikat|\bnicht\s+zugelassen|\bobligatorisch", re.I)
MAKE_LINE_RX = re.compile(r"^(?:[\wäöüÄÖÜ.\-]+\s+)?(Fabrikat|Hersteller|Marke|Produkt)\b\s*:?\s*(.*)$", re.I)
TYPE_LINE_RX = re.compile(r"^(?:[\wäöüÄÖÜ.\-]+\s+)?Typ\b\s*:?\s*(.*)$", re.I)
BLANK_RX = re.compile(r"^[.\s…_:-]*$|angabe\s+(?:des\s+)?(?:unternehmer|anbieter|bieter)|\bbieterangabe|"
                      r"\banzugeben\b|\bangeben\b|\beinzusetzen\b|\bfrei\s+wählbar|\bnach\s+wahl\b", re.I)


def _clean(v: str) -> str:
    v = re.sub(r"\bz\.\s?B\b\.?\s*:?\s*", "", v, flags=re.I)
    v = re.sub(r"\b(?:oder|od\.)\s+gleichwertig\w*.*$", "", v, flags=re.I)
    return re.split(r"\s{3,}", v.strip(" ,;:"))[0].strip(" ,;:")


def _lines(position: dict) -> list[str]:
    return [ln.rstrip() for ln in str(position.get("text_de") or "").splitlines() if ln.strip()]


def _squash(s: str, n: int = 140) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def _make_lines(lines: list[str]) -> tuple[int | None, int | None]:
    """Index of the line naming the make (first 'Fabrikat'), and of the first 'Typ' line."""
    mi = next((i for i, ln in enumerate(lines) if MAKE_LINE_RX.match(ln.strip())), None)
    ti = next((i for i, ln in enumerate(lines) if TYPE_LINE_RX.match(ln.strip())), None)
    return mi, ti


def make_rule(position: dict, parent: dict | None = None) -> dict:
    """{kind: example|named|prescribed|open|none, make, model, wording, snippet, explicit, inherited}.

    example     the tender names a make as an example: an equivalent product from another make is fine
    named       the tender names a make without equivalence wording: offered as equivalent, shown, not flagged
    prescribed  the tender says explicitly that only this make is accepted
    open        the tender leaves the make for the bidder to fill in ("Fabrikat ..........")
    none        no make named for this line
    """
    lines = _lines(position)
    mi, ti = _make_lines(lines)
    inherited = False
    if mi is None and parent is not None and position.get("make_hint"):
        # a part of a unit (e.g. a casing section of an air-handling unit): the make is named on the unit
        lines, inherited = _lines(parent), True
        mi, ti = _make_lines(lines)
    if mi is None:
        make = position.get("make_hint")
        return {"kind": "none" if not make else "example", "make": make, "model": position.get("model_hint"),
                "wording": None, "snippet": None, "explicit": False, "inherited": inherited}
    raw_make = MAKE_LINE_RX.match(lines[mi].strip()).group(2)
    raw_type = TYPE_LINE_RX.match(lines[ti].strip()).group(1) if ti is not None else ""
    # "Trox Hesco (vorgeschrieben, kein Ersatz)" / "Trox Hesco, vorgeschrieben": the wording is not part of the make
    bare_make = re.sub(r"\s*\([^)]*\)|\s*[,;].*$", lambda m: "" if PRESCRIBED_RX.search(m.group(0)) else m.group(0), raw_make)
    make = _clean(bare_make) or position.get("make_hint")
    model = _clean(raw_type) or position.get("model_hint")
    # the make line and the type line, each with its continuation ("oder gleichwertig" on its own line)
    cont = re.compile(r"^\s*(?:oder|od\.)\s+gleich", re.I)
    snippet_idx: list[int] = []
    for i in (mi, ti):
        if i is None or i in snippet_idx:
            continue
        snippet_idx.append(i)
        if i + 1 < len(lines) and cont.match(lines[i + 1]):
            snippet_idx.append(i + 1)
    near_text = [lines[i] for i in snippet_idx]
    snippet = "\n".join(_squash(lines[i], 100) for i in snippet_idx)
    explicit = next((m.group(0) for ln in lines if (m := PRESCRIBED_RX.search(ln))), None)
    example = next((m.group(0) for ln in near_text if (m := EXAMPLE_RX.search(ln))), None)
    if not _clean(raw_make) or BLANK_RX.search(raw_make):
        kind, wording = "open", None
    elif explicit:
        kind, wording = "prescribed", explicit
    elif example:
        kind, wording = "example", example
    else:
        kind, wording = "named", None  # named without "z.B." / "oder gleichwertig": Equans prices these as equivalent
    return {"kind": kind, "make": make if kind != "open" else None, "model": model if kind != "open" else None,
            "wording": wording, "snippet": snippet, "explicit": bool(explicit), "inherited": inherited}


def same_maker(make: str | None, manufacturer: str | None) -> bool:
    if not make or not manufacturer:
        return False
    a = re.sub(r"[^a-z0-9]", "", make.lower())
    b = re.sub(r"[^a-z0-9]", "", manufacturer.lower())
    first = re.sub(r"[^a-z0-9]", "", make.split()[0].lower()) if make.split() else ""
    return bool(a and b and (a in b or b in a or (len(first) >= 3 and first in b)))


def review_note(rule: dict, row: dict | None) -> str | None:
    """A reason to look at the line: the make is prescribed and our product is from another manufacturer."""
    if not row or rule.get("kind") != "prescribed" or same_maker(rule.get("make"), row.get("manufacturer")):
        return None
    how = f'"{rule["wording"]}"' if rule.get("wording") else 'without "or equivalent"'
    named = " ".join(x for x in (rule.get("make"), rule.get("model")) if x)
    return (f"Tender prescribes {named} ({how}); {row.get('manufacturer') or 'our product'} is another make: "
            f"offer it as a variant with a reason, or confirm")


def with_variant_rule(rule: dict, instructions: list[dict] | None, row: dict | None) -> dict:
    """The make rule as shown on a line: plus the tender's variant rule and whether our product is a variant."""
    vr = next((i for i in instructions or [] if re.search(r"variant", f"{i.get('type')} {i.get('section')}", re.I)), None)
    differs = bool(row and rule.get("make") and not same_maker(rule.get("make"), row.get("manufacturer")))
    return {**rule,
            "product_manufacturer": (row or {}).get("manufacturer"),
            "manufacturer_differs": differs,
            "variant_needed": differs and rule.get("kind") == "prescribed",
            "variant_rule": ({k: vr.get(k) for k in ("id", "type", "page", "section", "text_de", "text_en")}
                             if vr else None)}


# ---------------------------------------------------------------- attribute comparison

def _find(lines: list[str], rx: str | re.Pattern, default: str | None = None) -> str | None:
    r = re.compile(rx, re.I) if isinstance(rx, str) else rx
    return next((_squash(ln) for ln in lines if r.search(ln)), default)


def _mm(v) -> str:
    return f"{int(v)} mm" if v == int(v) else f"{v} mm"


def _product_material(desc: str) -> str | None:
    d = desc.lower()
    for rx, m in ((r"stainless|v2a|v4a", "stainless steel"), (r"galvani[sz]ed", "galvanized steel"),
                  (r"mineral wool", "mineral wool"), (r"plastic|pvc|\bpp\b", "plastic"), (r"aluminium", "aluminium")):
        if re.search(rx, d):
            return m
    return None


TENDER_MATERIALS = [
    (r"mineralwoll|steinwoll", "mineral wool"),
    (r"kunststoff|\bpvc\b|polypropylen", "plastic"),
    (r"\bv2a\b|\bv4a\b|chromnickel|chromstahl|rostfrei|edelstahl|inox", "stainless steel"),
    (r"verzinkt|sendzimir|sendizimir|galvanis", "galvanized steel"),
    (r"\balu(?:minium)?\b", "aluminium"),
]


def _tender_materials(lines: list[str]) -> list[tuple[str, str]]:
    """(material, quoted line) the tender states for the item: 'Material ...' lines and the first 3 lines."""
    picked = [ln for i, ln in enumerate(lines) if i < 3 or re.match(r"^\s*material\b", ln, re.I)]
    out: list[tuple[str, str]] = []
    for ln in picked:
        for rx, m in TENDER_MATERIALS:
            if re.search(rx, ln, re.I) and m not in [x for x, _ in out]:
                out.append((m, _squash(ln)))
    return out


def _product_length(row: dict, ca: dict) -> float | None:
    m = re.search(r"length\s*(\d+)\s*mm", str(row.get("description") or ""), re.I)
    if m:
        return float(m.group(1))
    dims = ca.get("dims_mm") or []
    return float(dims[2]) if len(dims) == 3 else None


ACTUATOR_RX = re.compile(r"stellantrieb|antrieb|stellmotor|\bmotor\b|federrücklauf", re.I)
ACTUATED = ("fire_damper", "damper", "flow_controller")


def _row(key: str, attribute: str, tender, snippet, product, verdict: str, note: str | None = None) -> dict:
    out = {"key": key, "attribute": attribute, "tender": tender, "snippet": snippet, "product": product,
           "verdict": verdict}
    if note:
        out["note"] = note
    return out


def compare(position: dict, row: dict | None, rule: dict | None = None, attrs: dict | None = None) -> dict | None:
    """Tender asks vs we offer, attribute by attribute, for one catalogue product."""
    if not row:
        return None
    pa = attrs or matcher.normalize(position)
    ca = matcher.catalog_attrs(row)
    sc = matcher.score_candidate(pa, row)
    rule = rule or make_rule(position)
    lines = _lines(position)
    own = matcher._own_line(position)
    fam = matcher.family_of(pa.get("type")) or matcher.family_of(f"{row.get('subcategory')} {row.get('description')}".lower())
    rows: list[dict] = []

    # type / function
    head = lines[0] if lines else position.get("title_de")
    prod_type = " · ".join(x for x in (row.get("subcategory"), row.get("category")) if x) or row.get("description")
    if not pa.get("type"):
        tv = "unknown"
    elif sc["type_ok"]:
        tv = "same"
    else:
        tv = "differs"
    note = None
    if sc["flow_conflict"]:
        note = f"Tender says {pa['flow']} air, product is {ca['flow']}"
    elif sc["excl_conflict"]:
        note = "Variable (VAV) vs constant (CAV) flow"
    elif sc["shape_conflict"]:
        note = f"Tender is {pa.get('shape')}, product is {ca.get('shape')}"
    rows.append(_row("type", "Type", pa.get("type"), _squash(head or ""), prod_type, tv, note))

    # size: diameter / dimensions / insulation thickness (airflow below for units without a size)
    t_size = matcher.size_label(pa)
    p_size = matcher.size_label(ca)
    if p_size or (t_size and not ca.get("airflow_m3h")):
        size_snip = None
        if pa.get("size_text"):
            size_snip = _find(lines, re.escape(pa["size_text"]))
        elif pa.get("thickness_mm"):
            size_snip = _find(lines, rf"\b{pa['thickness_mm']}\s*mm|\b{pa['thickness_mm']}/\d")
        size_snip = size_snip or (_squash(own) if own else None)
        state, kind = matcher._size_state(pa, ca)
        if kind == "angle":
            state, kind = matcher._size_state({**pa, "angle_deg": None}, ca)
        if state == 1:
            sv = "same"
        elif state == -1:
            sv = "differs"
        else:
            sv = "unknown"
        snote = None
        if sv == "same" and pa.get("size_text") and t_size and pa["size_text"].replace(" ", "") != t_size.replace(" ", ""):
            snote = f"{pa['size_text']} = {t_size}"
        elif sv == "unknown":
            snote = "Tender states no size" if not t_size else "Catalogue states no size"
        rows.append(_row("size", "Size", t_size, size_snip, p_size, sv, snote))

    # length (silencers: the tender's length can differ from the catalogue's)
    t_len = pa.get("length_mm")
    p_len = _product_length(row, ca)
    if t_len and (p_len or fam == "silencer"):
        lv = "unknown" if not p_len else ("same" if abs(float(t_len) - p_len) <= max(2.0, 0.01 * p_len) else "differs")
        # a 'Länge ...' table header plus this line's own row, else the first line that says Länge
        header = _find(lines, r"^\s*länge\b")
        len_snip = f"{header} | {_squash(own)}" if header and own else _find(lines, r"\blänge\b|\bL\s*=") or _find(lines, r"länge")
        rows.append(_row("length", "Length", _mm(float(t_len)), len_snip, _mm(p_len) if p_len else None, lv,
                         None if p_len else "Catalogue states no length"))

    # bend angle
    if pa.get("angle_deg") or ca.get("angle_deg"):
        if pa.get("angle_deg") and ca.get("angle_deg"):
            av = "same" if pa["angle_deg"] == ca["angle_deg"] else "differs"
        else:
            av = "unknown"
        rows.append(_row("angle", "Angle", f"{pa['angle_deg']}°" if pa.get("angle_deg") else None, _find(lines, r"\d{2,3}\s*°"),
                         f"{ca['angle_deg']}°" if ca.get("angle_deg") else None, av))

    # fire resistance class
    if pa.get("fire_class") or ca.get("fire_class"):
        tf, pf = pa.get("fire_class"), ca.get("fire_class")
        if tf and pf:
            fv = "same" if tf[:4].upper() == pf[:4].upper() else "differs"
        else:
            fv = "unknown"
        rows.append(_row("fire_class", "Fire class", tf, _find(lines, matcher.RX_FIRE), pf, fv,
                         None if (tf and pf) else ("Tender states no fire class" if not tf else "Catalogue states no fire class")))

    # airflow (air-handling units and fans are sized by airflow)
    if pa.get("airflow_m3h") and ca.get("airflow_m3h"):
        r = ca["airflow_m3h"] / max(pa["airflow_m3h"], 1)
        fl = "same" if abs(r - 1) < 0.005 else ("equivalent" if 0.85 <= r <= 1.5 else "differs")
        fmt = lambda v: f"{v:,.0f} m³/h".replace(",", "'")  # noqa: E731
        rows.append(_row("airflow", "Airflow", fmt(pa["airflow_m3h"]), _find(lines, matcher.RX_AIRFLOW),
                         "approx. " + fmt(ca["airflow_m3h"]), fl,
                         "Product is the next size that covers the airflow" if fl == "equivalent" else None))

    # actuator (dampers and controllers)
    if fam in ACTUATED:
        t_act = _find(lines, ACTUATOR_RX)
        p_act = bool(re.search(r"actuator", str(row.get("description") or ""), re.I))
        if t_act:
            rows.append(_row("actuator", "Actuator", "with actuator", t_act, "with actuator" if p_act else None,
                             "same" if p_act else "unknown", None if p_act else "Catalogue does not say"))

    # material: only where the tender states it for the item itself (a 'Material' line or the first lines),
    # not a material mentioned somewhere in a long unit description
    p_mat = _product_material(f"{row.get('subcategory')} {row.get('description')}")
    t_mats = _tender_materials(lines)
    if t_mats:
        hit = next(((m, ln) for m, ln in t_mats if m == p_mat), None)
        t_mat, mat_line = hit or t_mats[0]
        if not p_mat:
            mv = "unknown"
        elif hit:
            mv = "same"
        elif t_mat == "galvanized steel" and p_mat == "stainless steel":
            mv = "equivalent"  # stainless where galvanised is asked: better, not worse
        else:
            mv = "differs"
        rows.append(_row("material", "Material", t_mat, mat_line, p_mat, mv,
                         None if p_mat else "Catalogue does not say"))

    # unit
    t_unit = matcher.canon_unit(position.get("unit") or position.get("unit_raw"))
    p_unit = row.get("unit")
    if t_unit or p_unit:
        uv = "unknown" if not (t_unit and p_unit) else ("same" if str(t_unit).replace("²", "2") == str(p_unit).replace("²", "2") else "differs")
        qty_line = next((ln.get("text") for ln in ((position.get("source") or {}).get("lines") or []) if ln.get("role") == "qty"), None)
        rows.append(_row("unit", "Unit", t_unit, _squash(qty_line) if qty_line else position.get("unit_raw"), p_unit, uv))

    # make
    if rule.get("make") or rule.get("kind") == "open":
        maker = " ".join(x for x in (row.get("manufacturer"), row.get("model")) if x) or None
        if rule.get("kind") == "open":
            mk = "equivalent"
            mnote = "Tender leaves the make to the bidder"
        elif same_maker(rule.get("make"), row.get("manufacturer")):
            mk, mnote = "same", None
        elif rule.get("kind") == "prescribed":
            mk = "differs"
            mnote = "Tender prescribes this make: another make is a variant"
        elif rule.get("kind") == "named":
            mk = "equivalent"
            mnote = "Tender names the make without \"or equivalent\": offered as equivalent"
        else:
            mk = "equivalent"
            mnote = "Tender names the make as an example"
        named = " ".join(x for x in (rule.get("make"), rule.get("model")) if x) or None
        rows.append(_row("make", "Make", named, rule.get("snippet"), maker, mk, mnote))

    verdicts = [r["verdict"] for r in rows]
    if "differs" in verdicts:
        verdict = "differs"
    elif rows[0]["verdict"] == "unknown":
        verdict = "unknown"
    elif "equivalent" in verdicts:
        verdict = "equivalent"
    else:
        verdict = "same"
    by_key = {r["key"]: r for r in rows}
    t_dim = ((pa.get("size_text") or t_size) if "size" in by_key and by_key["size"]["tender"] else
             by_key["airflow"]["tender"] if "airflow" in by_key else None)
    t_label = " · ".join(x for x in (" ".join(y for y in (rule.get("make"), rule.get("model")) if y) or pa.get("type"),
                                      t_dim) if x)
    p_label = " · ".join(x for x in (" ".join(y for y in (row.get("manufacturer"), row.get("model")) if y), p_size) if x)
    return {"product_id": row.get("product_id"), "verdict": verdict, "rows": rows,
            "summary": {"tender": t_label or None, "make_kind": rule.get("kind"), "product": p_label or row.get("description"),
                        "checks": [{"key": r["key"], "attribute": r["attribute"], "verdict": r["verdict"]} for r in rows
                                   if r["key"] != "make"]}}


def annotate(position: dict, match: dict, rows_by_id: dict[str, dict], parent: dict | None = None) -> dict:
    """Match with its `make_rule`; a prescribed make that our product does not come from adds a review note
    (an assumption), so the line goes to review with the reason. The attribute comparison is computed when
    a line is read (`line_view`): it follows product changes and catalogue updates."""
    rule = make_rule(position, parent)
    row = rows_by_id.get(match.get("product_id") or "")
    out = {**match, "make_rule": rule}
    note = review_note(rule, row)
    if note and note not in (out.get("assumptions") or []):
        out["assumptions"] = list(out.get("assumptions") or []) + [note]
    return out


def line_view(position: dict, match: dict | None, effective_row: dict | None, rows_by_id: dict[str, dict],
              instructions: list[dict] | None, parent: dict | None = None) -> dict:
    """What the line detail shows: the make rule (with the tender's variant rule) and the comparison for the
    product in use; `match.comparison` is the one for the matcher's own pick."""
    rule = make_rule(position, parent)
    attrs = _attrs_of(match or {}, position)
    m_row = rows_by_id.get((match or {}).get("product_id") or "")
    out = {"make_rule": with_variant_rule(rule, instructions, effective_row),
           "comparison": compare(position, effective_row, rule, attrs=attrs)}
    out["match_comparison"] = (out["comparison"] if m_row is effective_row
                               else compare(position, m_row, rule, attrs=attrs))
    return out


def _attrs_of(match: dict, position: dict) -> dict:
    """The matcher's attributes when they came from rules (the comparison must not show an LLM-read type)."""
    a = match.get("attributes")
    if isinstance(a, dict) and a:
        base = matcher.normalize(position)
        return {**a, "type": base.get("type") or a.get("type")}
    return matcher.normalize(position)


def add_comparisons(position: dict, candidates: list[dict], parent: dict | None = None) -> list[dict]:
    """Each candidate (catalogue row + extras, as built for the Change product screen) gets its comparison."""
    rule = make_rule(position, parent)
    attrs = matcher.normalize(position)
    for c in candidates:
        if c.get("product_id") and c.get("description") is not None:
            try:
                c["comparison"] = compare(position, c, rule, attrs=attrs)
            except Exception:  # noqa: BLE001  a comparison must never break the screen
                c["comparison"] = None
    return candidates


def summary_text(cmp: dict | None) -> str:
    """One plain line for logs and tests: 'Trox Hesco Z-LVS · Ø 10 cm -> DemoVent DV-Z-100 · DN100 · same: type ✓ ...'."""
    if not cmp:
        return ""
    s = cmp["summary"]
    marks = {"same": "✓", "equivalent": "≈", "differs": "✗", "unknown": "?"}
    checks = " ".join(f"{c['key']} {marks[c['verdict']]}" for c in s["checks"])
    return f"{s['tender']} -> {s['product']} · {cmp['verdict']}: {checks}"
