"""Tender rules ("Instructions & norms") from the technical-conditions pages.

    extract_instructions(pages_text, positions, catalog=None, pdf=None, matches=None,
                         use_llm=None, max_rules=16) -> [Instruction]

How it works (generic, no page numbers or labels hardcoded):
1. Find "Technische Vorschriften" style sections by their numbered headings.
2. Split them into rules using the margin labels (right-hand column, read from PDF coordinates when
   `pdf` is given; from PyMuPDF text order otherwise). A rule = margin label + its paragraphs.
3. Rules pick the key sentences (cost / risk / variant / prohibition signals), classify the kind,
   map the rule to product families and from there to lv_ids (code, never the LLM).
4. If the LLM is available it selects the ~10-16 most price-relevant rules, picks the verbatim quote,
   translates it and writes the one-line "why". Every quote is verified against the rule text.
"""
from __future__ import annotations

import json
import re
from typing import Any

from . import config, llm, matcher
from .meta import (find_verbatim, join_lines, norm_ws, open_pdf, pages_text_from_pdf, search_bbox,
                   split_sentences, verbatim_in)

SECTION_RX = re.compile(r"^\s*(\d+(?:\.\d+)+)\s+(Technische\s+(?:Vorschriften|Bestimmungen|Anforderungen)|"
                        r"Ausführungsbestimmungen|Ausführungsvorschriften|Materialvorschriften)\b.*", re.I)
NUM_HEADING_RX = re.compile(r"^\s*\d+(?:\.\d+)+\s+[A-ZÄÖÜ]")

RISK_RX = re.compile(
    r"Folgekosten|zu\s+Lasten\s+des\s+Unternehmers|auf\s+Kosten\s+des\s+Unternehmers|"
    r"Unternehmer[^.]{0,80}(?:belastet|verrechnet|zu\s+tragen)|(?:belastet|verrechnet)[^.]{0,40}Unternehmer|"
    r"Unternehmer\s+(?:haftet|trägt)|Konventionalstrafe|nicht\s+vergütet", re.I)
COST_RX = re.compile(
    r"einzurechnen|einzukalkulieren|eingerechnet|einkalkuliert|mitzuliefern|mitzuofferieren|"
    r"im\s+(?:Einheits)?[Pp]reis\s+(?:inbegriffen|enthalten)|(?:ist|sind)\s+inbegriffen|Sache\s+des\s+Unternehmers", re.I)
PAY_RX = re.compile(r"vergütet", re.I)
VARIANT_RX = re.compile(r"\bVariante", re.I)
PROHIBIT_RX = re.compile(r"nicht\s+zugelassen|nicht\s+gestattet|nicht\s+akzeptiert|dürfen\s+nur|nur\s+[^.]{0,60}zulässig|"
                         r"unzulässig", re.I)
WEAK_PROHIBIT_RX = re.compile(r"\bkeine\s+[A-ZÄÖÜ]\w+")

# Pricing allowances that already cover a rule (rule regex, allowance description).
ALLOWANCES = [(re.compile(r"\bTransport", re.I), "transport_equipment_pct", "transport and equipment allowance")]

# German feature words in a rule -> English words to look for in the matched product descriptions.
FEATURES = [
    (re.compile(r"motorantrieb|stellantrieb|\bantrieb|federrücklauf", re.I), ["actuator"]),
    (re.compile(r"dämmschale|isoliert|wärmedämm", re.I), ["insulat"]),
    (re.compile(r"ummantelung|verkleidung", re.I), ["cladding"]),
]


# --------------------------------------------------------------------------- layout reading

def _page_lines(doc, pno: int) -> list[dict]:
    page = doc[pno - 1]
    out = []
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            text = "".join(s["text"] for s in l["spans"])
            if not text.strip():
                continue
            out.append({"page": pno, "x0": l["bbox"][0], "y0": l["bbox"][1], "x1": l["bbox"][2], "y1": l["bbox"][3],
                        "text": text.strip(), "bold": "bold" in l["spans"][0]["font"].lower(), "w": page.rect.width,
                        "h": page.rect.height})
    out.sort(key=lambda r: (round(r["y0"]), r["x0"]))
    return out


