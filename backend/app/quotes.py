"""Supplier quotes: group lines for one request, draft the German email, read the supplier's reply.

    group_for_quotes(positions, matches=None, catalog=None, instructions=None) -> [{id, title, title_de, lv_ids, rule, rule_ref, ...}]
    draft_request(tender_meta, group, positions, instructions=None) -> {subject, body_de}
    read_supplier_reply(file_bytes_or_text, filename, positions, use_llm=None) -> [{lv_id, unit_price, quoted_text, source, confidence, ...}]
    make_demo_replies(out_dir=None) -> [Path]      (writes the two demo supplier PDFs)

The email is a deterministic template (no LLM). Reading a reply: rules first (LV ids, sizes and
quantities in the reply lines; unit price = the price that times the quantity gives the line total),
then the LLM (if available) may map lines the rules could not, constrained to the given lv_ids.
Prices are always parsed by code from the quoted reply text; the LLM never produces a number.
"""
from __future__ import annotations

import datetime as dt
import email
import email.policy
import json
import re
from pathlib import Path

from . import config, llm, matcher
from . import pricing as P
from .meta import norm_ws, verbatim_in

UNIT_DE = {"pc": "Stk", "m2": "m²", "m": "m", "LS": "psch", "h": "h", "kg": "kg", "system": "Anlage"}


# --------------------------------------------------------------------------- grouping

def _attrs(p: dict, matches: dict | None) -> dict:
    m = (matches or {}).get(p["lv_id"]) or p.get("match") or {}
    return m.get("attributes") or p.get("attributes_norm") or matcher.normalize(p)


def _needs_quote(p: dict, matches: dict | None, rows_by_id: dict) -> bool:
    if p.get("kind", "item") in matcher.SKIP_KINDS:
        return False
    if (p.get("pricing") or {}).get("unit_price_source") == "labour" or P.is_hourly_work(p):
        return False  # hourly work is priced as our own labour, a supplier has nothing to quote
    if p.get("status") == "supplier_quote_required" or p.get("offer_ref"):
        return True
    m = (matches or {}).get(p["lv_id"]) or p.get("match") or {}
    pid = m.get("product_id")
    if not pid and (m.get("label") or "None") == "None" and p.get("quantity"):
        return True  # not in the catalogue: a supplier has to price it
    return bool(pid and rows_by_id.get(pid, {}).get("supplier_quote_required"))


# Extra type words that put a line into a supplier group. Grouping only: the product families in
# matcher.FAMILIES (used for rules and matching) stay as they are.
GROUP_TYPES: list[tuple[str, re.Pattern]] = [(k, re.compile(rx, re.I)) for k, rx in (
    ("controls", r"smoke detector|frost|thermostat|pressure switch|manometer|gauge|measur"),
    ("air_terminal", r"transfer air|overflow|air outlet|nozzle"),
    ("duct", r"flexible connector|sleeve|leakage test|\bpipe\b|\bduct\b"),
    ("support", r"mounting (?:feet|foot|rail)|bracket|hanger"),
    ("marking", r"label|arrow|marking|\bsign\b|equipotential|bonding"),
)]
GROUP_LABELS = {"marking": ("Labels and bonding", "Beschriftung und Potentialausgleich")}
# common section names of Swiss bills of quantities (NPK / SIA 451), for groups of leftover lines
SECTION_EN = {"apparate": "Equipment", "geräte": "Equipment", "kanäle": "Ducts", "rohre": "Pipes",
              "armaturen und instrumente": "Fittings and instruments", "armaturen": "Fittings",
              "regulierung": "Controls", "steuerung und regelung": "Controls", "msr": "Controls",
              "montage, dienstleistungen": "Installation and services", "montage": "Installation",
              "dienstleistungen": "Services", "dämmungen": "Insulation", "isolierungen": "Insulation",
              "brandschutz": "Fire protection", "diverses": "Miscellaneous", "allgemeines": "General items"}


def _own_group(p: dict, matches: dict | None) -> str | None:
    typ = _attrs(p, matches).get("type")
    fam = matcher.family_of(typ)
    if fam or not typ:
        return fam
    return next((k for k, rx in GROUP_TYPES if rx.search(typ)), None)


