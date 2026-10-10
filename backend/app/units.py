"""Unit and number helpers for Swiss tender (LV) text."""
from __future__ import annotations

import re

# Raw unit token (as printed in the Mass-Gattg. column) -> normalized unit.
_UNIT_MAP = {
    "stk": "pc", "stk.": "pc", "st": "pc", "st.": "pc", "stück": "pc", "stck": "pc", "stck.": "pc",
    "pce": "pc", "pc": "pc", "pcs": "pc", "nr": "pc", "nr.": "pc",
    "m": "m", "m1": "m", "lfm": "m", "lfm.": "m", "lm": "m", "m'": "m",
    "m2": "m2", "m²": "m2", "qm": "m2",
    "m3": "m3", "m³": "m3",
    "kg": "kg", "t": "t",
    "h": "h", "std": "h", "std.": "h", "stunden": "h", "h.": "h",
    "psch": "LS", "psch.": "LS", "pauschal": "LS", "gl": "LS", "gl.": "LS", "ls": "LS", "pau": "LS",
    "anlage": "system", "anl.": "system", "anl": "system",
    "tag": "day", "tage": "day",
}

UNIT_TOKENS = frozenset(_UNIT_MAP)


def normalize_unit(raw: str | None) -> str | None:
    """'Stk.' -> 'pc', 'm²' -> 'm2', 'psch' -> 'LS', 'Std.' -> 'h'. Unknown -> None."""
    if not raw:
        return None
    return _UNIT_MAP.get(raw.strip().lower())


def is_unit_token(tok: str) -> bool:
    return tok.strip().lower() in UNIT_TOKENS


_NUM_RE = re.compile(r"^\d{1,3}(?:['’`´]\d{3})+(?:[.,]\d+)?$|^\d+(?:[.,]\d+)?$")


def is_number_token(tok: str) -> bool:
    return bool(_NUM_RE.match(tok.strip()))


def parse_number(tok: str | None) -> float | None:
    """Swiss formats: 1'200 -> 1200, 12.5 -> 12.5, 12,5 -> 12.5, 2`900 -> 2900."""
    if tok is None:
        return None
    s = tok.strip()
    if not _NUM_RE.match(s):
        return None
    s = re.sub(r"['’`´]", "", s).replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def to_mm(value: float, unit: str | None) -> float:
    """Convert a length to mm. unit in {'mm','cm','m', None}; None -> as-is."""
    u = (unit or "").lower()
    if u == "cm":
        return value * 10.0
    if u == "m":
        return value * 1000.0
    return value


def clean_int(v: float | None):
    """12.0 -> 12, 12.5 -> 12.5 (nicer JSON)."""
    if v is None:
        return None
    return int(v) if float(v).is_integer() else round(v, 2)