def _sections_layout(doc, max_page: int | None = None) -> list[dict]:
    """[{heading, lines:[...]}] for each technical-rules section."""
    sections, cur = [], None
    last = min(doc.page_count, max_page or doc.page_count)
    for pno in range(1, last + 1):
        for ln in _page_lines(doc, pno):
            if ln["y1"] < 0.05 * ln["h"] or ln["y0"] > 0.95 * ln["h"]:
                continue  # page number / footer
            if NUM_HEADING_RX.match(ln["text"]) and ln["x0"] < 0.3 * ln["w"]:
                if SECTION_RX.match(ln["text"]):
                    cur = {"heading": norm_ws(ln["text"]), "page": pno, "lines": []}
                    sections.append(cur)
                    continue
                cur = None
                continue
            if cur is not None:
                cur["lines"].append(ln)
        if pno > 80 and not sections:
            break
    return sections


def _rules_from_layout(section: dict) -> list[dict]:
    lines = section["lines"]
    if not lines:
        return []
    width = lines[0]["w"]
    margin_x = 0.72 * width
    body = [l for l in lines if l["x0"] < margin_x]
    labels = [l for l in lines if l["x0"] >= margin_x]
    # label groups
    groups: list[dict] = []
    for l in labels:
        g = groups[-1] if groups else None
        if g and g["page"] == l["page"] and l["y0"] - g["lines"][-1]["y1"] <= 4.0:
            g["lines"].append(l)
        else:
            groups.append({"page": l["page"], "y0": l["y0"], "lines": [l]})
    label_starts = {(g["page"], round(g["y0"])) for g in groups}

    def starts_label(l):
        return any((l["page"], round(l["y0"]) + d) in label_starts for d in (-2, -1, 0, 1, 2))

    # paragraphs: vertical gap on the same page, or a margin label starting at this line
    paras: list[dict] = []
    for l in body:
        p = paras[-1] if paras else None
        if p and p["page"] == l["page"] and l["y0"] - p["lines"][-1]["y1"] <= 5.0 and not starts_label(l):
            p["lines"].append(l)
        elif p and p["page"] != l["page"] and not re.search(r"[.:!?]$", p["lines"][-1]["text"]) and l["y0"] < 0.2 * l["h"]:
            p["lines"].append(l)  # paragraph continues on next page
        else:
            paras.append({"page": l["page"], "y0": l["y0"], "lines": [l]})
    for g in groups:
        g["text"] = _join_label([x["text"] for x in g["lines"]])
        best = None
        for i, p in enumerate(paras):
            if p["page"] != g["page"]:
                continue
            ys = [x["y0"] for x in p["lines"]]
            if min(ys) - 4 <= g["y0"] <= max(ys) + 4:
                d = abs(min(ys) - g["y0"])
                if best is None or d < best[0]:
                    best = (d, i)
        if best:
            paras[best[1]].setdefault("labels", []).append(g["text"])
    rules: list[dict] = []
    for p in paras:
        if p.get("labels") or not rules:
            rules.append({"type": " / ".join(p.get("labels") or []) or None, "page": p["page"], "paras": [p]})
        else:
            rules[-1]["paras"].append(p)
    for r in rules:
        r["section"] = section["heading"]
    return rules


def _join_label(parts: list[str]) -> str:
    out = ""
    for t in parts:
        t = t.strip()
        if not out:
            out = t
        elif out.endswith("-") and not out.endswith(" -") and re.match(r"^[a-zäöü]", t):
            out = out[:-1] + t
        elif out.endswith("-") and re.match(r"^[A-ZÄÖÜ]", t):
            out = out + t
        elif out.endswith("/"):
            out = out + t
        else:
            out = out + " " + t
    return out


# --------------------------------------------------------------------------- text-only reading (no PDF)

def _rules_from_text(pages_text: dict[int, str]) -> list[dict]:
    """Fallback for PyMuPDF get_text() order: each block = body lines followed by its margin label line(s)."""
    rules: list[dict] = []
    section = None
    for pno in sorted(pages_text):
        blocks, cur = [], []
        for raw in pages_text[pno].splitlines():
            if raw.strip():
                cur.append(raw.strip())
            elif cur:
                blocks.append(cur)
                cur = []
        if cur:
            blocks.append(cur)
        for b in blocks:
            if len(b) == 1 and re.fullmatch(r"\d{1,3}", b[0]):
                continue
            if NUM_HEADING_RX.match(b[0]):
                if SECTION_RX.match(b[0]):
                    section = norm_ws(b[0])
                    b = b[1:]
                    if not b:
                        continue
                else:
                    section = None
                    continue
            if section is None:
                continue
            # trailing short lines without sentence punctuation = margin label
            k = len(b)
            while k > 1 and len(b) - k < 3 and len(b[k - 1]) <= 26 and not re.search(r"[.:;,]$", b[k - 1]) \
                    and not re.match(r"^[-•\d]", b[k - 1]):
                k -= 1
            label_lines = b[k:]
            body = b[:k]
            if label_lines and body and (len(body[-1]) > 30 or re.search(r"[.:)]$", body[-1])):
                para = {"page": pno, "lines": [{"text": x, "page": pno} for x in body]}
                rules.append({"type": _join_label(label_lines), "page": pno, "paras": [para], "section": section})
            else:
                para = {"page": pno, "lines": [{"text": x, "page": pno} for x in b]}
                if rules and rules[-1]["section"] == section:
                    rules[-1]["paras"].append(para)
                else:
                    rules.append({"type": None, "page": pno, "paras": [para], "section": section})
    return rules