def _group_label(key: str, lang: str) -> str:
    if key in GROUP_LABELS:
        return GROUP_LABELS[key][0 if lang == "en" else 1]
    return matcher.family_label(key, lang) or key


def _section_title(name: str) -> tuple[str, str]:
    de = norm_ws(name).strip(" ,.:")
    en = SECTION_EN.get(de.lower())
    if de.count(",") == 1:  # "Montage, Dienstleistungen" -> "Montage und Dienstleistungen"
        de = de.replace(", ", " und ")
    if not en:
        from .translate import gloss

        en = (gloss(de)[0] or de).strip()
        en = en[:1].upper() + en[1:]
    return en, de


def _resolve_groups(positions: list[dict], matches: dict | None) -> dict[str, str | None]:
    """Group key per item line: its own product family; else the parent device's family (parts of an
    air-handling unit go with the unit); else the family of the nearest neighbour in the same system and
    section (a colour coating or a mounting frame goes with the device it belongs to)."""
    items = [p for p in positions if p.get("kind", "item") not in matcher.SKIP_KINDS]
    own = {p["lv_id"]: _own_group(p, matches) for p in items}
    res: dict[str, str | None] = {}
    for p in items:
        parent = p.get("parent_lv_id")
        res[p["lv_id"]] = (own.get(parent) if parent and own.get(parent) else None) or own[p["lv_id"]]
    block = lambda p: (p.get("system_key") or p.get("system"), p.get("section"), p.get("section_name"))  # noqa: E731
    for i, p in enumerate(items):
        if res[p["lv_id"]]:
            continue
        found = None
        for step in (-1, -2, -3, 1, 2):  # nearest neighbour first, before the line, then after it
            j = i + step
            if 0 <= j < len(items) and block(items[j]) == block(p) and not P.is_hourly_work(items[j]):
                found = res.get(items[j]["lv_id"]) if step < 0 else own.get(items[j]["lv_id"])
                if found:
                    break
        res[p["lv_id"]] = found
    return res


def group_for_quotes(positions: list[dict], matches: dict | None = None, catalog=None,
                     instructions: list[dict] | None = None) -> list[dict]:
    """One supplier request per product family (silencers, dampers, ...). Lines of no family go with their
    parent device or neighbour, else into one request per tender section ("Regulierung", "Montage")."""
    rows_by_id = {r["product_id"]: r for r in matcher._as_rows(catalog)}
    fam_of = _resolve_groups(positions, matches)
    groups: dict[str, dict] = {}
    for p in positions:
        if not _needs_quote(p, matches, rows_by_id):
            continue
        fam = fam_of.get(p["lv_id"])
        if fam:
            key, title, title_de = fam, _group_label(fam, "en"), _group_label(fam, "de")
        else:
            sec = (p.get("section_name") or "").strip()
            if sec:
                title, title_de = _section_title(sec)
                key = "sec_" + re.sub(r"[^a-z0-9]+", "_", title_de.lower()).strip("_")[:30]
            else:
                key, title, title_de = "other", "Other items", "Weitere Positionen"
        g = groups.setdefault(key, {"id": key, "title": title, "title_de": title_de, "lv_ids": []})
        g["lv_ids"].append(p["lv_id"])
    out = list(groups.values())
    for g in out:
        rule = _rule_for(g, instructions or [])
        g["rule"] = rule["text_de"] if rule else ""
        g["rule_ref"] = f"{rule['type']}, S. {rule['page']}" if rule else ""
        g["rule_page"] = rule["page"] if rule else None
        g["instruction_id"] = rule["id"] if rule else None
    order = {p["lv_id"]: i for i, p in enumerate(positions)}
    out.sort(key=lambda g: min(order[i] for i in g["lv_ids"]))
    return out


def _rule_for(group: dict, instructions: list[dict]) -> dict | None:
    ids = set(group["lv_ids"])
    best = None
    for n, ins in enumerate(instructions):
        if ins.get("state") == "not_relevant":
            continue
        overlap = len(ids & set(ins.get("applies_to") or []))
        fam = ins.get("family")
        fam_hit = fam and (fam == group["id"] or matcher.FAMILY_PARENT.get(group["id"]) == fam)
        if not overlap and not fam_hit:
            continue
        score = (overlap, 1 if ins.get("kind") in ("scope", "cost") else 0, -n)
        if best is None or score > best[0]:
            best = (score, ins)
    return best[1] if best else None


