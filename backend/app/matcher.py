"""Match tender positions to catalogue products: normalize -> shortlist (code) -> pick (LLM or rules).

    normalize(position) -> attributes (English)
    normalize_many(positions, use_llm=None) -> {lv_id: attributes}      (LLM fills unknown types, batched)
    shortlist(position, catalog, k=5) -> [{product_id, score, why}]     (pure code)
    pick(position, candidates) -> {product_id|None, confidence, label, reason, assumptions, method}
    pick_many(positions, candidates_by_lv, use_llm=None) -> {lv_id: pick}
    match_positions(positions, catalog=None, progress=None, use_llm=None) -> {lv_id: SPEC match}

Principle: the LLM can only choose a product_id from the shortlist (enum-constrained) or "none".
No product IDs, pages or tender-specific rows are hardcoded here: the German lexicon below is
generic ventilation vocabulary.
"""
from __future__ import annotations

import csv
import json
import math
import re
from pathlib import Path
from typing import Any, Callable

from . import config, llm

# --------------------------------------------------------------------------- catalogue

_CATALOG_CACHE: dict[str, list[dict]] = {}


def load_catalog(path: str | Path | None = None) -> list[dict]:
    path = Path(path or config.REFERENCE_DIR / "catalog.csv")
    key = str(path)
    if key not in _CATALOG_CACHE:
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        for r in rows:
            for k in ("list_price_chf", "discount_pct", "net_cost_chf"):
                try:
                    r[k] = float(r[k])
                except (KeyError, TypeError, ValueError):
                    pass
            r["supplier_quote_required"] = str(r.get("supplier_quote_required", "")).strip().lower() == "true"
        _CATALOG_CACHE[key] = rows
    return _CATALOG_CACHE[key]


def _as_rows(catalog) -> list[dict]:
    if catalog is None:
        return load_catalog()
    if hasattr(catalog, "to_dict"):  # pandas DataFrame
        rows = catalog.reset_index().to_dict("records") if "product_id" not in catalog.columns else catalog.to_dict("records")
        for r in rows:
            if isinstance(r.get("supplier_quote_required"), str):
                r["supplier_quote_required"] = r["supplier_quote_required"].strip().lower() == "true"
        return rows
    return list(catalog)


# --------------------------------------------------------------------------- text helpers

UNIT_MAP = {
    "stk": "pc", "stk.": "pc", "st": "pc", "st.": "pc", "stück": "pc", "pc": "pc", "pcs": "pc", "pce": "pc",
    "m": "m", "lm": "m", "lfm": "m", "m1": "m", "m'": "m",
    "m2": "m2", "m²": "m2", "qm": "m2",
    "m3": "m3", "m³": "m3", "kg": "kg", "h": "h", "std": "h", "std.": "h",
    "ls": "LS", "psch": "LS", "psch.": "LS", "pauschal": "LS", "gl": "LS",
    "system": "system", "anlage": "system", "tage": "day", "tag": "day",
}


UNIT_DE_EN = {"pc": "pieces", "m": "metres", "m2": "m²", "LS": "lump sum", "h": "hours", "kg": "kg", "system": "systems"}


def canon_unit(u: str | None) -> str | None:
    if not u:
        return None
    return UNIT_MAP.get(str(u).strip().lower(), str(u).strip())


def _num(s: str) -> float:
    return float(s.replace("'", "").replace("’", "").replace("`", "").replace(",", "."))


STD_DN = [50, 63, 80, 100, 112, 125, 140, 150, 160, 180, 200, 224, 250, 280, 300, 315, 355, 400, 450, 500,
          560, 600, 630, 710, 800, 900, 1000, 1120, 1250, 1400, 1600]


def _snap_dn(mm: float) -> int:
    best = min(STD_DN, key=lambda d: abs(d - mm))
    return best if abs(best - mm) <= 0.03 * best else int(round(mm))


def _to_mm(v: float, unit: str | None, assume_cm_below: float = 64.0) -> float:
    unit = (unit or "").lower()
    if unit == "mm":
        return v
    if unit == "cm":
        return v * 10 if v * 10 <= 3000 else v  # "Ø 1155 cm" typo guard
    if unit == "m":
        return v * 1000
    return v * 10 if v < assume_cm_below else v


# --------------------------------------------------------------------------- German -> English type lexicon
# (regex on lowercased German, English type phrase in catalogue vocabulary). Order matters within a line.