# --------------------------------------------------------------------------- rule analysis

def _para_text(p: dict) -> str:
    return join_lines([l["text"] for l in p["lines"]])


def _rule_text(rule: dict) -> str:
    return " ".join(_para_text(p) for p in rule["paras"])


def _signals(sentence: str) -> set[str]:
    s = set()
    if RISK_RX.search(sentence):
        s.add("risk")
    if COST_RX.search(sentence):
        s.add("cost")
    if VARIANT_RX.search(sentence):
        s.add("variant")
    if PROHIBIT_RX.search(sentence):
        s.add("prohibit")
    elif WEAK_PROHIBIT_RX.search(sentence):
        s.add("weak_prohibit")
    if PAY_RX.search(sentence):
        s.add("pay")
    return s


def _strip_exclusions(text: str) -> str:
    return re.sub(r"\((?:exkl|ohne|ausser|ausgenommen)\.?[^)]*\)", " ", text, flags=re.I)


def _rule_family(rule: dict, quote: str) -> str | None:
    for src in (rule.get("type") or "", quote, _rule_text(rule)[:300]):
        t = matcher._lex_first(_strip_exclusions(src).lower())
        if t:
            return matcher.family_of(t)
    return None


def _select_quote(rule: dict) -> tuple[str, set[str]]:
    sents = []
    for p in rule["paras"]:
        sents.extend(split_sentences(_para_text(p)))
    sig = [_signals(s) for s in sents]
    strong = [i for i, sg in enumerate(sig) if sg & {"risk", "cost", "variant"}]
    if strong:
        lo, hi = strong[0], strong[-1]
        if "risk" in sig[lo] and lo > 0 and "pay" in sig[lo - 1]:
            lo -= 1  # "Die erste Messung wird ... vergütet." belongs to the risk sentence
        if hi - lo > 3:
            hi = lo
        chosen = sents[lo:hi + 1]
    else:
        first = _para_text(rule["paras"][0])
        chosen = split_sentences(first)
        while len(" ".join(chosen)) > 480 and len(chosen) > 1:
            chosen = chosen[:-1]
    kinds = set().union(*(sig[sents.index(c)] for c in chosen)) if chosen else set()
    return " ".join(chosen), kinds | (set().union(*sig) if sig else set())


def _position_type(p: dict, matches: dict | None) -> str | None:
    m = (matches or {}).get(p["lv_id"]) or p.get("match") or {}
    a = m.get("attributes") or p.get("attributes") or {}
    return a.get("type") or matcher.normalize(p).get("type")


def _applies(family: str | None, positions: list[dict], fam_of_pos: dict[str, str | None]) -> list[str]:
    if not family:
        return []
    return [p["lv_id"] for p in positions
            if fam_of_pos.get(p["lv_id"]) == family or matcher.FAMILY_PARENT.get(fam_of_pos.get(p["lv_id"]) or "") == family]


def _short_ids(ids: list[str]) -> str:
    if not ids:
        return ""
    first = ids[0]
    rest = [re.sub(r"^[A-Za-z]+", "", i) for i in ids[1:]]
    return ", ".join([first] + rest)


def _pos_long(p: dict, titles: dict) -> str:
    t = (titles.get(p["lv_id"]) or {}).get("title_en") or p.get("title_en") or p.get("title_de") or ""
    q = p.get("quantity")
    qs = f", {q:g} {p.get('unit') or ''}".rstrip() if isinstance(q, (int, float)) else ""
    return f"{p['lv_id']} {t}{qs}, p. {p.get('page')}"