# --------------------------------------------------------------------------- request email

def _line_de(p: dict, a: dict) -> str:
    title = (p.get("title_de") or (p.get("text_de") or "").split("\n")[0]).strip()
    size = a.get("size_text")
    has_size = re.search(r"\d\s*[x×]\s*\d|Ø|ø|\bDN\s*\d", title)
    if size and not has_size and norm_ws(size).replace(" ", "") not in norm_ws(title).replace(" ", ""):
        title = f"{title} {size}"
    q = p.get("quantity")
    qty = f"{q:g} {UNIT_DE.get(p.get('unit'), p.get('unit_raw') or p.get('unit') or '')}".strip() if isinstance(q, (int, float)) else "Menge gemäss LV"
    line = f"{p['lv_id']} · Seite {p.get('page')} · {title} · {qty}"
    hint = " ".join(x for x in (p.get("make_hint"), p.get("model_hint")) if x)
    if hint:
        line += f"\n    (Ausschreibung: z.B. {hint})"
    return line


def _fmt_date(iso: str | None) -> str | None:
    try:
        return dt.datetime.fromisoformat(iso).strftime("%d.%m.%Y") if iso else None
    except ValueError:
        return None


def draft_request(tender_meta: dict, group: dict, positions: list[dict], instructions: list[dict] | None = None,
                  sender: str = "[Ihr Name], Equans", matches: dict | None = None) -> dict:
    by_id = {p["lv_id"]: p for p in positions}
    plist = [by_id[i] for i in group["lv_ids"] if i in by_id]
    n = len(plist)
    name = tender_meta.get("name") or "das Projekt"
    trade = tender_meta.get("trade") or ""
    bkp = re.search(r"BKP\s*\d+", trade)
    subject = f"Preisanfrage {group['title_de']} ({n} Position{'en' if n != 1 else ''}) · {name}" + (f", {bkp.group(0)}" if bkp else "")
    rule, ref = group.get("rule"), group.get("rule_ref")
    if not rule and instructions:
        r = _rule_for(group, instructions)
        rule, ref = (r["text_de"], f"{r['type']}, S. {r['page']}") if r else (None, None)
    lines = [_line_de(p, _attrs(p, matches)) for p in plist]
    body = ["Guten Tag", "",
            f"Für das Projekt {name}" + (f" ({trade})" if trade else "") + " bitten wir Sie um ein Angebot für folgende Positionen:", ""]
    body += [f"- {l}" for l in lines]
    if rule:
        body += ["", f"Anforderungen gemäss Ausschreibung ({ref}):", f"«{rule}»"]
    body += ["", "Bitte nennen Sie uns Netto-Einheitspreis, Lieferzeit und Gültigkeit."]
    val = (tender_meta.get("offer_validity") or {}).get("text_de")
    if val:
        body.append(f"Gemäss Ausschreibung gilt: «{val}»")
    due = _fmt_date(tender_meta.get("due_at"))
    if due:
        reply_by = _fmt_date((dt.datetime.fromisoformat(tender_meta["due_at"]) - dt.timedelta(days=7)).isoformat())
        body.append(f"Unser Eingabetermin ist der {due}; wir danken für Ihre Antwort bis {reply_by}.")
    body += ["", "Freundliche Grüsse", sender]
    return {"subject": subject, "body_de": "\n".join(body), "lv_ids": [p["lv_id"] for p in plist]}


# --------------------------------------------------------------------------- reading a reply

PRICE_RX = re.compile(r"(?<![\d'’.,])(?:CHF\s*|Fr\.\s*)?(\d{1,3}(?:['’ ]\d{3})+|\d+)([.,]\d{2})(?![\d])")
QTY_RX = re.compile(r"(?<![\d.,'’x×])(\d+(?:[.,]\d+)?)\s*(Stk\.?|Stück|St\.|pcs?|m2|m²|lfm|m)(?![\w²])", re.I)
LV_RX = re.compile(r"\bLV\s?-?(\d{1,6})\b", re.I)
POS_RX = re.compile(r"^\s*(?:Pos(?:ition)?\.?\s*)?(\d{1,3}(?:\.\d{1,3})?)\s+(?=\D)")
META_RX = re.compile(r"(Gültigkeit|gültig|Lieferzeit|Lieferfrist|Zahlungs|Preise\s+netto|exkl\.\s*MWST)[^\n]*", re.I)


