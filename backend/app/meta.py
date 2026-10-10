"""Tender meta from the first pages: name, client, trade, due date, submission rule, award criteria.

    extract_meta(pages_text, pdf=None, use_llm=None, max_pages=15) -> {
        name, client, trade, due_at (ISO local), meta_sources{field: page},
        submission_rule{page, heading, text_de, text_en, bbox}, award_criteria[{label, points, page, rule_de, rule_en}],
        offer_validity{page, text_de} | None, method}

pages_text: {page_number (1-based): text} as produced by PyMuPDF page.get_text(). When `pdf`
(path, bytes or pymupdf.Document) is given, the text is re-read from it and quote bboxes are added.
Rules (regex) run first and always; the LLM (if available) fills gaps and translates. Every German
quote is verified to occur in the page text (whitespace and line-break hyphenation normalised).
Also hosts small text helpers shared with instructions.py and quotes.py.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

from . import llm

# --------------------------------------------------------------------------- shared helpers

ABBREV = ("z.B.", "z. B.", "inkl.", "exkl.", "evtl.", "bzw.", "ca.", "Nr.", "max.", "mind.", "gem.", "resp.", "usw.",
          "etc.", "Art.", "Abs.", "lit.", "Pkt.", "Tel.", "Std.", "St.", "Stk.", "ggf.", "u.a.", "d.h.", "vgl.", "Fr.")


def open_pdf(pdf):
    """Path / bytes / pymupdf.Document -> pymupdf.Document (or None)."""
    if pdf is None:
        return None
    import pymupdf

    if isinstance(pdf, pymupdf.Document):
        return pdf
    if isinstance(pdf, (bytes, bytearray)):
        return pymupdf.open(stream=bytes(pdf), filetype="pdf")
    return pymupdf.open(str(pdf))


def pages_text_from_pdf(doc, pages: list[int] | None = None) -> dict[int, str]:
    pages = pages or list(range(1, doc.page_count + 1))
    return {n: doc[n - 1].get_text() for n in pages if 1 <= n <= doc.page_count}


def join_lines(lines: list[str]) -> str:
    """Join PDF lines into running text, undoing line-break hyphenation ('inte-' + 'griertem')."""
    out = ""
    for raw in lines:
        line = re.sub(r"[ \t ]+", " ", raw).strip()
        if not line:
            continue
        if not out:
            out = line
            continue
        m = re.search(r"([A-Za-zÄÖÜäöüß]{2,})-$", out)
        nxt_word = line.split(" ", 1)[0]
        if m and re.match(r"^[a-zäöüß]", line) and nxt_word not in ("und", "oder", "bzw.", "sowie", "resp."):
            out = out[:-1] + line
        else:
            out = out + " " + line
    return out


def norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace(" ", " ")).strip()


def _canon(s: str) -> str:
    """Comparison form: whitespace collapsed, line-break hyphenation removed, typographic quotes unified."""
    s = norm_ws(s)
    s = s.replace("„", '"').replace("“", '"').replace("”", '"').replace("’", "'").replace("–", "-")
    s = re.sub(r"([A-Za-zÄÖÜäöüß])- ([a-zäöüß])", r"\1\2", s)
    return s


def verbatim_in(quote: str, source: str) -> bool:
    q = _canon(quote)
    return bool(q) and q in _canon(source)


def find_verbatim(quote: str, source: str) -> str | None:
    """Return the quote as it appears in the joined source text, or None."""
    q = _canon(quote)
    src = _canon(source)
    i = src.find(q)
    return src[i:i + len(q)] if i >= 0 and q else None


def split_sentences(text: str) -> list[str]:
    """Split German running text into sentences, keeping abbreviations together."""
    protected = text
    for i, a in enumerate(ABBREV):
        protected = protected.replace(a, a.replace(".", f"\u0000{i}\u0000"))
    parts = re.split(r"(?<=[.!?])\s+(?=[A-ZÄÖÜ(\"„«-]|\d+(?:\.\d+)+\s+[A-ZÄÖÜ])", protected)
    out = []
    for p in parts:
        for i, a in enumerate(ABBREV):
            p = p.replace(a.replace(".", f"\u0000{i}\u0000"), a)
        p = re.sub(r"\u0000\d+\u0000", ".", p)
        if p.strip():
            out.append(p.strip())
    return out


def search_bbox(doc, page: int, text: str) -> list[float] | None:
    """Union bbox of a quote on a page (searches its first and last words)."""
    if doc is None or not text:
        return None
    try:
        pg = doc[page - 1]
    except Exception:
        return None
    words = norm_ws(text).split(" ")
    rects = []
    for frag in (" ".join(words[:6]), " ".join(words[-5:])):
        if len(frag) < 6:
            continue
        hits = pg.search_for(frag)
        if hits:
            rects.append(hits[0])
    if not rects:
        return None
    x0 = min(r.x0 for r in rects)
    y0 = min(r.y0 for r in rects)
    x1 = max(r.x1 for r in rects)
    y1 = max(r.y1 for r in rects)
    return [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]


# --------------------------------------------------------------------------- dates

MONTHS = {"januar": 1, "jänner": 1, "februar": 2, "märz": 3, "maerz": 3, "april": 4, "mai": 5, "juni": 6, "juli": 7,
          "august": 8, "september": 9, "oktober": 10, "november": 11, "dezember": 12}
RX_DATE_LONG = re.compile(r"(\d{1,2})\.\s*(" + "|".join(MONTHS) + r")\s+(\d{4})(?:\s*,?\s*(?:um\s+)?(\d{1,2})[.:](\d{2})\s*(?:Uhr|h))?", re.I)
RX_DATE_NUM = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s*,?\s*(?:um\s+)?(\d{1,2})[.:](\d{2})\s*(?:Uhr|h)?)?")
DUE_WORDS = re.compile(r"einzureichen|eingereicht|einreichung|eingabe|abgabe|frist|offerteingabe|angebotsabgabe|submission", re.I)


def find_due_dates(pages_text: dict[int, str]) -> list[dict]:
    found = []
    for page, text in sorted(pages_text.items()):
        flat = norm_ws(text)
        for rx in (RX_DATE_LONG, RX_DATE_NUM):
            for m in rx.finditer(flat):
                try:
                    if rx is RX_DATE_LONG:
                        d = dt.datetime(int(m.group(3)), MONTHS[m.group(2).lower()], int(m.group(1)),
                                        int(m.group(4) or 0), int(m.group(5) or 0))
                    else:
                        d = dt.datetime(int(m.group(3)), int(m.group(2)), int(m.group(1)), int(m.group(4) or 0), int(m.group(5) or 0))
                except (ValueError, KeyError):
                    continue
                ctx = flat[max(0, m.start() - 300): m.end() + 80]
                score = len(DUE_WORDS.findall(ctx)) * 2 + (1 if m.group(4) else 0)
                found.append({"page": page, "date": d, "has_time": bool(m.group(4)), "match": m.group(0),
                              "start": m.start(), "score": score})
    found.sort(key=lambda f: (-f["score"], f["page"]))
    return found


# --------------------------------------------------------------------------- rule extractors

def _lines(text: str) -> list[str]:
    return [l.strip() for l in (text or "").splitlines()]


def _value_after_label(pages_text: dict[int, str], label_rx: str, max_pages: int = 3, skip_rx: str | None = None):
    """'Bauherr:' -> next meaningful line (or rest of the same line). Returns (value, page)."""
    rx = re.compile(label_rx, re.I)
    for page in sorted(pages_text)[:max_pages]:
        ls = _lines(pages_text[page])
        for i, l in enumerate(ls):
            m = rx.match(l)
            if not m:
                continue
            rest = l[m.end():].strip(" :\t")
            cands = ([rest] if rest else []) + [x for x in ls[i + 1:i + 5]]
            for c in cands:
                c = re.split(r"\s{3,}", c.strip())[0].strip()
                if not c or re.fullmatch(r"[\d.\s/-]+", c) or re.match(r"^\.{3,}", c):
                    continue
                if skip_rx and re.search(skip_rx, c, re.I):
                    continue
                if not re.search(r"[A-Za-zÄÖÜäöü]{3,}", c):
                    continue
                return c, page
    return None, None


def _rule_name(pages_text) -> tuple[str | None, int | None]:
    v, p = _value_after_label(pages_text, r"^(?:Projekt|Bauvorhaben|Objekt)\s*:", skip_rx=r"^(?:GP|Nr\.?)$")
    if v:
        v = re.sub(r"^[A-Z0-9]{2,6}_", "", v).strip()
        return v, p
    for page in sorted(pages_text)[:12]:
        m = re.search(r"Gegenstand\s+und\s+Umfang[^\n]*\n(?:[^\n]*\n)?\s*([^\n]{8,80})", pages_text[page])
        if m:
            return norm_ws(m.group(1)), page
    return None, None


def _rule_client(pages_text) -> tuple[str | None, int | None]:
    v, p = _value_after_label(pages_text, r"^(?:Bauherr(?:schaft|in)?|Auftraggeber(?:in)?|Vergabestelle)\s*:?", max_pages=12,
                              skip_rx=r"^(?:c/o|Tel|Fax|www)")
    return (norm_ws(v), p) if v else (None, None)


def _rule_trade(pages_text) -> tuple[str | None, int | None]:
    for page in sorted(pages_text)[:5]:
        m = re.search(r"\bBKP\s*(\d{3}(?:\.\d+)?)\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-/ ]{3,40}?)(?:\s*$|\s{2,}|\n)", pages_text[page], re.M)
        if m:
            return norm_ws(f"BKP {m.group(1)} {m.group(2)}"), page
    return None, None


def _paragraph_heading(lines_before: list[str]) -> str | None:
    """Numbered heading like '1.14 Adresse und Frist für die Ein-' 'reichung des Angebotes'."""
    for i in range(len(lines_before) - 1, -1, -1):
        if re.match(r"^\d+(?:\.\d+)+\s+\S", lines_before[i]):
            head = [lines_before[i]]
            j = i
            while head[-1].endswith("-") and j + 1 < len(lines_before):
                j += 1
                head.append(lines_before[j])
            return join_lines(head)
    return None


def _rule_submission(pages_text, due) -> dict | None:
    if not due:
        return None
    page = due["page"]
    ls = [l for l in _lines(pages_text[page])]
    # locate the line holding the date (by its day + month/year token)
    key = norm_ws(due["match"]).split(" ")[0]
    idx = None
    for i, l in enumerate(ls):
        if key in l and (str(due["date"].year) in l):
            idx = i
            break
    if idx is None:
        return None
    # walk back to the sentence start: stop after a line ending a sentence, skip numbered headings
    start = idx
    while start > 0:
        prev = ls[start - 1]
        if not prev:
            start -= 1
            continue
        if re.search(r"[.:;!?]\s*$", prev) and not prev.endswith(tuple(a for a in ABBREV)):
            break
        start -= 1
    block = [l for l in ls[start:idx + 1] if l]
    heading = None
    # strip a numbered heading at the top of the block (heading lines end without punctuation)
    if block and re.match(r"^\d+(?:\.\d+)+\s+\S", block[0]):
        h = [block[0]]
        k = 1
        while h[-1].endswith("-") and k < len(block):
            h.append(block[k])
            k += 1
        heading = join_lines(h)
        block = block[k:]
    else:
        heading = _paragraph_heading(ls[:start])
    # extend forward to the end of the sentence
    end = idx
    while end < len(ls) - 1 and not re.search(r"[.!?]\s*$", ls[end]):
        end += 1
        block.append(ls[end])
    text = join_lines(block)
    sents = split_sentences(text)
    key2 = norm_ws(due["match"])[:10]
    picked = [s for s in sents if key2 in s] or sents
    text_de = picked[0] if len(picked) == 1 else " ".join(picked)
    # include the preceding sentence fragment when the date sentence starts mid-paragraph
    return {"page": page, "heading": heading, "text_de": text_de}


def _rule_award(pages_text, max_pages: int = 15) -> list[dict]:
    """'1. Preis ... (Gewichtung 60 Pkt.)' style criteria after a 'Zuschlagskriterien' heading."""
    pages = sorted(pages_text)[:max_pages]
    started = False
    crits: list[dict] = []
    cur = None
    for page in pages:
        for l in _lines(pages_text[page]):
            if re.search(r"zuschlagskriteri", l, re.I):
                started = True
                continue
            if not started:
                continue
            m = re.match(r"^(\d)\.\s+([A-ZÄÖÜ][\wäöüÄÖÜß\-/ ]{2,40}?)\s*$", l)
            if m:
                cur = {"label": m.group(2).strip(), "page": page, "lines": []}
                crits.append(cur)
                continue
            if re.match(r"^\d+\.\d+\s+\S", l) and crits:  # next numbered section ends the list
                started = False
                cur = None
                break
            if cur is not None and l:
                cur["lines"].append(l)
        if crits and not started:
            break
    out = []
    for c in crits:
        text = join_lines(c["lines"])
        sents = split_sentences(text)
        # keep sentences up to (and including) the last one with a weight; drop the closing award sentence
        last = max([i for i, s in enumerate(sents) if re.search(r"Gewichtung|Pkt|Punkte|%", s)] or [len(sents) - 1])
        rule = " ".join(sents[:last + 1])
        pts = [int(x) for x in re.findall(r"Gewichtung\s*(\d+)\s*(?:Pkt|Punkte|%)", rule)]
        if not pts:
            pts = [int(x) for x in re.findall(r"\b(\d{1,3})\s*(?:Pkt\.?|Punkte|%)\s*\)?", rule)][-1:]
        out.append({"label": c["label"], "points": sum(pts) if pts else None, "page": c["page"], "rule_de": rule, "rule_en": None})
    return out


def _rule_validity(pages_text, max_pages: int = 15) -> dict | None:
    for page in sorted(pages_text)[:max_pages]:
        text = join_lines(_lines(pages_text[page]))
        for s in split_sentences(text):
            if re.search(r"Festpreis|Gültigkeit\s+bis|gültig\s+bis", s) and len(s) < 220:
                s = re.sub(r"^\d+(?:\.\d+)+\s+[^.]*?(?=Sämtliche|Die|Alle|Das)", "", s).strip()
                return {"page": page, "text_de": s}
    return None


# --------------------------------------------------------------------------- LLM

_SYSTEM = """You read the first pages of a Swiss German construction tender (Ausschreibung) and extract facts for an estimator.
Return only what the text states. Quotes (*_quote_de, text_de, rule_de) must be copied character for character from the given page text (you may drop line-break hyphens).
- name: the project name (e.g. 'Neubau Primarschule Erlenstrasse, Oberglatt'), client: the awarding authority/owner (Bauherr/Auftraggeber), trade: the BKP trade line (e.g. 'BKP 244 Lüftungsanlagen').
- due_at: submission deadline as ISO local datetime 'YYYY-MM-DDTHH:MM:SS' ('' if absent).
- submission_rule: the sentence(s) that say how and where to submit, with the clause heading and an English translation.
- award_criteria: each award criterion with its weight in points (sum all weights belonging to it) and the rule text, plus English.
Use page numbers from the '=== page N ===' markers."""

_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"}, "name_page": {"type": "integer"},
        "client": {"type": "string"}, "client_page": {"type": "integer"},
        "trade": {"type": "string"}, "trade_page": {"type": "integer"},
        "due_at": {"type": "string"}, "due_page": {"type": "integer"},
        "submission_rule": {"type": "object", "properties": {
            "page": {"type": "integer"}, "heading": {"type": "string"}, "text_de": {"type": "string"}, "text_en": {"type": "string"}},
            "required": ["page", "heading", "text_de", "text_en"], "additionalProperties": False},
        "award_criteria": {"type": "array", "items": {"type": "object", "properties": {
            "label": {"type": "string"}, "points": {"type": "integer"}, "page": {"type": "integer"},
            "rule_de": {"type": "string"}, "rule_en": {"type": "string"}},
            "required": ["label", "points", "page", "rule_de", "rule_en"], "additionalProperties": False}},
    },
    "required": ["name", "name_page", "client", "client_page", "trade", "trade_page", "due_at", "due_page",
                 "submission_rule", "award_criteria"],
    "additionalProperties": False,
}


def _llm_meta(pages_text: dict[int, str], max_chars: int = 60000) -> dict | None:
    parts, total = [], 0
    for page in sorted(pages_text):
        t = norm_ws(pages_text[page]) if len(pages_text[page]) > 4000 else pages_text[page]
        chunk = f"=== page {page} ===\n{t}\n"
        if total + len(chunk) > max_chars:
            break
        parts.append(chunk)
        total += len(chunk)
    try:
        return llm.call_json(_SYSTEM, "".join(parts), _SCHEMA, name="tender_meta", temperature=0)
    except (llm.LLMUnavailable, llm.LLMError):
        return None


def _iso(s: str) -> str | None:
    try:
        return dt.datetime.fromisoformat(s.strip()).isoformat() if s and s.strip() else None
    except ValueError:
        return None


# --------------------------------------------------------------------------- main

def extract_meta(pages_text: dict[int, str] | None = None, pdf=None, use_llm: bool | None = None, max_pages: int = 15) -> dict:
    doc = open_pdf(pdf)
    if doc is not None:
        pages_text = pages_text_from_pdf(doc, list(range(1, min(max_pages, doc.page_count) + 1)))
    pages_text = {int(k): v for k, v in (pages_text or {}).items() if int(k) <= max_pages}
    sources: dict[str, int] = {}

    name, p = _rule_name(pages_text)
    if name:
        sources["name"] = p
    client, p = _rule_client(pages_text)
    if client:
        sources["client"] = p
    trade, p = _rule_trade(pages_text)
    if trade:
        sources["trade"] = p
    dues = find_due_dates(pages_text)
    due = dues[0] if dues and dues[0]["score"] > 0 else None
    due_at = due["date"].isoformat() if due else None
    if due:
        sources["due_at"] = due["page"]
    sub = _rule_submission(pages_text, due)
    awards = _rule_award(pages_text, max_pages)
    validity = _rule_validity(pages_text, max_pages)
    method = "rules"

    if use_llm is not False:
        res = _llm_meta(pages_text)
        if res:
            method = "rules+llm"
            all_text = "\n".join(pages_text.values())

            def ok(v, page=None):
                if not v:
                    return False
                src = pages_text.get(page, "") if page else all_text
                return verbatim_in(v, src) or verbatim_in(re.sub(r"^[A-Z0-9]{2,6}_", "", v), src) or verbatim_in(v, all_text)

            if not name and ok(res.get("name"), res.get("name_page")):
                name, sources["name"] = res["name"], res.get("name_page")
            if not client and ok(res.get("client"), res.get("client_page")):
                client, sources["client"] = res["client"], res.get("client_page")
            if not trade and ok(res.get("trade"), res.get("trade_page")):
                trade, sources["trade"] = res["trade"], res.get("trade_page")
            if not due_at and _iso(res.get("due_at", "")):
                due_at, sources["due_at"] = _iso(res["due_at"]), res.get("due_page")
            r_sub = res.get("submission_rule") or {}
            if sub is None and r_sub.get("text_de") and verbatim_in(r_sub["text_de"], pages_text.get(r_sub.get("page"), "")):
                sub = {"page": r_sub["page"], "heading": r_sub.get("heading") or None,
                       "text_de": find_verbatim(r_sub["text_de"], join_lines(_lines(pages_text[r_sub["page"]]))) or r_sub["text_de"]}
            if sub is not None and r_sub.get("text_en"):
                sub["text_en"] = r_sub["text_en"]
            llm_aw = res.get("award_criteria") or []
            if not awards and llm_aw:
                awards = [{"label": a["label"], "points": a["points"], "page": a["page"],
                           "rule_de": a["rule_de"] if verbatim_in(a["rule_de"], all_text) else None, "rule_en": a["rule_en"]}
                          for a in llm_aw]
            else:
                for a in awards:
                    for b in llm_aw:
                        if b["label"].lower().startswith(a["label"].lower()[:5]) or a["label"].lower() in b["label"].lower():
                            a["rule_en"] = b.get("rule_en")
                            if a["points"] is None:
                                a["points"] = b.get("points")
    # English without an LLM: deterministic glossary gist, marked as such
    from .translate import gloss

    if sub is not None:
        if sub.get("text_en"):
            sub["text_en_method"] = "llm"
        else:
            g, cov = gloss(sub["text_de"])
            sub["text_en"], sub["text_en_method"] = (g, "glossary") if cov >= 0.5 else (None, None)
    for a in awards:
        if a.get("rule_en"):
            a["rule_en_method"] = "llm"
        elif a.get("rule_de"):
            g, cov = gloss(a["rule_de"])
            a["rule_en"], a["rule_en_method"] = (g, "glossary") if cov >= 0.5 else (None, None)
        a["label_en"] = gloss(a["label"])[0]
    if sub is not None:
        sub.setdefault("text_en", None)
        sub["bbox"] = search_bbox(doc, sub["page"], sub["text_de"]) if doc is not None else None
    return {
        "name": name, "client": client, "trade": trade, "due_at": due_at,
        "meta_sources": sources, "submission_rule": sub, "award_criteria": awards,
        "offer_validity": validity, "method": method,
    }