def _covered_by_product(rule_text: str, ids: list[str], matches: dict, rows_by_id: dict) -> str | None:
    feats = [eng for rx, eng in FEATURES if rx.search(rule_text)]
    if not feats or not ids:
        return None
    words = [w for f in feats for w in f]
    descs = []
    for lv in ids:
        pid = ((matches or {}).get(lv) or {}).get("product_id")
        if not pid or pid not in rows_by_id:
            return None
        descs.append(rows_by_id[pid].get("description", "").lower())
    hit = [w for w in words if all(w in d for d in descs)]
    if hit:
        return hit[0].rstrip("_")
    return None


def _allowance_for(text: str) -> tuple[str, float | None] | None:
    try:
        params = json.loads((config.REFERENCE_DIR / "project_parameters.json").read_text("utf-8"))
        allow = params.get("allowances", {})
    except Exception:
        allow = {}
    for rx, key, label in ALLOWANCES:
        if rx.search(text):
            return label, allow.get(key)
    return None


def _why(kind: str, family: str | None, sig: set[str], ids: list[str], quote: str, extra: str | None,
         quote_ids: set[str]) -> str:
    fam = (matcher.family_label(family) or "").lower()
    if kind == "covered":
        if extra and extra.startswith("allowance:"):
            return f"Covered by the {extra.split(':', 1)[1]} in Pricing."
        if extra:
            word = {"actuator": "actuator", "insulat": "insulation", "cladding": "cladding"}.get(extra, extra)
            return f"The matched product already includes the {word}, so nothing extra to price."
        return "Already covered by the matched products."
    if kind == "cost":
        verb = re.search(r"eingerechnet|einzurechnen|mitzuliefern|einzukalkulieren|inbegriffen", quote, re.I)
        v = f'"{verb.group(0)}": ' if verb else ""
        return f"The tender says this must be {v}included in our price" + (f" for the {fam} lines." if fam else ".")
    if kind == "risk":
        return "If this goes wrong, re-work and follow-up costs are ours." if "Folgekosten" in quote or "Nachprüf" in quote \
            else "Costs from not meeting this requirement are charged to us."
    if "variant" in sig:
        return "Swapping a product turns that line into a variant that needs a written reason."
    if ids and set(ids) & quote_ids:
        n = len(set(ids) & quote_ids)
        lead = "This line needs" if len(ids) == 1 else (f"{n} of these lines need" if n > 1 else "One of these lines needs")
        return f"{lead} a supplier quote. The text belongs in that request so the quote matches the spec."
    if "prohibit" in sig or "weak_prohibit" in sig:
        return f"Limits what may be offered" + (f" for {fam}." if fam else ".")
    if ids:
        return f"Sets how the {fam or 'affected'} lines must be built; no price change if the products follow it."
    return "Sets a requirement for the whole installation; check it is reflected in the offer."


# --------------------------------------------------------------------------- LLM selection

_LLM_SYSTEM = """You help a Swiss HVAC estimator read the technical conditions of a tender (German).
You get numbered candidate rules (margin label + text) and a summary of the priced lines.
Choose the 10 to 16 rules that matter most for the price or the risk of the offer, and for each:
- quote_de: the key sentence(s) copied EXACTLY from that rule's text (verbatim, no edits, no ellipsis). Prefer the sentence that carries the obligation.
- text_en: faithful English translation of quote_de.
- kind: "cost" = something we must include in our price (extra material, spare parts, 'einzurechnen', 'mitzuliefern');
  "risk" = cost exposure for us if something fails (re-tests, follow-up costs, penalties);
  "scope" = defines what/how without a price change (standards, materials, allowed products, variants);
  "covered" = already covered by the matched product (see product descriptions) or by an allowance listed.
- why: one plain English sentence for the estimator explaining the impact (max 25 words).
Prefer rules that concern products present in the tender lines, cost/risk obligations, and the variant rule."""


def _llm_select(rules: list[dict], quotes: dict, pos_summary: dict, allowances: list[str]) -> dict | None:
    ids = [r["id"] for r in rules]
    schema = {
        "type": "object",
        "properties": {"instructions": {"type": "array", "items": {
            "type": "object",
            "properties": {"rule_id": {"type": "string", "enum": ids}, "quote_de": {"type": "string"},
                           "text_en": {"type": "string"}, "kind": {"type": "string", "enum": ["cost", "risk", "scope", "covered"]},
                           "why": {"type": "string"}},
            "required": ["rule_id", "quote_de", "text_en", "kind", "why"], "additionalProperties": False}}},
        "required": ["instructions"], "additionalProperties": False,
    }
    payload = {
        "allowances_in_pricing": allowances,
        "tender_lines_by_product_family": pos_summary,
        "rules": [{"rule_id": r["id"], "label": r.get("type"), "page": r["page"], "text_de": r["text"][:1500]} for r in rules],
    }
    try:
        return llm.call_json(_LLM_SYSTEM, json.dumps(payload, ensure_ascii=False, indent=1), schema,
                             name="tender_instructions", temperature=0)
    except (llm.LLMUnavailable, llm.LLMError):
        return None