def _parse_price(s: str) -> float:
    s = s.replace("CHF", "").replace("Fr.", "").strip()
    s = re.sub(r"['’ ]", "", s)
    return float(s.replace(",", "."))


def _prices(line: str) -> list[tuple[float, str]]:
    out = []
    for m in PRICE_RX.finditer(line):
        try:
            out.append((_parse_price(m.group(1) + m.group(2)), m.group(0).strip()))
        except ValueError:
            pass
    return out


def _pdf_rows_text(page) -> str:
    """Page text with table cells on the same baseline joined into one row (cells separated by 2 spaces)."""
    words = page.get_text("words")
    words.sort(key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    rows: list[list] = []
    for w in words:
        yc = (w[1] + w[3]) / 2
        if rows and abs(rows[-1][0] - yc) <= 2.5:
            rows[-1][1].append(w)
        else:
            rows.append([yc, [w]])
    lines, last_y = [], None
    for yc, ws in rows:
        ws.sort(key=lambda w: w[0])
        parts, prev = [], None
        for w in ws:
            if prev is not None and w[0] - prev[2] > 6:
                parts.append("  ")
            elif prev is not None:
                parts.append(" ")
            parts.append(w[4])
            prev = w
        if last_y is not None and yc - last_y > 18:
            lines.append("")
        lines.append("".join(parts))
        last_y = yc
    return "\n".join(lines)


def extract_reply_pages(file, filename: str = "") -> list[tuple[int, str]]:
    """PDF bytes/path -> [(page, text)]; e-mail (.eml) or plain text -> [(1, text)]."""
    if isinstance(file, (str, Path)) and Path(str(file)).exists() and len(str(file)) < 1024:
        file = Path(file).read_bytes()
    if isinstance(file, (bytes, bytearray)):
        b = bytes(file)
        if b[:5] == b"%PDF-":
            import pymupdf

            try:
                doc = pymupdf.open(stream=b, filetype="pdf")
            except Exception as e:  # damaged or not really a PDF: a clear 400, not a crash
                raise ValueError(f"Could not read {filename or 'the PDF'}: the file is damaged or not a PDF") from e
            return [(i + 1, _pdf_rows_text(doc[i])) for i in range(doc.page_count)]
        if filename.lower().endswith(".eml") or b[:200].lower().find(b"subject:") >= 0:
            msg = email.message_from_bytes(b, policy=email.policy.default)
            part = msg.get_body(preferencelist=("plain", "html"))
            text = part.get_content() if part else ""
            if part is not None and part.get_content_type() == "text/html":
                text = re.sub(r"<[^>]+>", " ", text)
            return [(1, f"Betreff: {msg.get('subject', '')}\n{text}")]
        return [(1, b.decode("utf-8", errors="replace"))]
    return [(1, str(file or ""))]


def _reply_rows(pages: list[tuple[int, str]]) -> list[dict]:
    """Price-bearing rows; a row may continue on the next line(s) until a price appears."""
    rows = []
    for page, text in pages:
        lines = [l.rstrip() for l in text.splitlines()]
        buf: list[str] = []
        for l in lines:
            if not l.strip():
                buf = []
                continue
            buf.append(l.strip())
            if _prices(l):
                joined = " ".join(buf[-4:])
                rows.append({"page": page, "text": joined, "last": l.strip()})
                buf = []
    return rows


def _lv_norm(num: str) -> str:
    return f"LV{int(num):04d}"


def _size_consistent(line_sizes: dict, a: dict) -> bool:
    """An LV id quoted in a reply is trusted unless the line states a size that contradicts the position."""
    if line_sizes.get("dims_mm") and a.get("dims_mm"):
        return matcher._dims_equal(line_sizes["dims_mm"], a["dims_mm"])
    if line_sizes.get("dn_mm") and a.get("dn_mm"):
        return line_sizes["dn_mm"] == a["dn_mm"]
    if (line_sizes.get("dims_mm") or line_sizes.get("dn_mm")) and not (a.get("dims_mm") or a.get("dn_mm")):
        return False
    return True


def _rule_map(rows: list[dict], positions: list[dict], matches: dict | None) -> list[dict]:
    by_id = {p["lv_id"]: p for p in positions}
    attrs = {p["lv_id"]: _attrs(p, matches) for p in positions}
    out = []
    for r in rows:
        text = r["text"]
        prices = _prices(text)
        if not prices:
            continue
        qm = QTY_RX.search(text)
        qty = float(qm.group(1).replace(",", ".")) if qm else None
        unit_price, unit_txt = None, None
        if qty and len(prices) >= 2:
            for a, at in prices:
                for b, bt in prices:
                    if b > a and abs(a * qty - b) <= max(0.02, 0.005 * b):
                        unit_price, unit_txt = a, at
                        break
                if unit_price:
                    break
        if unit_price is None:
            if len(prices) == 1 or qty in (None, 1.0):
                unit_price, unit_txt = prices[0]
            else:
                unit_price, unit_txt = min(prices)
        # which position?
        cand, conf, how = None, 0.0, ""
        ids = [_lv_norm(m.group(1)) for m in LV_RX.finditer(text)]
        ids = [i for i in ids if i in by_id]
        line_sizes = matcher._sizes_in(text)
        if len(ids) == 1 and _size_consistent(line_sizes, attrs[ids[0]]):
            cand, conf, how = ids[0], 0.95, "LV id in reply"
        else:
            sizes = matcher._sizes_in(text)
            fam_hint = matcher.family_of(matcher._lex_first(text.lower()) or "")
            best = []
            for lv, a in attrs.items():
                s = 0.0
                if sizes.get("dims_mm") and a.get("dims_mm") and matcher._dims_equal(sizes["dims_mm"], a["dims_mm"]):
                    s += 2
                elif sizes.get("dn_mm") and a.get("dn_mm") and sizes["dn_mm"] == a["dn_mm"]:
                    s += 2
                if qty is not None and by_id[lv].get("quantity") == qty:
                    s += 1
                if fam_hint and matcher.family_of(a.get("type")) == fam_hint:
                    s += 0.5
                if a.get("thickness_mm") and re.search(rf"\b{int(a['thickness_mm'])}\s*mm\b", text):
                    s += 0.5
                if s:
                    best.append((s, lv))
            best.sort(reverse=True)
            if best and (len(best) == 1 or best[0][0] > best[1][0]) and best[0][0] >= 1.5:
                cand = best[0][1]
                conf = 0.85 if best[0][0] >= 3 else (0.75 if best[0][0] >= 2 else 0.6)
                how = "size and quantity match" if best[0][0] >= 3 else ("size match" if best[0][0] >= 2 else "type and quantity match")
        if not cand:
            continue
        pm = POS_RX.match(r["last"]) or POS_RX.match(text)
        out.append({"lv_id": cand, "unit_price": round(unit_price, 2), "unit_price_text": unit_txt, "quoted_qty": qty,
                    "quoted_text": r["last"] if verbatim_in(unit_txt, r["last"]) else text,
                    "page": r["page"], "pos": pm.group(1) if pm else None, "confidence": conf, "method": "rules",
                    "match_note": how})
    return out


_LLM_SYSTEM = """You read a supplier's offer (German, Swiss HVAC trade) and map its lines to our open tender positions.
For each offer line that prices one of the given positions, return:
- lv_id: one of the given lv_ids (each at most once)
- line_text: the offer line copied exactly as it appears in the text (one line, verbatim)
- unit_price_text: the net unit price exactly as written in that line (e.g. "2'480.00"), not the line total
- page: the page number from the '=== page N ===' marker; pos: the supplier's position number ('' if none)
Match by product type, dimensions and quantity. Skip lines you cannot map with confidence. Never compute or invent prices."""


def _llm_map(pages: list[tuple[int, str]], positions: list[dict], matches: dict | None) -> list[dict]:
    ids = [p["lv_id"] for p in positions]
    if not ids:
        return []
    schema = {"type": "object", "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {"lv_id": {"type": "string", "enum": ids}, "line_text": {"type": "string"},
                       "unit_price_text": {"type": "string"}, "page": {"type": "integer"}, "pos": {"type": "string"}},
        "required": ["lv_id", "line_text", "unit_price_text", "page", "pos"], "additionalProperties": False}}},
        "required": ["items"], "additionalProperties": False}
    plist = []
    for p in positions:
        a = _attrs(p, matches)
        plist.append({"lv_id": p["lv_id"], "text_de": (p.get("title_de") or "")[:120], "size": a.get("size_text") or matcher.size_label(a),
                      "type_en": a.get("type"), "quantity": p.get("quantity"), "unit": p.get("unit")})
    user = "Open positions:\n" + json.dumps(plist, ensure_ascii=False, indent=1) + "\n\nSupplier offer:\n" + \
        "\n".join(f"=== page {n} ===\n{t[:12000]}" for n, t in pages)
    res = llm.call_json(_LLM_SYSTEM, user, schema, name="read_supplier_reply", temperature=0)
    out = []
    page_text = dict(pages)
    for it in res.get("items", []):
        src = page_text.get(it["page"], "") or "\n".join(page_text.values())
        if not verbatim_in(it["line_text"], src) or not verbatim_in(it["unit_price_text"], it["line_text"]):
            continue
        pr = _prices(it["unit_price_text"])
        if not pr:
            continue
        qm = QTY_RX.search(it["line_text"])
        out.append({"lv_id": it["lv_id"], "unit_price": round(pr[0][0], 2), "unit_price_text": pr[0][1],
                    "quoted_qty": float(qm.group(1).replace(",", ".")) if qm else None,
                    "quoted_text": norm_ws(it["line_text"]), "page": it["page"], "pos": it.get("pos") or None,
                    "confidence": 0.8, "method": "llm", "match_note": "LLM mapping, price read by code"})
    return out