LEXICON: list[tuple[str, str]] = [
    (r"(?:leer|filter|ventilator|misch|kühler|erhitzer|tropfenabscheider|befeuchter|wärmetauscher|klappen|lufterhitzer|luftkühler)teil\b",
     "casing section of ventilation unit"),
    (r"rauchmelder", "smoke detector"),
    (r"frostschutzwächter|frostschutzthermostat", "frost protection thermostat"),
    (r"druckdifferenzfühler|differenzdruckfühler|druckwächter|differenzdruckwächter", "differential pressure transmitter"),
    (r"feuchtefühler|feuchtigkeitsfühler", "humidity sensor"),
    (r"temperaturfühler|temperatur-\s+und\s+feuchtefühler", "temperature sensor"),
    (r"dichtheitsprüfung|dichtheitsmessung", "duct leakage test"),
    (r"montagerahmen", "mounting frame"),
    (r"überström", "transfer air element"),
    (r"wirbelstrahlauslass|wirbelauslass|düsenrohrdurchlass|düsenauslass", "air diffuser"),
    (r"montagefuss|montagefüsse", "mounting feet"),
    (r"putzdeckel|reinigungsdeckel|reinigungsöffnung", "duct access door"),
    (r"revisi\w*deckel|revisionsöffnung|inspektionsdeckel|kontrolldeckel", "inspection cover for fire insulation"),
    (r"wetterfest\w*\s+(?:ummantelung|dämmung|verkleidung)|wetterschutzummantelung", "weatherproof external insulation with cladding"),
    (r"brandschutzklappe|brandschutz-\s*klappe|\bbsk\b", "fire damper"),
    (r"durchdringung|abschottung|brandschott|brandabschnitt\w*\s+(?:decke|wand)", "fire penetration seal"),
    (r"brandschutzdämm|bs-dämm|dämmung\s+ei\s?\d|aussendämmung\s+ei\s?\d", "fire insulation"),
    (r"kompaktschalldämpfer|rohrschalldämpfer|telefonieschalldämpfer|rundschalldämpfer", "compact silencer"),
    (r"schalldämpfer|kulissenschalldämpfer|schalldämmkulisse", "silencer"),
    (r"(?:konstant\w*)\s*(?:-|\s)?volumenstrom|volumenstromregler\s+(?:für\s+)?konstant|\bkvs\b|\bkvr\b|konstant-?volumenstromregler", "CAV constant volume flow controller"),
    (r"variab\w*\s+volumenstrom|volumenstromregler\s+(?:für\s+)?variab|\bvvs\b|\bvav\b|volumenstromregler", "VAV variable volume flow controller"),
    (r"tellerventil|luftventil|zuluftventil|abluftventil", "air valve"),
    (r"drallauslass|deckenauslass|luftauslass|schlitzauslass|weitwurfdüse|quellauslass|diffusor", "air diffuser"),
    (r"zuluftgitter|abluftgitter|lüftungsgitter|überströmgitter|\bgitter\b", "air grille"),
    (r"drosselklappe|regulierklappe|einstellklappe|irisblende|klappe\s+mit\s+stellsegment", "manual balancing damper"),
    (r"jalousieklappe|motorklappe|absperrklappe|luftklappe|verschlussklappe", "motorised shut-off damper"),
    (r"rückschlagklappe|überdruckklappe", "non-return damper"),
    (r"regenhut|wetterschutzhaube|dachhaube|deflektorhaube", "rain cap"),
    (r"lamellenhut|wetterschutzgitter|aussenluftgitter|ansauggitter|fortluftgitter", "weather louvre"),
    (r"dehnungsmanschette|segeltuchstutzen|flexible\s+verbindung|manschette", "flexible connector"),
    (r"flexrohr|flexschlauch|flexible[rn]?\s+(?:rohr|schlauch)|aluflex|schläuche", "flexible duct"),
    (r"anschlusswink|befestigungswink|winkelprofil\w*\s+für\s+befestigung|abhänge|aufhänge|konsole|montageschiene", "connection angle set support"),
    (r"aussendämmung|innendämmung|wärmedämmung|kanaldämmung|thermische\s+dämmung|mineralwoll\w*\s+dämmung|\bdämmung(?:en)?\b", "thermal duct insulation mineral wool"),
    (r"spirorohr|wickelfalzrohr|rundrohr|lüftungsrohr|rohrleitung", "circular galvanized duct"),
    (r"bogen|bögen", "circular bend"),
    (r"formstück|reduktion|t-stück|abzweig|übergangsstück|hosenstück|etage", "duct fitting transition"),
    (r"blechkan[aä]l|luftkan[aä]l|kanäle|\bkanal\b|rechteckkanal", "rectangular galvanized duct"),
    (r"aerosolabscheider|küchenhaube|abzugshaube|dunstabzug|\bhaube\b", "kitchen exhaust hood"),
    (r"kassette", "ceiling cassette panel"),
    (r"luftkühler|lufterhitzer|heizregister|kühlregister|wärmetauscher|batterie", "heating cooling coil"),
    (r"wärmerückgewinnung|rotationswärmetauscher|plattenwärmetauscher", "heat recovery unit"),
    (r"thermometer", "thermometer"),
    (r"bezeichnungsschild|schilder", "equipment labels"),
    (r"farbpfeil", "colour arrows"),
    (r"potentialverbindung|potentialausgleich", "equipotential bonding"),
    (r"mauerkragen|ringraumdichtung|wanddurchführung", "wall sleeve seal"),
    (r"farbbeschichtung|pulverbeschichtung", "colour coating"),
    (r"zuluftgerät|abluftgerät|fortluftgerät|monobloc|lüftungsgerät|lüftungsapparat|klimagerät|kompaktgerät|rlt-gerät|monoblock", "air-handling unit"),
    (r"ventilator|dachventilator|rohrventilator|radiallüfter", "fan unit"),
    (r"filter", "air filter"),
    (r"differenzdruck|druckmessumformer|druckwächter|drucktransmitter", "differential pressure transmitter"),
    (r"kanalfühler|fühler", "sensor"),
    (r"stellantrieb|stellmotor|klappenantrieb", "actuator 24V"),
    (r"volumenstrommess|messblende|messeinrichtung", "volume flow transmitter"),
    (r"hygiene", "hygiene inspection"),
    (r"inbetriebsetz|inbetriebnahme|einregulier", "commissioning"),
    (r"montage\s+und\s+transport|montage\s+der|\bmontage\b|einbau\s+der", "installation labour"),
    (r"dokumentation|revisionspläne|wartungsvorschrift|betriebsinstruktion", "documentation"),
    (r"regiearbeit|regiestunde|stundenansatz", "daywork hours"),
]
_LEX = [(re.compile(p, re.I), t) for p, t in LEXICON]

# Generic cues when no noun matches (e.g. a block that only lists Mod/DN/Vmin/Vmax table rows).
CUES: list[tuple[str, str]] = [
    (r"v\s?min\.?.{0,60}v\s?max", "VAV variable volume flow controller"),
    (r"kulissen", "silencer"),
]
_CUES = [(re.compile(p, re.I | re.S), t) for p, t in CUES]


def _lex_first(text: str) -> str | None:
    """First lexicon hit by word position. Within one German compound word the head noun (the part that
    ends last, e.g. 'Kanal-Aussendämmung' -> Dämmung, 'Kanalschalldämpfer' -> Schalldämpfer) wins."""
    best = None
    for rx, t in _LEX:
        for m in rx.finditer(text):
            ws = re.search(r"[^\s/]*$", text[:m.start()])
            word_start = ws.start() if ws else m.start()
            we = re.match(r"[^\s/]*", text[m.end():])
            word_end = m.end() + (we.end() if we else 0)
            key = (word_start, -m.end(), -(m.end() - m.start()))
            if best is None or key < best[0]:
                best = (key, t)
            break
    return best[1] if best else None


# --------------------------------------------------------------------------- size parsing

