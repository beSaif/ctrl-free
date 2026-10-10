"""FastAPI routes (docs/SPEC.md "API"). Run: cd backend && uv run uvicorn app.main:app --reload --port 8000"""
from __future__ import annotations

import copy
import io
import logging
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from . import assist, config, pipeline, store
from .models import (AssistCommand, InstructionPatch, Outcome, PositionPatch, PricingUpdate, QuoteApply,
                     TenderPatch)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("ctrlfree.api")

app = FastAPI(title="ctrl-free API", version="4.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

mod = pipeline.mod

CALL_LABELS = {
    "competition": [("Light", 0.05), ("Normal", 0.0), ("Strong", -0.05), ("Very strong", -0.10)],
    "appetite": [("Not a priority", -0.05), ("Neutral", 0.0), ("We want it", 0.05), ("Must win", 0.10)],
    "sensitivity": [("Low", 0.03), ("Normal", 0.05), ("High", 0.08)],
}
REVIEW_FILTERS = ("review", "all", "flagged", "confirmed", *pipeline.STATUSES)


@app.exception_handler(store.NotFound)
async def _not_found(_req, exc):
    return JSONResponse({"detail": f"Not found: {exc.args[0] if exc.args else ''}"}, status_code=404)


@app.exception_handler(ValueError)
async def _bad_value(_req, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ================================================================== helpers


def swiss(n: float | None, dp: int = 0) -> str:
    if n is None:
        return ""
    return f"{float(n):,.{dp}f}".replace(",", "'")


def _tender(tid: str) -> dict:
    if not store.exists(tid):
        raise HTTPException(404, f"Tender {tid} not found")
    return store.load(tid)


def _ready(t: dict) -> bool:
    return t.get("status") in ("ready", "submitted", "awarded") and bool(t.get("positions") is not None)


def _days_left(due_at: str | None) -> int | None:
    if not due_at:
        return None
    try:
        due = datetime.fromisoformat(due_at)
    except ValueError:
        return None
    return math.ceil((due - datetime.now()).total_seconds() / 86400)


def call_label(key: str, value: float | None) -> str | None:
    if value is None:
        return None
    best = min(CALL_LABELS[key], key=lambda lv: abs(lv[1] - value))
    return best[0] if abs(best[1] - value) < 1e-6 else f"{value:+.2f}"


def _catalog_row(pid: str | None) -> dict | None:
    return pipeline.catalog().get(pid) if pid else None


def _product_brief(pid: str | None) -> dict | None:
    row = _catalog_row(pid)
    if not row:
        return {"product_id": pid, "description": None} if pid else None
    return {k: row.get(k) for k in ("product_id", "category", "subcategory", "manufacturer", "model", "description",
                                    "unit", "net_cost_chf", "install_code", "source_type", "supplier_quote_required")}


def _group_of(p: dict) -> tuple[str, str, str | None, str | None]:
    """(key, title, category, subcategory) by product type: catalogue row, else the English type, else Other."""
    pid = (p.get("pricing") or {}).get("product_id") or pipeline.effective_product(p)
    row = _catalog_row(pid)
    if row:
        cat, sub = row.get("category") or "Other", row.get("subcategory") or None
        title = f"{cat} · {sub}" if sub else cat
        return f"cat:{cat}/{sub or ''}", title, cat, sub
    typ = ((p.get("attributes") or {}).get("type") or "").strip()
    if typ:
        return f"type:{typ.lower()}", typ[:1].upper() + typ[1:], None, None
    return "other", "Other", None, None


def _first_line_de(p: dict) -> str:
    text = (p.get("text_de") or p.get("title_de") or "").strip()
    first = text.split("\n", 1)[0].strip()
    return re.sub(r"\s+", " ", first)[:80]


def _list_position(p: dict) -> dict:
    """Position for tables: no per-line source text lines and no candidate list (detail has them)."""
    out = {k: v for k, v in p.items() if k not in ("source",)}
    src = p.get("source") or {}
    out["source"] = {k: v for k, v in src.items() if k != "lines"}
    m = p.get("match")
    if m:
        out["match"] = {k: v for k, v in m.items() if k != "candidates"}
    pid = (p.get("pricing") or {}).get("product_id") or pipeline.effective_product(p)
    out["product"] = _product_brief(pid)
    key, title, _, _ = _group_of(p)
    out["group"] = key
    out["group_title"] = title
    return out


def _direct(p: dict) -> float:
    return float((p.get("pricing") or {}).get("direct") or 0.0)


def _lines_count(v: dict) -> int:
    return sum(1 for p in v["positions"] if p["status"] != "non_priceable")


def _open_instructions(t: dict) -> list[dict]:
    return [i for i in t.get("instructions") or [] if i.get("state", "open") == "open"]


def summary(t: dict) -> dict:
    keys = ("id", "name", "client", "trade", "file_name", "page_count", "file_size", "due_at", "status", "progress",
            "created_at", "updated_at", "updated_by", "profile", "meta_sources", "submission_rule", "award_criteria",
            "warnings", "timings", "user_fields")
    out = {k: t.get(k) for k in keys}
    _add_plain_summaries(out)
    out["days_left"] = _days_left(t.get("due_at"))
    out["open_work"] = None
    out["offer_price"] = None
    out["standard_price"] = None
    out["offer_price_final"] = False
    if not _ready(t):
        return out
    v = pipeline.view(t)
    totals, settings = v["totals"], v["settings"]
    to_review = sum(1 for p in v["positions"] if p["needs_review"])
    chosen = settings.get("chosen")
    out["open_work"] = {
        "lines_to_review": to_review,
        "lines_total": _lines_count(v),
        "instructions_to_confirm": len(_open_instructions(t)),
        "instructions_total": len(t.get("instructions") or []),
        "price_chosen": bool(chosen),
        "chosen": chosen,
    }
    out["standard_price"] = totals.get("standard_price")
    out["direct"] = totals.get("direct")
    out["cost"] = totals.get("cost")
    if t.get("submission"):
        out["offer_price"] = t["submission"].get("offer_price")
        out["offer_price_final"] = True
    elif totals.get("offer_price") is not None:
        out["offer_price"] = totals["offer_price"]
        out["offer_price_final"] = True
    else:
        out["offer_price"] = totals.get("standard_price")
    out["outcome"] = t.get("outcome")
    out["submission"] = t.get("submission")
    return out


def _n(n: int, one: str, many: str) -> str:
    return (one if n == 1 else many).format(n=n)


def review_breakdown(review: list[dict], direct: float) -> list[str]:
    """Plain sentences for the lines that need the estimator, one per kind of open work."""
    budget = [p for p in review if (p.get("pricing") or {}).get("unit_price_source") == "supplier_package"
              and not _has_quote(p)]
    ids = {p["lv_id"] for p in budget}
    rest = [p for p in review if p["lv_id"] not in ids]
    no_cat = [p for p in rest if p["status"] == "supplier_quote_required" and not p.get("pricing")]
    no_qty = [p for p in rest if p["status"] == "insufficient_information"]
    guess = [p for p in rest if p["status"] == "assumption_applied"]
    check = [p for p in rest if p["status"] == "review_required"]
    counted = len(no_cat) + len(no_qty) + len(guess) + len(check)
    other = len(rest) - counted
    out = []
    if budget:
        b = sum(_direct(p) for p in budget)
        share = round(b / direct * 100) if direct else 0
        out.append(_n(len(budget), "1 runs on a budget price", "{n} run on budget prices")
                   + f": CHF {swiss(b, 0)} of direct cost ({share}%).")
    if no_cat:
        out.append(_n(len(no_cat), "1 is not in the catalogue and needs a supplier price.",
                      "{n} are not in the catalogue and need a supplier price."))
    if no_qty:
        out.append(_n(len(no_qty), "1 has no quantity in the tender.", "{n} have no quantity in the tender."))
    if guess:
        out.append(_n(len(guess), "1 is priced with an assumption: check it.",
                      "{n} are priced with an assumption: check them."))
    if check:
        out.append(_n(len(check), "1 needs a product checked.", "{n} need a product checked."))
    if other > 0:
        out.append(_n(other, "1 more is flagged or has a quote to confirm.",
                      "{n} more are flagged or have a quote to confirm."))
    return out


def _has_quote(p: dict) -> bool:
    return bool((p.get("supplier_quote") or {}).get("unit_price") is not None
                or (p.get("overrides") or {}).get("unit_price") is not None)


def _add_plain_summaries(out: dict) -> None:
    """Code-built plain sentences next to the verbatim German (submission rule, price award criterion)."""
    meta = mod("meta")
    if meta is None:
        return
    try:
        rule = out.get("submission_rule")
        if rule:
            out["submission_rule"] = {**rule, "summary": meta.submission_summary(rule, out.get("due_at"), out.get("client"))}
        crits = out.get("award_criteria") or []
        if crits:
            total = sum(float(c.get("points") or 0) for c in crits) or None
            out["award_criteria"] = [
                {**c, **(meta.award_price_summary(c, total) or {})} if re.search(r"preis|price", c.get("label") or "", re.I) else c
                for c in crits]
    except Exception as e:  # a summary must never break the tender view
        log.warning("plain summaries failed: %s", e)


def overview(t: dict) -> dict:
    v = pipeline.view(t)
    totals, settings = v["totals"], v["settings"]
    lines = _lines_count(v)
    review = [p for p in v["positions"] if p["needs_review"]]
    review_direct = round(sum(_direct(p) for p in review), 2)
    direct = totals.get("direct") or 0.0
    instr = t.get("instructions") or []
    open_i = _open_instructions(t)
    open_cost = sum(1 for i in open_i if i.get("kind") == "cost")
    open_risk = sum(1 for i in open_i if i.get("kind") == "risk")
    chosen = settings.get("chosen")
    std_margin = totals.get("standard_margin_pct")
    pc_on = any((settings.get("project_costs") or {}).values())
    budget_direct = totals.get("budget_direct") or 0.0
    budget_share = totals.get("budget_share") or 0.0

    if review:
        detail = " ".join(review_breakdown(review, direct)) or "Check the product or the quantity and confirm."
    else:
        detail = "Every line that needed you is confirmed."
    s1 = {"key": "review", "title": "Review lines", "done": not review, "count": len(review), "total": lines,
          "text": f"{len(review)} of {lines} lines need you." if review else f"All {lines} lines are reviewed.",
          "detail": detail, "review_direct": review_direct,
          "review_share": round(review_direct / direct, 4) if direct else 0.0,
          "budget_direct": budget_direct, "budget_share": budget_share, "budget_lines": totals.get("budget_lines"),
          "action": "Start review", "to": "lines"}
    s2 = {"key": "instructions", "title": "Confirm instructions and norms", "done": not open_i,
          "count": len(open_i), "total": len(instr), "open_cost": open_cost, "open_risk": open_risk,
          "text": (f"{len(open_i)} of {len(instr)} not confirmed." if open_i else
                   f"All {len(instr)} handled." if instr else "No instructions found in the tender."),
          "detail": (f"{open_cost} add cost and {open_risk} are risks. Each one is quoted from the tender with its page."
                     if open_i else "Each one is quoted from the tender with its page."),
          "action": "Open", "to": "instructions"}
    pc_all = totals.get("project_costs_all")
    if chosen:
        offer = totals.get("offer") or {}
        p_text = f"{chosen} · CHF {swiss(offer.get('bid'))} at {offer.get('margin_pct', 0):.1f}% margin."
    else:
        p_text = "Not chosen yet."
    p_detail = ((f"Project costs are in the price (CHF {swiss(totals.get('project_costs'))}). " if pc_on else
                 f"Project costs are not in the price (CHF {swiss(pc_all)} if all are switched on). ")
                + (f"At the standard {std_margin:.1f}% margin the price would be CHF {swiss(totals.get('standard_price'))}."
                   if std_margin is not None else ""))
    s3 = {"key": "price", "title": "Choose the offer price", "done": bool(chosen), "chosen": chosen,
          "offer_price": totals.get("offer_price"), "standard_price": totals.get("standard_price"),
          "standard_margin_pct": std_margin, "project_costs_on": pc_on, "project_costs_all": pc_all,
          "text": p_text, "detail": p_detail, "action": "Open", "to": "pricing"}
    exported = t.get("exported") or {}
    s4 = {"key": "export", "title": "Export and submit", "done": bool(t.get("submission")),
          "exported": exported, "submitted_at": (t.get("submission") or {}).get("at"),
          "text": "Submitted." if t.get("submission") else "",
          "detail": "Offer workbook, SIA interface file and pricing report. Open points above do not block the export.",
          "action": "Open", "to": "export"}
    s5 = {"key": "outcome", "title": "After the award: record the outcome", "done": bool(t.get("outcome")),
          "text": "",
          "detail": "Winning price and number of bidders from the award notice, so the next tender starts from real numbers.",
          "action": "Open", "to": "outcome"}
    steps = [s1, s2, s3, s4, s5]
    left = sum(1 for s in steps[:3] if not s["done"])
    nxt = next((s for s in steps if not s["done"]), None)
    ref = mod("reference")
    facts = {
        "client": t.get("client"), "trade": t.get("trade"), "file_name": t.get("file_name"),
        "page_count": t.get("page_count"), "profile": t.get("profile"),
        "systems": len(t.get("systems") or []),
        "catalog_products": len(pipeline.catalog()), "install_rules": len(pipeline.rules()),
        "reference_source": (ref.reference_bundle()["source"] if ref else None),
        "submission_rule": t.get("submission_rule"), "award_criteria": t.get("award_criteria"),
        "meta_sources": t.get("meta_sources"),
    }
    price_so_far = {"direct": totals.get("direct"), "lines": totals.get("lines_priced"), "cost": totals.get("cost"),
                    "standard_price": totals.get("standard_price"), "standard_margin_pct": std_margin,
                    "offer_price": totals.get("offer_price"), "chosen": chosen}
    return {"steps": steps, "steps_left": left,
            "headline": (f"{left} step{'s' if left != 1 else ''} left before you can submit" if left
                         else "Ready to submit"),
            "next": ({"key": nxt["key"], "to": nxt["to"],
                      "label": (f"Continue: review {len(review)} lines" if nxt["key"] == "review" else
                                f"Continue: confirm {len(open_i)} instructions" if nxt["key"] == "instructions" else
                                "Continue: choose the offer price" if nxt["key"] == "price" else
                                "Continue: export and submit" if nxt["key"] == "export" else
                                "Continue: record the outcome")} if nxt else None),
            "totals": totals, "facts": facts, "price_so_far": price_so_far}


def _tender_detail(t: dict) -> dict:
    out = summary(t)
    out["systems"] = t.get("systems")
    if _ready(t):
        out["overview"] = overview(t)
        out["nav"] = {
            "lines_to_review": out["open_work"]["lines_to_review"],
            "instructions_to_confirm": out["open_work"]["instructions_to_confirm"],
            "price_chosen": out["open_work"]["price_chosen"],
        }
    else:
        out["overview"] = None
    return out


# ================================================================== tenders


@app.get("/api/health")
def health():
    llm = mod("llm")
    return {"ok": True, "modules": {m: mod(m) is not None for m in
                                    ("parser", "pricing", "reference", "export", "llm", "matcher", "translate",
                                     "instructions", "meta", "quotes")},
            "llm": {"available": llm.available() if llm else False,
                    "reason": llm.unavailable_reason() if llm else "llm.py missing",
                    "stats": llm.stats() if llm else None},
            "demo_pdf": config.DEMO_PDF.exists()}


@app.get("/api/tenders")
def list_tenders(tab: str | None = None, q: str | None = None):
    out = []
    for tid in store.list_ids():
        try:
            out.append(summary(store.load(tid)))
        except Exception as e:  # a corrupt tender must not break the list
            log.warning("tender %s unreadable: %s", tid, e)
    if tab:
        want = {"calculation": ("reading", "ready", "error"), "submitted": ("submitted",), "awarded": ("awarded",)}
        out = [s for s in out if s["status"] in want.get(tab, (tab,))]
    if q:
        ql = q.lower()
        out = [s for s in out if any(ql in str(s.get(k) or "").lower() for k in ("name", "client", "trade", "file_name"))]
    out.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    return out


def _create(pdf: bytes, file_name: str, fields: dict) -> dict:
    if not pdf.startswith(b"%PDF"):
        raise HTTPException(400, "The file is not a PDF")
    t = store.create(pdf, file_name, fields)
    pipeline.start_processing(t["id"])
    return summary(store.load(t["id"]))


@app.post("/api/tenders")
async def create_tender(file: UploadFile = File(...), name: str | None = Form(None), client: str | None = Form(None),
                        trade: str | None = Form(None), due_at: str | None = Form(None),
                        profile: str | None = Form(None)):
    data = await file.read()
    return _create(data, file.filename or "tender.pdf",
                   {"name": name, "client": client, "trade": trade, "due_at": due_at, "profile": profile})


@app.post("/api/tenders/demo")
def create_demo():
    if not config.DEMO_PDF.exists():
        raise HTTPException(404, f"Demo PDF not found at {config.DEMO_PDF}")
    return _create(config.DEMO_PDF.read_bytes(), config.DEMO_PDF.name, {})


@app.get("/api/tenders/{tid}")
def get_tender(tid: str):
    return _tender_detail(_tender(tid))


@app.patch("/api/tenders/{tid}")
def patch_tender(tid: str, body: TenderPatch):
    upd = body.model_dump(exclude_unset=True)
    with store.edit(tid) as t:
        store.change(t, "You", "edit_tender", "tender", tid, upd, text="Changed tender details")
        t["user_fields"] = sorted(set(t.get("user_fields") or []) | set(upd))
    return _tender_detail(store.load(tid))


@app.delete("/api/tenders/{tid}")
def delete_tender(tid: str):
    _tender(tid)
    # the background run would write the tender back after the delete
    if pipeline.is_running(tid):
        raise HTTPException(409, "The tender is still being read. Delete it once reading has finished.")
    store.delete(tid)
    return {"ok": True}


@app.post("/api/tenders/{tid}/reprocess")
def reprocess(tid: str):
    _tender(tid)
    with store.edit(tid, by=None) as t:
        t["status"] = "reading"
        t["warnings"] = []
    pipeline.start_processing(tid)
    return summary(store.load(tid))


# ================================================================== positions


def _filter_positions(positions: list[dict], flt: str, q: str | None) -> list[dict]:
    if flt == "review":
        out = [p for p in positions if p["needs_review"]]
    elif flt == "flagged":
        out = [p for p in positions if p.get("flagged")]
    elif flt == "confirmed":
        out = [p for p in positions if p.get("confirmed")]
    elif flt in pipeline.STATUSES:
        out = [p for p in positions if p["status"] == flt]
    else:
        out = list(positions)
    if q:
        terms = q.lower().split()

        def hay(p):
            prod = _catalog_row((p.get("pricing") or {}).get("product_id")) or {}
            return " ".join(str(x or "") for x in (
                p["lv_id"], p.get("title_de"), p.get("title_en"), p.get("text_de"), p.get("system"),
                p.get("section_name"), prod.get("description"), prod.get("product_id"), f"p. {p.get('page')}")).lower()
        out = [p for p in out if all(term in hay(p) for term in terms)]
    return out


def _counts(positions: list[dict]) -> dict:
    c = {"review": 0, "all": len(positions), "flagged": 0, "confirmed": 0, **{s: 0 for s in pipeline.STATUSES}}
    for p in positions:
        c[p["status"]] = c.get(p["status"], 0) + 1
        c["review"] += bool(p["needs_review"])
        c["flagged"] += bool(p.get("flagged"))
        c["confirmed"] += bool(p.get("confirmed"))
    return c


@app.get("/api/tenders/{tid}/positions")
def list_positions(tid: str, filter: str = "all", q: str | None = None, group: str | None = None):
    t = _tender(tid)
    v = pipeline.view(t)
    flt = filter if filter in REVIEW_FILTERS else "all"
    rows = _filter_positions(v["positions"], flt, q)
    # groups by product type, in order of first appearance (review: by money at risk)
    groups: dict[str, dict] = {}
    for p in rows:
        key, title, cat, sub = _group_of(p)
        g = groups.setdefault(key, {"key": key, "title": title, "category": cat, "subcategory": sub,
                                    "count": 0, "to_review": 0, "direct": 0.0, "lv_ids": [], "_de": {}})
        g["count"] += 1
        g["to_review"] += bool(p["needs_review"])
        g["direct"] += _direct(p)
        g["lv_ids"].append(p["lv_id"])
        de = _first_line_de(p)
        if de:
            g["_de"][de] = g["_de"].get(de, 0) + 1
    for g in groups.values():
        g["title_de"] = max(g["_de"], key=g["_de"].get) if g["_de"] else g["title"]
        g["direct"] = round(g["direct"], 2)
        del g["_de"]
    if flt == "review":
        rows.sort(key=lambda p: -_direct(p))
        glist = sorted(groups.values(), key=lambda g: -g["direct"])
        for g in glist:
            g["lv_ids"].sort(key=lambda x: -_direct(v["by_lv"][x]))
    else:
        glist = list(groups.values())
    if group:
        rows = [p for p in rows if _group_of(p)[0] == group]
    totals = v["totals"]
    return {
        "filter": flt, "q": q,
        "positions": [_list_position(p) for p in rows],
        "queue": [p["lv_id"] for p in rows],
        "groups": glist,
        "counts": _counts(v["positions"]),
        "totals": _footer(totals),
    }


def _footer(totals: dict) -> dict:
    keys = ("material", "labour", "direct", "cost", "standard_price", "standard_margin_pct", "offer_price", "chosen",
            "to_review", "lines_priced", "lines_total", "budget_direct", "budget_share", "transport", "overhead",
            "project_costs")
    return {k: totals.get(k) for k in keys}


def _candidate(t: dict, pos: dict, cur: dict, pid: str, extra: dict | None = None) -> dict:
    row = _catalog_row(pid) or {"product_id": pid}
    pr = pipeline.price(t, pos, product_id=pid)
    cur_direct = _direct(cur)
    line_total = pr["direct"] if pr else None
    cur_pid = (cur.get("pricing") or {}).get("product_id") or pipeline.effective_product(cur)
    out = {**row, "product_id": pid, "unit_price": row.get("net_cost_chf"),
           "line_total": line_total, "material": pr["material"] if pr else None,
           "labour": pr["labour"] if pr else None, "hours": pr["hours"] if pr else None,
           "diff": round(line_total - cur_direct, 2) if line_total is not None else None,
           "current": pid == cur_pid,
           "matched": pid == (cur.get("match") or {}).get("product_id"),
           "unit_matches": (not pos.get("unit") or not row.get("unit") or
                            str(row.get("unit")).replace("²", "2") == str(pos.get("unit")).replace("²", "2"))}
    if extra:
        out.update({k: v for k, v in extra.items() if k in ("score", "why", "label", "tag")})
    return out


def _shortlist_ids(pos: dict, k: int = 5) -> list[tuple[str, dict]]:
    cands = (pos.get("match") or {}).get("candidates") or []
    out = [(c["product_id"], c) for c in cands if c.get("product_id")]
    if not out:
        matcher = mod("matcher")
        if matcher is not None and hasattr(matcher, "shortlist"):
            try:
                for c in matcher.shortlist(pos, list(pipeline.catalog().values()), k=k) or []:
                    if isinstance(c, dict) and c.get("product_id"):
                        out.append((c["product_id"], c))
                    elif isinstance(c, str):
                        out.append((c, {}))
            except Exception as e:
                log.warning("shortlist failed: %s", e)
    pid = pipeline.effective_product(pos)
    # drop far-off padding ("Partly the same type", an air-handling unit for a valve); "Search all" still finds them
    strong = [(x, c) for x, c in out if x == pid or not isinstance(c.get("score"), (int, float)) or c["score"] >= 0.33]
    if len(strong) >= 2:
        out = strong
    if pid and pid not in [x for x, _ in out]:
        out.insert(0, (pid, {"why": "Current product"}))
    return out[:max(k, 1) + 1]


def _search_catalog(q: str, limit: int = 20) -> list[str]:
    terms = [x for x in re.split(r"[\s,;/]+", q.lower()) if x]
    scored = []
    for pid, row in pipeline.catalog().items():
        hay = " ".join(str(row.get(k) or "") for k in ("product_id", "category", "subcategory", "manufacturer",
                                                       "model", "description", "install_code")).lower()
        score = sum(1 for term in terms if term in hay)
        if score:
            scored.append((score, pid))
    scored.sort(key=lambda s: (-s[0], s[1]))
    return [pid for _, pid in scored[:limit]]


def _quote_group_for(t: dict, lv_id: str) -> dict | None:
    for g in t.get("quote_requests") or []:
        if lv_id in (g.get("lv_ids") or []):
            return _quote_group_view(t, g)
    return None


def _quote_group_view(t: dict, g: dict) -> dict:
    v = pipeline.view(t)
    lines = []
    for x in g.get("lv_ids") or []:
        p = v["by_lv"].get(x)
        if not p:
            continue
        pr = p.get("pricing") or {}
        prod = _catalog_row(pr.get("product_id")) or {}
        lines.append({"lv_id": x, "title_de": p.get("title_de"), "title_en": p.get("title_en"), "page": p.get("page"),
                      "system": p.get("system"), "quantity": pr.get("quantity", p.get("quantity")), "unit": p.get("unit"),
                      "budget_unit_price": prod.get("net_cost_chf"), "unit_price": pr.get("net_unit_cost"),
                      "unit_price_source": pr.get("unit_price_source"),
                      "quote": p.get("supplier_quote"), "status": p["status"], "needs_review": p["needs_review"]})
    return {**g, "lines": lines, "quotes_entered": sum(1 for x in lines if x["quote"])}


def position_detail(t: dict, lv_id: str) -> dict:
    v = pipeline.view(t)
    cur = v["by_lv"].get(lv_id)
    if cur is None:
        raise HTTPException(404, f"Line {lv_id} not found")
    raw = next(p for p in t["positions"] if p["lv_id"] == lv_id)
    out = dict(cur)
    pid = (cur.get("pricing") or {}).get("product_id") or pipeline.effective_product(cur)
    out["product"] = _product_brief(pid)
    # what the line costs without the estimator's overrides ("Calculated total was ...")
    if cur.get("pricing") and any(v is not None for v in (raw.get("overrides") or {}).values()):
        base = copy.deepcopy(raw)
        base["overrides"] = {}
        calc = pipeline.price(t, base)
        if calc:
            out["pricing"] = {**cur["pricing"], "calculated": {
                k: calc.get(k) for k in ("quantity", "net_unit_cost", "hours", "material", "labour", "direct")}}
    out["install_rule"] = pipeline.rules().get((cur.get("pricing") or {}).get("install_code") or "")
    out["candidates"] = [_candidate(t, raw, cur, c_pid, extra) for c_pid, extra in _shortlist_ids(raw)]
    out["instructions"] = [i for i in t.get("instructions") or [] if lv_id in (i.get("applies_to") or [])]
    variant_rule = next((i for i in t.get("instructions") or []
                         if re.search(r"variant", f"{i.get('type')} {i.get('section')}", re.I)), None)
    make = (raw.get("make_hint") or "").lower()
    prod = _catalog_row(pid) or {}
    out["variant"] = {
        "rule": variant_rule,
        "make_hint": raw.get("make_hint"), "model_hint": raw.get("model_hint"),
        "differs": bool(make and prod and make.split()[0] not in str(prod.get("manufacturer") or "").lower()),
        "reason": raw.get("variant_reason"),
    }
    _line_extras(t, v, raw, pid, out)
    out["quote_group"] = _quote_group_for(t, lv_id)
    out["log"] = [e for e in reversed(t.get("log") or []) if e.get("lv_id") == lv_id]
    sq = cur.get("supplier_quote")
    if sq and not sq.get("log_id"):  # the entry that set the quote, so the UI can offer Undo
        # only an entry that actually set the quote (a later quantity edit must not be what "Undo" reverts)
        e = next((e for e in out["log"] if e.get("undoable", True) and not e.get("undone")
                  and e.get("action") in ("fill_quote", "edit") and "supplier_quote" in (e.get("after") or {})), None)
        if e:
            out["supplier_quote"] = {**sq, "log_id": e["id"]}
    out["assist"] = assist.line_proposals(t, lv_id)
    out["explain_steps"] = {}
    pricing = mod("pricing")
    for f in ("material", "hours", "labour", "direct"):
        try:
            out["explain_steps"][f] = pricing.explain_field(raw, cur.get("pricing"), f)
        except Exception:
            pass
    # neighbours for J/K in the review queue (money at risk first) and in document order
    queue = sorted((p for p in v["positions"] if p["needs_review"]), key=lambda p: -_direct(p))
    qids = [p["lv_id"] for p in queue]
    doc = [p["lv_id"] for p in v["positions"]]
    out["nav"] = {
        "review": _nav(qids, lv_id),
        "all": _nav(doc, lv_id),
    }
    out["totals"] = _footer(v["totals"])
    return out


def _parent_of(t: dict, raw: dict) -> dict | None:
    pid = raw.get("parent_lv_id")
    return next((p for p in t["positions"] if p["lv_id"] == pid), None) if pid else None


def _line_extras(t: dict, v: dict, raw: dict, pid: str | None, out: dict) -> None:
    """Line detail: tender asks vs we offer (equivalence.py) for the product in use, the matcher's pick and
    every candidate; similar lines and the learned rule for this wording (learned.py)."""
    eq, ln = mod("equivalence"), mod("learned")
    cat = pipeline.catalog()
    if eq is not None:
        try:
            parent = _parent_of(t, raw)
            lv = eq.line_view(raw, raw.get("match"), cat.get(pid or ""), cat, t.get("instructions"), parent)
            out["make_rule"], out["comparison"] = lv["make_rule"], lv["comparison"]
            if out.get("match"):
                out["match"] = {**out["match"], "comparison": lv["match_comparison"]}
            eq.add_comparisons(raw, out.get("candidates") or [], parent)
        except Exception as e:  # a comparison must never break the line
            log.warning("comparison failed for %s: %s", raw.get("lv_id"), e)
    if ln is not None:
        try:
            out["similar"] = ln.similar(t, raw["lv_id"], {p["lv_id"]: p["needs_review"] for p in v["positions"]})
            out["learned_rule"] = ln.rule_for(raw)
        except Exception as e:
            log.warning("learned view failed for %s: %s", raw.get("lv_id"), e)


def _learn(t: dict, lv_id: str, n_log: int) -> None:
    """Teach learned.py from the log entries one change added (their `by` is who taught it)."""
    ln = mod("learned")
    if ln is not None:
        try:
            ln.record_patch(t, lv_id, (t.get("log") or [])[n_log:])
        except Exception as e:
            log.warning("learning from %s failed: %s", lv_id, e)


def _nav(ids: list[str], lv_id: str) -> dict:
    if lv_id not in ids:
        return {"index": None, "total": len(ids), "prev": None, "next": ids[0] if ids else None}
    i = ids.index(lv_id)
    return {"index": i + 1, "total": len(ids), "prev": ids[i - 1] if i > 0 else None,
            "next": ids[i + 1] if i + 1 < len(ids) else None}


@app.get("/api/tenders/{tid}/positions/{lv_id}")
def get_position(tid: str, lv_id: str):
    return position_detail(_tender(tid), lv_id)


def _fmt_val(v: Any) -> str:
    if v is None:
        return "empty"
    if isinstance(v, float):
        return swiss(v, 2) if v != int(v) else swiss(v, 0)
    return str(v)


@app.patch("/api/tenders/{tid}/positions/{lv_id}")
def patch_position(tid: str, lv_id: str, body: PositionPatch):
    data = body.model_dump(exclude_unset=True)
    with store.edit(tid) as t:
        n_log = len(t.get("log") or [])  # the entries this request adds teach learned matches (_learn)
        pos = store.resolve_target(t, "position", lv_id)
        if pos is None:
            raise HTTPException(404, f"Line {lv_id} not found")
        pos.setdefault("overrides", {})
        if data.get("reset"):
            ov = pos.get("overrides") or {}
            upd = {f"overrides.{k}": None for k, val in ov.items() if val is not None}
            if pos.get("variant_reason"):
                upd["variant_reason"] = None
            store.change(t, "You", "reset", "position", lv_id, upd, text=f"Reset {lv_id} to calculated values")
        edits: dict[str, Any] = {}
        words = []
        for k in ("quantity", "product_id", "unit_price", "hours", "install_code", "status"):
            if k in data:
                edits[f"overrides.{k}"] = data[k]
                base = {"quantity": pos.get("quantity"), "product_id": (pos.get("match") or {}).get("product_id"),
                        "install_code": (pos.get("match") or {}).get("install_code")}.get(k)
                old = pos["overrides"].get(k)
                words.append(f"{k.replace('_', ' ')} {_fmt_val(old if old is not None else base)} → "
                             f"{_fmt_val(data[k] if data[k] is not None else base)}")
        if "product_id" in data:
            if data["product_id"] and data["product_id"] not in pipeline.catalog():
                raise HTTPException(400, f"Product {data['product_id']} is not in the catalogue")
            if "install_code" not in data:
                edits["overrides.install_code"] = None  # follows the new product
        if "install_code" in data and data["install_code"] and data["install_code"] not in pipeline.rules():
            raise HTTPException(400, f"Install rule {data['install_code']} does not exist")
        if "variant_reason" in data:
            edits["variant_reason"] = data["variant_reason"]
            words.append("variant reason")
        if "quote_unit_price" in data or "quote_source" in data:
            qp = data.get("quote_unit_price", (pos.get("supplier_quote") or {}).get("unit_price"))
            edits["supplier_quote"] = None if qp is None else {
                "unit_price": qp, "source": data.get("quote_source") or "Typed by you",
                "received_at": store.now(), "by": "You"}
            words.append(f"supplier quote → {_fmt_val(qp)}")
        if edits:
            store.change(t, "You", "edit", "position", lv_id, edits, text=f"{lv_id}: " + ", ".join(words))
        if data.get("confirm"):
            store.change(t, "You", "confirm", "position", lv_id,
                         {"confirmed": {"by": "You", "at": store.now()}, "flagged": False},
                         text=f"Confirmed {lv_id}")
        if data.get("unconfirm"):
            store.change(t, "You", "unconfirm", "position", lv_id, {"confirmed": None}, text=f"Unconfirmed {lv_id}")
        if "flag" in data and data["flag"] is not None:
            store.change(t, "You", "flag" if data["flag"] else "unflag", "position", lv_id, {"flagged": data["flag"]},
                         text=("Flagged " if data["flag"] else "Unflagged ") + lv_id)
    _learn(t, lv_id, n_log)
    return position_detail(store.load(tid), lv_id)


@app.get("/api/tenders/{tid}/positions/{lv_id}/candidates")
def candidates(tid: str, lv_id: str, q: str | None = None, limit: int = 20):
    t = _tender(tid)
    v = pipeline.view(t)
    cur = v["by_lv"].get(lv_id)
    if cur is None:
        raise HTTPException(404, f"Line {lv_id} not found")
    raw = next(p for p in t["positions"] if p["lv_id"] == lv_id)
    eq = mod("equivalence")
    if q and q.strip():
        known = dict(_shortlist_ids(raw))
        ids = _search_catalog(q, limit)
        items = [_candidate(t, raw, cur, pid, known.get(pid)) for pid in ids]
        if eq is not None:
            eq.add_comparisons(raw, items, _parent_of(t, raw))
        return {"q": q, "candidates": items, "total": len(pipeline.catalog()), "search": True}
    items = [_candidate(t, raw, cur, pid, extra) for pid, extra in _shortlist_ids(raw)]
    if eq is not None:
        eq.add_comparisons(raw, items, _parent_of(t, raw))
    return {"q": None, "candidates": items, "total": len(pipeline.catalog()), "search": False}


# ================================================================== learned matches


@app.get("/api/learned")
def get_learned():
    """Reference -> Learned matches: every rule estimators taught, with where, who, when and its record."""
    return mod("learned").rules_view()


@app.patch("/api/learned/{rid}")
def patch_learned(rid: str, enabled: bool = Body(..., embed=True)):
    return mod("learned").set_enabled(rid, enabled)


@app.delete("/api/learned/{rid}")
def delete_learned(rid: str):
    mod("learned").delete(rid)
    return {"ok": True}


@app.post("/api/tenders/{tid}/positions/{lv_id}/apply-similar")
def apply_similar(tid: str, lv_id: str):
    """This line's product (and confirmation) on the lines with the same tender wording: one undoable batch."""
    t = _tender(tid)
    v = pipeline.view(t)
    if lv_id not in v["by_lv"]:
        raise HTTPException(404, f"Line {lv_id} not found")
    res = mod("learned").apply_similar(tid, lv_id, "You", {p["lv_id"]: p["needs_review"] for p in v["positions"]})
    return {**res, "position": position_detail(store.load(tid), lv_id)}


# ================================================================== pages / pdf


@app.get("/api/tenders/{tid}/pdf")
def get_pdf(tid: str):
    t = _tender(tid)
    return FileResponse(store.pdf_path(tid), media_type="application/pdf",
                        filename=t.get("file_name") or "tender.pdf", content_disposition_type="inline")


def _open_pdf(tid: str):
    import pymupdf

    return pymupdf.open(str(store.pdf_path(tid)))


@app.get("/api/tenders/{tid}/pages/{n}.png")
def page_png(tid: str, n: int, scale: float = Query(2.0, ge=0.5, le=4.0)):
    _tender(tid)
    scale = round(scale * 4) / 4  # bound the cache
    cache = store.tender_dir(tid) / "pages" / f"{n}@{scale:g}.png"
    if not cache.exists():
        import pymupdf

        with _open_pdf(tid) as doc:
            if n < 1 or n > doc.page_count:
                raise HTTPException(404, f"Page {n} does not exist (1-{doc.page_count})")
            pix = doc[n - 1].get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            data = pix.tobytes("png")
        cache.parent.mkdir(parents=True, exist_ok=True)
        tmp = cache.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(cache)
    return FileResponse(cache, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/tenders/{tid}/pages/{n}/text")
def page_text(tid: str, n: int):
    _tender(tid)
    with _open_pdf(tid) as doc:
        if n < 1 or n > doc.page_count:
            raise HTTPException(404, f"Page {n} does not exist")
        page = doc[n - 1]
        words = [{"text": w[4], "bbox": [round(x, 2) for x in w[:4]], "block": w[5], "line": w[6]}
                 for w in page.get_text("words")]
        lines = []
        for b in page.get_text("dict").get("blocks", []):
            for ln in b.get("lines", []):
                text = "".join(s.get("text", "") for s in ln.get("spans", []))
                if text.strip():
                    lines.append({"text": text, "bbox": [round(x, 2) for x in ln["bbox"]]})
        return {"page": n, "size": [page.rect.width, page.rect.height], "words": words, "lines": lines}


# ================================================================== instructions


def _instruction_view(t: dict, ins: dict, v: dict) -> dict:
    lines = []
    for x in ins.get("applies_to") or []:
        p = v["by_lv"].get(x)
        if p:
            lines.append({"lv_id": x, "title_de": p.get("title_de"), "title_en": p.get("title_en"), "page": p.get("page"),
                          "quantity": p.get("quantity"), "unit": p.get("unit"), "status": p["status"],
                          "needs_review": p["needs_review"], "direct": _direct(p)})
    return {**ins, "lines": lines,
            "log": [e for e in reversed(t.get("log") or [])
                    if (e.get("target") or {}).get("kind") == "instruction" and e["target"].get("id") == ins["id"]][:10]}


@app.get("/api/tenders/{tid}/instructions")
def list_instructions(tid: str, filter: str = "open"):
    t = _tender(tid)
    v = pipeline.view(t)
    items = t.get("instructions") or []
    counts = {"open": 0, "all": len(items), "cost": 0, "risk": 0, "scope": 0, "covered": 0,
              "confirmed": 0, "not_relevant": 0}
    for i in items:
        counts[i.get("state", "open")] = counts.get(i.get("state", "open"), 0) + 1
        if i.get("kind") in counts:
            counts[i["kind"]] += 1
    if filter == "open":
        sel = [i for i in items if i.get("state", "open") == "open"]
    elif filter in ("cost", "risk", "scope", "covered"):
        sel = [i for i in items if i.get("kind") == filter]
    elif filter in ("confirmed", "not_relevant"):
        sel = [i for i in items if i.get("state") == filter]
    else:
        sel = list(items)
    pages = sorted({i.get("page") for i in items if i.get("page")})
    sections = sorted({i.get("section") for i in items if i.get("section")})
    return {"filter": filter, "instructions": [_instruction_view(t, i, v) for i in sel], "counts": counts,
            "pages": [pages[0], pages[-1]] if pages else None, "sections": sections}


@app.get("/api/tenders/{tid}/instructions/{iid}")
def get_instruction(tid: str, iid: str):
    t = _tender(tid)
    ins = store.resolve_target(t, "instruction", iid)
    if ins is None:
        raise HTTPException(404, f"Instruction {iid} not found")
    return _instruction_view(t, ins, pipeline.view(t))


def _applies_label(ids: list[str]) -> str:
    if not ids:
        return "Whole tender"
    return ", ".join(ids[:3]) + (f" and {len(ids) - 3} more" if len(ids) > 3 else "")


@app.patch("/api/tenders/{tid}/instructions/{iid}")
def patch_instruction(tid: str, iid: str, body: InstructionPatch):
    data = body.model_dump(exclude_unset=True)
    with store.edit(tid) as t:
        ins = store.resolve_target(t, "instruction", iid)
        if ins is None:
            raise HTTPException(404, f"Instruction {iid} not found")
        upd: dict[str, Any] = {}
        if "kind" in data and data["kind"]:
            upd["kind"] = data["kind"]
        if "applies_to" in data and data["applies_to"] is not None:
            known = {p["lv_id"] for p in t["positions"]}
            bad = [x for x in data["applies_to"] if x not in known]
            if bad:
                raise HTTPException(400, f"Unknown lines: {', '.join(bad)}")
            upd["applies_to"] = data["applies_to"]
            upd["applies_label"] = _applies_label(data["applies_to"])
        if upd:
            store.change(t, "You", "edit_instruction", "instruction", iid, upd, text=f"Changed {ins.get('type')}")
        if data.get("state"):
            st = data["state"]
            u2 = {"state": st, "confirmed_by": "You" if st != "open" else None,
                  "confirmed_at": store.now() if st != "open" else None}
            verb = {"confirmed": "Confirmed", "not_relevant": "Marked not relevant", "open": "Reopened"}[st]
            store.change(t, "You", f"instruction_{st}", "instruction", iid, u2, text=f"{verb}: {ins.get('type')}")
    t = store.load(tid)
    return _instruction_view(t, store.resolve_target(t, "instruction", iid), pipeline.view(t))


# ================================================================== pricing

_PRICING_SKIP = {"changed_by", "notes", "chosen"}


def _flatten(d: dict, prefix: str = "") -> dict:
    out = {}
    for k, val in d.items():
        if isinstance(val, dict):
            out.update(_flatten(val, f"{prefix}{k}."))
        else:
            out[f"{prefix}{k}"] = val
    return out


def pricing_payload(t: dict) -> dict:
    v = pipeline.view(t)
    settings = v["settings"]
    defaults = pipeline.default_settings()
    fs = _flatten({k: x for k, x in settings.items() if k not in _PRICING_SKIP})
    fd = _flatten({k: x for k, x in defaults.items() if k not in _PRICING_SKIP})
    changed = sorted(k for k in fs if fs.get(k) != fd.get(k))
    ref = mod("reference")
    calls = {k: {"value": settings.get(k), "label": call_label(k, settings.get(k)),
                 "options": [{"label": lab, "value": val} for lab, val in CALL_LABELS[k]],
                 "note": (settings.get("notes") or {}).get(k, ""),
                 "changed_by": (settings.get("changed_by") or {}).get(k)}
             for k in CALL_LABELS}
    return {"settings": settings, "defaults": defaults, "totals": v["totals"],
            "changed_count": len(changed), "changed": changed, "calls": calls,
            "labels": {"factors": getattr(ref, "FACTOR_LABELS", {}), "settings": getattr(ref, "SETTING_LABELS", {}),
                       "project_costs": ref.project_cost_labels() if ref else {}}}


@app.get("/api/tenders/{tid}/pricing")
def get_pricing(tid: str):
    return pricing_payload(_tender(tid))


@app.get("/api/tenders/{tid}/verification")
def get_verification(tid: str):
    """Verified against Equans examples: our lines and subset totals vs the golden numbers (default settings)."""
    from . import verification
    return verification.verify(_tender(tid))


@app.put("/api/tenders/{tid}/pricing")
def put_pricing(tid: str, body: PricingUpdate = Body(...)):
    data = body.model_dump(exclude_unset=True)
    data.pop("changed_by", None)
    with store.edit(tid) as t:
        settings = pipeline.settings_of(t)
        if "chosen" in data and data["chosen"] is not None and data["chosen"] not in settings["margins"]:
            raise HTTPException(400, f"Unknown option {data['chosen']}")
        if t.get("pricing") is None:
            t["pricing"] = {}
        upd: dict[str, Any] = {}
        for k, val in data.items():
            if isinstance(val, dict):
                for sk, sv in val.items():
                    upd[f"{k}.{sk}"] = sv
            else:
                upd[k] = val
        # values the arithmetic cannot take (a 0 site efficiency divides by zero, a 100% margin too):
        # rejected here, otherwise every screen of the tender would fail until pricing is reset
        for k, val in upd.items():
            if not isinstance(val, (int, float)) or isinstance(val, bool):
                continue
            if k.startswith("factors.") and val <= 0:
                raise HTTPException(400, f"{k.split('.', 1)[1].replace('_', ' ').capitalize()} must be above 0")
            if k.startswith("margins.") and not -100 < val < 100:
                raise HTTPException(400, "A margin must be between -100% and 100%")
            if k == "round_to" and val <= 0:
                raise HTTPException(400, "Rounding must be above 0")
            if k.endswith("_pct") and val < 0:
                raise HTTPException(400, f"{k.replace('_', ' ')} cannot be negative")
        # compare against effective values, so re-sending a default is a no-op
        eff = _flatten(settings)
        upd = {k: val for k, val in upd.items() if eff.get(k) != val or k not in eff}
        if upd:
            names = ", ".join(sorted({k.split(".")[0] for k in upd}))
            stamp = {"by": "You", "at": store.now()}
            for k in list(upd):
                if not k.startswith("notes."):
                    upd[f"changed_by.{k}"] = stamp  # nested like the setting: changed_by.factors.site_efficiency
            store.change(t, "You", "pricing", "pricing", None, upd, text=f"Changed pricing: {names}")
    return pricing_payload(store.load(tid))


@app.post("/api/tenders/{tid}/pricing/reset")
def reset_pricing(tid: str):
    with store.edit(tid) as t:
        cur = t.get("pricing") or {}
        keep = {k: cur[k] for k in ("chosen", "notes") if k in cur}
        store.change(t, "You", "pricing_reset", "tender", tid, {"pricing": keep}, text="Reset pricing to defaults")
    return pricing_payload(store.load(tid))


# ================================================================== quotes


@app.get("/api/tenders/{tid}/quotes")
def list_quotes(tid: str):
    t = _tender(tid)
    return {"groups": [_quote_group_view(t, g) for g in t.get("quote_requests") or []],
            "proposals": [p for p in (t.get("assist") or {}).get("proposals", []) if p.get("kind") == "supplier_reply"]}


@app.post("/api/tenders/{tid}/quotes/rebuild")
def rebuild_quotes(tid: str):
    t = _tender(tid)
    groups = pipeline.build_quote_groups(t)
    with store.edit(tid) as t2:
        sent = {g["id"]: g.get("sent_at") for g in t2.get("quote_requests") or []}
        for g in groups:
            g["sent_at"] = sent.get(g["id"])
        t2["quote_requests"] = groups
    return list_quotes(tid)


@app.post("/api/tenders/{tid}/quotes/{group}/sent")
def mark_sent(tid: str, group: str, sent: bool = True):
    with store.edit(tid) as t:
        g = store.resolve_target(t, "quote", group)
        if g is None:
            raise HTTPException(404, f"Quote group {group} not found")
        store.change(t, "You", "quote_sent" if sent else "quote_unsent", "quote", group,
                     {"sent_at": store.now() if sent else None, "sent_by": "You" if sent else None},
                     text=f"Marked the request for {g.get('title') or group} as {'sent' if sent else 'not sent'}")
    t = store.load(tid)
    return _quote_group_view(t, store.resolve_target(t, "quote", group))


@app.post("/api/tenders/{tid}/quotes/read")
async def read_quote(tid: str, file: UploadFile | None = File(None), text: str | None = Form(None)):
    _tender(tid)
    if file is None and not text:
        raise HTTPException(400, "Send a file or text")
    # pasted text goes in as bytes: a str is also taken as a file path by the reader, which must never
    # happen for text typed into the browser
    data: bytes = await file.read() if file is not None else (text or "").encode("utf-8")
    filename = (file.filename if file is not None else None) or "Pasted text"
    return assist.read_supplier_reply(tid, data, filename)


@app.post("/api/tenders/{tid}/quotes/apply")
def apply_quotes(tid: str, body: QuoteApply):
    return assist.apply_quotes(tid, [p.model_dump() for p in body.proposals], body.proposal_id)


# ================================================================== exports


def _export_mod():
    ex = mod("export")
    if ex is None:
        raise HTTPException(503, "Exports are not available yet (app/export.py missing)")
    return ex


def _export_inputs(tid: str) -> tuple[dict, dict, dict]:
    t = _tender(tid)
    if not _ready(t):
        raise HTTPException(409, "The tender is still being read")
    v = pipeline.view(t)
    return t, v["totals"], v["settings"]  # export.py re-prices positions itself


def _mark_exported(tid: str, kind: str) -> None:
    with store.edit(tid, by=None, touch=False) as t:
        t.setdefault("exported", {})[kind] = store.now()


def _safe_name(t: dict) -> str:
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", (t.get("name") or t["id"]))[:60].strip("_")
    return base or t["id"]


@app.get("/api/tenders/{tid}/export/xlsx")
def export_xlsx(tid: str):
    t, totals, settings = _export_inputs(tid)
    data = _export_mod().build_xlsx(t, totals, settings)
    _mark_exported(tid, "xlsx")
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{_safe_name(t)}_Offer.xlsx"'})


@app.get("/api/tenders/{tid}/export/report.pdf")
def export_report(tid: str):
    t, totals, settings = _export_inputs(tid)
    ex = _export_mod()
    pts = ex.open_points(t, totals)
    data = ex.build_report_pdf(t, totals, settings, pts)
    _mark_exported(tid, "report")
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{_safe_name(t)}_Pricing_report.pdf"'})


@app.get("/api/tenders/{tid}/export/sia")
def export_sia(tid: str):
    t, totals, _settings = _export_inputs(tid)
    ex = _export_mod()
    data = ex.build_sia_file(t, totals)
    if isinstance(data, str):
        data = data.encode("utf-8")
    ext = getattr(ex, "SIA_EXTENSION", "csv").lstrip(".")  # semicolon CSV, "planned format"
    media = getattr(ex, "SIA_MEDIA_TYPE", "text/csv; charset=utf-8")
    _mark_exported(tid, "sia")
    return Response(data, media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{_safe_name(t)}_SIA.{ext}"'})


@app.get("/api/tenders/{tid}/export/checklist")
def export_checklist(tid: str):
    t, totals, _settings = _export_inputs(tid)
    pts = _export_mod().open_points(t, totals)
    return {"open_points": pts, "submission_rule": t.get("submission_rule"), "days_left": _days_left(t.get("due_at")),
            "offer": totals.get("offer"), "standard_price": totals.get("standard_price"),
            "submitted": t.get("submission")}


# ================================================================== submit / outcome / results


@app.post("/api/tenders/{tid}/submit")
def submit(tid: str, body: dict | None = Body(None)):
    t = _tender(tid)
    if not _ready(t):
        raise HTTPException(409, "The tender is still being read")
    v = pipeline.view(t)
    totals, settings = v["totals"], v["settings"]
    option = (body or {}).get("option") or settings.get("chosen") or "Standard"
    row = next((s for s in totals.get("scenarios") or [] if s["name"] == option), None)
    if row is None:
        raise HTTPException(400, f"Unknown option {option}")
    snap = {
        "at": store.now(), "by": "You", "option": option, "chosen_explicitly": bool(settings.get("chosen")),
        "offer_price": row["bid"], "margin_pct": row["margin_pct"], "cost": totals.get("cost"),
        "direct": totals.get("direct"), "win": row["win"], "profit": row["profit"], "expected": row["expected"],
        "standard_price": totals.get("standard_price"),
        "calls": {k: {"value": settings.get(k), "label": call_label(k, settings.get(k)),
                      "note": (settings.get("notes") or {}).get(k, ""),
                      "default": settings.get(k) == pipeline.default_settings().get(k)} for k in CALL_LABELS},
        "settings": settings,
        "lines": totals.get("lines_priced"), "to_review": totals.get("to_review"),
        "instructions_open": len(_open_instructions(t)),
    }
    with store.edit(tid) as t2:
        store.change(t2, "You", "submit", "tender", tid, {"submission": snap, "status": "submitted"},
                     text=f"Marked as submitted at CHF {swiss(row['bid'])} ({option})")
    return _tender_detail(store.load(tid))


@app.put("/api/tenders/{tid}/outcome")
def put_outcome(tid: str, body: Outcome):
    t = _tender(tid)
    data = body.model_dump()
    data["recorded_at"] = store.now()
    data["recorded_by"] = "You"
    sub = t.get("submission") or {}
    if data.get("winning_price") and sub.get("offer_price"):
        data["gap_pct"] = round((sub["offer_price"] / data["winning_price"] - 1) * 100, 2)
    # N09 "Compared with your offer"
    cmp = []
    if data.get("winning_price") and sub.get("offer_price"):
        gap = sub["offer_price"] - data["winning_price"]
        cmp.append({"key": "gap", "text": (f"Our offer was CHF {swiss(abs(gap))} ({abs(data['gap_pct']):.1f}%) "
                                           f"{'above' if gap > 0 else 'below' if gap < 0 else 'equal to'} the winning price.")})
        std = sub.get("standard_price")
        if std:
            cmp.append({"key": "standard", "text": f"The winning price was {abs(data['winning_price'] / std - 1) * 100:.1f}% "
                                                   f"{'below' if data['winning_price'] < std else 'above'} our standard price."})
    if sub.get("win") is not None and data.get("result") in ("won", "lost"):
        cmp.append({"key": "win", "text": f"We predicted a {round(sub['win'] * 100)}% win chance; the result: {data['result']}."})
    comp = (sub.get("calls") or {}).get("competition") or {}
    if data.get("bidders") and comp.get("label"):
        cmp.append({"key": "competition", "text": f"Your competition call was {comp['label']}; {data['bidders']} firms bid."})
    data["comparison"] = cmp
    with store.edit(tid) as t2:
        store.change(t2, "You", "outcome", "tender", tid, {"outcome": data, "status": "awarded"},
                     text="Recorded the award outcome")
    return _tender_detail(store.load(tid))


@app.get("/api/results")
def results():
    rows = []
    for tid in store.list_ids():
        try:
            t = store.load(tid)
        except Exception:
            continue
        sub, oc = t.get("submission"), t.get("outcome")
        if not sub:
            continue
        win_price = (oc or {}).get("winning_price")
        gap = ((sub["offer_price"] / win_price - 1) * 100) if (win_price and sub.get("offer_price")) else None
        comp = (sub.get("calls") or {}).get("competition") or {}
        rows.append({
            "id": t["id"], "name": t.get("name"), "trade": t.get("trade"), "client": t.get("client"),
            "submitted_at": sub.get("at"), "our_offer": sub.get("offer_price"), "option": sub.get("option"),
            "margin_pct": sub.get("margin_pct"), "predicted_win": sub.get("win"),
            "winning_price": win_price, "gap_pct": round(gap, 2) if gap is not None else None,
            "bidders": (oc or {}).get("bidders"), "rank": (oc or {}).get("rank"),
            "competition_call": comp.get("label"), "competition_value": comp.get("value"),
            "result": (oc or {}).get("result") or ("awaiting" if not oc else "open"),
            "status": t.get("status"), "outcome": oc,
        })
    rows.sort(key=lambda r: r.get("submitted_at") or "", reverse=True)
    recorded = [r for r in rows if r["outcome"] and r["result"] in ("won", "lost")]
    learned = None
    if len(recorded) >= 3:
        comp: dict[str, dict] = {}
        for r in recorded:
            c = comp.setdefault(r["competition_call"] or "?", {"call": r["competition_call"], "tenders": 0, "bidders": []})
            c["tenders"] += 1
            if r["bidders"]:
                c["bidders"].append(r["bidders"])
        comp_rows = [{"call": c["call"], "tenders": c["tenders"],
                      "avg_bidders": round(sum(c["bidders"]) / len(c["bidders"]), 1) if c["bidders"] else None}
                     for c in comp.values()]
        gaps: dict[str, list[float]] = {}
        for r in recorded:
            if r["gap_pct"] is not None:
                gaps.setdefault(r["trade"] or "?", []).append(r["gap_pct"])
        gap_rows = [{"trade": k, "avg_gap_pct": round(sum(g) / len(g), 2), "tenders": len(g)} for k, g in gaps.items()]
        opts: dict[str, list[bool]] = {}
        for r in recorded:
            opts.setdefault(r["option"] or "?", []).append(r["result"] == "won")
        win_rows = [{"option": k, "tenders": len(w), "won": sum(w), "win_rate": round(sum(w) / len(w), 2)}
                    for k, w in opts.items()]
        pred = [(r["predicted_win"], r["result"] == "won") for r in recorded if r["predicted_win"] is not None]
        learned = {"competition_calls": comp_rows, "gap_by_trade": gap_rows, "win_rate_by_option": win_rows,
                   "predicted_vs_actual": {"avg_predicted": round(sum(p for p, _ in pred) / len(pred), 2) if pred else None,
                                           "actual_win_rate": round(sum(w for _, w in pred) / len(pred), 2) if pred else None}}
    return {"rows": [{k: v for k, v in r.items() if k != "outcome"} for r in rows],
            "recorded": len(recorded), "needed": 3, "learned": learned,
            "note": f"{len(recorded)} tender{'s' if len(recorded) != 1 else ''} recorded so far."}


# ================================================================== reference


@app.get("/api/reference")
def get_reference():
    ref = mod("reference")
    b = ref.reference_bundle()
    b["counts"] = {"catalog": len(b["catalog"]), "rules": len(b["rules"])}
    b["project_costs"] = ref.project_cost_amounts()
    b["project_cost_labels"] = ref.project_cost_labels()
    b["defaults"] = ref.default_settings()
    return b


@app.post("/api/reference/{kind}")
async def import_reference(kind: str, file: UploadFile = File(...)):
    ref = mod("reference")
    entry = ref.import_reference(kind, await file.read())
    return {"ok": True, "version": entry, "reference": get_reference()}


# ================================================================== assist / explain / log


@app.get("/api/tenders/{tid}/assist")
def get_assist(tid: str):
    return assist.tray(_tender(tid))


@app.post("/api/tenders/{tid}/assist/command")
def assist_command(tid: str, body: AssistCommand):
    _tender(tid)
    return assist.command(tid, body.text, body.scope, body.lv_id)


@app.post("/api/tenders/{tid}/assist/plans/{plan_id}/apply")
def assist_apply(tid: str, plan_id: str):
    _tender(tid)
    return assist.apply(tid, plan_id)


@app.post("/api/tenders/{tid}/assist/proposals/{proposal_id}/dismiss")
def assist_dismiss(tid: str, proposal_id: str):
    return assist.dismiss(tid, proposal_id)


@app.post("/api/tenders/{tid}/assist/proposals/{proposal_id}/apply")
def assist_apply_proposal(tid: str, proposal_id: str, body: dict | None = Body(None)):
    return assist.apply_proposal(tid, proposal_id, (body or {}).get("lv_ids"))


@app.post("/api/tenders/{tid}/assist/undo/{log_id}")
def assist_undo(tid: str, log_id: str):
    with store.edit(tid) as t:
        try:
            entries = store.undo(t, log_id)
        except ValueError as e:
            raise HTTPException(409, str(e))
        assist.reopen_after_undo(t, entries)
    ln = mod("learned")
    if ln is not None:  # forget what the undone changes taught
        ln.retract([e.get("undoes") for e in entries])
    t = store.load(tid)
    v = pipeline.view(t)
    return {"undone": entries, "totals": _footer(v["totals"])}


@app.post("/api/tenders/{tid}/undo/{log_id}")
def undo(tid: str, log_id: str):
    return assist_undo(tid, log_id)


@app.get("/api/tenders/{tid}/explain/{lv_id}")
def explain(tid: str, lv_id: str, field: str = "labour"):
    t = _tender(tid)
    return assist.explain(t, lv_id, field)


@app.get("/api/tenders/{tid}/log")
def get_log(tid: str, lv_id: str | None = None, by: str | None = None, limit: int = 200):
    t = _tender(tid)
    entries = list(reversed(t.get("log") or []))
    if lv_id:
        entries = [e for e in entries if e.get("lv_id") == lv_id]
    if by:
        entries = [e for e in entries if e.get("by") == by]
    return {"log": entries[:limit], "total": len(entries)}