def read_supplier_reply(file, filename: str, positions: list[dict], use_llm: bool | None = None,
                        matches: dict | None = None) -> list[dict]:
    """Proposals only (never applied here). `positions` = the open supplier-quote lines to map to."""
    pages = extract_reply_pages(file, filename)
    rows = _reply_rows(pages)
    found = {}
    for pr in _rule_map(rows, positions, matches):
        if pr["lv_id"] not in found or pr["confidence"] > found[pr["lv_id"]]["confidence"]:
            found[pr["lv_id"]] = pr
    missing = [p for p in positions if p["lv_id"] not in found]
    if missing and use_llm is not False:
        try:
            for pr in _llm_map(pages, missing, matches):
                found.setdefault(pr["lv_id"], pr)
        except (llm.LLMUnavailable, llm.LLMError):
            pass
    notes = []
    for _, t in pages:
        notes += [norm_ws(m.group(0)) for m in META_RX.finditer(t)]
    by_order = {p["lv_id"]: i for i, p in enumerate(positions)}
    out = []
    for lv, pr in sorted(found.items(), key=lambda kv: by_order.get(kv[0], 0)):
        pos = f" pos {pr['pos']}" if pr.get("pos") else ""
        pr["source"] = f"{filename} p.{pr['page']}{pos}"
        pr["notes"] = notes[:4]
        out.append(pr)
    return out