_N = r"(\d+(?:[.,]\d+)?)"
RX_DN_PREFIX = re.compile(r"(?:Ø|ø|⌀|\bDN|\bNW|\bd\s*=)\s*" + _N + r"\s*(mm|cm|m)?(?![\d])", re.I)
RX_DN_SUFFIX = re.compile(_N + r"\s*(?:Ø|ø|⌀)\s*(mm|cm)?", re.I)
_NN = r"(\d+(?:[.,]\d+)?)(?![\d])"
RX_DIMS = re.compile(r"(?<![\d.,x×])" + _NN + r"\s*[x×]\s*" + _NN + r"(?:\s*[x×]\s*" + _NN + r")?(?!\s*[x×]\s*\d)\s*(mm|cm|m\b)?", re.I)
RX_UNIT_HINT = re.compile(r"\((mm|cm)\)|\b(?:in|abmessungen[^\n]*?)\s*\((mm|cm)\)", re.I)
RX_FIRE = re.compile(r"\bEI\s*(\d{2,3})(\s*-\s*S)?\b", re.I)
RX_AIRFLOW = re.compile(r"(\d[\d'’`.]*)\s*(?:m3/h|m³/h|m3/std)", re.I)
RX_THICK = re.compile(r"\b(\d{2,3})\s*mm\b")
RX_THICK_SLASH = re.compile(r"\b(\d{2,3})/\d{1,2}\b")

HEADER_SIZE_TOKENS = {"dn": "dn", "ø": "dn", "⌀": "dn", "nw": "dn", "bxh": "dims", "b": "dims", "bxhxl": "dims"}


def _parse_dims(m) -> tuple[list[float], str | None]:
    vals = [_num(g) for g in m.groups()[:3] if g]
    return vals, (m.group(4) or None)


def _table_size(block_lines: list[str], own: str) -> dict | None:
    """Read DN/BxH from a 'Mod. DN Vmin. Vmax.' style table row using the header's column index."""
    own_toks = own.split()
    if not own_toks:
        return None
    for i, line in enumerate(block_lines):
        toks = line.split()
        low = [t.lower().strip(".:") for t in toks]
        col, kind = None, None
        for j, t in enumerate(low):
            if t in HEADER_SIZE_TOKENS:
                col, kind = j, HEADER_SIZE_TOKENS[t]
                break
        if col is None or len(toks) < 3:
            continue
        # it must be a header: mostly non-numeric tokens
        if any(re.search(r"\d", t) for t in toks) or line.strip() == own.strip():
            continue
        unit = None
        for nxt in block_lines[i + 1:i + 4]:
            u = [t for t in nxt.split() if re.match(r"^(mm|cm|m3/h|m³/h|pa|db|hz|m/s|%)$", t, re.I)]
            if len(u) >= 2 or (u and len(nxt.split()) <= 4):
                off = len(toks) - len(u)
                k = col - off
                if 0 <= k < len(u) and u[k].lower() in ("mm", "cm"):
                    unit = u[k].lower()
                elif off == 0 and col < len(u) and u[col].lower() in ("mm", "cm"):
                    unit = u[col].lower()
                break
        if col >= len(own_toks):
            continue
        cell = own_toks[col]
        if kind == "dn" or re.match(r"^\d+(?:[.,]\d+)?$", cell):
            mnum = re.match(r"^(\d+(?:[.,]\d+)?)$", cell)
            if mnum:
                v = _num(mnum.group(1))
                return {"dn_mm": _snap_dn(_to_mm(v, unit)), "size_text": f"Ø {cell} {unit or ''}".strip()}
        md = re.match(r"^(\d+(?:[.,]\d+)?)[x×](\d+(?:[.,]\d+)?)(?:[x×](\d+(?:[.,]\d+)?))?$", cell)
        if md:
            vals = [_num(g) for g in md.groups() if g]
            mm = [round(_to_mm(v, unit, assume_cm_below=120 if max(vals) <= 120 else 0)) for v in vals]
            return {"dims_mm": mm, "size_text": f"{cell} {unit or ''}".strip()}
    return None


def _sizes_in(text: str, unit_hint: str | None = None) -> dict:
    out: dict[str, Any] = {}
    # dims first (they may contain numbers that look like DN)
    for m in RX_DIMS.finditer(text):
        vals, unit = _parse_dims(m)
        if len(vals) < 2 or max(vals) <= 0:
            continue
        u = unit or unit_hint
        if u:
            mm = [round(_to_mm(v, u)) for v in vals]
        else:
            mm = [round(v * 10) if max(vals) <= 120 else round(v) for v in vals]
        out = {"dims_mm": mm, "size_text": m.group(0).strip()}
        break
    m = RX_DN_PREFIX.search(text) or RX_DN_SUFFIX.search(text)
    if m:
        v = _num(m.group(1))
        unit = (m.group(2) or "").lower() or None
        if m.re is RX_DN_PREFIX and m.group(0).strip().upper().startswith(("DN", "NW")) and not unit:
            unit = "mm"
        out_dn = {"dn_mm": _snap_dn(_to_mm(v, unit)), "size_text": m.group(0).strip()}
        if "dims_mm" not in out or (m.start() < (RX_DIMS.search(text).start() if RX_DIMS.search(text) else 10**9)):
            if "dims_mm" in out:
                out_dn["dims_extra"] = out["dims_mm"]
            return out_dn
    return out


def _unit_hint(text: str) -> str | None:
    m = re.search(r"\((mm|cm)\)", text, re.I)
    return m.group(1).lower() if m else None


# --------------------------------------------------------------------------- normalize

QTY_TAIL = re.compile(r"\s+(Stk\.?|St\.?|m2|m²|m|lm|lfm|kg|h|LS|Psch\.?|pauschal|Tage)\s*([\d'’.,]+)?\s*[.…]*\s*$", re.I)


def _own_line(position: dict) -> str | None:
    if position.get("variant_de"):
        return str(position["variant_de"])
    src = position.get("source") or {}
    for ln in src.get("lines") or []:
        if ln.get("role") == "qty":
            return QTY_TAIL.sub("", ln.get("text", "")).strip()
    # fallback: the text line that ends with this position's quantity
    q = position.get("quantity")
    if q is not None:
        hits = []
        for l in str(position.get("text_de") or "").splitlines():
            m = QTY_TAIL.search(l)
            if m and m.group(2):
                try:
                    if abs(_num(m.group(2).rstrip(".")) - float(q)) < 1e-9:
                        hits.append(QTY_TAIL.sub("", l).strip())
                except ValueError:
                    pass
        if len(hits) == 1:
            return hits[0]
    return None


def _lines(position: dict) -> list[str]:
    text = position.get("text_de") or position.get("title_de") or ""
    return [l.rstrip() for l in str(text).splitlines() if l.strip()]


def _strip_other_qty(position: dict, lines: list[str]) -> list[str]:
    src = position.get("source") or {}
    others = {re.sub(r"\s+", " ", l.get("text", "")).strip() for l in (src.get("lines") or []) if l.get("role") == "other_qty"}
    if not others:
        return lines
    return [l for l in lines if re.sub(r"\s+", " ", l).strip() not in others]


