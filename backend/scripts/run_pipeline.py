"""Run the tender pipeline synchronously and print a summary.

Usage: cd backend && uv run python scripts/run_pipeline.py [path/to/tender.pdf] [--keep]
Without a path the Oberglatt demo PDF is used. The tender is created in data/tenders/
(kept with --keep, else deleted at the end).
"""
from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, pipeline, store  # noqa: E402


def chf(n, dp=0):
    return "" if n is None else f"{float(n):,.{dp}f}".replace(",", "'")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", nargs="?", default=str(config.DEMO_PDF))
    ap.add_argument("--keep", action="store_true", help="keep the tender in data/tenders")
    args = ap.parse_args()
    pdf = Path(args.pdf)
    t = store.create(pdf.read_bytes(), pdf.name, {})
    tid = t["id"]
    print(f"tender {tid}: {pdf.name}")
    t0 = time.monotonic()
    timings = pipeline.run(tid)
    wall = time.monotonic() - t0
    t = store.load(tid)
    try:
        print(f"status {t['status']} · {t.get('page_count')} pages · {len(t['positions'])} positions · "
              f"{len(t['systems'])} systems · {len(t['instructions'])} instructions · "
              f"{len(t.get('quote_requests') or [])} quote groups")
        print("timings (s):", ", ".join(f"{k} {v}" for k, v in timings.items()), f"| wall {wall:.1f}")
        llm = pipeline.mod("llm")
        if llm:
            print("llm:", llm.stats(), "| available:", llm.available(), llm.unavailable_reason() or "")
        for w in t.get("warnings") or []:
            print(f"WARNING [{w['stage']}]: {w['message'][:300]}")
        print("meta:", {k: t.get(k) for k in ("name", "client", "trade", "due_at")})
        if t["status"] == "error":
            return 1
        v = pipeline.view(t)
        tot = v["totals"]
        print("\ncounts by status:")
        for st, n in Counter(p["status"] for p in v["positions"]).most_common():
            print(f"  {st:26s} {n}")
        print(f"  needs review               {sum(p['needs_review'] for p in v['positions'])}")
        labels = Counter((p.get("match") or {}).get("label") for p in v["positions"])
        print("match labels:", dict(labels))
        print(f"\nmaterial {chf(tot['material'], 2)} · labour {chf(tot['labour'], 2)} · direct {chf(tot['direct'], 2)}")
        print(f"cost {chf(tot['cost'], 2)} · standard price {chf(tot['standard_price'])} "
              f"({tot.get('standard_margin_pct')}%) · budget share {tot.get('budget_share', 0) * 100:.0f}%")
        print("scenarios:")
        for s in tot["scenarios"]:
            print(f"  {s['name']:13s} {s['margin_pct']:4.1f}%  bid {chf(s['bid']):>10s}  win {s['win']:.2f}  "
                  f"expected {chf(s['expected'], 2)}{'  <- best' if s['best'] else ''}")
        print("by system:")
        for s in tot["by_system"]:
            print(f"  {s['system'][:45]:45s} {s['lines']:4d} lines  direct {chf(s['direct'], 2):>14s}  "
                  f"to review {s['to_review']}")
        print("\ntop review items (money at risk):")
        rev = sorted((p for p in v["positions"] if p["needs_review"]),
                     key=lambda p: -((p.get("pricing") or {}).get("direct") or 0))
        for p in rev[:12]:
            pr = p.get("pricing") or {}
            print(f"  {p['lv_id']} p.{p.get('page'):>3}  {chf(pr.get('direct'), 2):>12s}  {p['status']:24s} "
                  f"{(p.get('title_en') or p.get('title_de') or '')[:60]}")
        return 0
    finally:
        if not args.keep:
            store.delete(tid)


if __name__ == "__main__":
    sys.exit(main())