# --------------------------------------------------------------------------- demo replies

DEMO_DIR = config.DATA_DIR / "demo"


def _offer_pdf(path: Path, supplier: list[str], offer_no: str, date: str, ref: str, rows: list[tuple],
               footer: list[str]) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    y = h - 22 * mm
    c.setFont("Helvetica-Bold", 13)
    c.drawString(20 * mm, y, supplier[0])
    c.setFont("Helvetica", 9)
    for i, s in enumerate(supplier[1:]):
        c.drawString(20 * mm, y - (i + 1) * 4.5 * mm, s)
    c.drawRightString(w - 20 * mm, y, f"Datum: {date}")
    y -= 30 * mm
    c.setFont("Helvetica", 10)
    for s in ("Equans (Demo)", "Kalkulation Gebäudetechnik", "z. Hd. Projektleitung"):
        c.drawString(20 * mm, y, s)
        y -= 4.8 * mm
    y -= 8 * mm
    c.setFont("Helvetica-Bold", 12)
    c.drawString(20 * mm, y, f"Angebot Nr. {offer_no}")
    y -= 6 * mm
    c.setFont("Helvetica", 10)
    c.drawString(20 * mm, y, ref)
    y -= 10 * mm
    c.setFont("Helvetica-Bold", 9)
    cols = [20, 31, 134, 150, 172]
    for x, t in zip(cols, ("Pos.", "Bezeichnung", "Menge", "EP netto CHF", "Total CHF")):
        c.drawString(x * mm, y, t)
    y -= 2 * mm
    c.line(20 * mm, y, w - 20 * mm, y)
    y -= 5 * mm
    c.setFont("Helvetica", 9)
    for pos, desc, qty, ep, total, sub in rows:
        c.drawString(cols[0] * mm, y, pos)
        c.drawString(cols[1] * mm, y, desc)
        c.drawString(cols[2] * mm, y, qty)
        c.drawRightString((cols[3] + 22) * mm, y, ep)
        c.drawRightString((cols[4] + 18) * mm, y, total)
        y -= 4.5 * mm
        c.setFillGray(0.35)
        for s in sub:
            c.drawString(cols[1] * mm, y, s)
            y -= 4.2 * mm
        c.setFillGray(0)
        y -= 3 * mm
    c.line(20 * mm, y, w - 20 * mm, y)
    y -= 8 * mm
    for s in footer:
        c.drawString(20 * mm, y, s)
        y -= 5 * mm
    c.save()