def normalize(position: dict) -> dict:
    """Rules-only English attributes. Unknown type -> type None (normalize_many asks the LLM)."""
    lines = _lines(position)
    own = _own_line(position)
    own_clean = QTY_TAIL.sub("", own).strip() if own else None
    body_lines = _strip_other_qty(position, lines)
    body = "\n".join(body_lines)
    low_body = body.lower()
    heading = " ".join(lines[:2]).lower()
    full = "\n".join(lines)

    # ---- type
    t = None
    if own_clean:
        t = _lex_first(own_clean.lower())
        if t in ("air filter", "installation labour", "commissioning"):  # too generic on a size line
            t = None
    t = t or _lex_first(heading) or _lex_first(str(position.get("title_de") or "").lower()) or _lex_first(low_body)
    if not t:
        for rx, tt in _CUES:
            if rx.search(body):
                t = tt
                break
    type_source = "rules" if t else None

    # ---- flow direction (heading first)
    flow = None
    for src in (heading, (own_clean or "").lower()):
        sup = re.search(r"zuluft|\bzul\b|frischluft", src)
        exh = re.search(r"abluft|\babl\b|fortluft|rückluft", src)
        if sup and not exh:
            flow = "supply"
        elif exh and not sup:
            flow = "exhaust"
        if flow:
            break
    if t in ("air valve", "air grille", "air diffuser") and flow:
        t = f"{flow} {t}"

    # ---- sizes: own line (table aware) -> own line patterns -> block
    sizes: dict = {}
    hint = _unit_hint(body)
    if own_clean:
        sizes = _table_size(body_lines, own_clean) or _sizes_in(own_clean, hint)
    if not sizes:
        # prefer explicit size labels (Grösse, BxH, Abmessungen) over model strings
        labelled = [l for l in body_lines if re.search(r"grösse|grosse|bxh|b x h|abmessung|dimension|\bdn\b|ø", l, re.I)]
        for l in labelled + body_lines:
            sizes = _sizes_in(l, hint)
            if sizes:
                break

    shape = None
    if "dn_mm" in sizes:
        shape = "circular"
    elif "dims_mm" in sizes:
        shape = "rectangular"
    if re.search(r"\beckig|rechteckig", low_body):
        shape = "rectangular"
    elif re.search(r"\brunde?n?\b|rund\w*\s+rohr", low_body) and "dims_mm" not in sizes:
        shape = "circular"

    # ---- thickness (insulation)
    thickness = None
    if t and ("insulation" in t):
        m = RX_THICK_SLASH.search(full) or RX_THICK.search(full)
        if m:
            thickness = int(m.group(1))

    # ---- fire class
    fire = None
    m = RX_FIRE.search(full)
    if m:
        fire = "EI" + m.group(1) + ("-S" if m.group(2) else "")

    # ---- material
    material = None
    if re.search(r"kunststoff|\bpvc\b|\bpp\b|polypropylen", low_body):
        material = "plastic"
    elif re.search(r"v2a|v4a|chromnickel|rostfrei|edelstahl|inox", low_body):
        material = "stainless steel"
    elif re.search(r"verzinkt|sendzimir|sendizimir|galvanis", low_body):
        material = "galvanized steel"
    elif re.search(r"\balu(?:minium)?\b", low_body):
        material = "aluminium"

    # ---- airflow
    airflow = None
    m = RX_AIRFLOW.search(full)
    if m:
        try:
            airflow = _num(m.group(1).rstrip("."))
        except ValueError:
            airflow = None

    if t and shape and t in ("silencer", "VAV variable volume flow controller", "CAV constant volume flow controller"):
        t = f"{t} {shape}"
    if t and t.startswith("fire penetration seal") and shape:
        t = f"{t} {shape}"
    if t == "rectangular galvanized duct" and "dn_mm" in sizes:
        t = "circular galvanized duct"

    angle = None
    m = re.search(r"(\d{2,3})\s*°", own_clean or "") or (re.search(r"(\d{2,3})\s*°", body) if t and "bend" in t else None)
    if m:
        angle = int(m.group(1))

    attrs = {
        "type": t,
        "type_source": type_source,
        "dn_mm": sizes.get("dn_mm"),
        "dims_mm": sizes.get("dims_mm"),
        "thickness_mm": thickness,
        "fire_class": fire,
        "flow": flow,
        "material": material,
        "shape": shape,
        "airflow_m3h": airflow,
        "angle_deg": angle,
        "size_text": sizes.get("size_text"),
    }
    # keep any parser-provided attributes we could not derive
    for k, v in (position.get("attributes") or {}).items():
        if k == "type":
            if v and v != t:
                attrs["type_hint"] = v  # parser's guess: shown in titles, never used to match
            continue
        if attrs.get(k) in (None, [], "") and v not in (None, [], ""):
            attrs[k] = v
    return attrs


# --------------------------------------------------------------------------- LLM normalize (types)

_NORM_SYSTEM = (
    "You classify lines of a Swiss German ventilation (HVAC) tender. For each line give the product type as a "
    "short English noun phrase using catalogue vocabulary (e.g. 'supply air valve', 'fire damper', 'rectangular "
    "silencer', 'VAV variable volume flow controller circular', 'thermal duct insulation mineral wool', "
    "'rain cap', 'installation labour'). Use the catalogue categories listed when one fits. "
    "Do not invent sizes or prices; only classify."
)


def normalize_many(positions: list[dict], use_llm: bool | None = None, catalog=None, batch: int = 20) -> dict[str, dict]:
    out = {p["lv_id"]: normalize(p) for p in positions}
    unknown = [p for p in positions if not out[p["lv_id"]]["type"] and p.get("kind", "item") in ("item", "lump_sum", None)]
    if use_llm is False or not unknown:
        return out
    rows = _as_rows(catalog)
    cats = sorted({f"{r['category']} / {r['subcategory']}" for r in rows})

    def run(chunk):
        ids = [p["lv_id"] for p in chunk]
        schema = {
            "type": "object",
            "properties": {i: {"type": "object", "properties": {"type_en": {"type": "string"}},
                               "required": ["type_en"], "additionalProperties": False} for i in ids},
            "required": ids, "additionalProperties": False,
        }
        user = "Catalogue categories:\n" + "\n".join(cats) + "\n\nTender lines:\n" + "\n\n".join(
            f"[{p['lv_id']}] unit {p.get('unit_raw') or p.get('unit')}\n{_trim(p.get('text_de') or p.get('title_de') or '', 900)}"
            for p in chunk)
        return llm.call_json(_NORM_SYSTEM, user, schema, name="normalize_types", temperature=0)

    try:
        results = llm.map_concurrent(run, llm.chunks(unknown, batch))
    except llm.LLMUnavailable:
        return out
    for chunk, res in zip(llm.chunks(unknown, batch), results):
        if isinstance(res, Exception) or not res:
            continue
        for p in chunk:
            t = (res.get(p["lv_id"]) or {}).get("type_en")
            if t:
                out[p["lv_id"]]["type"] = t.strip().lower()
                out[p["lv_id"]]["type_source"] = "llm"
    return out


