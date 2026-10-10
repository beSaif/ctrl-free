"""Filled tender: the original LV PDF with our prices written in, the way an estimator
fills the Leistungsverzeichnis by hand.

What is written where (all found on the page itself, no page numbers hardcoded):
- every priced line: unit price in the "Einheits-Preis" column and the amount in the
  "Betrag" column, on the line where the tender prints the quantity; a small grey LV id
  in the right margin links the number back to the line in ctrl-free;
- lines without a price: a short marker in the "Betrag" column ("Offerte folgt",
  "Menge fehlt", "nicht offeriert", "in Prüfung"), never a guessed number;
- the tender's own total lines (section, group and system totals) and the dotted blanks
  of each system's cost summary (Kostenzusammenstellung);
- the summary pages in front of the LV when they are there: the system x section matrix,
  the lot sums ("Eingabesumme Los n"), the conditions (Brutto ... MWST ... Netto) and the
  "Eingabesumme Netto" on the title page.

Prices are SELLING prices, computed exactly like the SIA file (export.build_sia_file):
markup factor k = offer price / direct cost, unit price = line direct cost x k / quantity
rounded to the cent, amount = quantity x unit price. The rounding difference between the
sum of the amounts and the (rounded) offer price is shown on the cover page; the LV's own
totals are always the sum of the amounts written, so the document adds up.
"""
from __future__ import annotations

import io
import logging
import re
from datetime import datetime

import pymupdf

from app import export as E
from app import pricing as P

log = logging.getLogger(__name__)

INK = (0.122, 0.310, 0.847)      # accent #1F4FD8: everything ctrl-free writes is in "pen" blue
FAINT = (0.541, 0.541, 0.525)    # #8A8A86: LV ids in the margin
ATTN = (0.761, 0.255, 0.047)     # #C2410C: open lines

# Marker for lines that carry no price, by status (German: it is written into the tender).
MARKERS = {
    "supplier_quote_required": "Offerte folgt",
    "insufficient_information": "Menge fehlt",
    "review_required": "in Prüfung",
    "assumption_applied": "in Prüfung",
    "calculated": "in Prüfung",
    "out_of_scope": "nicht offeriert",
}
MARKER_HELP = {
    "Offerte folgt": "supplier quote required, no budget price yet",
    "Menge fehlt": "no quantity in the tender",
    "in Prüfung": "no confident product match yet",
    "nicht offeriert": "out of scope (other trade, excluded lot or 'bauseits')",
}

_DOTS = re.compile(r"^[.…_]{4,}$")
_SECTION_TOTAL = re.compile(r'"\s*([A-Z])\s*"\s*$')
_SYSTEM_TOTAL = re.compile(r"^total\s+\d{3}\.\d+", re.I)
_CODE = re.compile(r"^(\d{3})\.(\d+)$")


def chf(v: float) -> str:
    return P.swiss(v, 2)


# ---------------------------------------------------------------- prices

def selling_prices(tender: dict, totals: dict) -> dict:
    """Selling unit price and amount per priced line (same method as the SIA file).

    Returns {offer, how, direct, k, lines: {lv_id: {unit_price, amount, quantity}}, sum, positions}.
    `positions` are the evaluated positions in document order."""
    s = E._settings(tender)
    positions = E._evaluate(tender, s)
    offer, how = E._offer(totals)
    direct = float(totals.get("direct") or 0)
    k = offer / direct if direct else 0.0
    lines: dict[str, dict] = {}
    for p in positions:
        pr = p.get("pricing")
        q = P.effective_quantity(p)
        if (p.get("kind") or "item") in ("subtotal", "text_only") or not P.included(p["status"], pr) or not q:
            continue
        unit = round((pr["material"] + pr["labour"]) * k / q, 2)
        lines[p["lv_id"]] = {"unit_price": unit, "amount": round(q * unit, 2), "quantity": q}
    return {"offer": offer, "how": how, "direct": direct, "k": k, "lines": lines,
            "sum": round(sum(v["amount"] for v in lines.values()), 2), "positions": positions}


def _marker(p: dict) -> str | None:
    if (p.get("kind") or "item") in ("subtotal", "text_only") or p["status"] == "non_priceable":
        return None
    if p["status"] == "insufficient_information" and P.effective_quantity(p):
        return "in Prüfung"
    return MARKERS.get(p["status"], "in Prüfung")


