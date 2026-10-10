"""Evaluate the tender parser: recall vs the 22 verified examples + summary statistics.

Run: cd backend && uv run python scripts/eval_parser.py [--pdf PATH] [--seed N] [--dump out.json]
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import random
import re
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.config import DEMO_PDF, STARTER_DIR  # noqa: E402
from app.parser import parse_tender  # noqa: E402

EXAMPLES = STARTER_DIR / "example_lv_positions.csv"


def _example_sizes(desc: str):
    """Sizes mentioned in the English example description: DN100 -> 100, 400x300x1250 -> [400,300,1250]."""
    dn = [int(x) for x in re.findall(r"DN\s?(\d+)", desc)]
    dims = [[int(v) for v in m if v] for m in re.findall(r"(\d+)x(\d+)(?:x(\d+))?", desc)]
    thick = [int(x) for x in re.findall(r"(\d+)\s?mm", desc)]
    return dn, dims, thick


def size_ok(pos: dict, desc: str) -> bool:
    """Plausible size: when the example names a DN / dimensions, the position must carry it."""
    dn, dims, thick = _example_sizes(desc)
    a = pos.get("attributes") or {}
    if dn:
        return a.get("dn_mm") in dn
    if dims:
        pd = a.get("dims_mm") or []
        return any(pd[:len(d)] == d or sorted(pd) == sorted(d) for d in dims)
    if thick and "insulation" in desc.lower():
        return a.get("thickness_mm") in thick
    return True


def match_examples(positions: list[dict]):
    rows = list(csv.DictReader(open(EXAMPLES, encoding="utf-8")))
    results = []
    for r in rows:
        page, qty, unit = int(r["source_page"]), float(r["quantity"]), r["unit"]
        cands = [p for p in positions if p["page"] == page and p["quantity"] == qty and p["unit"] == unit]
        sized = [p for p in cands if size_ok(p, r["description"])]
        hit = sized[0] if sized else None
        results.append((r, hit, cands))
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", default=str(DEMO_PDF))
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--dump", default=None, help="write the parse result (without pages_text) as JSON")
    ap.add_argument("--samples", type=int, default=15)
    args = ap.parse_args()

    t0 = time.perf_counter()
    res = parse_tender(args.pdf)
    dt = time.perf_counter() - t0
    pos = res["positions"]

    print(f"Parsed {res['page_count']} pages in {dt:.2f} s")
    print(f"Conditions pages: {res['conditions_pages'][0]}-{res['conditions_pages'][-1]}" if res["conditions_pages"] else "Conditions pages: none")
    print(f"Engineer list pages (skipped): {res['engineer_list_pages']}")
    print(f"Appendix pages: {res['appendix_pages']}")
    print(f"Lots: {res['lots']}")
    print("\nSystems:")
    for s in res["systems"]:
        print(f"  {s['label']:40s} key={s['key']:7s} pages {s['pages'][0]}-{s['pages'][1]}  lot={s['lot']}  profile={s['profile']}")

    # ---- recall vs the 22 examples ----
    results = match_examples(pos)
    hits = sum(1 for _, h, _ in results if h)
    print(f"\nRecall vs examples: {hits}/{len(results)}")
    print(f"  {'example':8s} {'page':>4s} {'qty':>6s} {'unit':4s}  {'parsed':8s}  title_de")
    for r, h, cands in results:
        if h:
            print(f"  {r['lv_id']:8s} {r['source_page']:>4s} {r['quantity']:>6s} {r['unit']:4s}  {h['lv_id']:8s}  {h['title_de']}")
    misses = [(r, c) for r, h, c in results if not h]
    if misses:
        print("\nMISSES:")
        for r, cands in misses:
            print(f"  {r['lv_id']} p{r['source_page']} {r['quantity']} {r['unit']} {r['description']}")
            for c in cands:
                print(f"      candidate {c['lv_id']} {c['title_de']} attrs={c['attributes']}")
            same_page = [p for p in pos if p["page"] == int(r["source_page"])]
            for c in same_page:
                print(f"      on page: {c['lv_id']} {c['quantity']} {c['unit']} {c['title_de']}")

    # ---- stats ----
    print(f"\nTotal positions: {len(pos)}  (text blocks kept aside: {len(res['text_blocks'])})")
    by_kind = collections.Counter(p["kind"] for p in pos)
    print("By kind:", dict(by_kind))
    by_unit = collections.Counter(p["unit"] for p in pos if p["kind"] != "subtotal")
    print("By unit:", dict(by_unit))
    nullq = [p for p in pos if p["kind"] in ("item", "lump_sum") and p["quantity"] is None]
    print(f"Items with null quantity: {len(nullq)}")
    for p in nullq:
        print(f"    {p['lv_id']} p{p['page']} {p['unit_raw']} {p['title_de']}")
    print("By system (items+lump sums / subtotals):")
    for s in res["systems"]:
        items = [p for p in pos if p["system_key"] == s["key"] and p["kind"] != "subtotal"]
        subs = [p for p in pos if p["system_key"] == s["key"] and p["kind"] == "subtotal"]
        secs = collections.Counter(p["section"] for p in items)
        print(f"  {s['label']:40s} {len(items):4d} / {len(subs):2d}   sections {dict(secs)}")
    offers = [p for p in pos if p.get("offer_ref")]
    print(f"With offer_ref: {len(offers)}; with make_hint: {sum(1 for p in pos if p.get('make_hint'))}; "
          f"with dn_mm: {sum(1 for p in pos if p['attributes'].get('dn_mm'))}; "
          f"with dims_mm: {sum(1 for p in pos if p['attributes'].get('dims_mm'))}")

    print(f"\nSample of {args.samples} random positions (seed {args.seed}):")
    rnd = random.Random(args.seed)
    items = [p for p in pos if p["kind"] != "subtotal"]
    for p in sorted(rnd.sample(items, min(args.samples, len(items))), key=lambda p: p["lv_id"]):
        q = "-" if p["quantity"] is None else f"{p['quantity']:g}"
        print(f"  {p['lv_id']} p{p['page']:<3d} {p['system_key']:6s} {p['section'] or '-'} {q:>6s} {p['unit'] or '-':4s} {p['title_de']}")

    if args.dump:
        out = {k: v for k, v in res.items() if k != "pages_text"}
        Path(args.dump).write_text(json.dumps(out, ensure_ascii=False, indent=1))
        print(f"\nWrote {args.dump}")
    return 0 if hits == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