def _trim(s: str, n: int) -> str:
    s = re.sub(r"[ \t]+", " ", s)
    return s if len(s) <= n else s[:n] + " …"


# --------------------------------------------------------------------------- catalogue attributes + scoring

STOP = {"with", "and", "for", "the", "of", "in", "mm", "approx", "incl", "a", "to", "per", "on", "or", "x",
        "set", "unit", "length", "system", "dn"}
SYN = {
    "round": "circular", "rect": "rectangular", "regulator": "controller", "controllers": "controller",
    "attenuator": "silencer", "sealing": "seal", "penetration": "seal", "galvanised": "galvanized",
    "angles": "angle", "bracket": "angle", "covers": "cover", "valves": "valve", "dampers": "damper",
    "ducts": "duct", "fittings": "fitting", "grilles": "grille", "variable": "vav", "constant": "cav",
    "insulating": "insulation", "thermal": "insulation", "ahu": "air-handling", "handling": "air-handling",
}


def _tokens(text: str) -> set[str]:
    out = set()
    for w in re.split(r"[^a-z0-9äöü\-]+", (text or "").lower()):
        for part in w.split("-"):
            if not part or part in STOP or re.match(r"^\d", part) or re.match(r"^(dn|ei)\d", part):
                continue
            if len(part) > 3 and part.endswith("s") and not part.endswith("ss"):
                part = part[:-1]
            out.add(SYN.get(part, part))
    return out


def catalog_attrs(row: dict) -> dict:
    desc = f"{row.get('subcategory', '')} {row.get('description', '')}"
    a: dict[str, Any] = {"dn_mm": None, "dims_mm": None, "thickness_mm": None, "fire_class": None,
                         "flow": None, "airflow_m3h": None, "shape": None}
    m = re.search(r"\bDN\s*(\d+)", desc)
    if m:
        a["dn_mm"] = int(m.group(1))
        a["shape"] = "circular"
    m = RX_DIMS.search(desc)
    if m:
        vals, _ = _parse_dims(m)
        a["dims_mm"] = [round(v) for v in vals]
        a["shape"] = "rectangular"
    if "insulation" in desc.lower() or str(row.get("category", "")).lower() == "insulation":
        m = re.search(r"(\d+)\s*mm", desc)
        if m and not a["dims_mm"]:
            a["thickness_mm"] = int(m.group(1))
    m = RX_FIRE.search(desc)
    if m:
        a["fire_class"] = "EI" + m.group(1)
    m = re.search(r"(\d{2,3})\s*°", desc)
    a["angle_deg"] = int(m.group(1)) if m else None
    m = re.search(r"(\d[\d']*)\s*m3/h", desc)
    if m:
        a["airflow_m3h"] = _num(m.group(1))
    low = desc.lower()
    if "supply" in low:
        a["flow"] = "supply"
    elif "exhaust" in low:
        a["flow"] = "exhaust"
    if "circular" in low:
        a["shape"] = "circular"
    elif "rectangular" in low:
        a["shape"] = "rectangular"
    return a


def _cat_tokens(row: dict) -> set[str]:
    return _tokens(f"{row.get('category', '')} {row.get('subcategory', '')} {row.get('description', '')}")


def size_label(a: dict) -> str | None:
    if a.get("dn_mm"):
        return f"DN{a['dn_mm']}"
    if a.get("dims_mm"):
        return "x".join(str(int(v)) for v in a["dims_mm"]) + " mm"
    if a.get("thickness_mm"):
        return f"{a['thickness_mm']} mm"
    return None


def _dims_equal(a: list, b: list) -> bool:
    if not a or not b:
        return False
    sa, sb = sorted(a, reverse=True), sorted(b, reverse=True)
    if len(sa) != len(sb):
        return False
    return all(abs(x - y) <= max(2, 0.01 * y) for x, y in zip(sa, sb))


def _size_state(pa: dict, ca: dict) -> tuple[int, str]:
    """(+1 match | 0 n/a | -1 mismatch, short note)."""
    if ca.get("angle_deg") and pa.get("angle_deg") and ca["angle_deg"] != pa["angle_deg"]:
        return -1, "angle"
    if ca.get("dn_mm") and pa.get("dn_mm"):
        return (1, "dn") if ca["dn_mm"] == pa["dn_mm"] else (-1, "dn")
    if ca.get("dims_mm") and pa.get("dims_mm"):
        return (1, "dims") if _dims_equal(pa["dims_mm"], ca["dims_mm"]) else (-1, "dims")
    if ca.get("thickness_mm") and pa.get("thickness_mm"):
        return (1, "thickness") if ca["thickness_mm"] == pa["thickness_mm"] else (-1, "thickness")
    if (ca.get("dn_mm") and pa.get("dims_mm") and not pa.get("dn_mm")) or (ca.get("dims_mm") and pa.get("dn_mm") and not pa.get("dims_mm")):
        return -1, "shape"
    if ca.get("airflow_m3h") and pa.get("airflow_m3h"):
        r = ca["airflow_m3h"] / max(pa["airflow_m3h"], 1)
        return (1, "airflow") if 0.85 <= r <= 1.5 else (-1, "airflow")
    if ca.get("dn_mm") or ca.get("dims_mm") or ca.get("thickness_mm"):
        return 0, "unstated"
    return 0, "none"


EXCLUSIVE = [("vav", "cav")]  # token pairs that make two products different kinds