def _group_values(positions: list[dict], prices: dict) -> dict[str, dict]:
    """Value of every total line the tender prints (subtotal positions), keyed by its id.

    'Total ... "C"' sums section C of the system, 'Total 244.xx ...' the whole system, any
    other total (e.g. 'Total Montage und Transport', 'Zwischentotal "Kanäle"') the lines
    since the previous total in the same section; 'Total aller <X>' starts at the first line
    about X. Each value says how many lines in it are still open."""
    out: dict[str, dict] = {}
    lines = prices["lines"]

    def summarize(group: list[dict]) -> dict:
        priced = [p for p in group if p["lv_id"] in lines]
        open_ = [p for p in group if p["lv_id"] not in lines and _marker(p)]
        return {"amount": round(sum(lines[p["lv_id"]]["amount"] for p in priced), 2),
                "priced": len(priced), "open": len(open_)}

    last_total: dict[tuple, int] = {}
    for i, st in enumerate(positions):
        if st.get("kind") != "subtotal":
            continue
        label = (st.get("title_de") or st.get("text_de") or "").strip()
        system = st.get("system")
        items = [p for p in positions if p.get("kind") != "subtotal" and p.get("system") == system]
        m = _SECTION_TOTAL.search(label)
        if _SYSTEM_TOTAL.match(label):
            group = items
            scope = "system"
        elif m and label.lower().startswith("total"):
            group = [p for p in items if p.get("section") == m.group(1)]
            scope = "section"
        else:
            key = (system, st.get("section"))
            start = last_total.get(key, -1)
            group = [p for p in positions[start + 1:i]
                     if p.get("kind") != "subtotal" and p.get("system") == system and p.get("section") == st.get("section")]
            mm = re.search(r"\baller\s+(\S+)", label, re.I)
            if mm:  # "Total aller <X>": from the first line about X (lines after it may only print sizes)
                stem = mm.group(1).lower()[-10:]
                first = next((k for k, p in enumerate(group)
                              if stem in ((p.get("text_de") or "") + (p.get("title_de") or "")).lower()), 0)
                group = group[first:]
            scope = "group"
        last_total[(system, st.get("section"))] = i
        out[st["lv_id"]] = dict(summarize(group), scope=scope, label=label, section=st.get("section"),
                                lines=len(group))
    return out


def _section_values(positions: list[dict], prices: dict) -> dict[tuple, dict]:
    """(system label, section letter) -> {amount, open}."""
    out: dict[tuple, dict] = {}
    for p in positions:
        if p.get("kind") == "subtotal":
            continue
        row = out.setdefault((p.get("system"), p.get("section")), {"amount": 0.0, "open": 0, "priced": 0})
        if p["lv_id"] in prices["lines"]:
            row["amount"] += prices["lines"][p["lv_id"]]["amount"]
            row["priced"] += 1
        elif _marker(p):
            row["open"] += 1
    for v in out.values():
        v["amount"] = round(v["amount"], 2)
    return out


# ---------------------------------------------------------------- page geometry

def _columns(page) -> dict | None:
    """Unit price and amount column of an LV page: the two rightmost full-height column boxes,
    else the printed column header ("Einheits-Preis", "Betrag")."""
    w = page.rect.width
    boxes = set()
    for dr in page.get_drawings():
        for it in dr["items"]:
            if it[0] == "re":
                r = it[1]
                if r.height > 300 and r.x0 > w * 0.6 and r.width > 20:
                    boxes.add((round(r.x0, 1), round(r.x1, 1)))
    boxes = sorted(boxes)
    if len(boxes) >= 2:
        (p0, p1), (a0, a1) = boxes[-2], boxes[-1]
        return {"price": (p0, p1), "amount": (a0, a1)}
    words = page.get_text("words")
    preis = [x for x in words if x[4].lower().startswith("einheits") and x[1] < page.rect.height * 0.2]
    if not preis:
        return None
    pw = preis[0]
    betrag = [x for x in words if x[4].lower().startswith("betrag") and x[0] > pw[2] and abs(x[1] - pw[1]) < 8]
    if not betrag:
        return None
    a0 = (pw[2] + betrag[0][0]) / 2 + 4
    p0 = pw[0] - (a0 - pw[2]) + 2
    return {"price": (p0, a0), "amount": (a0, min(w - 30, betrag[0][2] + (betrag[0][0] - a0)))}