def make_demo_replies(out_dir: Path | None = None) -> list[Path]:
    """Two fictional supplier offers for the demo (silencers, air volume controllers)."""
    out_dir = Path(out_dir or DEMO_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    p1 = out_dir / "supplier_reply_silencers.pdf"
    _offer_pdf(p1, ["DemoAcoustic AG", "Industriestrasse 12, 8952 Schlieren", "Tel. 044 000 00 00 · offerten@demoacoustic.example"],
               "A-26-0917", "10.09.2026",
               "Ihre Anfrage vom 09.09.2026: Schalldämpfer, Neubau Primarschule Erlenstrasse, Oberglatt (BKP 244)",
               [("1", "Rechteckschalldämpfer MSA 400 x 300 x 1250 mm", "4 Stk", "2'480.00", "9'920.00",
                 ["Kulissen 100 mm, Lochblechabdeckung beidseitig, nicht brennbar (A1)"]),
                ("2", "Rechteckschalldämpfer MSA 600 x 600 x 1750 mm", "4 Stk", "5'150.00", "20'600.00",
                 ["2 Kulissen 200 mm, Dämpfung über das ganze Frequenzband gemäss Datenblatt"]),
                ("3", "Rechteckschalldämpfer MSA 540 x 400 x 1250 mm", "6 Stk", "3'720.00", "22'320.00",
                 ["2 Kulissen 200 mm, abriebfest bis 25 m/s"])],
               ["Preise netto, exkl. MWST, franko Baustelle Oberglatt.",
                "Lieferzeit: 4-5 Wochen ab Auftragsbestätigung.",
                "Gültigkeit des Angebots: 60 Tage.",
                "Freundliche Grüsse, DemoAcoustic AG"])
    p2 = out_dir / "supplier_reply_vav.pdf"
    _offer_pdf(p2, ["DemoControl GmbH", "Gewerbering 5, 6030 Ebikon", "Tel. 041 000 00 00 · verkauf@democontrol.example"],
               "VK-2026-3381", "11.09.2026",
               "Betreff: Volumenstromregler, Projekt Primarschule Erlenstrasse Oberglatt",
               [("10", "VVS-Regler rechteckig 500 x 300 mm, Modbus RTU", "4 Stk", "3'980.00", "15'920.00",
                 ["Dämmschale, werkseitig verdrahtet, inkl. Inbetriebnahme"]),
                ("20", "VVS-Regler rechteckig 300 x 200 mm, doppelwandig", "6 Stk", "3'250.00", "19'500.00",
                 ["Regelklappe dicht schliessend, Stellantrieb mit Drehwinkelbegrenzer"])],
               ["Alle Preise netto in CHF, exkl. MWST.",
                "Lieferfrist: ca. 6 Wochen.",
                "Angebot gültig bis 31.12.2026.",
                "Mit freundlichen Grüssen, DemoControl GmbH"])
    return [p1, p2]