def score_candidate(pa: dict, row: dict) -> dict:
    ca = catalog_attrs(row)
    type_tokens = _tokens(pa.get("type") or "")
    ct = _cat_tokens(row)
    if type_tokens:
        inter = type_tokens & ct
        coverage = len(inter) / len(type_tokens)
        dice = 2 * len(inter) / (len(type_tokens) + len(ct))
    else:
        coverage = dice = 0.0
    type_score = 0.75 * coverage + 0.25 * dice
    flow_conflict = bool(pa.get("flow") and ca.get("flow") and pa["flow"] != ca["flow"])
    excl_conflict = any((a in type_tokens and b in ct and a not in ct) or (b in type_tokens and a in ct and b not in ct)
                        for a, b in EXCLUSIVE)
    shape_conflict = bool(pa.get("shape") and ca.get("shape") and pa["shape"] != ca["shape"])
    size, size_kind = _size_state(pa, ca)
    fire_conflict = bool(pa.get("fire_class") and ca.get("fire_class") and pa["fire_class"][:4] != ca["fire_class"][:4])

    s = 0.62 * type_score
    # a size match only counts fully when the type also fits ("same size, other product" must rank below
    # "right type, wrong size", as in the playbook)
    s += 0.30 * (0.3 + 0.7 * type_score) if size == 1 else (-0.25 if size == -1 else 0.0)
    if size == 0 and size_kind == "none":
        s += 0.12  # product has no size: nothing to contradict
    if flow_conflict:
        s -= 0.25
    if excl_conflict:
        s -= 0.3
    if shape_conflict and size_kind != "shape":
        s -= 0.15
    if fire_conflict:
        s -= 0.2
    if pa.get("fire_class") and ca.get("fire_class") and not fire_conflict:
        s += 0.05
    if type_score >= 0.6 and not flow_conflict:
        s += 0.08
    s = max(0.0, min(1.0, s))
    type_ok = coverage >= 0.6 and not flow_conflict and not shape_conflict and not excl_conflict
    return {"score": round(s, 3), "type_score": round(type_score, 3), "coverage": round(coverage, 3), "size": size,
            "size_kind": size_kind, "flow_conflict": flow_conflict, "shape_conflict": shape_conflict,
            "fire_conflict": fire_conflict, "excl_conflict": excl_conflict, "type_ok": type_ok, "cat": ca}


_FLOW_WORD = {"supply": "supply", "exhaust": "exhaust"}


def _why(pa: dict, row: dict, sc: dict) -> str:
    tender_size = pa.get("size_text") or size_label(pa)
    cat_size = size_label(sc["cat"])
    if sc["flow_conflict"]:
        return f"Right size, but {sc['cat']['flow']}, not {pa['flow']}" if sc["size"] == 1 else \
            f"Wrong direction: {sc['cat']['flow']}, tender says {pa['flow']}"
    if sc["fire_conflict"]:
        return f"Wrong fire class: tender says {pa['fire_class']}"
    if sc.get("excl_conflict"):
        return ("Same size, but variable (VAV) vs constant (CAV) flow" if sc["size"] == 1
                else "Different controller kind: variable (VAV) vs constant (CAV) flow")
    if sc["type_ok"]:
        if sc["size"] == 1 and sc["size_kind"] == "airflow":
            ta, ka = f"{pa['airflow_m3h']:,.0f}".replace(",", "'"), f"{sc['cat']['airflow_m3h']:,.0f}".replace(",", "'")
            return f"Type and airflow match (tender {ta} m³/h, product approx. {ka} m³/h)"
        if sc["size"] == 1:
            if tender_size and cat_size and tender_size.replace(" ", "") != cat_size.replace(" ", ""):
                return f"Type and size match ({tender_size} = {cat_size})"
            return "Type and size match" + (f" ({cat_size})" if cat_size else "")
        if sc["size"] == -1:
            if sc["size_kind"] == "shape":
                return f"Right type, wrong shape: tender says {tender_size}"
            if sc["size_kind"] == "angle":
                return f"Right type, wrong angle: tender says {pa.get('angle_deg')}°"
            return f"Right type, wrong size: tender says {tender_size}" if tender_size else "Right type, wrong size"
        if sc["size_kind"] == "unstated":
            return f"Right type; tender states no size, product is {cat_size}"
        return "Right type" + ("; product has no size to check" if sc["size_kind"] == "none" else "")
    if sc["size"] == 1:
        return "Same size, different product type"
    if sc["coverage"] >= 0.3:
        return "Partly the same type" + (f", wrong size: tender says {tender_size}" if sc["size"] == -1 and tender_size else "")
    return "Weak match"


def shortlist(position: dict, catalog=None, k: int = 5, attrs: dict | None = None) -> list[dict]:
    """Top-k catalogue candidates, scored in code. Wrong units are dropped."""
    rows = _as_rows(catalog)
    pa = attrs or position.get("attributes_norm") or normalize(position)
    unit = canon_unit(position.get("unit") or position.get("unit_raw"))
    cat_units = {r.get("unit") for r in rows}
    if unit in cat_units:
        rows = [r for r in rows if r.get("unit") == unit]
    elif unit:  # LS, h, system, kg ... nothing in the catalogue is sold that way
        return []
    scored = []
    for r in rows:
        sc = score_candidate(pa, r)
        scored.append((sc["score"], sc["type_score"], r, sc))
    scored.sort(key=lambda x: (-x[0], -x[1], str(x[2].get("product_id"))))
    top = scored[:k]
    # keep up to two right-type alternatives visible even when their size is wrong
    typed = [x for x in scored if x[3]["type_ok"]][:2]
    for x in typed:
        if x not in top and len(top) >= k:
            for j in range(len(top) - 1, -1, -1):
                if not top[j][3]["type_ok"]:
                    top[j] = x
                    break
    top.sort(key=lambda x: (-x[0], -x[1], str(x[2].get("product_id"))))
    out = []
    for s, _, r, sc in top:
        out.append({"product_id": r["product_id"], "score": s, "why": _why(pa, r, sc),
                    "_type_ok": sc["type_ok"], "_size": sc["size"], "_size_kind": sc["size_kind"]})
    return out


def public_candidates(cands: list[dict]) -> list[dict]:
    return [{"product_id": c["product_id"], "score": c["score"], "why": c["why"]} for c in cands]


# --------------------------------------------------------------------------- pick

LABELS = ((0.85, "Strong"), (0.6, "Close"), (0.0, "Weak"))


def _label(conf: float, pid) -> str:
    if not pid:
        return "None"
    for th, lab in LABELS:
        if conf >= th:
            return lab
    return "Weak"