def _baseline(bbox) -> float:
    """Text baseline of a word/line bbox (Arial-like font: descender ~19% of the box)."""
    return bbox[3] - (bbox[3] - bbox[1]) * 0.19


def _fit(text: str, width: float, size: float, font: str = "helv", min_size: float = 5.5) -> float:
    while size > min_size and pymupdf.get_text_length(text, fontname=font, fontsize=size) > width:
        size -= 0.25
    return size


class _Page:
    """Pending writes on one page: dotted blanks to clear, then text to draw."""

    def __init__(self, page):
        self.page = page
        self.clear: list = []
        self.texts: list = []
        self.used_dots: set = set()
        self._dots = None

    def dots(self):
        if self._dots is None:
            self._dots = [pymupdf.Rect(w[:4]) for w in self.page.get_text("words") if _DOTS.match(w[4])]
        return self._dots

    def right(self, text: str, x1: float, y: float, size: float, *, color=INK, bold=False, width: float | None = None,
              pad: float = 3.0):
        font = "hebo" if bold else "helv"
        if width is not None:
            size = _fit(text, width - 2 * pad, size, font)
        tw = pymupdf.get_text_length(text, fontname=font, fontsize=size)
        self.texts.append((pymupdf.Point(x1 - pad - tw, y), text, size, font, color))

    def left(self, text: str, x0: float, y: float, size: float, *, color=INK, bold=False):
        self.texts.append((pymupdf.Point(x0, y), text, size, "hebo" if bold else "helv", color))

    def take_dots(self, x0: float, x1: float, y0: float, y1: float) -> pymupdf.Rect | None:
        """Dotted blank inside the given area (cleared before writing on it)."""
        for i, r in enumerate(self.dots()):
            if i in self.used_dots:
                continue
            if r.x0 >= x0 - 2 and r.x1 <= x1 + 2 and r.y1 > y0 and r.y0 < y1:
                self.used_dots.add(i)
                self.clear.append(r)
                return r
        return None

    def apply(self):
        if self.clear:
            for r in self.clear:
                self.page.add_redact_annot(r, fill=False)
            self.page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                                       graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
        for pt, text, size, font, color in self.texts:
            self.page.insert_text(pt, text, fontsize=size, fontname=font, color=color)


# ---------------------------------------------------------------- the LV pages

def _qty_place(p: dict) -> tuple[int, list] | None:
    src = p.get("source") or {}
    for ln in src.get("lines") or []:
        if ln.get("role") == "qty" and ln.get("bbox"):
            return int(ln.get("page") or src.get("page") or p.get("page")), ln["bbox"]
    bbox = src.get("qty_bbox") or src.get("line_bbox") or src.get("block_bbox")
    page = src.get("page") or p.get("page")
    if not bbox or not page:
        return None
    if not src.get("qty_bbox") and bbox is src.get("block_bbox"):
        bbox = [bbox[0], bbox[1], bbox[2], bbox[1] + 11.2]
    return int(page), bbox


