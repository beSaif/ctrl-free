"""Tender PDF -> systems + positions (with bounding boxes).

Works on the PDF's own layout, not on hardcoded page numbers or names:

* An LV page is a page that carries the column header
  ``Pos. | Gegenstand | Mass-Gattg. | Massbetrag | Einheits-Preis | Betrag Fr.``.
  The x-positions of that header define the unit / quantity / price columns.
  Everything before the first LV page is "conditions" (Vorbemerkungen).
* The system of a page comes from the source-document footer
  (``...\\244.01 LA01 Nebenräume UG.docx``) when present, else from the page header
  (``244.01 LA01 Nebenräume   Seite 9 / 20``), checked for continuity of
  ``Seite n / M`` (catches pages whose header was copied from another system).
* Sections are lines with a single letter in the ``Pos.`` column and an upper-case
  title (``C  ARMATUREN UND INSTRUMENTE``).
* A position is a free-text block whose quantity line has a unit in the
  Mass-Gattg. column and (usually) a number in the Massbetrag column. Consecutive
  quantity lines share the block text (size variants, small tables). A quantity line
  at the *top* of a block that is followed by a spec (``Fabrikat`` / ``Offert-Nr.``)
  opens a "device" (e.g. an air handling unit) whose component lines become
  sub-positions.
* Pages without the column header inside the LV (Ingenieurliste / Bauteilliste,
  Planliste) never produce positions.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import pymupdf

from .units import clean_int, is_number_token, is_unit_token, normalize_unit, parse_number, to_mm

# --------------------------------------------------------------------------------------
# Low level: words -> lines with column zones
# --------------------------------------------------------------------------------------

Y_TOL = 3.5          # words whose vertical centres differ less than this are on one line
TIGHT = 15.5         # centre distance of consecutive lines inside one paragraph (12 pt leading)
STRONG = 31.0        # two or more blank lines


def _r(v: float) -> float:
    return round(float(v), 1)


def _bbox_union(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return [_r(min(b[0] for b in boxes)), _r(min(b[1] for b in boxes)),
            _r(max(b[2] for b in boxes)), _r(max(b[3] for b in boxes))]


@dataclass
class Columns:
    pos_x1: float      # right edge of the Pos. column zone
    unit_x0: float     # Mass-Gattg.
    qty_x0: float      # Massbetrag
    price_x0: float    # Einheits-Preis
    header_bottom: float
    inferred: bool = False   # no printed column header: columns inferred from "unit qty" line ends


@dataclass
class Line:
    page: int
    idx: int                     # running index within the LV stream
    bbox: list
    yc: float
    text: str                    # description zone text
    desc_bbox: list | None
    pos_text: str = ""           # text in the Pos. column (section letters)
    unit_raw: str | None = None
    qty_raw: str | None = None
    qty_bbox: list | None = None
    price_text: str = ""
    kind: str = "text"           # text | qty | section | recap | total | heading | dots
    gap: str = "tight"           # tight | blank | strong | page | break  (distance to previous line)
    system_idx: int = -1

    @property
    def has_qty_col(self) -> bool:
        return self.unit_raw is not None or self.qty_raw is not None

    @property
    def full_text(self) -> str:
        parts = [self.text]
        if self.unit_raw:
            parts.append(self.unit_raw)
        if self.qty_raw:
            parts.append(self.qty_raw)
        return "   ".join(p for p in parts if p).strip()


def _group_words(words):
    """PyMuPDF words -> list of rows (each a list of words sorted by x)."""
    ws = sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    rows: list[list] = []
    cur: list = []
    cur_y = None
    for w in ws:
        yc = (w[1] + w[3]) / 2
        if cur and abs(yc - cur_y) <= Y_TOL:
            cur.append(w)
            cur_y = (cur_y * (len(cur) - 1) + yc) / len(cur)
        else:
            if cur:
                rows.append(sorted(cur, key=lambda w: w[0]))
            cur, cur_y = [w], yc
    if cur:
        rows.append(sorted(cur, key=lambda w: w[0]))
    return rows


# Symbol-font glyphs extracted as private-use code points
_PUA_MAP = {0xF067: "γ", 0xF072: "ρ", 0xF06C: "λ", 0xF06D: "µ", 0xF0B0: "°", 0xF0B1: "±", 0xF044: "Δ",
            0xF0A3: "≤", 0xF0B3: "≥", 0xF0B4: "×"}


def _clean_tok(t: str) -> str:
    if any(0xE000 <= ord(c) <= 0xF8FF for c in t):
        t = "".join(_PUA_MAP.get(ord(c), "") if 0xE000 <= ord(c) <= 0xF8FF else c for c in t)
    return t


def _join(words) -> str:
    """Join words of one line; keep wide gaps as 3 spaces (label | value)."""
    out = ""
    prev = None
    for w in words:
        tok = _clean_tok(w[4])
        if not tok:
            continue
        if prev is not None:
            out += "   " if w[0] - prev[2] > 12 else " "
        out += tok
        prev = w
    return out


def _find_columns(rows) -> Columns | None:
    """Locate the LV column header by its words and return the column x-positions."""
    flat = [w for r in rows for w in r]
    gattg = [w for w in flat if w[4].lower().startswith("gattg")]
    if not gattg:
        return None
    g = gattg[0]
    near = [w for w in flat if abs(w[1] - g[1]) < 25]
    betrag = [w for w in near if w[4].lower().startswith("betrag") and w[0] > g[0] + 5]
    preis = [w for w in near if w[4].lower().startswith(("einheits", "preis"))]
    pos = [w for w in near if w[4].lower().startswith("pos")]
    mass = sorted([w for w in near if w[4].lower().startswith("mass")], key=lambda w: w[0])
    betrag = [w for w in betrag if not preis or w[0] < min(x[0] for x in preis)]
    qty_x0 = min(w[0] for w in betrag) if betrag else (mass[1][0] if len(mass) > 1 else g[0] + 34)
    price_x0 = min(w[0] for w in preis) if preis else qty_x0 + 40
    pos_x1 = (pos[0][0] + 22) if pos else min(w[0] for w in flat) + 22
    header_bottom = max(w[3] for w in near)
    return Columns(pos_x1=pos_x1, unit_x0=g[0], qty_x0=qty_x0, price_x0=price_x0,
                   header_bottom=header_bottom)


def _infer_columns(rows, rect) -> Columns | None:
    """Fallback for LV pages without the printed column header: find lines ending in
    '<unit> <number>' right of the text column and derive the column positions from them."""
    units, nums = [], []
    for r in rows:
        if len(r) < 3:
            continue
        u, q = r[-2], r[-1]
        if is_unit_token(u[4]) and is_number_token(q[4]) and u[0] > rect.width * 0.55 and u[0] - r[-3][2] > 20:
            units.append(u[0])
            nums.append(q[0])
    if len(units) < 2:
        return None
    units.sort()
    nums.sort()
    ux = units[len(units) // 2]
    qx = nums[len(nums) // 2]
    return Columns(pos_x1=min(w[0] for r in rows for w in r) + 15, unit_x0=ux, qty_x0=qx,
                   price_x0=qx + 40, header_bottom=0.0, inferred=True)


_FOOTER_RE = re.compile(r"\.docx|\\\\|^[A-Z]:\\")
_SEITE_RE = re.compile(r"Seite\s+(\d+)\s*/\s*(\d+)")
_DOTS_RE = re.compile(r"^[.…_]{3,}$")


@dataclass
class PageInfo:
    no: int
    size: list
    cols: Columns | None
    header_text: str = ""
    footer_text: str = ""
    seite: tuple | None = None
    lines: list = field(default_factory=list)       # body Line objects (LV pages only)
    text: str = ""
    is_engineer_list: bool = False


def _analyze_page(page, no: int) -> PageInfo:
    words = page.get_text("words")
    rect = page.rect
    info = PageInfo(no=no, size=[_r(rect.width), _r(rect.height)], cols=None)
    rows = _group_words(words)
    info.text = page.get_text("text")
    low = info.text.lower()
    info.is_engineer_list = ("ingenieurliste" in low or "bauteilliste" in low or "auflistung der" in low)
    cols = _find_columns(rows)
    if cols is None and not info.is_engineer_list:
        cols = _infer_columns(rows, rect)
    if cols is None and not info.is_engineer_list:
        # LV page without quantity columns (e.g. a system's general description): running header only
        top = [r for r in rows[:3] if _SEITE_RE.search(_join(r)) and _CODE_RE.search(_join(r))]
        if top:
            y1 = max(w[3] for w in top[0])
            cols = Columns(pos_x1=min(w[0] for w in top[0]) + 15, unit_x0=rect.width + 1, qty_x0=rect.width + 2,
                           price_x0=rect.width + 3, header_bottom=y1 + 20.5, inferred=True)
    if cols is None:
        return info
    info.cols = cols
    h = rect.height
    for r in rows:
        yc = (r[0][1] + r[0][3]) / 2
        txt = _join(r)
        if yc < cols.header_bottom - 20:          # running page header (above column header)
            info.header_text += (" " if info.header_text else "") + txt
            continue
        if yc <= cols.header_bottom + 2:          # column header itself
            continue
        if yc > h * 0.88 and (_FOOTER_RE.search(txt) or re.fullmatch(r"\d+\s*/\s*\d+", txt.strip())):
            info.footer_text += (" " if info.footer_text else "") + txt
            continue
        info.lines.append(_make_line(r, no, cols))
    m = _SEITE_RE.search(info.header_text)
    if m:
        info.seite = (int(m.group(1)), int(m.group(2)))
    return info


def _make_line(r, page_no: int, cols: Columns) -> Line:
    desc, pos, unit_w, qty_w, price = [], [], [], [], []
    for w in r:
        x0, tok = w[0], w[4]
        if x0 < cols.pos_x1 and x0 < cols.unit_x0 - 100:
            pos.append(w)
        elif x0 >= cols.price_x0 - 6:
            price.append(w)
        elif x0 >= cols.unit_x0 - 8 and x0 < cols.qty_x0 - 3 and is_unit_token(tok) and not unit_w:
            unit_w.append(w)
        elif x0 >= cols.qty_x0 - 14 and is_number_token(tok) and not qty_w:
            qty_w.append(w)
        else:
            desc.append(w)
    # A unit printed slightly right (e.g. "m2@383") may land in the qty zone: accept it.
    if not unit_w:
        for w in list(desc):
            if w[0] >= cols.unit_x0 - 8 and is_unit_token(w[4]):
                unit_w.append(w)
                desc.remove(w)
                break
    bbox = _bbox_union([w[:4] for w in r])
    line = Line(page=page_no, idx=-1, bbox=bbox, yc=(bbox[1] + bbox[3]) / 2,
                text=_join(desc).strip(), desc_bbox=_bbox_union([w[:4] for w in desc]),
                pos_text=_join(pos).strip())
    if unit_w:
        line.unit_raw = unit_w[0][4]
    if qty_w:
        line.qty_raw = qty_w[0][4]
    if unit_w or qty_w:
        line.qty_bbox = _bbox_union([w[:4] for w in unit_w + qty_w])
    line.price_text = _join(price).strip()
    return line


# --------------------------------------------------------------------------------------
# Systems
# --------------------------------------------------------------------------------------

_CODE_RE = re.compile(r"\b(\d{3})\.(\d{1,2})\b")
_KEY_RE = re.compile(r"\bLA\s?0?(\d{1,2})\b")
_FOOTER_SYS_RE = re.compile(r"(\d{3}\.\d{2})\s+([^\\/]+?)\.docx", re.I)


def _norm_code(a: str, b: str) -> str:
    return f"{a}.{int(b):02d}"


def _header_system(header: str):
    """'SH Erlenstrasse Oberglatt   244.01 LA01 Nebenräume   Seite 9 / 20' -> ('244.01', 'LA01 Nebenräume')."""
    h = _SEITE_RE.sub("", header)
    m = _CODE_RE.search(h)
    if not m:
        return None
    rest = h[m.end():].strip()
    rest = re.split(r"\s{3,}", rest)[0].strip()
    return _norm_code(m.group(1), m.group(2)), rest


def _footer_system(footer: str):
    m = _FOOTER_SYS_RE.search(footer)
    if not m:
        return None
    code = m.group(1)
    return code, m.group(2).strip()


def _split_key(name: str):
    m = _KEY_RE.search(name)
    if not m:
        return None, name.strip()
    key = f"LA{int(m.group(1)):02d}"
    rest = (name[:m.start()] + name[m.end():]).strip()
    return key, re.sub(r"\s+", " ", rest)


def _words(s: str):
    return set(re.sub(r"[/\-]", " ", s.casefold()).split())


def _profile(name: str) -> str:
    return "sports_hall" if re.search(r"turnhalle|sporthalle|halle\b", name, re.I) else "school"


# --------------------------------------------------------------------------------------
# Text helpers (attributes, hints, titles)
# --------------------------------------------------------------------------------------

_KV_RE = re.compile(r"^(Fabrikat|Typ|Offert(?:e|-Nr\.?)?|Hersteller|Material|Farbe|Luftmenge|Regelfabrikat|"
                    r"Prüffirma|Grundlage|Klappe|Motor|Kommunikationseinheit|Ausführung|Qualitätsstufe)\b", re.I)
_SIZE_LABEL_RE = re.compile(r"^(Grösse|Größe|Abmessungen?|Dimension(en)?|BxHxL|BxH|B\s*x\s*H(\s*x\s*L)?|"
                            r"Durchmesser|DN|Länge)\s*(\([^)]*\))?\s*:?\s*", re.I)
_COUNT_RE = re.compile(r"^(\d{1,3})\s*(x\s+)?(?=[A-Za-zÄÖÜäöü])")
_CONT_START_RE = re.compile(r"^(dito|detto|wie\s+vor\w*|wie\s+oben|jedoch|idem)\b", re.I)
_ZB_RE = re.compile(r"\bz\.\s?B\.?\s*:?\s*", re.I)


def _is_kv(text: str) -> bool:
    return bool(_KV_RE.match(text.strip()))


def _is_table_header(text: str) -> bool:
    t = text.strip()
    if "___" in t or _DOTS_RE.match(t):
        return True
    toks = t.split()
    if len(toks) >= 3 and sum(len(x) <= 6 for x in toks) >= len(toks) - 1 and \
            re.match(r"^(Mod\.?|Typ|Länge|DN|BxH|cm|mm|m3/h|Pa)\b", t, re.I):
        return True
    return False


def _is_bullet(text: str) -> bool:
    return bool(re.match(r"^[-•–]\s", text.strip()))


def _clean_hint(v: str) -> str | None:
    v = _ZB_RE.sub("", v).strip()
    v = re.sub(r"\boder\s+gleichwertig\b.*$", "", v, flags=re.I).strip(" ,;:")
    if not v or _DOTS_RE.match(v) or set(v) <= set(". "):
        return None
    return v


def _extract_hint(lines: list[str], label: str) -> str | None:
    rx = re.compile(rf"(?:^|\s){label}\s*:?\s+(.+)$", re.I)
    for t in lines:
        m = rx.search(t)
        if m:
            v = _clean_hint(m.group(1))
            if v:
                # "Klappe  Fabrikat z.B. Troxhesco" - keep the value only
                return re.split(r"\s{3,}", v)[0].strip()
    return None


_OFFER_RE = re.compile(r"\bOffert(?:e|-?Nr\.?|en-?Nr\.?)\s*:?\s+([A-Z]{0,3}\d[\w./-]*)", re.I)

_MATERIALS = [
    (r"mineralwoll|steinwoll", "mineral wool"),
    (r"kunststoff|\bPVC\b|polyethylen|polyurethan", "plastic"),
    (r"sendzimir|sendizimir|verzinkt|galvani", "galvanized steel"),
    (r"\bV2A\b|\bV4A\b|chromstahl|edelstahl|rostfrei|inox", "stainless steel"),
    (r"alumin|\balu\b", "aluminium"),
    (r"mineralwoll|steinwoll", "mineral wool"),
    (r"stahlblech", "sheet steel"),
]

_TYPES = [
    (r"zuluft.{0,4}tellerventil", "supply air valve"),
    (r"abluft.{0,4}tellerventil", "exhaust air valve"),
    (r"tellerventil", "disc valve"),
    (r"brandschutzklappe", "fire damper"),
    (r"volumenstromregler|vvs|\bvav\b", "flow controller"),
    (r"drosselklappe", "balancing damper"),
    (r"rohrschalldämpfer|telefonieschalldämpfer", "circular silencer"),
    (r"schalldämpfer", "silencer"),
    (r"wetterschutzgitter", "weather louvre"),
    (r"zuluftgitter|abluftgitter|gitter", "grille"),
    (r"düsenrohr|weitwurfdüse|drallauslass|deckenauslass|luftdurchlass", "air diffuser"),
    (r"regenhut|lamellenhut|dachhaube", "roof cowl"),
    (r"dehnungsmanschette|manschette", "flexible connector"),
    (r"kontroll.{0,10}deckel|putzdeckel|revisi?sondeckel|revisionsdeckel", "inspection cover"),
    (r"dämmung|isolation|aussendämmung", "insulation"),
    (r"durchdringung|durchführung|abschottung", "fire penetration seal"),
    (r"zuluftgerät|abluftgerät|lüftungsgerät|monoblock", "air handling unit"),
    (r"drehantrieb|stellantrieb|klappenantrieb", "actuator"),
    (r"rauchmelder", "smoke detector"),
    (r"druckwächter|frostschutz|fühler|thermometer", "sensor"),
    (r"kanaldichtheitsprüfung|dichtheitsprüfung", "leak test"),
    (r"montagef|montageschiene|anschlusswink|befestigung|l-profil", "support"),
    (r"montage|transport|inbetrieb|einregulierung|arbeitsstunde", "service"),
    (r"bezeichnungsschild|farbpfeil", "labelling"),
    (r"potentialverbindung", "bonding"),
    (r"wickelfalz|spiro|rohr\b|kanal", "duct"),
]


def _num(s: str) -> float:
    return float(s.replace(",", ".").replace("'", ""))


_DN_PATTERNS = [
    # Ø 10 cm, ø 12.5 cm, Ø 315 mm, Ø315
    (re.compile(r"[Øø⌀]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm)?\b", re.I), 1, 2),
    # 10 Ø cm
    (re.compile(r"(\d+(?:[.,]\d+)?)\s*[Øø⌀]\s*(mm|cm)\b", re.I), 1, 2),
    # DN 160, DN160
    (re.compile(r"\bDN\s*(\d+(?:[.,]\d+)?)\b"), 1, None),
    # d = 200 mm / d=200
    (re.compile(r"\bd\s*=\s*(\d+(?:[.,]\d+)?)\s*(mm|cm)\b"), 1, 2),
]
_DIMS_RE = re.compile(
    r"(?<![\w/.])(\d+(?:[.,]\d+)?)\.?\s*[xX×]\s*(\d+(?:[.,]\d+)?)(?:\s*[xX×]\s*(\d+(?:[.,]\d+)?))?\s*(mm|cm|m)?(?![\w/])")
_THICK_RE = [
    re.compile(r"\b(\d{1,3})\s*mm\s+(?:stark\w*\s+)?(?:Mineralwoll|Steinwoll|Glaswoll|Dämm|Isol|Kautschuk|Armaflex)", re.I),
    re.compile(r"(?:Dämm|Isolier)(?:stärke|dicke)\s*:?\s*(\d{1,3})\s*mm", re.I),
    re.compile(r"(?:dämmung|isolation)\s+(\d{2,3})\s*/\s*\d{1,2}\b", re.I),
]
_FIRE_RE = re.compile(r"\b(EI|E|REI)\s?(\d{2,3})(?:\s*-\s*S)?\b")


def _dn_from(text: str):
    for rx, gi, ui in _DN_PATTERNS:
        m = rx.search(text)
        if m:
            v = _num(m.group(gi))
            unit = (m.group(ui) if ui else "mm") or None
            if unit is None:
                unit = "cm" if v < 50 else "mm"
            mm = to_mm(v, unit.lower())
            if unit.lower() == "cm" and mm > 2500:      # "Ø 1155 cm" is a typo for mm
                mm = v
            return clean_int(mm)
    return None


def _dims_from(text: str):
    for m in _DIMS_RE.finditer(text):
        a, b, c, unit = m.group(1), m.group(2), m.group(3), m.group(4)
        vals = [_num(a), _num(b)] + ([_num(c)] if c else [])
        if unit is None:
            unit = "mm" if max(vals) >= 100 else "cm"
        if unit == "m" and max(vals) > 20:
            continue
        mm = [clean_int(to_mm(v, unit)) for v in vals]
        if min(mm) < 10:      # "2 x 124 mm" = two spigots, not a size
            continue
        return mm
    return None


def _thickness_from(text: str):
    for rx in _THICK_RE:
        m = rx.search(text)
        if m:
            return int(m.group(1))
    return None


def _fire_from(text: str):
    m = _FIRE_RE.search(text)
    if not m:
        return None
    s = f"{m.group(1)}{m.group(2)}"
    if re.search(rf"{m.group(1)}\s?{m.group(2)}\s*-\s*S", text):
        s += "-S"
    return s


def _material_from(text: str):
    for rx, name in _MATERIALS:
        if re.search(rx, text, re.I):
            return name
    return None


def _type_from(text: str):
    for rx, name in _TYPES:
        if re.search(rx, text, re.I):
            return name
    return None


def _dehyphen_join(lines: list[str]) -> str:
    out = ""
    for t in lines:
        t = t.strip()
        if not out:
            out = t
        elif re.search(r"[A-Za-zäöüß]-$", out) and t[:1].islower():
            out = out[:-1] + t
        else:
            out += " " + t
    return out


def _collapse(s: str) -> str:
    s = re.sub(r"\s{2,}", " ", s).strip()
    s = re.sub(r"(\w)\s+[-–]\s+(\w)", r"\1-\2", s)     # "Zuluft - Tellerventil" -> "Zuluft-Tellerventil"
    return s


def _strip_size_label(t: str) -> str:
    t = t.strip()
    t2 = _SIZE_LABEL_RE.sub("", t, count=1).strip()
    return t2 or t


def _is_sizeish(t: str) -> bool:
    t = t.strip()
    if not t:
        return False
    if _SIZE_LABEL_RE.match(t):
        return True
    if re.search(r"[Øø⌀]|\bDN\s*\d", t):
        return True
    if _DIMS_RE.search(t) and len(t) < 40:
        return True
    # table row like "TVR-D 12.5 60 200 150" / "100 10 20 10 ....."
    toks = t.split()
    nums = sum(bool(re.match(r"^[\d.,/\-]+\.?$", x)) for x in toks)
    return len(toks) >= 3 and nums >= len(toks) - 1


def _shorten(s: str, n: int = 110) -> str:
    s = s.strip(" ,;:")
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:") + " …"


# --------------------------------------------------------------------------------------
# Small tables inside a block ("Mod. DN Vmin Vmax P" / "cm m3/h ...")
# --------------------------------------------------------------------------------------



# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------

@dataclass
class _Group:
    """A set of quantity lines sharing the same block text."""
    shared: list            # Lines before the first quantity line
    heading: str | None     # main heading text used in titles
    qualifier: str | None
    positions: list = field(default_factory=list)   # position dicts
    qty_lines: list = field(default_factory=list)
    section: str | None = None
    subheading: str | None = None
    inherited: bool = False


def parse_tender(pdf_path: str | Path, progress: Callable[[int, int], None] | None = None) -> dict:
    """Parse a tender (Leistungsverzeichnis) PDF.

    Returns {"page_count", "systems", "positions", "pages_text", "conditions_pages",
             "engineer_list_pages", "appendix_pages", "text_blocks", "lots"}.
    Positions carry no match/pricing (added later by the pipeline).
    """
    doc = pymupdf.open(str(pdf_path))
    n = doc.page_count
    pages: list[PageInfo] = []
    for i, page in enumerate(doc):
        pages.append(_analyze_page(page, i + 1))
        if progress:
            progress(i + 1, n)
    doc.close()
    return _build(pages)


def _build(pages: list[PageInfo]) -> dict:
    n = len(pages)
    pages_text = {p.no: p.text for p in pages}
    real = [p.no for p in pages if p.cols is not None and not p.cols.inferred and p.lines]
    first_real = real[0] if real else None
    lv_pages = [p for p in pages if p.cols is not None and p.lines and
                (not p.cols.inferred or first_real is None or p.no > first_real)]
    if not lv_pages:
        return {"page_count": n, "systems": [], "positions": [], "pages_text": pages_text,
                "conditions_pages": list(range(1, n + 1)), "engineer_list_pages": [],
                "appendix_pages": [], "text_blocks": [], "lots": {}}
    first_lv = lv_pages[0].no
    last_lv = lv_pages[-1].no
    conditions_pages = list(range(1, first_lv))
    lv_set = {p.no for p in lv_pages}
    engineer = [p.no for p in pages if first_lv <= p.no <= last_lv and p.no not in lv_set and p.is_engineer_list]
    appendix = [p.no for p in pages if p.no > first_lv and p.no not in lv_set and p.no not in engineer
                and p.cols is None]
    lots = _detect_lots([pages[i - 1] for i in conditions_pages])

    systems = _assign_systems(lv_pages, lots)

    # ---------------- line stream ----------------
    stream: list[Line] = []
    prev_page = None
    for p in lv_pages:
        prev_yc = None
        for ln in p.lines:
            if prev_yc is None:
                ln.gap = "page" if (prev_page is not None and p.no == prev_page + 1) else "break"
            else:
                d = ln.yc - prev_yc
                ln.gap = "tight" if d <= TIGHT else ("blank" if d < STRONG else "strong")
            prev_yc = ln.yc
            ln.idx = len(stream)
            stream.append(ln)
        prev_page = p.no
    _classify(stream)

    positions, text_blocks, section_names = _segment(stream, systems)
    sizes = {p.no: p.size for p in pages}
    for item in positions + text_blocks:
        item["source"]["page_size"] = sizes.get(item["source"]["page"])

    # section names from the cost summary (proper case) when available
    for pos in positions:
        sk = (pos["system_key"], pos["section"])
        if pos["section"] and sk in section_names:
            pos["section_name"] = section_names[sk]
    # LV ids only for priceable rows (item / lump_sum); subtotals get their own "ST001" series
    n_lv = n_st = 0
    for pos in positions:
        if pos["kind"] == "subtotal":
            n_st += 1
            pos["lv_id"] = f"ST{n_st:03d}"
        else:
            n_lv += 1
            pos["lv_id"] = f"LV{n_lv:04d}"
    # fix up component links to lv ids
    by_obj = {id(p): p["lv_id"] for p in positions}
    for p in positions:
        parent = p.pop("_parent", None)
        p["parent_lv_id"] = by_obj.get(id(parent)) if parent is not None else None
    out_systems = []
    for s in systems:
        out_systems.append({k: s[k] for k in ("code", "key", "name", "label", "pages", "lot", "profile")})
    return {
        "page_count": n,
        "systems": out_systems,
        "positions": positions,
        "pages_text": pages_text,
        "conditions_pages": conditions_pages,
        "engineer_list_pages": engineer,
        "appendix_pages": appendix,
        "text_blocks": text_blocks,
        "lots": lots,
    }


def _detect_lots(cond_pages: list[PageInfo]) -> dict:
    """'LOS 1' ... '244.1 LA01 Nebenräume' ... 'LOS 2' ... '244.5 LA05 Turnhalle' -> {'244.01': 1, ...}."""
    lots: dict[str, int] = {}
    for p in cond_pages:
        cur = None
        for raw in p.text.splitlines():
            t = raw.strip()
            m = re.match(r"^(?:LOS|Los)\s+(\d+)\b\s*$", t)
            if m:
                cur = int(m.group(1))
                continue
            if cur is None:
                continue
            m = re.match(r"^(\d{3})\.(\d{1,2})\s+\S", t)
            if m:
                lots.setdefault(_norm_code(m.group(1), m.group(2)), cur)
            elif re.match(r"^Total\b", t):
                cur = None
    return lots


def _assign_systems(lv_pages: list[PageInfo], lots: dict) -> list[dict]:
    systems: list[dict] = []
    by_code: dict[str, dict] = {}
    totals_by_code: dict[str, set] = {}
    prev = None          # (system dict, seite)
    for p in lv_pages:
        hs = _header_system(p.header_text)
        fs = _footer_system(p.footer_text)
        code = fs[0] if fs else (hs[0] if hs else None)
        # continuity check: header copied from another system ("Seite 8 / 20" after "Seite 7 / 20")
        if not fs and prev is not None and hs and p.seite and prev[1]:
            pn, pm = prev[1]
            if hs[0] != prev[0]["code"] and p.seite[1] == pm and p.seite[0] == pn + 1 \
                    and pm not in totals_by_code.get(hs[0], {pm}):
                code = prev[0]["code"]
        if code is None:
            code = prev[0]["code"] if prev else "?"
        if code not in by_code:
            s = {"code": code, "names": [], "pages_list": []}
            by_code[code] = s
            systems.append(s)
        s = by_code[code]
        if hs and hs[0] == code:
            s["names"].append(("header", hs[1]))
        if fs and fs[0] == code:
            s["names"].append(("footer", fs[1]))
        if p.seite:
            totals_by_code.setdefault(code, set()).add(p.seite[1])
        s["pages_list"].append(p.no)
        for ln in p.lines:
            ln.system_idx = systems.index(s)
        prev = (s, p.seite)
    for s in systems:
        hdr = [nm for src, nm in s["names"] if src == "header"]
        ftr = [nm for src, nm in s["names"] if src == "footer"]
        hname = max(set(hdr), key=hdr.count) if hdr else None
        fname = max(set(ftr), key=ftr.count) if ftr else None
        hkey, hrest = _split_key(hname) if hname else (None, "")
        fkey, frest = _split_key(fname) if fname else (None, "")
        name = hrest or frest
        if hrest and frest and _words(frest) > _words(hrest):
            name = frest
        key = hkey or fkey or s["code"]
        s["key"] = key
        s["name"] = name
        s["label"] = " ".join(x for x in (s["code"], key if key != s["code"] else None, name) if x)
        s["pages"] = [min(s["pages_list"]), max(s["pages_list"])]
        s["lot"] = lots.get(s["code"])
        s["profile"] = _profile(s["label"])
    return systems


_SECTION_TITLE_RE = re.compile(r"^[A-ZÄÖÜ0-9 ,./&\-]+$")


def _upper_ratio(t: str) -> float:
    letters = [c for c in t if c.isalpha()]
    if not letters:
        return 0.0
    return sum(c.isupper() for c in letters) / len(letters)


def _classify(stream: list[Line]) -> None:
    recap = False
    cur_sys = None
    for ln in stream:
        if ln.system_idx != cur_sys:
            cur_sys, recap = ln.system_idx, False
        t = ln.text
        if re.fullmatch(r"KOSTENZUSAMMENSTELLUNG|ZUSAMMENSTELLUNG|REKAPITULATION", t.strip(), re.I):
            ln.kind, recap = "heading", True
            continue
        if re.match(r"^(Total|Zwischentotal|Übertrag|Uebertrag)\b", t, re.I):
            ln.kind = "total"
            continue
        if recap and re.fullmatch(r"[A-Z]", ln.pos_text):
            ln.kind = "recap"
            continue
        if re.fullmatch(r"[A-Z]", ln.pos_text) and t and _upper_ratio(t) > 0.8:
            ln.kind = "section"
            continue
        m = re.match(r"^([A-Z])\s{3,}(\S.*)$", t)
        if not ln.pos_text and m and _upper_ratio(m.group(2)) > 0.8 and len(m.group(2)) > 3 and not ln.has_qty_col:
            # section letter printed in the text column ("B           KANÄLE")
            ln.pos_text, ln.text = m.group(1), m.group(2).strip()
            ln.kind = "recap" if recap else "section"
            continue
        if re.fullmatch(r"[A-Z]", ln.pos_text) and t and (ln.price_text or recap):
            ln.kind = "recap"
            continue
        if (re.match(r"^\d{3}(\.\d+)?\b", ln.pos_text) or re.match(r"^\d{3}\.\d+\s", t)) and _upper_ratio(t) > 0.8:
            ln.kind = "heading"
            continue
        if ln.has_qty_col and (ln.unit_raw or ln.qty_raw):
            ln.kind = "qty"
            continue
        if not t and (ln.price_text or not ln.pos_text):
            ln.kind = "dots"
            continue
        if not t and ln.pos_text:
            t = ln.pos_text
        ln.kind = "text"


def _title_case_de(s: str) -> str:
    small = {"und", "oder", "für", "mit", "der", "die", "das", "von", "im", "in", "zu", "an", "auf"}
    out = []
    for i, w in enumerate(s.lower().split()):
        out.append(w if (i > 0 and w in small) else w[:1].upper() + w[1:])
    return " ".join(out)


def _segment(stream: list[Line], systems: list[dict]):
    """Turn the classified line stream into positions (+ subtotals) and leftover text blocks."""
    positions: list[dict] = []
    text_blocks: list[dict] = []
    section_names: dict = {}

    def sys_of(ln):
        return systems[ln.system_idx] if ln.system_idx >= 0 else None

    st = {"section": None, "section_name": None}
    pending: list[Line] = []
    last_group: _Group | None = None
    trailing_ok = False              # text right after a qty line in the same paragraph is trailing text
    device: dict | None = None       # open device position (e.g. an AHU) collecting its description
    groups_in_section: list[_Group] = []

    def to_text(lines):
        lines = [l for l in lines if l.kind == "text"]
        if lines:
            text_blocks.append(_text_block(lines, systems, st["section"], st["section_name"]))

    def flush():
        nonlocal pending
        if pending:
            if device is not None:
                _append_lines(device, [l for l in pending if l.kind == "text"], role="desc")
            else:
                to_text(pending)
        pending = []

    def close_device():
        nonlocal device
        if device is not None:
            flush()
        device = None

    def emit(g: _Group, qline: Line, component_of=None, variant=False):
        nonlocal last_group, trailing_ok
        pos = _make_position(g, qline, sys_of(qline), st["section"], st["section_name"],
                             variant=variant, component_of=component_of)
        positions.append(pos)
        g.positions.append(pos)
        g.qty_lines.append(qline)
        if len(g.qty_lines) > 1:
            _refresh_variant_roles(g)
        last_group, trailing_ok = g, True
        return pos

    def new_group(shared):
        return _Group(shared=shared, heading=None, qualifier=None, section=st["section"])

    def open_device(pos: dict, i: int) -> int:
        """Make pos the open device and absorb the tight paragraph below its heading."""
        nonlocal device, trailing_ok
        device = pos
        trailing_ok = False
        pos["attributes"]["device"] = True
        j = i + 1
        while j < N and stream[j].kind == "text" and stream[j].gap == "tight":
            _append_lines(pos, [stream[j]], role="desc")
            j += 1
        return j

    def component(qline: Line, comp: list[Line]):
        g = new_group(comp)
        first = comp[0].text if comp else qline.text
        comp_txt = _collapse(_COUNT_RE.sub("", first).strip())
        g.heading = f"{device['_heading']}: {comp_txt}" if comp_txt else device["_heading"]
        emit(g, qline, component_of=device)

    cur_system = None
    i = 0
    N = len(stream)
    while i < N:
        ln = stream[i]
        if ln.system_idx != cur_system:
            close_device()
            flush()
            cur_system = ln.system_idx
            st["section"] = st["section_name"] = None
            last_group, trailing_ok = None, False
            groups_in_section = []
        kind = ln.kind

        if kind in ("section", "heading", "recap"):
            close_device()
            flush()
            last_group, trailing_ok = None, False
            if kind == "section":
                st["section"] = ln.pos_text
                st["section_name"] = _title_case_de(ln.text)
                groups_in_section = []
            elif kind == "recap":
                s = sys_of(ln)
                nm = re.sub(r"\s*[.…]{3,}.*$", "", ln.text).strip()
                if s and nm:
                    section_names[(s["key"], ln.pos_text)] = nm
            i += 1
            continue

        if kind == "dots":
            i += 1
            continue

        if kind == "total":
            close_device()
            flush()
            lines = [ln]
            j = i + 1
            while j < N and stream[j].gap == "tight" and stream[j].kind == "text" and stream[j].text[:1].islower():
                lines.append(stream[j])
                j += 1
            positions.append(_subtotal(lines, sys_of(ln), st["section"], st["section_name"]))
            last_group, trailing_ok = None, False
            i = j
            continue

        if kind == "text":
            if trailing_ok and ln.gap == "tight" and last_group is not None and not pending:
                _append_lines(last_group.positions[-1], [ln], role="desc")
                i += 1
                continue
            trailing_ok = False
            if device is None and ln.gap == "break" and pending:
                to_text(pending)
                pending = []
            pending.append(ln)
            i += 1
            continue

        # ---------------- quantity line ----------------
        bare = not ln.text
        cnt_q = bool(_COUNT_RE.match(ln.text))

        # consecutive quantity line in the same paragraph -> size variant of the previous group
        if last_group is not None and not pending and i > 0 and stream[i - 1].kind == "qty" \
                and ln.gap == "tight" and last_group.section == st["section"]:
            emit(last_group, ln, component_of=last_group.positions[0].get("_parent"), variant=True)
            i += 1
            continue

        if device is not None:
            new_head = (not bare and _is_descriptive(ln.text) and ln.gap != "tight" and not pending
                        and _spec_follows(stream, i))
            new_head = new_head or (not bare and _is_descriptive(ln.text) and ln.gap != "tight"
                                    and _spec_follows(stream, i, strict=True))
            bare_head = (bare and pending and _headingish(pending[-1].text)
                         and pending[-1].gap != "tight" and _spec_follows(stream, i, strict=True))
            if new_head or bare_head:
                head = pending[-1:] if bare_head else []
                pending = pending[:-1] if bare_head else pending
                close_device()
                pending = head
            elif cnt_q or bare or not _is_descriptive(ln.text):
                if cnt_q:
                    k = len(pending)
                else:
                    k = next((k for k in range(len(pending) - 1, -1, -1) if _COUNT_RE.match(pending[k].text)),
                             max(0, len(pending) - 1))
                before, comp = pending[:k], pending[k:]
                _append_lines(device, [l for l in before if l.kind == "text"], role="desc")
                pending = []
                component(ln, comp)
                i += 1
                continue
            else:
                # an ordinary position after the device: its block starts at the last paragraph break
                k = next((k for k in range(len(pending) - 1, -1, -1) if pending[k].gap in ("strong", "break")), None)
                if k is None:
                    k = next((k for k in range(len(pending) - 1, -1, -1) if pending[k].gap != "tight"), 0)
                before, pending = pending[:k], pending[k:]
                _append_lines(device, [l for l in before if l.kind == "text"], role="desc")
                device = None
        elif (cnt_q or bare) and pending:
            # component line of a device whose heading carries no quantity ("Zuluftgerät 4-1" + spec)
            h = _implicit_device_head(pending)
            if h is not None:
                k = len(pending) if cnt_q else next(
                    (k for k in range(len(pending) - 1, h, -1) if _COUNT_RE.match(pending[k].text)), len(pending) - 1)
                if k > h:
                    to_text(pending[:h])
                    g = new_group([])
                    dev = emit(g, pending[h])
                    dev["source"]["qty_bbox"] = None
                    for sl in dev["source"]["lines"]:
                        sl["role"] = "desc"
                    groups_in_section.append(g)
                    device = dev
                    device["attributes"]["device"] = True
                    _append_lines(device, [l for l in pending[h + 1:k] if l.kind == "text"], role="desc")
                    comp = pending[k:]
                    pending = []
                    component(ln, comp)
                    i += 1
                    continue

        # ---------------- new block ----------------
        shared, pending = pending, []
        starts_par = ln.gap != "tight"
        if shared and starts_par and last_group is not None and last_group.section == st["section"] \
                and device is None and shared[0].gap != "break":
            # quantity-first layout: lower-case paragraphs below the previous quantity line describe it
            paras = _paragraphs(shared)
            k = 0
            while k < len(paras) and paras[k][0].text[:1].islower():
                k += 1
            if k:
                moved = [l for p_ in paras[:k] for l in p_]
                _append_lines(last_group.positions[-1], [l for l in moved if l.kind == "text"], role="desc")
                shared = [l for p_ in paras[k:] for l in p_]
        if shared and starts_par and _is_descriptive(ln.text) and not all(_is_kv(l.text) for l in shared):
            paras = _paragraphs(shared)
            if len(paras) >= 2 or len(shared) >= 4:
                # the quantity line names the item itself; the text above is a section preamble
                to_text(shared)
                shared = []
        g = new_group(shared)
        _derive_heading(g, ln, groups_in_section)
        pos = emit(g, ln)
        groups_in_section.append(g)
        head_like = (not shared and _is_descriptive(ln.text)) or (bare and 0 < len(shared) <= 2
                                                                   and _headingish(shared[-1].text))
        if head_like and _spec_follows(stream, i):
            i = open_device(pos, i)
            continue
        i += 1

    close_device()
    flush()
    for p in positions:
        p.pop("_heading", None)
        p.pop("_lines_obj", None)
    return positions, text_blocks, section_names


def _implicit_device_head(pending: list[Line]) -> int | None:
    """Index of a heading line followed (within 4 lines) by Fabrikat/Offert -> device heading."""
    for k, l in enumerate(pending):
        t = l.text.strip()
        if not t or _is_kv(t) or _COUNT_RE.match(t) or _is_bullet(t):
            continue
        for l2 in pending[k + 1:k + 5]:
            if re.match(r"^(Offert|Offerte)\b", l2.text, re.I):
                return k
        return None
    return None


def _spec_follows(stream: list[Line], i: int, strict: bool = False) -> bool:
    """True if the line right below line i starts a maker/offer spec (Fabrikat / Offert-Nr.) -> the
    quantity at line i heads a device description (e.g. an air handling unit). strict: an offer
    reference must follow within the next lines too."""
    j = i + 1
    if j >= len(stream) or stream[j].kind != "text" or stream[j].system_idx != stream[i].system_idx:
        return False
    if not re.match(r"^(Fabrikat|Offert|Hersteller)\b", stream[j].text, re.I):
        return False
    if not strict:
        return True
    for l2 in stream[j:j + 5]:
        if l2.kind != "text":
            return False
        if re.match(r"^(Offert|Offerte)\b", l2.text, re.I):
            return True
    return False


def _implicit_device_head(pending: list[Line]) -> int | None:
    """Index of a heading line followed (within 4 lines) by Fabrikat/Offert -> device heading."""
    for k, l in enumerate(pending):
        t = l.text.strip()
        if not t or _is_kv(t) or _COUNT_RE.match(t) or _is_bullet(t):
            continue
        for l2 in pending[k + 1:k + 5]:
            if re.match(r"^(Offert|Offerte)\b", l2.text, re.I):
                return k
        return None
    return None


def _spec_follows(stream: list[Line], i: int, strict: bool = False) -> bool:
    """True if, below line i and before the next quantity line, a Fabrikat/Offert/Typ spec starts
    within a few lines -> the quantity at line i heads a device description."""
    seen = 0
    j = i + 1
    while j < len(stream) and seen < 5:
        l2 = stream[j]
        if l2.kind != "text" or l2.system_idx != stream[i].system_idx:
            return False
        if re.match(r"^(Offert|Offerte)\b" if strict else r"^(Fabrikat|Offert|Hersteller)\b", l2.text, re.I):
            return True
        seen += 1
        j += 1
    return False



def _text_block(lines: list[Line], systems, section, section_name) -> dict:
    s = systems[lines[0].system_idx] if lines[0].system_idx >= 0 else None
    page = lines[0].page
    return {
        "kind": "text_only",
        "system": s["label"] if s else None, "system_key": s["key"] if s else None,
        "section": section, "section_name": section_name,
        "page": page,
        "text_de": "\n".join(l.text for l in lines),
        "source": {"page": page, "block_bbox": _bbox_union([l.bbox for l in lines if l.page == page]),
                   "lines": [_src_line(l, "desc") for l in lines]},
    }


def _src_line(l: Line, role: str) -> dict:
    return {"text": l.full_text, "bbox": l.bbox, "role": role, "page": l.page}


def _append_lines(pos: dict, lines: list[Line], role: str):
    if not lines:
        return
    pos["_lines_obj"].extend(lines)
    pos["text_de"] = (pos["text_de"] + "\n" if pos["text_de"] else "") + "\n".join(l.text for l in lines)
    for l in lines:
        pos["source"]["lines"].append(_src_line(l, role))
    page = pos["source"]["page"]
    pos["source"]["block_bbox"] = _bbox_union([pos["source"]["block_bbox"]] + [l.bbox for l in lines if l.page == page])
    # hints may appear in the spec below a device heading
    _fill_hints(pos, [l.text for l in pos["_lines_obj"]])


def _paragraphs(lines: list[Line]) -> list[list[Line]]:
    out: list[list[Line]] = []
    for l in lines:
        if not out or l.gap != "tight":
            out.append([l])
        else:
            out[-1].append(l)
    return out


def _headingish(t: str) -> bool:
    t = t.strip()
    return bool(t) and not (_is_kv(t) or _is_table_header(t) or _is_bullet(t) or _is_sizeish(t)
                            or _SIZE_LABEL_RE.match(t) or _COUNT_RE.match(t) or _is_spec_line(t))


def _is_spec_line(t: str) -> bool:
    """'Druckverlust   30Pa', 'Luftmenge   700 m3/h' - a label/value line (not a heading)."""
    parts = re.split(r"\s{3,}", t.strip())
    return len(parts) >= 2 and any(re.search(r"\d", x) for x in parts[1:]) and len(parts[0]) <= 40


_QTY_LABEL_RE = re.compile(r"^(Anzahl|Menge|Stückzahl|Stück|Total)\b", re.I)


def _is_descriptive(t: str) -> bool:
    """A quantity line whose text names the item ('Drehantrieb, 20 Nm', 'Farbpfeile')."""
    t = (t or "").strip()
    return bool(t) and not t[:1].islower() and not (_is_sizeish(t) or _SIZE_LABEL_RE.match(t) or _is_spec_line(t) or _is_kv(t)
                            or _COUNT_RE.match(t) or _QTY_LABEL_RE.match(t))


_FUNC_END_RE = re.compile(r"(\b(als|und|oder|mit|der|die|das|den|dem|des|von|zu|zur|zum|in|im|für|auf|bei|nach|"
                          r"gegen|durch|sowie|inkl\.?)|[-,])$", re.I)


def _derive_heading(g: _Group, qline: Line, groups_in_section: list[_Group]):
    texts = [l for l in g.shared if l.kind == "text"]
    head_idx = next((k for k, l in enumerate(texts) if _headingish(l.text)), None)
    parent = groups_in_section[-1] if groups_in_section else None
    if head_idx is None:
        # block made only of spec/size lines (or a bare "Farbe ..." line) -> inherits the previous heading
        if parent is not None and parent.heading and (texts or (qline.text and not _is_descriptive(qline.text)
                                                                and not _COUNT_RE.match(qline.text))):
            g.heading = parent.heading
            g.qualifier = parent.qualifier
            g.inherited = True
        return
    head_lines = [texts[head_idx].text]
    k = head_idx + 1
    while k < len(texts) and texts[k].gap == "tight" and \
            re.search(r"(-|\bund|\bmit|,|\bfür)$", head_lines[-1].strip()) and not _is_kv(texts[k].text):
        head_lines.append(texts[k].text)
        k += 1
    heading = _collapse(_dehyphen_join(head_lines))
    if _CONT_START_RE.match(heading) and parent is not None and parent.heading:
        heading = f"{parent.heading}, {heading}"
    qualifier = None
    if k < len(texts):
        t2 = texts[k].text.strip()
        first2 = " ".join(t2.lower().split()[:2])
        if t2[:1].islower() and not _is_kv(t2) and len(t2) <= 70 and not _is_sizeish(t2) \
                and first2 not in heading.lower():
            q_lines = [t2]
            k2 = k + 1
            while k2 < len(texts) and texts[k2].gap == "tight" and _FUNC_END_RE.search(q_lines[-1].strip()) \
                    and not _is_kv(texts[k2].text) and len(q_lines) < 3:
                q_lines.append(texts[k2].text)
                k2 += 1
            qualifier = _collapse(_dehyphen_join(q_lines).rstrip(","))
        elif re.fullmatch(r"[\w./-]*\d+\s*[xX]\s*\d+[\w./x-]*", t2) and len(t2) <= 40:
            qualifier = t2      # model/size code right below the heading ("EVS-W-3600x1300x420mm")
    # sub-heading: a short title line opening the last paragraph ("Aussendämmung EI30")
    sub = None
    paras = _paragraphs(texts[k:])
    if len(paras) >= 1 and paras[-1] and texts.index(paras[-1][0]) > head_idx:
        cand = paras[-1][0].text.strip()
        if _headingish(cand) and len(cand.split()) <= 6 and not cand.endswith((".", ":")) and cand != qualifier \
                and not cand[:1].islower() and not _FUNC_END_RE.search(cand) \
                and not re.search(r"Abmessung|B\s*x\s*H|\((mm|cm)\)", cand):
            sub = _collapse(cand)
    g.heading = heading
    g.qualifier = qualifier
    g.subheading = sub


def _variant_text(qline: Line) -> str:
    if not qline.text:
        return ""
    v = _collapse(_strip_size_label(qline.text))
    v = re.sub(r"(\d+(?:[.,]\d+)?)\s*[Øø]\s*(cm|mm)\b", r"Ø \1 \2", v)
    return v


def _build_title(g: _Group, qline: Line, attrs: dict) -> tuple[str, str | None]:
    v = _variant_text(qline)
    head = g.heading
    if v and _COUNT_RE.match(v) and head and ": " in head:
        v = ""      # component line already in the heading
    size_like = bool(v) and (_is_sizeish(qline.text) or bool(_SIZE_LABEL_RE.match(qline.text)))
    spec_like = bool(v) and not size_like and (_is_spec_line(qline.text) or bool(_QTY_LABEL_RE.match(v)))
    texts = [l for l in g.shared if l.kind == "text"]
    if v and not size_like and qline.gap == "tight" and texts:
        prev = texts[-1].text.strip()
        # the quantity sits on the last line of running text: not a variant label
        if _FUNC_END_RE.search(prev) or v.endswith((".", "!")) or len(v) > 50:
            spec_like = True
            hq = " ".join(x for x in (g.heading, g.qualifier) if x)
            if _FUNC_END_RE.search(prev) and hq and _collapse(prev).rstrip("-") and \
                    hq.endswith(_collapse(prev).split()[-1].rstrip("-")) and len(v) <= 50:
                # "abriebfest für" + "Wand- und Deckendurchführungen": finish the heading phrase
                spec_like = False
                v = ""
                g = _Group(shared=g.shared, heading=g.heading, qualifier=(
                    f"{g.qualifier} {_variant_text(qline)}" if g.qualifier else None) or g.qualifier,
                    section=g.section, subheading=g.subheading)
                if not g.qualifier:
                    g.heading = f"{g.heading} {_variant_text(qline)}"
                head = g.heading
    if v and not size_like and head and len(v) > 50:
        spec_like = True
    if v and not size_like and not spec_like and qline.gap != "tight" and head and texts and _is_descriptive(v):
        short_head = len(texts) == 1 and len(head.split()) <= 6 and not head.endswith((":", "."))
        if not short_head:
            head = None     # the quantity line names the item; the text above is context
    table_row = attrs.get("_table_row")
    head_txt = None
    if head:
        head_txt = head
        if g.qualifier and g.qualifier.lower() not in head.lower():
            head_txt = f"{head} {g.qualifier}"
    tail: list[str] = []
    if g.inherited and v and not size_like and not table_row and not g.shared:
        tail.append(v)          # "Farbe NCS nach Wunsch" add-on below the previous item
        v = ""
    sub = getattr(g, "subheading", None)
    if sub and head and sub.lower() not in head.lower() and (not v or sub.lower() not in v.lower()):
        tail.append(sub)
    if table_row:
        model, size_s = table_row
        t = " ".join(x for x in (model, size_s) if x)
        if t:
            tail.append(t)
    elif v and not spec_like and (not head or v.lower() not in head.lower()):
        if not head_txt:
            head_txt = v
        elif size_like:
            tail.append(v)
        elif v[:1].islower() and not tail:
            head_txt = f"{head_txt} {v}"
        elif head.endswith((".", ":")) or len(head.split()) > 8:
            head_txt, tail = v, []
        else:
            tail.append(v)
    else:
        sz = _size_str(attrs)
        if sz and head_txt and sz.lower() not in head_txt.lower():
            tail.append(sz)
        elif not head_txt:
            head_txt = v or None
    head_txt = _clean_title_part(head_txt or "")
    tail = [_clean_title_part(t) for t in tail if t]
    tail_s = ", ".join(t for t in tail if t)
    budget = max(45, 110 - len(tail_s) - 2)
    title = ", ".join(x for x in (_shorten(head_txt, budget), tail_s) if x)
    return title or "(ohne Text)", (v if (size_like or table_row) and v else None)


def _clean_title_part(t: str) -> str:
    t = re.sub(r"\(\s*[γρ]?\s*=[^)]*\)", "", t)    # "(γ = 80 kg/m3)"
    t = re.sub(r"\(\s*z\.\s?B\.[^)]*\)", "", t)     # "(z.B. System Flumroc)"
    t = re.sub(r"\s*\bz\.\s?B\.?\s*:?$", "", t.strip())
    return _collapse(t).strip(" ,;")


def _size_str(attrs: dict) -> str | None:
    if attrs.get("dn_mm"):
        return f"DN {attrs['dn_mm']}"
    if attrs.get("dims_mm"):
        return " x ".join(str(x) for x in attrs["dims_mm"]) + " mm"
    return None


_TABLE_HDR_RE = re.compile(r"^(Mod\.?|Typ|Länge|Grösse|DN|BxH)\b")


def _table_for(g: _Group, qline: Line):
    """Find a column header inside the block (e.g. 'Mod. DN Vmin. Vmax. P' + 'cm m3/h m3/h Pa')."""
    texts = [l for l in g.shared if l.kind == "text"]
    hdr = None
    for k, l in enumerate(texts):
        toks = l.text.split()
        if len(toks) >= 3 and _TABLE_HDR_RE.match(l.text) and (
                "DN" in toks or "BxH" in toks or any(t.startswith("Ø") for t in toks) or "Länge" in toks):
            unit_line = None
            for l2 in texts[k + 1:k + 4]:
                if re.match(r"^(cm|mm|m)\b", l2.text.strip()):
                    unit_line = l2
                    break
            hdr = (l, unit_line)
    return hdr




def _attrs_for(g: _Group, qline: Line, block_text: str, variant_text: str) -> dict:
    attrs: dict = {}
    # variant line first, then the block text (excluding Typ lines which carry model strings)
    spec_free = "\n".join(t for t in block_text.splitlines() if not re.match(r"^\s*(Typ|Fabrikat)\b", t))
    table = _table_for(g, qline)
    if table is not None and variant_text:
        hdr_line, unit_line = table
        hdr_toks = hdr_line.text.split()
        row_toks = qline.text.split()
        unit_toks = unit_line.text.split() if unit_line else []
        # align by position in token order: header tokens and row tokens usually line up 1:1
        cols = {}
        # unit line has no entry for the model column -> shift by one when shorter
        offset = len(hdr_toks) - len(unit_toks)
        for idx, h in enumerate(hdr_toks):
            val = row_toks[idx] if idx < len(row_toks) else None
            u = unit_toks[idx - offset] if 0 <= idx - offset < len(unit_toks) else None
            cols[h.strip(".:")] = (val, u)
        model = None
        if hdr_toks[0].lower().startswith(("mod", "typ")):
            model = row_toks[0] if row_toks and not _DOTS_RE.match(row_toks[0]) else None
        size_s = None
        if "DN" in cols and cols["DN"][0] and re.match(r"^\d+(?:[.,]\d+)?x\d", cols["DN"][0]):
            cols["BxH"] = cols.pop("DN")
        if "DN" in cols and cols["DN"][0]:
            try:
                v = _num(cols["DN"][0])
                attrs["dn_mm"] = clean_int(to_mm(v, (cols["DN"][1] or "mm").lower()))
                size_s = f"DN {attrs['dn_mm']}"
            except ValueError:
                pass
        if "BxH" in cols and cols["BxH"][0]:
            m = re.match(r"(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)", cols["BxH"][0])
            if m:
                u = (cols["BxH"][1] or "mm").lower()
                attrs["dims_mm"] = [clean_int(to_mm(_num(m.group(1)), u)), clean_int(to_mm(_num(m.group(2)), u))]
                size_s = " x ".join(str(x) for x in attrs["dims_mm"]) + " mm"
        if not size_s:
            # e.g. Rohrschalldämpfer: "Länge Ø Ø Isol." with "cm cm cm cm" -> length + inner Ø
            nums = [t for t in row_toks if re.match(r"^\d+(?:[.,]\d+)?$", t)]
            if any(t.startswith("Ø") for t in hdr_toks) and len(nums) >= 2:
                u = (unit_toks[0] if unit_toks else "cm").lower()
                ix = [k for k, t in enumerate(hdr_toks) if t.startswith("Ø")]
                if ix and ix[0] < len(row_toks):
                    try:
                        attrs["dn_mm"] = clean_int(to_mm(_num(row_toks[ix[0]]), u))
                        attrs["length_mm"] = clean_int(to_mm(_num(row_toks[0]), u)) if hdr_toks[0].startswith("Läng") else None
                        size_s = f"DN {attrs['dn_mm']}" + (f", L {attrs['length_mm']} mm" if attrs.get("length_mm") else "")
                    except ValueError:
                        pass
        if model or size_s:
            attrs["_table_row"] = (model, size_s)
    # size: variant line first, then the heading, then explicitly labelled size lines
    head_text = " ".join(x for x in (g.heading, g.qualifier, getattr(g, "subheading", None)) if x)
    size_lines = [t for t in spec_free.splitlines()
                  if _SIZE_LABEL_RE.match(t.strip()) or re.match(r"^\s*([Øø⌀]|B\s*x\s*H|Abmessung)", t.strip())]
    sources = [variant_text, head_text] + size_lines
    if "dn_mm" not in attrs and "dims_mm" not in attrs:
        for src in sources:
            if not src:
                continue
            dims = _dims_from(src)
            dn = _dn_from(src)
            if dims and (dn is None or src.find("x") < src.find("Ø") if "Ø" in src else True):
                attrs["dims_mm"] = dims
                break
            if dn is not None:
                attrs["dn_mm"] = dn
                break
    th = _thickness_from(block_text)
    if th:
        attrs["thickness_mm"] = th
    fc = _fire_from(block_text)
    if fc:
        attrs["fire_class"] = fc
    mat = _material_from(" ".join(x for x in (g.heading, g.qualifier, variant_text) if x)) or _material_from(block_text)
    if mat:
        attrs["material"] = mat
    tp = _type_from(g.heading or "") or _type_from(block_text)
    if tp:
        attrs["type"] = tp
    return attrs


def _fill_hints(pos: dict, texts: list[str]):
    if not pos.get("make_hint"):
        pos["make_hint"] = _extract_hint(texts, "Fabrikat")
    if not pos.get("model_hint"):
        pos["model_hint"] = _extract_hint(texts, "Typ")
    if not pos.get("offer_ref"):
        for t in texts:
            m = _OFFER_RE.search(t)
            if m:
                pos["offer_ref"] = m.group(1).rstrip(".,")
                break


def _make_position(g: _Group, qline: Line, system: dict | None, section, section_name,
                   variant: bool, component_of: dict | None = None) -> dict:
    shared_text = [l for l in g.shared if l.kind == "text"]
    block_lines = [l.text for l in shared_text] + ([qline.text] if qline.text else [])
    text_de = "\n".join(block_lines)
    attrs = _attrs_for(g, qline, text_de, qline.text if qline.text else "")
    title, variant_de = _build_title(g, qline, attrs)
    attrs.pop("_table_row", None)
    qty = parse_number(qline.qty_raw)
    unit = normalize_unit(qline.unit_raw)
    kind = "lump_sum" if unit == "LS" else "item"
    page = qline.page
    src_lines = [_src_line(l, "desc") for l in shared_text] + [_src_line(qline, "qty")]
    pos = {
        "lv_id": None,
        "system": system["label"] if system else None,
        "system_key": system["key"] if system else None,
        "section": section,
        "section_name": section_name,
        "page": page,
        "pdf_order": qline.idx,          # running index of the quantity line in the LV stream (printed order)
        "text_de": text_de,
        "title_de": title,
        "variant_de": variant_de,
        "quantity": float(qty) if qty is not None else None,
        "unit": unit,
        "unit_raw": qline.unit_raw,
        "kind": kind,
        "make_hint": None, "model_hint": None, "offer_ref": None,
        "attributes": {k: v for k, v in attrs.items() if v is not None},
        "source": {
            "page": page,
            "page_size": None,
            "block_bbox": _bbox_union([l.bbox for l in shared_text if l.page == page] + [qline.bbox]),
            "qty_bbox": qline.qty_bbox,
            "line_bbox": qline.bbox,
            "lines": src_lines,
        },
        "_heading": g.heading or title,
        "_lines_obj": list(shared_text) + [qline],
    }
    if component_of is not None:
        pos["_parent"] = component_of
        pos["attributes"]["component"] = True
    _fill_hints(pos, block_lines)
    if component_of is not None:
        for k in ("make_hint", "offer_ref"):
            if not pos.get(k):
                pos[k] = component_of.get(k)
    return pos


def _refresh_variant_roles(g: _Group):
    """All quantity lines of a group are listed in each position: own = qty, siblings = other_qty."""
    for p in g.positions:
        own = p["source"]["qty_bbox"]
        lines = [x for x in p["source"]["lines"] if x["role"] == "desc"]
        trailing = [x for x in p["source"]["lines"] if x["role"] == "trail"]
        for ql in g.qty_lines:
            role = "qty" if ql.qty_bbox == own and ql.bbox == p["source"]["line_bbox"] else "other_qty"
            lines.append(_src_line(ql, role))
        p["source"]["lines"] = lines + trailing
        p["source"]["block_bbox"] = _bbox_union(
            [p["source"]["block_bbox"]] + [ql.bbox for ql in g.qty_lines if ql.page == p["page"]])


def _subtotal(lines: list[Line], system: dict | None, section, section_name) -> dict:
    ln = lines[0]
    text = _collapse(" ".join(l.text for l in lines))
    return {
        "lv_id": None,
        "system": system["label"] if system else None,
        "system_key": system["key"] if system else None,
        "section": section, "section_name": section_name,
        "page": ln.page,
        "pdf_order": ln.idx,
        "text_de": "\n".join(l.text for l in lines),
        "title_de": text,
        "variant_de": None,
        "quantity": None, "unit": None, "unit_raw": None,
        "kind": "subtotal",
        "make_hint": None, "model_hint": None, "offer_ref": None,
        "attributes": {},
        "source": {"page": ln.page, "page_size": None,
                   "block_bbox": _bbox_union([l.bbox for l in lines if l.page == ln.page]),
                   "qty_bbox": None, "line_bbox": ln.bbox,
                   "lines": [_src_line(l, "desc") for l in lines]},
    }