def pick_rules(position: dict, candidates: list[dict], attrs: dict | None = None) -> dict:
    pa = attrs or position.get("attributes_norm") or normalize(position)
    if not candidates:
        return {"product_id": None, "confidence": 0.0, "label": "None", "method": "rules", "assumptions": [],
                "reason": f"No catalogue product is sold per {position.get('unit') or 'this unit'}" if position.get("unit") else "No catalogue candidates"}
    typed = [c for c in candidates if c.get("_type_ok")]
    top = typed[0] if typed else candidates[0]
    if not pa.get("type"):
        return {"product_id": None, "confidence": 0.0, "label": "None", "method": "rules", "assumptions": [],
                "reason": "Could not tell the product type from the tender text"}
    if top.get("_type_ok") and top.get("_size") == -1:
        return {"product_id": None, "confidence": round(top["score"] * 0.6, 2), "label": "None", "method": "rules",
                "assumptions": [], "reason": f"Right type in catalogue, but no matching size ({top['why']})"}
    if not top.get("_type_ok", True) or top["score"] < 0.45:
        return {"product_id": None, "confidence": round(top["score"] * 0.5, 2), "label": "None", "method": "rules",
                "assumptions": [], "reason": f"No catalogue product of this type ({pa['type']})"}
    if top.get("_size") == -1:
        return {"product_id": None, "confidence": round(top["score"] * 0.6, 2), "label": "None", "method": "rules",
                "assumptions": [], "reason": f"Right type in catalogue, but no matching size ({top['why']})"}
    assumptions: list[str] = []
    # explicit, explainable confidence levels for the rules path
    if top.get("_size") == 1:
        conf = 0.9 if top["score"] >= 0.75 else 0.8
    elif top.get("_size_kind") == "none":
        conf = 0.75  # product has no size: type match only
    else:
        conf = 0.7
    same_type_sized = [c for c in candidates if c.get("_type_ok") and c.get("_size_kind") == "unstated"]
    if top.get("_size_kind") == "unstated":
        if len(same_type_sized) > 1:
            return {"product_id": None, "confidence": 0.3, "label": "None", "method": "rules", "assumptions": [],
                    "reason": "Several sizes in the catalogue and the tender size was not found"}
        assumptions.append("Size not stated in the tender; the only catalogue size was assumed")
        conf = min(conf, 0.7)
    second = candidates[1] if len(candidates) > 1 else None
    if second and second.get("_type_ok") and second.get("_size") != -1 and abs(second["score"] - top["score"]) < 0.03:
        conf = min(conf, 0.65)
        assumptions.append(f"Close tie with {second['product_id']}; check the product")
    return {"product_id": top["product_id"], "confidence": round(conf, 2), "label": _label(conf, top["product_id"]),
            "reason": top["why"], "assumptions": assumptions, "method": "rules"}


_PICK_SYSTEM = """You match lines of a Swiss German ventilation (HVAC) tender to catalogue products.
For each tender line you get the German text, the line's own size/variant row, attributes read by code, and up to 5 candidate products.
Answer exactly one candidate product_id, or "none" when no candidate is the same kind of product.
Rules:
- The product type must match: supply vs exhaust, variable (VAV) vs constant (CAV) flow controller, rectangular vs circular, compact vs rectangular silencer, thermal vs weatherproof insulation, EI30 vs EI90.
- When the tender and the product both state a size, it must be the same size (Ø 10 cm = DN100, 40 x 30 x 125 cm = 400x300x1250 mm, 30/5 insulation = 30 mm). A wrong size means "none" unless every candidate of that type is wrong (then "none").
- A block can list several sizes; the line's own size is the 'own row' given, not the first size in the block.
- Makes in the tender are examples ("z.B."); a different manufacturer is fine and is not an assumption.
- If you pick a product although the tender does not state an attribute the product fixes (finish, length, size, what a set contains), add a short plain-English assumption, e.g. "Finish not specified, galvanised assumed". Otherwise return an empty list.
- confidence: high = type and size clearly match; medium = likely but something is assumed; low = weak.
- reason: one short plain-English line for an estimator, naming the decisive attribute, e.g. "Supply air, plastic, Ø 10 cm = DN100".
Never invent product IDs or prices."""


def _pick_payload(p: dict, pa: dict, cands: list[dict], rows_by_id: dict) -> dict:
    return {
        "lv_id": p["lv_id"],
        "unit": p.get("unit_raw") or p.get("unit"),
        "quantity": p.get("quantity"),
        "make_hint": p.get("make_hint"), "model_hint": p.get("model_hint"),
        "own_row": _own_line(p),
        "text_de": _trim(p.get("text_de") or p.get("title_de") or "", 1400),
        "attributes": {k: v for k, v in pa.items() if v not in (None, [], "") and k != "type_source"},
        "candidates": [{"product_id": c["product_id"],
                        "category": rows_by_id[c["product_id"]].get("category"),
                        "subcategory": rows_by_id[c["product_id"]].get("subcategory"),
                        "description": rows_by_id[c["product_id"]].get("description"),
                        "unit": rows_by_id[c["product_id"]].get("unit"),
                        "code_check": c["why"]} for c in cands],
    }


CONF = {"high": 0.92, "medium": 0.72, "low": 0.45}