def _fill_lv(doc, positions: list[dict], prices: dict, report: dict) -> tuple[dict[int, _Page], dict]:
    pages: dict[int, _Page] = {}
    cols: dict[int, dict | None] = {}

    def page_of(n: int):
        if n not in pages:
            pages[n] = _Page(doc[n - 1])
            cols[n] = _columns(doc[n - 1])
        return pages[n], cols[n]

    groups = _group_values(positions, prices)
    for p in positions:
        place = _qty_place(p)
        if not place or not (1 <= place[0] <= doc.page_count):
            continue
        n, bbox = place
        pg, c = page_of(n)
        if not c:
            continue
        y = _baseline(bbox)
        (p0, p1), (a0, a1) = c["price"], c["amount"]
        lv = p["lv_id"]
        if p.get("kind") == "subtotal":
            g = groups.get(lv)
            if not g:
                continue
            # a total label may wrap: its dotted blank can sit on the next printed line
            d = pg.take_dots(a0, a1, bbox[1], bbox[3] + 14)
            if d is not None:
                y = _baseline((d.x0, d.y0, d.x1, d.y1))
            if g["priced"]:
                pg.right(chf(g["amount"]), a1, y, 9, bold=True, width=a1 - a0)
            else:
                pg.right("offen", a1, y, 7.5, color=ATTN, width=a1 - a0)
                if not g["lines"]:
                    report["empty_totals"] += 1
            if g["open"] and g["priced"]:
                pg.left(f"+{g['open']} offen", a1 + 2.5, y, 5, color=ATTN)
            report["totals_filled"] += 1
            report["pages"].add(n)
            continue
        if lv in prices["lines"]:
            v = prices["lines"][lv]
            pg.take_dots(a0, a1, bbox[1], bbox[3])
            pg.take_dots(p0, p1, bbox[1], bbox[3])
            pg.right(chf(v["unit_price"]), p1, y, 9, width=p1 - p0, pad=2.5)
            pg.right(chf(v["amount"]), a1, y, 9, width=a1 - a0)
            pg.left(lv, a1 + 2.5, y, 5, color=FAINT)
            tender_q = p.get("quantity")
            if tender_q is not None and abs(float(tender_q) - v["quantity"]) > 1e-9:
                pg.left(f"Menge {P.fmt_qty(v['quantity'])}", a1 + 2.5, y + 5.5, 5, color=ATTN)
            report["filled"] += 1
            report["per_page"][n] = report["per_page"].get(n, 0) + 1
            report["pages"].add(n)
            continue
        mk = _marker(p)
        if mk:
            pg.take_dots(a0, a1, bbox[1], bbox[3])
            pg.right(mk, a1, y, 7, color=ATTN, width=a1 - a0)
            pg.left(lv, a1 + 2.5, y, 5, color=FAINT)
            report["open"][mk] = report["open"].get(mk, 0) + 1
            report["pages"].add(n)
    return pages, cols


def _fill_recaps(doc, systems: list[dict], sections: dict, pages: dict, cols: dict, report: dict):
    """The dotted blanks left in an LV page's amount column with a section letter in the Pos.
    column are the system's cost summary (Kostenzusammenstellung): write the section sums."""
    for sy in systems or []:
        a, b = (sy.get("pages") or [None, None])[:2]
        if not a or not b:
            continue
        label = sy.get("label") or sy.get("name")
        for n in range(int(a), int(b) + 1):
            if not (1 <= n <= doc.page_count):
                continue
            if n not in pages:
                pages[n] = _Page(doc[n - 1])
                cols[n] = _columns(doc[n - 1])
            pg, c = pages[n], cols[n]
            if not c:
                continue
            a0, a1 = c["amount"]
            words = pg.page.get_text("words")
            for i, r in enumerate(pg.dots()):
                if i in pg.used_dots or r.x0 < a0 - 2 or r.x1 > a1 + 2:
                    continue
                yc = (r.y0 + r.y1) / 2
                letters = [w[4] for w in words if w[0] < 80 and abs((w[1] + w[3]) / 2 - yc) < 4
                           and re.fullmatch(r"[A-Z]", w[4])]
                if not letters:
                    continue
                v = sections.get((label, letters[0]))
                pg.used_dots.add(i)
                pg.clear.append(r)
                y = _baseline((r.x0, r.y0, r.x1, r.y1))
                if v and v["priced"]:
                    pg.right(chf(v["amount"]), a1, y, 9, width=a1 - a0)
                    if v["open"]:
                        pg.left(f"+{v['open']} offen", a1 + 2.5, y, 5, color=ATTN)
                else:
                    pg.right("offen", a1, y, 7.5, color=ATTN, width=a1 - a0)
                report["totals_filled"] += 1
                report["pages"].add(n)


# ---------------------------------------------------------------- summary pages in front of the LV

def _rows(words) -> list[list]:
    rows: list[list] = []
    for w in sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        yc = (w[1] + w[3]) / 2
        if rows and abs(yc - rows[-1][0]) < 3.5:
            rows[-1][1].append(w)
        else:
            rows.append([yc, [w]])
    return [sorted(r[1], key=lambda w: w[0]) for r in rows]