# --------------------------------------------------------------------------- main

def extract_instructions(pages_text: dict[int, str] | None, positions: list[dict], catalog=None, pdf=None,
                         matches: dict | None = None, use_llm: bool | None = None, max_rules: int = 16,
                         titles: dict | None = None) -> list[dict]:
    # subtotals ("Total Kanäle B") and pure text blocks are never what a rule applies to
    positions = [p for p in positions if p.get("kind") not in ("subtotal", "text_only")]
    doc = open_pdf(pdf)
    if doc is not None:
        last_cond = min(doc.page_count, min([p.get("page") or 10**6 for p in positions] or [doc.page_count]) - 1) or doc.page_count
        raw_rules = []
        for sec in _sections_layout(doc, max_page=max(last_cond, 1)):
            raw_rules.extend(_rules_from_layout(sec))
        if pages_text is None:
            pages_text = pages_text_from_pdf(doc, list(range(1, max(last_cond, 1) + 1)))
    else:
        raw_rules = _rules_from_text(pages_text or {})
    if not raw_rules:
        return []
    rows = matcher._as_rows(catalog)
    rows_by_id = {r["product_id"]: r for r in rows}
    titles = titles or {}
    fam_of_pos = {p["lv_id"]: matcher.family_of(_position_type(p, matches)) for p in positions}
    quote_ids = set()
    for p in positions:
        m = (matches or {}).get(p["lv_id"]) or p.get("match") or {}
        pid = m.get("product_id")
        if p.get("status") == "supplier_quote_required" or p.get("offer_ref") or (pid and rows_by_id.get(pid, {}).get("supplier_quote_required")):
            quote_ids.add(p["lv_id"])
    trade_words = {"lüftung", "klima", "ventilation"}

    analysed = []
    for i, r in enumerate(raw_rules):
        text = _rule_text(r)
        if len(text) < 25:
            continue
        quote, sig = _select_quote(r)
        fam = _rule_family(r, quote)
        ids = _applies(fam, positions, fam_of_pos)
        allowance = _allowance_for(quote) if "cost" in sig else None
        covered_feat = _covered_by_product(text, ids, matches or {p["lv_id"]: p.get("match") or {} for p in positions}, rows_by_id)
        if "risk" in _signals(quote):
            kind = "risk"
        elif "cost" in _signals(quote):
            kind = "covered" if allowance else "cost"
        elif covered_feat:
            kind = "covered"
        else:
            kind = "scope"
        score = 0.0
        score += 5 if kind in ("risk", "cost") or allowance else 0
        score += 5 if "variant" in sig else 0
        score += 2.5 if "prohibit" in sig else (1.0 if "weak_prohibit" in sig else 0)
        score += 3 if ids else (0.5 if fam else 0)
        score += 1 if ids and set(ids) & quote_ids else 0
        score += 1 if covered_feat else 0
        score += 1 if any(w in r["section"].lower() for w in trade_words) else 0
        score -= 1 if len(quote) > 700 else 0
        extra = f"allowance:{allowance[0]}" + (f" ({allowance[1]:g}%)" if allowance and allowance[1] is not None else "") if allowance else covered_feat
        analysed.append({"id": f"r{i:03d}", "rule": r, "type": r.get("type") or (r["section"].split(" ", 1)[-1]),
                         "page": r["page"], "section": r["section"], "text": text, "quote": quote, "sig": sig,
                         "family": fam, "ids": ids, "kind": kind, "score": score, "extra": extra})

    chosen, per_family = [], {}
    for a in sorted([a for a in analysed if a["score"] >= 3], key=lambda a: -a["score"]):
        f = a["family"] or "_whole"
        if a["family"] and per_family.get(f, 0) >= 2 and a["kind"] == "scope":
            continue  # keep variety: at most two scope rules per product family
        per_family[f] = per_family.get(f, 0) + 1
        chosen.append(a)
    chosen = chosen[:max_rules]
    llm_items: dict[str, dict] = {}
    if use_llm is not False:
        cand = sorted(analysed, key=lambda a: -a["score"])[:45]
        fam_counts: dict[str, Any] = {}
        for p in positions:
            f = fam_of_pos.get(p["lv_id"])
            if f:
                e = fam_counts.setdefault(matcher.family_label(f), {"lines": 0, "matched_products": set()})
                e["lines"] += 1
                pid = ((matches or {}).get(p["lv_id"]) or p.get("match") or {}).get("product_id")
                if pid in rows_by_id:
                    e["matched_products"].add(rows_by_id[pid]["description"])
        summary = {k: {"lines": v["lines"], "matched_products": sorted(v["matched_products"])[:6]} for k, v in fam_counts.items()}
        allow_desc = []
        for rx, key, label in ALLOWANCES:
            a = _allowance_for(label.split()[0].capitalize())
            allow_desc.append(f"{label}" + (f" {a[1]:g}%" if a and a[1] is not None else ""))
        res = _llm_select([{"id": a["id"], "type": a["type"], "page": a["page"], "text": a["text"]} for a in cand], {}, summary, allow_desc)
        if res:
            by_id = {a["id"]: a for a in analysed}
            picked = []
            for it in res.get("instructions", []):
                a = by_id.get(it["rule_id"])
                if not a or a in picked:
                    continue
                q = find_verbatim(it["quote_de"], a["text"])
                if q:
                    a["quote"] = q
                    a["text_en"] = it["text_en"]
                else:
                    a["text_en"] = None  # keep the rules quote; the LLM translation was for another text
                a["kind"] = it["kind"] if it["kind"] != "covered" or a["kind"] == "covered" or a["ids"] else a["kind"]
                a["why_llm"] = it["why"]
                a["method"] = "llm"
                picked.append(a)
            if picked:
                chosen = picked[:max_rules]

    chosen.sort(key=lambda a: (a["page"], analysed.index(a)))
    out = []
    for n, a in enumerate(chosen, 1):
        ids = a["ids"]
        fam_label = matcher.family_label(a["family"]) if a["family"] else None
        if "variant" in a["sig"]:
            label, long = "Product changes", "Any line where you pick a product other than the one specified."
        elif ids and len(ids) <= 4:
            label = _short_ids(ids)
            plist = [p for p in positions if p["lv_id"] in ids]
            long = "; ".join(_pos_long(p, titles) for p in plist) + "."
        elif ids:
            pages = sorted({p.get("page") for p in positions if p["lv_id"] in ids if p.get("page")})
            label = f"{len(ids)} {fam_label.lower() if fam_label else 'lines'}"
            long = f"All {fam_label.lower() if fam_label else ''} lines ({len(ids)}): {', '.join(ids[:12])}{' …' if len(ids) > 12 else ''}" + \
                   (f", pages {pages[0]}–{pages[-1]}." if len(pages) > 1 else (f", page {pages[0]}." if pages else "."))
        elif a["family"]:
            label = f"{fam_label} lines"
            long = f"{fam_label} lines (none found in this tender's priced lines)."
        else:
            label, long = "Whole installation", "The whole installation."
        quote = a["quote"]
        if not verbatim_in(quote, a["text"]):  # should never happen; keep the honest full text instead
            quote = a["text"]
        why = a.get("why_llm") or _why(a["kind"], a["family"], a["sig"], ids, quote, a["extra"], quote_ids)
        bbox = search_bbox(doc, a["page"], quote) if doc is not None else None
        out.append({
            "id": f"i_{n:02d}", "type": a["type"], "page": a["page"], "section": a["section"],
            "text_de": quote, "text_en": a.get("text_en"), "bbox": bbox,
            "kind": a["kind"], "applies_to": ids, "applies_label": label, "applies_long": long, "why": why,
            "family": a["family"], "method": a.get("method", "rules"),
            "state": "open", "confirmed_by": None, "confirmed_at": None,
        })
    # Translate quotes the LLM did not translate: LLM if available, else the deterministic glossary gist
    for o in out:
        o["text_en_method"] = "llm" if o["text_en"] else None
    missing = {o["id"]: o["text_de"] for o in out if not o["text_en"]}
    if missing:
        from .translate import translate_texts_or_gloss

        tr = translate_texts_or_gloss(missing, use_llm=use_llm, context="Swiss German ventilation tender (technical conditions)")
        for o in out:
            if not o["text_en"] and tr.get(o["id"], (None, None))[0]:
                o["text_en"], o["text_en_method"] = tr[o["id"]]
    return out