def _llm_pick_batch(batch: list[tuple[dict, dict, list[dict]]], rows_by_id: dict) -> dict[str, dict]:
    ids = [p["lv_id"] for p, _, _ in batch]
    props = {}
    for p, _, cands in batch:
        props[p["lv_id"]] = {
            "type": "object",
            "properties": {
                "product_id": {"type": "string", "enum": [c["product_id"] for c in cands] + ["none"]},
                "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                "reason": {"type": "string"},
                "assumptions": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["product_id", "confidence", "reason", "assumptions"],
            "additionalProperties": False,
        }
    schema = {"type": "object", "properties": props, "required": ids, "additionalProperties": False}
    user = "Tender lines with candidates (JSON):\n" + json.dumps(
        [_pick_payload(p, pa, c, rows_by_id) for p, pa, c in batch], ensure_ascii=False, indent=1)
    res = llm.call_json(_PICK_SYSTEM, user, schema, name="pick_products", temperature=0)
    cached = llm.last_call_cached()
    out = {}
    for p, pa, cands in batch:
        r = res.get(p["lv_id"]) or {}
        pid = r.get("product_id")
        valid = {c["product_id"]: c for c in cands}
        if pid not in valid:
            pid = None
        conf = CONF.get(r.get("confidence"), 0.45) if pid else 0.0
        assumptions = [a for a in (r.get("assumptions") or []) if a and a.strip()]
        reason = (r.get("reason") or "").strip()
        if pid:
            c = valid[pid]
            if c.get("_size") == -1:  # code disagrees on size: never Strong
                conf = min(conf, 0.5)
                assumptions.append(f"Code check: {c['why']}")
            if assumptions:
                conf = min(conf, 0.74)
        out[p["lv_id"]] = {"product_id": pid, "confidence": round(conf, 2), "label": _label(conf, pid),
                           "reason": reason or ("No candidate fits" if not pid else valid[pid]["why"]),
                           "assumptions": assumptions, "method": "cache" if cached else "llm"}
    return out


def pick_many(positions: list[dict], candidates_by_lv: dict[str, list[dict]], catalog=None,
              use_llm: bool | None = None, batch: int = 10, attrs_by_lv: dict | None = None,
              progress: Callable[[int, int], None] | None = None) -> dict[str, dict]:
    attrs_by_lv = attrs_by_lv or {}
    rows_by_id = {r["product_id"]: r for r in _as_rows(catalog)}
    out: dict[str, dict] = {}
    todo = []
    for p in positions:
        lv = p["lv_id"]
        pa = attrs_by_lv.get(lv) or normalize(p)
        cands = candidates_by_lv.get(lv) or []
        out[lv] = pick_rules(p, cands, pa)
        if cands and pa.get("type") and use_llm is not False:
            todo.append((p, pa, cands))
    if not todo or use_llm is False:
        return out
    if use_llm is None and not llm.available():
        # cache-only mode: try each batch, cache hits still work
        pass
    batches = llm.chunks(todo, batch)
    results = llm.map_concurrent(lambda b: _llm_pick_batch(b, rows_by_id), batches, max_workers=8, progress=progress)
    for b, res in zip(batches, results):
        if isinstance(res, Exception):
            continue  # keep rules result for this batch
        out.update(res)
    return out


def pick(position: dict, candidates: list[dict], catalog=None, use_llm: bool | None = None) -> dict:
    return pick_many([position], {position["lv_id"]: candidates}, catalog=catalog, use_llm=use_llm)[position["lv_id"]]


# --------------------------------------------------------------------------- end to end

SKIP_KINDS = {"text_only", "subtotal"}


def match_positions(positions: list[dict], catalog=None, progress: Callable[[int, int], None] | None = None,
                    use_llm: bool | None = None, k: int = 5) -> dict[str, dict]:
    """SPEC `match` object per lv_id (text-only and subtotal kinds are skipped)."""
    rows = _as_rows(catalog)
    rows_by_id = {r["product_id"]: r for r in rows}
    todo = [p for p in positions if p.get("kind", "item") not in SKIP_KINDS]
    attrs = normalize_many(todo, use_llm=use_llm, catalog=rows)
    cands = {p["lv_id"]: shortlist(p, rows, k=k, attrs=attrs[p["lv_id"]]) for p in todo}
    picks = pick_many(todo, cands, catalog=rows, use_llm=use_llm, attrs_by_lv=attrs, progress=progress)
    for p in todo:
        pk = picks[p["lv_id"]]
        a = attrs[p["lv_id"]]
        if pk.get("product_id") or not a.get("type") or pk["method"] != "rules":
            continue
        unit = canon_unit(p.get("unit") or p.get("unit_raw"))
        other = [r for r in rows if r.get("unit") != unit and score_candidate(a, r)["type_ok"]]
        if other and unit:
            units = sorted({r["unit"] for r in other})
            pk["reason"] = (f"Catalogue has {a['type']} only per {', '.join(units)}; the tender counts "
                            f"{UNIT_DE_EN.get(unit, unit)}")
    out = {}
    for p in todo:
        lv = p["lv_id"]
        pk = picks[lv]
        pid = pk.get("product_id")
        out[lv] = {
            "product_id": pid,
            "install_code": rows_by_id[pid].get("install_code") if pid else None,
            "confidence": pk["confidence"],
            "label": pk["label"],
            "reason": pk["reason"],
            "method": pk["method"],
            "assumptions": pk.get("assumptions", []),
            "candidates": public_candidates(cands[lv]),
            "attributes": {k2: v for k2, v in attrs[lv].items() if k2 != "type_source"},
        }
    return out


# --------------------------------------------------------------------------- product families (grouping, rule applicability)

FAMILIES: list[tuple[str, str, str, str]] = [
    # key, regex on English type, English label, German label
    ("silencer", r"silencer", "Silencers", "Schalldämpfer"),
    ("fire_damper", r"fire damper", "Fire dampers", "Brandschutzklappen"),
    ("fire_seal", r"fire penetration seal", "Fire penetration seals", "Brandschutzabschottungen"),
    ("fire_access", r"inspection cover|access door", "Inspection covers", "Revisionsdeckel"),
    ("fire_insulation", r"fire insulation", "Fire insulation", "Brandschutzdämmungen"),
    ("weatherproof_insulation", r"weatherproof", "Weatherproof insulation", "Wetterfeste Dämmung mit Ummantelung"),
    ("insulation", r"insulation", "Duct insulation", "Dämmungen"),
    ("flow_controller", r"flow controller|volume flow controller", "Air volume controllers", "Volumenstromregler"),
    ("flexible", r"flexible duct", "Flexible ducts", "Flexible Rohre"),
    ("damper", r"damper", "Dampers", "Klappen"),
    ("air_terminal", r"air valve|grille|diffuser", "Air valves and grilles", "Luftdurchlässe"),
    ("duct", r"duct|bend|fitting", "Ducts and fittings", "Kanäle und Rohre"),
    ("ahu", r"air-handling|ventilation unit|heating cooling coil|heat recovery|air filter", "Air-handling units", "Lüftungsgeräte"),
    ("fan", r"\bfan\b", "Fans", "Ventilatoren"),
    ("support", r"support|connection angle", "Supports and hangers", "Befestigungen"),
    ("controls", r"sensor|transmitter|actuator|thermometer", "Field devices", "Feldgeräte"),
    ("weather_protection", r"rain cap|louvre", "Rain caps and louvres", "Wetterschutz"),
    ("kitchen_hood", r"kitchen exhaust hood|ceiling cassette", "Kitchen hoods", "Küchenhauben"),
]
_FAM = [(k, re.compile(rx, re.I), en, de) for k, rx, en, de in FAMILIES]
# families a rule about family X also covers (insulation rules apply to weatherproof insulation lines too)
FAMILY_PARENT = {"weatherproof_insulation": "insulation", "fire_insulation": "insulation"}


def family_of(type_en: str | None) -> str | None:
    if not type_en:
        return None
    for k, rx, _, _ in _FAM:
        if rx.search(type_en):
            return k
    return None


def family_label(key: str | None, lang: str = "en") -> str | None:
    for k, _, en, de in _FAM:
        if k == key:
            return en if lang == "en" else de
    return None