def _code_key(code: str | None) -> tuple | None:
    m = re.match(r"^(\d{3})\.(\d+)", code or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def _write_on_dots(pg: _Page, dots_word, text: str, size: float = 9, bold: bool = False):
    r = pymupdf.Rect(dots_word[:4])
    pg.clear.append(r)
    pg.right(text, r.x1, _baseline(dots_word[:4]), size, bold=bold, width=max(r.width, 60) + 6, pad=0)


def _fill_front(doc, first_lv_page: int, systems: list[dict], sections: dict, lv_sum: float, report: dict) -> dict:
    """Matrix (system x section), lot sums, conditions and the title page sum. Returns the
    conditions applied {brutto, steps: [(label, pct, amount)], netto} (empty when not found)."""
    conditions: dict = {}
    sys_by_code = {_code_key(s.get("code")): s for s in systems or [] if _code_key(s.get("code"))}
    letters = sorted({k[1] for k in sections if k[1]})

    def sys_total(sy):
        lab = sy.get("label") or sy.get("name")
        return round(sum(v["amount"] for (s_, _), v in sections.items() if s_ == lab), 2)

    def lot_total(lot):
        return round(sum(sys_total(s) for s in systems or [] if s.get("lot") == lot), 2)

    touched_pages: dict[int, _Page] = {}
    for n in range(1, max(1, first_lv_page)):
        page = doc[n - 1]
        words = page.get_text("words")
        if not words:
            continue
        pg = _Page(page)
        touched = False
        rows = _rows(words)
        # -- system x section matrix: header letters A..F + "Total" on one row
        heads = [r for r in rows if sum(1 for w in r if w[4] in letters) >= 3]
        for hrow in heads:
            hy = hrow[0][1]
            hcols = {w[4]: ((w[0] + w[2]) / 2) for w in hrow if w[4] in letters}
            tot_w = [w for w in words if w[4] == "Total" and abs(w[1] - hy) < 30 and w[0] > max(hcols.values())]
            xs = sorted(hcols.values())
            step = (xs[-1] - xs[0]) / max(1, len(xs) - 1)
            col_x1 = {k: x + step / 2 for k, x in hcols.items()}
            total_x1 = ((tot_w[0][0] + tot_w[0][2]) / 2 + step / 2) if tot_w else None

            def cell(x1, y, vals, bold=False):
                if any(v["priced"] for v in vals):
                    pg.right(chf(sum(v["amount"] for v in vals)), x1, y, 7.5, width=step, bold=bold)
                elif any(v["open"] for v in vals):
                    pg.right("offen", x1, y, 6.5, color=ATTN, width=step)

            nxt = [h[0][1] for h in heads if h[0][1] > hy + 5]
            limit = min(nxt) if nxt else page.rect.height
            lot = None
            lot_seen = False
            for r in rows:
                y0 = r[0][1]
                if y0 <= hy + 20 or y0 >= limit:
                    continue
                t0 = r[0][4]
                if t0.upper() == "LOS" and len(r) > 1 and r[1][4].isdigit():
                    lot, lot_seen = int(r[1][4]), True
                    continue
                y = _baseline(r[0][:4])
                if _CODE.match(t0) and r[0][0] < xs[0] - step:
                    sy = sys_by_code.get(_code_key(t0))
                    if not sy:
                        continue
                    lab = sy.get("label") or sy.get("name")
                    for L, x1 in col_x1.items():
                        cell(x1, y, [sections[(lab, L)]] if (lab, L) in sections else [])
                    if total_x1:
                        cell(total_x1, y, [v for (s_, _), v in sections.items() if s_ == lab], bold=True)
                    touched = True
                elif t0 == "Total" and len(r) == 1 and r[0][0] < xs[0] - step:
                    group = [s for s in systems or [] if not lot_seen or s.get("lot") == lot]
                    labs = {s.get("label") or s.get("name") for s in group}
                    for L, x1 in col_x1.items():
                        cell(x1, y, [v for (s_, l_), v in sections.items() if s_ in labs and l_ == L], bold=True)
                    if total_x1:
                        cell(total_x1, y, [v for (s_, _), v in sections.items() if s_ in labs], bold=True)
                    touched = True
        # -- labelled dotted blanks: lot sums, NPK summary, conditions, title page
        cond_rows = []
        for r in rows:
            dots = [w for w in r if _DOTS.match(w[4])]
            if not dots:
                continue
            label = " ".join(w[4] for w in r if not _DOTS.match(w[4]) and w[0] < dots[0][0]).strip()
            low = label.lower()
            m = re.search(r"\blos\s+(\d+)", low)
            if low.startswith("eingabesumme los") and m:
                _write_on_dots(pg, dots[-1], chf(lot_total(int(m.group(1)))))
                touched = True
            elif low.startswith("total eingabesumme"):
                _write_on_dots(pg, dots[-1], chf(lv_sum), bold=True)
                touched = True
            elif re.match(r"^(brutto|rabatt|zwischentotal|skonto|allg|mwst|netto)\b", low):
                cond_rows.append((low, r, dots))
            elif low.startswith("eingabesumme netto"):
                conditions.setdefault("_title", []).append((pg, dots[0]))
        if cond_rows:
            amt = lv_sum
            steps = []
            for low, r, dots in cond_rows:
                main = [d for d in dots if d[2] - d[0] > 60]
                if not main:
                    continue
                target = main[0]  # first (left) column is the bidder's "Eingabesumme"
                pct_w = [w for w in r if re.fullmatch(r"\d+(?:\.\d+)?", w[4]) and w[0] < target[0]]
                pct_dots = [d for d in dots if d[2] - d[0] <= 60 and d[0] < target[0]]
                if low.startswith("brutto"):
                    amt = lv_sum
                elif low.startswith(("rabatt", "skonto", "allg", "mwst")):
                    pct = float(pct_w[0][4]) if pct_w else 0.0
                    if pct_dots:
                        _write_on_dots(pg, pct_dots[0], "0.00", size=8)
                    delta = round(amt * pct / 100, 2) * (1 if low.startswith("mwst") else -1)
                    steps.append((" ".join(w[4] for w in r if w[0] < 230), pct, delta))
                    _write_on_dots(pg, target, chf(delta))
                    amt = round(amt + delta, 2)
                    touched = True
                    continue
                _write_on_dots(pg, target, chf(amt), bold=low.startswith("netto"))
                touched = True
            conditions.update(brutto=lv_sum, steps=steps, netto=amt)
            # the NPK summary above the conditions: brutto | netto columns
            for r in rows:
                dots = [w for w in r if _DOTS.match(w[4])]
                label = " ".join(w[4] for w in r if not _DOTS.match(w[4])).lower()
                if len(dots) == 2 and not any(label.startswith(x) for x in ("brutto", "rabatt", "zwischentotal",
                                                                             "skonto", "allg", "mwst", "netto")):
                    _write_on_dots(pg, dots[0], chf(lv_sum), size=8.5, bold=label.startswith("total"))
                    _write_on_dots(pg, dots[1], chf(amt), size=8.5, bold=label.startswith("total"))
        if touched:
            touched_pages[n] = pg
    for pg, dots in conditions.pop("_title", []):
        _write_on_dots(pg, dots, chf(conditions.get("netto", lv_sum)), size=10, bold=True)
        touched_pages[pg.page.number + 1] = pg
    for n, pg in touched_pages.items():
        pg.apply()
        report["front_pages"].append(n)
    return conditions


# ---------------------------------------------------------------- cover page

def _cover(tender: dict, totals: dict, prices: dict, report: dict, conditions: dict, by_system: list[dict]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    ink, muted, rule, accent, attn = (colors.HexColor("#" + x) for x in (E.INK, E.MUTED, E.RULE, E.ACCENT, E.ATTN))
    base = ParagraphStyle("b", fontName="Helvetica", fontSize=9, leading=12, textColor=ink)
    mute = ParagraphStyle("m", parent=base, textColor=muted, fontSize=8, leading=10.5)
    h1 = ParagraphStyle("h1", parent=base, fontName="Helvetica-Bold", fontSize=16, leading=20, spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=base, fontName="Helvetica-Bold", fontSize=10.5, leading=14, spaceBefore=10, spaceAfter=4)
    big = ParagraphStyle("big", parent=base, fontName="Helvetica-Bold", fontSize=20, leading=24)
    para = lambda t, st=base: Paragraph(E._pdf_text(t), st)
    doc_w = A4[0] - 36 * mm

    def table(rows, widths, right_cols=(), bold_rows=(), header=True):
        t = Table(rows, colWidths=widths)
        style = [("FONT", (0, 0), (-1, -1), "Helvetica", 8.5), ("TEXTCOLOR", (0, 0), (-1, -1), ink),
                 ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.3, rule),
                 ("TOPPADDING", (0, 0), (-1, -1), 2.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
                 ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3)]
        if header:
            style += [("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8.5), ("LINEBELOW", (0, 0), (-1, 0), 0.8, ink)]
        for c in right_cols:
            style.append(("ALIGN", (c, 0), (c, -1), "RIGHT"))
        for r in bold_rows:
            style += [("FONT", (0, r), (-1, r), "Helvetica-Bold", 8.5), ("LINEABOVE", (0, r), (-1, r), 0.8, ink)]
        t.setStyle(TableStyle(style))
        return t

    now = datetime.now()
    story = [para("Filled tender (LV)", h1),
             para(" · ".join(x for x in (tender.get("name"), tender.get("client"), tender.get("trade")) if x), mute),
             para(f"The original tender {tender.get('file_name') or ''} with our prices written in. "
                  f"Prices filled by ctrl-free from {tender.get('id')}, {now:%d.%m.%Y %H:%M}.", mute),
             Spacer(1, 8)]
    o = totals.get("offer")
    story.append(para(f"Offer price CHF {P.swiss(prices['offer'], 0)}", big))
    if o:
        story.append(para(f"Chosen option: {o['name']} · {o['margin_pct']:.1f}% margin · "
                          f"{P._half_up(o['win'] * 100)}% win chance"))
    else:
        story.append(para("No option chosen yet: the standard price is used.", ParagraphStyle("a", parent=base, textColor=attn)))

    n_open = sum(report["open"].values())
    diff = round(prices["offer"] - prices["sum"], 2)
    rows = [["", ""],
            ["Positions filled with a price", str(report["filled"])],
            ["Lines still open (marker instead of a price)", str(n_open)]]
    for mk, cnt in sorted(report["open"].items(), key=lambda kv: -kv[1]):
        rows.append([f'   "{mk}": {MARKER_HELP.get(mk, "")}', str(cnt)])
    rows += [["Total lines filled (section, group and system totals)", str(report["totals_filled"])],
             ["Sum of the LV (brutto, excl. MWST)", f"CHF {chf(prices['sum'])}"]]
    if report["empty_totals"]:
        rows.insert(-1, ["   Totals with no priceable line under them (marked \"offen\")", str(report["empty_totals"])])
    if abs(diff) >= 0.005:
        rows.append(["Rounding (unit prices to the cent) vs. the offer price", f"CHF {chf(diff)}"])
    if conditions.get("steps"):
        for label, pct, delta in conditions["steps"]:
            if pct:  # no discount or cash discount is offered: those rows show 0.00 in the tender
                rows.append([f"{label} {pct:.2f}% (the tender's conditions)", f"CHF {chf(delta)}"])
        rows.append(["Eingabesumme netto incl. MWST (written on the title page)", f"CHF {chf(conditions['netto'])}"])
    t = table(rows, [doc_w - 40 * mm, 40 * mm], right_cols=(1,), header=False)
    story.append(Spacer(1, 6))
    story.append(t)

    story.append(para("By system", h2))
    srows = [["System", "Filled", "Open", "Amount CHF"]]
    for r in by_system:
        srows.append([para(r["system"]), r["filled"], r["open"], chf(r["amount"])])
    srows.append(["Total", report["filled"], n_open, chf(prices["sum"])])
    story.append(table(srows, [doc_w - 76 * mm, 18 * mm, 18 * mm, 40 * mm], right_cols=(1, 2, 3),
                       bold_rows=(len(srows) - 1,)))

    story.append(para("How the prices were made", h2))
    for line in (
        f"Unit prices are selling prices. Each line's direct cost (material + labour, from the catalogue, "
        f"install rules and supplier quotes, with your overrides) is multiplied by k = offer price / direct cost "
        f"= {P.swiss(prices['offer'], 0)} / {chf(prices['direct'])} = {prices['k']:.4f}. This spreads transport, "
        f"overhead, project costs and margin over the priced lines in proportion to their direct cost.",
        "Unit price = line direct cost x k / quantity, rounded to the cent; amount = quantity x unit price. "
        "The SIA file uses the same numbers.",
        "Totals written into the tender (section, group, system, lot) are the sums of the amounts written, so the "
        "document adds up. Lines still open are not in these sums; a total with open lines carries '+n offen'.",
        "Lines without a price get a marker, never a guessed number: "
        + "; ".join(f'"{k}" = {v}' for k, v in MARKER_HELP.items()) + ".",
        "Blue = written by ctrl-free. The small grey id in the right margin (e.g. LV0010) is the line in ctrl-free, "
        "where its price is explained step by step.",
    ):
        story.append(para("- " + line, mute))

    def on_page(canvas, d):
        canvas.saveState()
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(muted)
        canvas.drawString(18 * mm, 10 * mm, E._pdf_text(f"ctrl-free · {tender.get('name') or ''}")[:110].replace("&amp;", "&"))
        canvas.restoreState()

    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=18 * mm,
                      bottomMargin=16 * mm, title=f"Filled tender - {tender.get('name') or ''}",
                      author="ctrl-free").build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()


# ---------------------------------------------------------------- build

def build_filled_lv(tender: dict, totals: dict, pdf_path) -> tuple[bytes, dict]:
    """The tender PDF with our prices written in, plus a cover page. Returns (pdf bytes, report)."""
    prices = selling_prices(tender, totals)
    positions = prices["positions"]
    systems = tender.get("systems") or []
    report = {"filled": 0, "open": {}, "totals_filled": 0, "empty_totals": 0, "pages": set(), "front_pages": [],
              "per_page": {}}
    doc = pymupdf.open(str(pdf_path))
    try:
        pages, cols = _fill_lv(doc, positions, prices, report)
        sections = _section_values(positions, prices)
        _fill_recaps(doc, systems, sections, pages, cols, report)
        stamp = f"Preise eingesetzt von ctrl-free · {tender.get('id')} · {datetime.now():%d.%m.%Y}"
        for n, pg in pages.items():
            if n in report["pages"]:
                r = pg.page.rect
                pg.left(stamp, 56, r.height - 14, 6, color=FAINT)
            pg.apply()
        lv_pages = [int(s["pages"][0]) for s in systems if s.get("pages")]
        first_lv = min(lv_pages) if lv_pages else 1
        try:  # the summary pages are found by their labels; another tender's layout must not break the export
            conditions = _fill_front(doc, first_lv, systems, sections, prices["sum"], report)
        except Exception:  # noqa: BLE001
            log.exception("filled LV: summary pages not filled")
            conditions = {}

        by_system = []
        for sy in systems:
            lab = sy.get("label") or sy.get("name")
            mine = [p for p in positions if p.get("system") == lab]
            by_system.append({"system": lab,
                              "filled": sum(1 for p in mine if p["lv_id"] in prices["lines"]),
                              "open": sum(1 for p in mine if p["lv_id"] not in prices["lines"] and _marker(p)),
                              "amount": round(sum(prices["lines"][p["lv_id"]]["amount"] for p in mine
                                                  if p["lv_id"] in prices["lines"]), 2)})
        cover = pymupdf.open("pdf", _cover(tender, totals, prices, report, conditions, by_system))
        doc.insert_pdf(cover, start_at=0)
        n_cover = cover.page_count
        doc.set_metadata({"title": f"{tender.get('name') or 'Tender'} - filled LV", "author": "ctrl-free",
                          "creator": "ctrl-free", "producer": "ctrl-free (PyMuPDF)"})
        page_count = doc.page_count
        data = doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()
    busiest = sorted(report["per_page"], key=lambda n: (-report["per_page"][n], n))[:3]
    front = sorted(n + n_cover for n in set(report["front_pages"]))
    out = {"offer": prices["offer"], "how": prices["how"], "chosen": bool(totals.get("offer")),
           "k": round(prices["k"], 6), "lv_sum": prices["sum"],
           "rounding": round(prices["offer"] - prices["sum"], 2), "filled": report["filled"],
           "open": sum(report["open"].values()), "open_by_marker": report["open"],
           "totals_filled": report["totals_filled"], "netto": conditions.get("netto"),
           "cover_pages": n_cover, "page_count": page_count,
           # page numbers in the OUTPUT file (cover pages first)
           "filled_pages": sorted(n + n_cover for n in report["pages"]),
           "front_pages": front,
           # a few pages worth previewing: cover, the summary matrix, the LV pages with most prices
           "preview_pages": list(dict.fromkeys([1] + [n + n_cover for n in busiest[:1]] + front[-1:] + front[:1]
                                               + [n + n_cover for n in busiest[1:2]])),
           "lines": {k: {"unit_price": v["unit_price"], "amount": v["amount"]} for k, v in prices["lines"].items()}}
    return data, out
