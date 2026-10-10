"""Evaluate the matcher on the 22 verified example positions.

Positions are rebuilt honestly from the tender PDF: for every CSV row we read the page with
PyMuPDF, split it into blocks at quantity rows (unit + number in the unit column) and take the
German block whose quantity row has the CSV's quantity and unit. The matcher only sees the
German block text, the own quantity row and quantity/unit (no English CSV description).

    cd backend && uv run python scripts/eval_matcher.py [--rules-only] [--verbose]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

import pymupdf  # noqa: E402

from app import config, llm, matcher  # noqa: E402

EXAMPLES = config.STARTER_DIR / "example_lv_positions.csv"
UNIT_TOKENS = {"stk", "stk.", "st.", "m", "m2", "m²", "lm", "kg", "h", "ls", "psch", "psch.", "tage"}


def page_rows(doc, pno: int) -> tuple[list[dict], float]:
    """Rows of words (y-grouped) for 1-based page pno, with layout-ish text and x positions."""
    page = doc[pno - 1]
    words = page.get_text("words")
    words.sort(key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    rows: list[list] = []
    for w in words:
        yc = (w[1] + w[3]) / 2
        if rows and abs(rows[-1][0] - yc) <= 3.0:
            rows[-1][1].append(w)
        else:
            rows.append([yc, [w]])
    out = []
    for yc, ws in rows:
        ws.sort(key=lambda w: w[0])
        out.append({"y": yc, "x0": ws[0][0], "words": [(w[0], w[4]) for w in ws],
                    "text": " ".join(w[4] for w in ws), "bbox": [min(w[0] for w in ws), min(w[1] for w in ws),
                                                                 max(w[2] for w in ws), max(w[3] for w in ws)]})
    return out, page.rect.width


def _qty_of(row: dict, width: float):
    """(unit_raw, qty|None, desc_text) if the row ends with a unit (+ number) in the right-hand columns."""
    ws = [(x, t) for x, t in row["words"] if not re.fullmatch(r"[.…]+", t)]
    if not ws:
        return None
    if len(ws) >= 2 and ws[-2][1].lower() in UNIT_TOKENS and ws[-2][0] > 0.6 * width and re.fullmatch(r"[\d'’.,]+", ws[-1][1]):
        desc = " ".join(t for x, t in ws[:-2])
        return ws[-2][1], float(ws[-1][1].replace("'", "").replace(",", ".")), desc
    if ws[-1][1].lower() in UNIT_TOKENS and ws[-1][0] > 0.6 * width:
        return ws[-1][1], None, " ".join(t for x, t in ws[:-1])
    return None


def page_positions(doc, pno: int) -> list[dict]:
    rows, width = page_rows(doc, pno)
    # drop page header (up to the column header row ending with 'Fr.') and footer path
    start = 0
    for i, r in enumerate(rows[:8]):
        if "Gegenstand" in r["text"]:
            start = i + 1
            if i + 1 < len(rows) and re.search(r"\bPreis\b|\bFr\b", rows[i + 1]["text"]):
                start = i + 2
    rows = [r for r in rows[start:] if not r["text"].startswith("H:\\")]
    blocks: list[dict] = []
    cur: list[dict] = []
    last_block = None
    for r in rows:
        if re.fullmatch(r"[A-Z]\s+[A-ZÄÖÜ ,]+", r["text"]) and r["x0"] < 70:  # section heading "C ARMATUREN ..."
            cur = []
            last_block = None
            continue
        q = _qty_of(r, width)
        if q:
            if any(c["text"].strip() for c in cur) or last_block is None:
                last_block = {"head": cur, "qty_rows": []}
                blocks.append(last_block)
            last_block["qty_rows"].append((r, q))
            cur = []
        else:
            cur.append(r)
    positions = []
    for b in blocks:
        multi = len(b["qty_rows"]) > 1
        for r, (unit_raw, qty, desc) in b["qty_rows"]:
            lines = [{"text": h["text"], "bbox": h["bbox"], "role": "desc"} for h in b["head"]]
            for r2, _ in b["qty_rows"]:
                lines.append({"text": r2["text"], "bbox": r2["bbox"], "role": "qty" if r2 is r else "other_qty"})
            text_de = "\n".join(l["text"] for l in lines)
            make = model = None
            for l in b["head"]:
                m = re.match(r"^(Fabrikat|Typ)\s+(?:z\.\s?B\.?\s*)?(.+)$", l["text"])
                if m and not re.fullmatch(r"[.…]+", m.group(2).strip()):
                    if m.group(1) == "Fabrikat" and not make:
                        make = m.group(2).strip()
                    elif m.group(1) == "Typ" and not model:
                        model = m.group(2).strip()
            positions.append({
                "page": pno, "text_de": text_de,
                "title_de": b["head"][0]["text"] if b["head"] else desc,
                "variant_de": desc if multi else None,
                "quantity": qty, "unit_raw": unit_raw, "unit": matcher.canon_unit(unit_raw),
                "kind": "item", "make_hint": make, "model_hint": model,
                "source": {"page": pno, "lines": lines},
            })
    return positions


def _squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def build_example_positions(csv_path: Path = EXAMPLES, pdf_path: Path = config.DEMO_PDF) -> tuple[list[dict], list[dict]]:
    """Returns (positions, ground_truth_rows)."""
    doc = pymupdf.open(pdf_path)
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    cache: dict[int, list[dict]] = {}
    used: set[tuple[int, int]] = set()
    positions = []
    for row in rows:
        pno = int(row["source_page"])
        cands = cache.setdefault(pno, page_positions(doc, pno))
        qty = float(row["quantity"])
        unit = row["unit"]
        hits = [(i, p) for i, p in enumerate(cands) if p["quantity"] == qty and p["unit"] == unit and (pno, i) not in used]
        if len(hits) > 1 and row.get("model_hint"):
            keys = [_squash(k) for k in re.split(r"[/ ]+", row["model_hint"]) if len(_squash(k)) >= 3]
            narrowed = [(i, p) for i, p in hits if any(k in _squash(p["text_de"]) for k in keys)]
            hits = narrowed or hits
        if not hits:
            raise RuntimeError(f"{row['lv_id']}: no block with {qty} {unit} on p. {pno}")
        i, p = hits[0]
        used.add((pno, i))
        positions.append({"lv_id": row["lv_id"], "system": row["system"], **p})
    return positions, rows


def evaluate(use_llm: bool | None, verbose: bool = False) -> dict:
    positions, truth = build_example_positions()
    t0 = time.time()
    matches = matcher.match_positions(positions, use_llm=use_llm)
    dt = time.time() - t0
    ok_pid = ok_code = 0
    misses = []
    for p, gt in zip(positions, truth):
        m = matches[p["lv_id"]]
        good_pid = m["product_id"] == gt["suggested_product_id"]
        good_code = m["install_code"] == gt["expected_install_code"]
        ok_pid += good_pid
        ok_code += good_code
        line = (f"{p['lv_id']} p.{p['page']:>3} {m['label']:<6} {str(m['product_id']):<11} "
                f"(truth {gt['suggested_product_id']:<9}) conf {m['confidence']:.2f} [{m['method']}] {m['reason']}")
        if not good_pid or not good_code:
            misses.append({"lv_id": p["lv_id"], "got": m["product_id"], "truth": gt["suggested_product_id"],
                           "reason": m["reason"], "type": m["attributes"].get("type"),
                           "size": matcher.size_label(m["attributes"]), "top": m["candidates"][:3]})
        if verbose or not good_pid:
            print(("   " if good_pid else "XX ") + line)
            if verbose and m.get("assumptions"):
                print("      assumptions:", m["assumptions"])
    return {"n": len(positions), "product_id": ok_pid, "install_code": ok_code, "seconds": round(dt, 2), "misses": misses}


def evaluate_parser(use_llm: bool | None, verbose: bool = False) -> dict:
    """Run on app.parser output for the whole tender; score the 22 examples found in it."""
    from app import parser

    parsed = parser.parse_tender(config.DEMO_PDF)
    items = [p for p in parsed["positions"] if p.get("kind", "item") not in matcher.SKIP_KINDS]
    rows = list(csv.DictReader(open(EXAMPLES, encoding="utf-8")))
    t0 = time.time()
    matches = matcher.match_positions(parsed["positions"], use_llm=use_llm)
    dt = time.time() - t0
    used, ok_pid, ok_code, misses = set(), 0, 0, []
    for row in rows:
        hits = [p for p in items if p["page"] == int(row["source_page"]) and p.get("quantity") == float(row["quantity"])
                and p.get("unit") == row["unit"] and p["lv_id"] not in used]
        if len(hits) > 1 and row.get("model_hint"):
            keys = [_squash(k) for k in re.split(r"[/ ]+", row["model_hint"]) if len(_squash(k)) >= 3]
            hits = [p for p in hits if any(k in _squash(p.get("text_de", "") + (p.get("model_hint") or "")) for k in keys)] or hits
        if not hits:
            misses.append({"example": row["lv_id"], "problem": "not found in parser output"})
            continue
        p = hits[0]
        used.add(p["lv_id"])
        m = matches[p["lv_id"]]
        g1, g2 = m["product_id"] == row["suggested_product_id"], m["install_code"] == row["expected_install_code"]
        ok_pid += g1
        ok_code += g2
        if not g1 or verbose:
            print(("   " if g1 else "XX ") + f"{row['lv_id']}={p['lv_id']} p.{p['page']} {m['label']:<6} {m['product_id']} "
                  f"(truth {row['suggested_product_id']}) {m['reason']}")
        if not g1:
            misses.append({"example": row["lv_id"], "lv_id": p["lv_id"], "got": m["product_id"], "reason": m["reason"]})
    labels: dict[str, int] = {}
    for m in matches.values():
        labels[m["label"]] = labels.get(m["label"], 0) + 1
    return {"n": len(rows), "product_id": ok_pid, "install_code": ok_code, "seconds": round(dt, 2), "misses": misses,
            "items": len(items), "labels": labels, "matches": matches, "positions": parsed["positions"]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rules-only", action="store_true")
    ap.add_argument("--verbose", "-v", action="store_true")
    ap.add_argument("--parser", action="store_true", help="also evaluate on app.parser output for the full tender")
    a = ap.parse_args()
    if a.parser:
        r = evaluate_parser(use_llm=False if a.rules_only else None, verbose=a.verbose)
        print(f"parser positions, {'rules-only' if a.rules_only else 'LLM/cache'}: product_id {r['product_id']}/{r['n']}, "
              f"install_code {r['install_code']}/{r['n']}; full tender {r['items']} items matched in {r['seconds']} s; labels {r['labels']}")
        for m in r["misses"]:
            print("  miss:", json.dumps(m, ensure_ascii=False))
    print("== rules only")
    r = evaluate(use_llm=False, verbose=a.verbose)
    print(f"rules-only: product_id {r['product_id']}/{r['n']}, install_code {r['install_code']}/{r['n']} ({r['seconds']} s)")
    if not a.rules_only:
        print(f"\n== LLM ({config.LLM_MODEL}); live calls {'possible' if llm.available() else 'NOT possible: ' + str(llm.unavailable_reason())}")
        r2 = evaluate(use_llm=None, verbose=a.verbose)
        methods = {}
        print(f"LLM: product_id {r2['product_id']}/{r2['n']}, install_code {r2['install_code']}/{r2['n']} ({r2['seconds']} s)")
        if llm.unavailable_reason():
            print("(LLM unavailable: %s -> rules fallback used where the cache had no answer)" % llm.unavailable_reason())
        print("llm stats:", json.dumps(llm.stats()))
        for m in r2["misses"]:
            print("  miss:", json.dumps(m, ensure_ascii=False))


if __name__ == "__main__":
    main()
