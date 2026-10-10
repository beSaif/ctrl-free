"""Assist: proposals, plans and explanations. Assist never applies anything silently.

- tray(t)                     -> {needs_ok, working_on, done, suggestions}
- read_supplier_reply(...)    -> reads a reply (quotes.py), stores a proposal, applies nothing
- apply_quotes / apply_proposal / dismiss
- command(tid, text, ...)     -> a plan (concrete actions + effect on direct cost), stored, not applied
- apply(tid, plan_id)         -> executes the plan with by="Assist", logged and undoable (one batch)
- explain(t, lv_id, field)    -> sentence steps from pricing.explain_field

The free-text request is mapped onto a small set of allowed actions with an enum-constrained
JSON schema (llm.call_json). When the LLM is not available, keyword rules do the mapping.
"""
from __future__ import annotations

import copy
import json
import logging
import re
import threading
from typing import Any

from fastapi import HTTPException

from . import pipeline, store

log = logging.getLogger("ctrlfree.assist")
mod = pipeline.mod

INTENTS = ["fill_quotes_from_reply", "confirm_instructions", "set_status", "change_product", "set_quantity",
           "explain", "unsupported"]
SET_STATUS_VALUES = ["confirmed", "unconfirmed", "flagged", "unflagged", "out_of_scope", "review_required",
                     "calculated", "non_priceable"]
CONDITIONS = ["all", "at_or_below_budget", "above_budget"]
FIELDS = ["material", "labour", "hours", "direct"]

# running jobs (in memory; a restart forgets them, which is fine for "working on")
_jobs: dict[str, dict[str, dict]] = {}
_jobs_lock = threading.Lock()


def swiss(n: float | None, dp: int = 2) -> str:
    if n is None:
        return ""
    return f"{float(n):,.{dp}f}".replace(",", "'")


def _assist_state(t: dict) -> dict:
    a = t.setdefault("assist", {})
    a.setdefault("proposals", [])
    a.setdefault("plans", {})
    a.setdefault("dismissed_instructions", [])
    return a


def _direct(p: dict | None) -> float:
    return float(((p or {}).get("pricing") or {}).get("direct") or 0.0)


# ================================================================== jobs


def start_job(tid: str, kind: str, title: str, detail: str = "") -> str:
    jid = store.new_id("j_")
    with _jobs_lock:
        _jobs.setdefault(tid, {})[jid] = {"id": jid, "kind": kind, "title": title, "detail": detail,
                                          "started_at": store.now()}
    return jid


def update_job(tid: str, jid: str, **kw) -> None:
    with _jobs_lock:
        j = _jobs.get(tid, {}).get(jid)
        if j:
            j.update(kw)


def end_job(tid: str, jid: str) -> None:
    with _jobs_lock:
        _jobs.get(tid, {}).pop(jid, None)


def jobs(tid: str) -> list[dict]:
    with _jobs_lock:
        return [dict(j) for j in _jobs.get(tid, {}).values()]


# ================================================================== tray


def _auto_confirmable(t: dict, v: dict) -> list[dict]:
    """Open scope/covered instructions whose lines already match (confirming them changes no price)."""
    out = []
    dismissed = set(_assist_state(t)["dismissed_instructions"])
    for i in t.get("instructions") or []:
        if i.get("state", "open") != "open" or i.get("kind") not in ("scope", "covered") or i["id"] in dismissed:
            continue
        lines = [v["by_lv"].get(x) for x in i.get("applies_to") or []]
        if all(p is not None and p.get("pricing") and p["status"] not in
               ("review_required", "insufficient_information") for p in lines):
            out.append(i)
    return out


def _open_reply_proposals(t: dict) -> list[dict]:
    return [p for p in _assist_state(t)["proposals"]
            if p.get("kind") == "supplier_reply" and p.get("state") == "open"]


def tray(t: dict, lv_id: str | None = None) -> dict:
    v = pipeline.view(t) if t.get("positions") else {"by_lv": {}, "positions": []}
    needs_ok = []
    for p in _open_reply_proposals(t):
        items = [x for x in p["items"] if x.get("state") == "open"]
        if not items:
            continue
        needs_ok.append({**p, "items": items, "count": len(items)})
    auto = _auto_confirmable(t, v) if t.get("positions") else []
    if auto:
        open_i = [i for i in t.get("instructions") or [] if i.get("state", "open") == "open"]
        cost = sum(1 for i in open_i if i.get("kind") == "cost")
        risk = sum(1 for i in open_i if i.get("kind") == "risk")
        stay = []
        if cost:
            stay.append(f"the {cost} that add cost" if cost != 1 else "the 1 that adds cost")
        if risk:
            stay.append(f"the {risk} risks" if risk != 1 else "the 1 risk")
        n = len(auto)
        needs_ok.append({
            "id": "confirm_instructions", "kind": "confirm_instructions",
            "title": f"Confirm {n} instruction{'s' if n != 1 else ''} that do{'es' if n == 1 else ''} not change the price",
            "detail": (f"All {n} are Scope or Covered and their lines already match."
                       + (f" {' and '.join(stay).capitalize()} stay with you." if stay else "")),
            "items": [{"id": i["id"], "type": i.get("type"), "page": i.get("page"), "kind": i.get("kind"),
                       "applies_label": i.get("applies_label")} for i in auto],
            "count": n, "state": "open",
        })
    done = [{"id": e["id"], "text": e.get("text") or e.get("action"), "at": e["at"], "action": e["action"],
             "lv_id": e.get("lv_id"), "undoable": e.get("undoable", True) and not e.get("undone"),
             "undone": bool(e.get("undone")), "batch": e.get("batch")}
            for e in reversed(t.get("log") or []) if e.get("by") == "Assist"]
    # collapse batches to one row (the first entry carries the batch text)
    seen, rows = set(), []
    for d in done:
        if d["batch"]:
            if d["batch"] in seen:
                continue
            seen.add(d["batch"])
            batch_entries = [e for e in t.get("log") or [] if e.get("batch") == d["batch"]]
            head = next((e for e in batch_entries if e.get("text")), batch_entries[0])
            d = {**d, "id": head["id"], "text": _batch_text(batch_entries)}
        rows.append(d)
    return {"needs_ok": needs_ok, "working_on": jobs(t["id"]), "done": rows[:15],
            "count": len(needs_ok), "suggestions": suggestions(t, lv_id),
            "pill": f"Assist · {len(needs_ok)} to approve" if needs_ok else "Assist"}


def _batch_text(entries: list[dict]) -> str:
    acts = [e["action"] for e in entries]
    n_fill = acts.count("fill_quote")
    n_conf = acts.count("confirm")
    n_ins = acts.count("instruction_confirmed")
    parts = []
    if n_fill:
        parts.append(f"filled {n_fill} quote{'s' if n_fill != 1 else ''}")
    if n_conf:
        parts.append(f"confirmed {n_conf} line{'s' if n_conf != 1 else ''}")
    if n_ins:
        parts.append(f"confirmed {n_ins} instruction{'s' if n_ins != 1 else ''} for you")
    other = len(entries) - n_fill - n_conf - n_ins
    if other and not parts:
        return entries[0].get("text") or f"{len(entries)} changes"
    if other:
        parts.append(f"{other} other change{'s' if other != 1 else ''}")
    s = " and ".join(parts) if len(parts) <= 2 else ", ".join(parts[:-1]) + " and " + parts[-1]
    return s[:1].upper() + s[1:]


def suggestions(t: dict, lv_id: str | None) -> list[dict]:
    out = []
    if lv_id:
        if any(x["lv_id"] == lv_id for p in _open_reply_proposals(t) for x in p["items"] if x.get("state") == "open"):
            out.append({"text": "Fill the quote from the supplier's reply", "kind": "fills data"})
        out.append({"text": "Why is the labour on this line what it is?", "kind": "explains"})
        out.append({"text": "Confirm this line", "kind": "shows a plan first"})
        out.append({"text": "Use the next closest product", "kind": "shows a plan first"})
    if _open_reply_proposals(t):
        out.append({"text": "Confirm every line where the quote is at or below budget", "kind": "shows a plan first"})
    if t.get("instructions"):
        out.append({"text": "Confirm the instructions that do not change the price", "kind": "shows a plan first"})
    return out


def line_proposals(t: dict, lv_id: str) -> list[dict]:
    """In-place proposals for the line detail (S01 "Assist found a quote for this line")."""
    out = []
    for p in _open_reply_proposals(t):
        mine = next((x for x in p["items"] if x["lv_id"] == lv_id and x.get("state") == "open"), None)
        if mine:
            others = [x["lv_id"] for x in p["items"] if x["lv_id"] != lv_id and x.get("state") == "open"]
            out.append({"proposal_id": p["id"], "source": p.get("source"), "received_at": p.get("received_at"),
                        **mine, "others": others, "title": p.get("title")})
    return out


# ================================================================== supplier replies


def _with_quote(pos: dict, unit_price: float) -> dict:
    p = copy.deepcopy(pos)
    p["supplier_quote"] = {"unit_price": unit_price, "source": "preview"}
    (p.setdefault("overrides", {}))["unit_price"] = None
    return p


def _quote_item(t: dict, v: dict, raw_pos: dict, unit_price: float, source: str | None) -> dict:
    cur = v["by_lv"].get(raw_pos["lv_id"]) or {}
    pr = cur.get("pricing") or {}
    budget = pr.get("net_unit_cost")
    new = pipeline.price(t, _with_quote(raw_pos, unit_price), v["settings"])
    delta = round((new or {}).get("direct", 0) - _direct(cur), 2) if new else None
    return {"lv_id": raw_pos["lv_id"], "unit_price": float(unit_price), "budget": budget, "delta": delta,
            "source": source, "title_de": raw_pos.get("title_de"), "title_en": raw_pos.get("title_en"),
            "quantity": pr.get("quantity", raw_pos.get("quantity")), "unit": raw_pos.get("unit"),
            "page": raw_pos.get("page"),
            "above_budget": bool(budget is not None and unit_price > budget),
            "state": "open"}


def read_supplier_reply(tid: str, data: bytes | str, filename: str) -> dict:
    quotes = mod("quotes")
    jid = start_job(tid, "read_reply", f"Reading {filename}", "you can keep working")
    try:
        t = store.load(tid)
        v = pipeline.view(t)
        if quotes is None:
            raise HTTPException(503, "Reading supplier replies is not available (app/quotes.py missing)")
        open_lines = [p for p in v["positions"] if p["status"] == "supplier_quote_required"
                      and not (p.get("supplier_quote") or {}).get("unit_price")]
        raw = quotes.read_supplier_reply(data, filename, open_lines or v["positions"]) or []
        by_lv = {p["lv_id"]: p for p in t["positions"]}
        items = []
        for r in raw:
            lv = r.get("lv_id")
            price = r.get("unit_price")
            if lv not in by_lv or price is None:
                continue
            it = _quote_item(t, v, by_lv[lv], float(price), r.get("source") or filename)
            # keep what the reader says about the reply row (position no., text, page ...) under reply_*
            for k, val in r.items():
                if k not in ("lv_id", "unit_price", "source", "budget", "delta"):
                    it[f"reply_{k}"] = val
            items.append(it)
        prop = None
        if items:
            groups = {(v["by_lv"][x["lv_id"]].get("pricing") or {}).get("category") for x in items}
            what = (next(iter(groups)) or "").lower() if len(groups) == 1 else ""
            prop = {"id": store.new_id("pr_"), "kind": "supplier_reply", "state": "open", "source": filename,
                    "received_at": store.now(),
                    "title": f"Fill {len(items)} {what + ' ' if what else ''}quote{'s' if len(items) != 1 else ''}",
                    "items": items}
            with store.edit(tid, by=None, touch=False) as t2:
                _assist_state(t2)["proposals"].append(prop)
                store.append_log(t2, "Assist", "read_reply", target=("tender", tid), undoable=False,
                                 text=f"Read {filename}: {len(items)} price{'s' if len(items) != 1 else ''} found")
        return {"proposal_id": prop["id"] if prop else None, "proposals": items, "source": filename,
                "title": prop["title"] if prop else "No prices for this tender's lines found in the reply"}
    finally:
        end_job(tid, jid)


def _fill_quote(t: dict, lv_id: str, unit_price: float, source: str | None, by: str, batch: str,
                proposal_id: str | None = None) -> dict | None:
    pos = store.resolve_target(t, "position", lv_id)
    if pos is None:
        raise HTTPException(404, f"Line {lv_id} not found")
    q = {"unit_price": float(unit_price), "source": source, "received_at": store.now(), "by": by}
    if proposal_id:
        q["proposal_id"] = proposal_id
    old = (pos.get("supplier_quote") or {}).get("unit_price")
    return store.change(t, by, "fill_quote", "position", lv_id, {"supplier_quote": q}, batch=batch,
                        text=f"{lv_id}: supplier quote {swiss(old) if old is not None else 'empty'} → {swiss(unit_price)}")


def _mark_items(t: dict, proposal_id: str | None, lv_ids: set[str], state: str) -> None:
    for p in _assist_state(t)["proposals"]:
        if proposal_id and p["id"] != proposal_id:
            continue
        for x in p.get("items") or []:
            if x["lv_id"] in lv_ids and x.get("state") == "open":
                x["state"] = state
        if p.get("items") and all(x.get("state") != "open" for x in p["items"]):
            p["state"] = "applied" if any(x.get("state") == "filled" for x in p["items"]) else "dismissed"


def reopen_after_undo(t: dict, undone: list[dict]) -> None:
    """Undoing an Assist fill puts the reply's proposal back in "Needs your OK", so it can be filled again."""
    for u in undone:
        orig = next((e for e in t.get("log") or [] if e.get("id") == u.get("undoes")), None)
        if not orig or orig.get("action") != "fill_quote":
            continue
        pid = ((orig.get("after") or {}).get("supplier_quote") or {}).get("proposal_id")
        for p in _assist_state(t)["proposals"]:
            if p["id"] != pid:
                continue
            for x in p.get("items") or []:
                if x["lv_id"] == orig.get("lv_id") and x.get("state") == "filled":
                    x["state"] = "open"
                    p["state"] = "open"


def apply_quotes(tid: str, proposals: list[dict], proposal_id: str | None = None) -> dict:
    batch = store.new_id("b_")
    entries = []
    with store.edit(tid) as t:
        for pr in proposals:
            e = _fill_quote(t, pr["lv_id"], pr["unit_price"], pr.get("source"), "Assist", batch, proposal_id)
            if e:
                entries.append(e)
        _mark_items(t, proposal_id, {p["lv_id"] for p in proposals}, "filled")
    return _result(tid, entries, batch)


def _result(tid: str, entries: list[dict], batch: str | None) -> dict:
    t = store.load(tid)
    v = pipeline.view(t)
    tot = v["totals"]
    return {"applied": len(entries), "batch": batch, "log_ids": [e["id"] for e in entries],
            "undo_id": entries[0]["id"] if entries else None,
            "text": _batch_text(entries) if entries else "Nothing to change",
            "lines": [{"lv_id": p["lv_id"], "status": p["status"], "needs_review": p["needs_review"],
                       "direct": _direct(p)} for p in v["positions"] if p["lv_id"] in {e.get("lv_id") for e in entries}],
            "totals": {k: tot.get(k) for k in ("material", "labour", "direct", "cost", "standard_price", "offer_price",
                                               "to_review")}}


def apply_proposal(tid: str, proposal_id: str, lv_ids: list[str] | None = None) -> dict:
    t = store.load(tid)
    if proposal_id == "confirm_instructions":
        v = pipeline.view(t)
        ids = [i["id"] for i in _auto_confirmable(t, v)]
        if lv_ids:  # here: instruction ids to limit to
            ids = [i for i in ids if i in lv_ids]
        batch = store.new_id("b_")
        entries = []
        with store.edit(tid) as t2:
            for iid in ids:
                e = _confirm_instruction(t2, iid, "Assist", batch)
                if e:
                    entries.append(e)
        return _result(tid, entries, batch)
    prop = next((p for p in _assist_state(t)["proposals"] if p["id"] == proposal_id), None)
    if prop is None:
        raise HTTPException(404, f"Proposal {proposal_id} not found")
    items = [x for x in prop["items"] if x.get("state") == "open" and (not lv_ids or x["lv_id"] in lv_ids)]
    return apply_quotes(tid, items, proposal_id)


def dismiss(tid: str, proposal_id: str) -> dict:
    with store.edit(tid, by=None, touch=False) as t:
        a = _assist_state(t)
        if proposal_id == "confirm_instructions":
            v = pipeline.view(store.load(tid))
            a["dismissed_instructions"] = sorted(set(a["dismissed_instructions"]) |
                                                 {i["id"] for i in _auto_confirmable(t, v)})
        else:
            prop = next((p for p in a["proposals"] if p["id"] == proposal_id), None)
            if prop is None:
                raise HTTPException(404, f"Proposal {proposal_id} not found")
            prop["state"] = "dismissed"
            for x in prop["items"]:
                if x.get("state") == "open":
                    x["state"] = "dismissed"
    return tray(store.load(tid))


# ================================================================== explain


def explain(t: dict, lv_id: str, field: str = "labour") -> dict:
    pricing = mod("pricing")
    raw = next((p for p in t.get("positions") or [] if p["lv_id"] == lv_id), None)
    if raw is None:
        raise HTTPException(404, f"Line {lv_id} not found")
    if field not in FIELDS:
        raise HTTPException(400, f"Unknown field '{field}'. Use {', '.join(FIELDS)}.")
    v = pipeline.view(t)
    cur = v["by_lv"][lv_id]
    pr = cur.get("pricing")
    steps = pricing.explain_field(raw, pr, field)
    title = pricing.explain_title(field, pr) if hasattr(pricing, "explain_title") else f"Why the {field}"
    value = (pr or {}).get(field)
    sources = sorted({s.get("source") for s in steps if s.get("source")})
    return {"lv_id": lv_id, "field": field, "title": title, "value": value, "steps": steps, "sources": sources,
            "sentence": (pr or {}).get("explain", {}).get(field)}


# ================================================================== command -> plan

_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["intent", "lv_ids", "product_id", "quantity", "status", "field", "condition", "confirm", "reply"],
    "properties": {
        "intent": {"type": "string", "enum": INTENTS},
        "lv_ids": {"type": "array", "items": {"type": "string"}},
        "product_id": {"type": ["string", "null"]},
        "quantity": {"type": ["number", "null"]},
        "status": {"type": ["string", "null"], "enum": SET_STATUS_VALUES + [None]},
        "field": {"type": ["string", "null"], "enum": FIELDS + [None]},
        "condition": {"type": ["string", "null"], "enum": CONDITIONS + [None]},
        "confirm": {"type": "boolean"},
        "reply": {"type": "string"},
    },
}

_SYSTEM = """You turn an estimator's short request inside a tender pricing tool into ONE action from a fixed list.
You never compute or invent prices; the tool computes every number.
Actions:
- fill_quotes_from_reply: put supplier-reply prices that Assist already read into the lines (optionally only
  where condition at_or_below_budget / above_budget; confirm=true when the user also wants those lines confirmed).
- confirm_instructions: confirm the tender instructions that do not change the price.
- set_status: lv_ids + status (confirmed, unconfirmed, flagged, unflagged, out_of_scope, review_required, ...).
- change_product: one line, product_id must be one of that line's candidates.
- set_quantity: one line, new quantity.
- explain: why a number on a line is what it is (field: material, labour, hours, direct).
- unsupported: anything else; put a one-sentence answer in reply saying what you can do instead.
Use the line in context when the request says "this line". Only use lv_ids and product ids that appear in the context.
Answer in the user's language in `reply` (one short sentence describing what you will do)."""


def _context(t: dict, v: dict, scope: str, lv_id: str | None, text: str) -> dict:
    ctx: dict[str, Any] = {"scope": scope}
    ids = set(re.findall(r"\bLV\d{3,5}\b", text, re.I))
    if lv_id:
        ids.add(lv_id)
    lines = []
    for x in sorted(i.upper() for i in ids):
        p = v["by_lv"].get(x)
        if not p:
            continue
        pr = p.get("pricing") or {}
        cands = [{"product_id": c.get("product_id"), "why": c.get("why")}
                 for c in (p.get("match") or {}).get("candidates") or []][:6]
        lines.append({"lv_id": x, "title": p.get("title_en") or p.get("title_de"), "quantity": pr.get("quantity"),
                      "unit": p.get("unit"), "product_id": pr.get("product_id"), "status": p["status"],
                      "candidates": cands, "this_line": x == lv_id})
    ctx["lines"] = lines
    ctx["open_supplier_reply_prices"] = sum(1 for p in _open_reply_proposals(t) for x in p["items"]
                                            if x.get("state") == "open")
    ctx["open_instructions"] = sum(1 for i in t.get("instructions") or [] if i.get("state", "open") == "open")
    return ctx


def _rules(text: str, scope: str, lv_id: str | None) -> dict:
    s = text.lower()
    ids = [x.upper() for x in re.findall(r"\bLV\d{3,5}\b", text, re.I)] or ([lv_id] if lv_id else [])
    out = {"intent": "unsupported", "lv_ids": ids, "product_id": None, "quantity": None, "status": None,
           "field": None, "condition": None, "confirm": False, "reply": ""}
    pid = re.search(r"\bP-[A-Z]{2,4}-\d{3}\b", text, re.I)
    num = re.search(r"(?<![\w.])(\d+(?:[.,]\d+)?)(?![\w.])", re.sub(r"\bLV\d+\b", "", text, flags=re.I))
    if re.search(r"\b(why|explain|how (is|was|come)|warum|wieso|erklär)", s):
        out["intent"] = "explain"
        out["field"] = ("material" if re.search(r"materi", s) else "hours" if re.search(r"\bhours?\b|stunden", s)
                        else "direct" if re.search(r"total|direct|line total|gesamt", s) else "labour")
    elif re.search(r"quote|reply|offer|offerte|angebot|supplier|lieferant", s) and not re.search(r"instruction", s):
        out["intent"] = "fill_quotes_from_reply"
        out["condition"] = ("at_or_below_budget" if re.search(r"(at or )?below budget|under budget|unter budget|<=", s)
                            else "above_budget" if re.search(r"above budget|over budget|über budget", s) else "all")
        out["confirm"] = bool(re.search(r"confirm|bestätig", s))
        if scope == "line" and not re.search(r"\ball\b|every|alle", s):
            out["lv_ids"] = [lv_id] if lv_id else ids
        elif scope == "tender" or re.search(r"\ball\b|every|alle", s):
            out["lv_ids"] = [x for x in ids if x != lv_id] if not re.search(r"\bLV\d", text, re.I) else ids
    elif re.search(r"instruction|norm|anweisung|vorschrift", s) and re.search(r"confirm|bestätig|ok", s):
        out["intent"] = "confirm_instructions"
    elif (re.search(r"quantit|qty|menge|stück|anzahl", s) or re.search(r"\bset\b.*\bto\b\s*\d", s)) and num:
        out["intent"] = "set_quantity"
        out["quantity"] = float(num.group(1).replace(",", "."))
    elif pid or re.search(r"(change|switch|use|swap|other|next|different).*(product|candidate)|produkt", s):
        out["intent"] = "change_product"
        out["product_id"] = pid.group(0).upper() if pid else "__next__"
    elif re.search(r"unflag", s):
        out.update(intent="set_status", status="unflagged")
    elif re.search(r"flag|markier", s):
        out.update(intent="set_status", status="flagged")
    elif re.search(r"out of scope|not priced|bauseits|exclude|nicht kalkul", s):
        out.update(intent="set_status", status="out_of_scope")
    elif re.search(r"unconfirm|reopen", s):
        out.update(intent="set_status", status="unconfirmed")
    elif re.search(r"confirm|bestätig|looks (good|right)|ok\b", s):
        out.update(intent="set_status", status="confirmed")
    if out["intent"] == "unsupported":
        out["reply"] = ("I can fill quotes from a supplier reply, confirm instructions or lines, change a product to one "
                        "of the closest candidates, set a quantity, or explain a number.")
    return out


def _classify(t: dict, v: dict, text: str, scope: str, lv_id: str | None) -> tuple[dict, str]:
    llm = mod("llm")
    if llm is not None:
        try:
            user = json.dumps({"request": text, "context": _context(t, v, scope, lv_id, text)}, ensure_ascii=False)
            res = llm.call_json(_SYSTEM, user, _SCHEMA, name="assist_command", timeout=30)
            if res.get("intent") in INTENTS:
                return res, ("cache" if llm.last_call_cached() else "llm")
        except Exception as e:  # LLMUnavailable / LLMError / network
            log.info("assist command falls back to rules: %s", e)
    return _rules(text, scope, lv_id), "rules"


def _shortlist(raw: dict) -> list[str]:
    ids = [c.get("product_id") for c in (raw.get("match") or {}).get("candidates") or [] if c.get("product_id")]
    if not ids:
        matcher = mod("matcher")
        if matcher is not None and hasattr(matcher, "shortlist"):
            try:
                for c in matcher.shortlist(raw, list(pipeline.catalog().values()), k=5) or []:
                    ids.append(c.get("product_id") if isinstance(c, dict) else c)
            except Exception:
                pass
    return [x for x in ids if x]


def _build_actions(t: dict, v: dict, cls: dict, scope: str, lv_id: str | None) -> tuple[list[dict], str]:
    intent = cls["intent"]
    raw_by = {p["lv_id"]: p for p in t["positions"]}
    ids = [x.upper() for x in cls.get("lv_ids") or [] if x and x.upper() in raw_by]
    if not ids and lv_id and scope == "line":
        ids = [lv_id]
    acts: list[dict] = []
    msg = cls.get("reply") or ""

    if intent == "fill_quotes_from_reply":
        cond = cls.get("condition") or "all"
        confirm = bool(cls.get("confirm"))
        pending = [(p, x) for p in _open_reply_proposals(t) for x in p["items"] if x.get("state") == "open"]
        if scope == "line" and lv_id and lv_id in ids and len(ids) == 1:
            pending = [(p, x) for p, x in pending if x["lv_id"] == lv_id]
        elif ids and scope == "tender" and any(re.fullmatch(r"LV\d+", i) for i in cls.get("lv_ids") or []):
            pending = [(p, x) for p, x in pending if x["lv_id"] in ids]
        for p, x in pending:
            ok = (cond == "all" or (cond == "at_or_below_budget" and not x["above_budget"])
                  or (cond == "above_budget" and x["above_budget"]))
            line = f"Quote {swiss(x['unit_price'])}, budget {swiss(x['budget'])}"
            if ok:
                acts.append({"action": "fill_quote", "lv_id": x["lv_id"], "params": {
                    "unit_price": x["unit_price"], "source": x.get("source"), "proposal_id": p["id"]},
                    "text": line, "act": "Fill and confirm" if confirm else "Fill"})
                if confirm:
                    acts.append({"action": "confirm_line", "lv_id": x["lv_id"], "params": {}, "text": line,
                                 "act": "", "hidden": True})
            else:
                acts.append({"action": "none", "lv_id": x["lv_id"], "params": {}, "text": line,
                             "act": "Leave in review" if x["above_budget"] else "Leave as it is"})
        if confirm and cond != "above_budget":
            # quotes already on the lines (typed or filled earlier) that are at or below budget
            for p in v["positions"]:
                q = (p.get("supplier_quote") or {}).get("unit_price")
                prod = pipeline.catalog().get((p.get("pricing") or {}).get("product_id") or "") or {}
                if q is None or p.get("confirmed") or any(a["lv_id"] == p["lv_id"] for a in acts):
                    continue
                if cond == "all" or q <= float(prod.get("net_cost_chf") or q):
                    acts.append({"action": "confirm_line", "lv_id": p["lv_id"], "params": {},
                                 "text": f"Quote {swiss(q)} already entered", "act": "Confirm"})
        if not acts:
            msg = "There are no supplier prices waiting. Drop the supplier's reply on the line first."
    elif intent == "confirm_instructions":
        for i in _auto_confirmable(t, v):
            acts.append({"action": "confirm_instruction", "lv_id": None, "iid": i["id"], "params": {"iid": i["id"]},
                         "text": f"{i.get('type')} · p. {i.get('page')} ({i.get('kind')})", "act": "Confirm"})
        if not acts:
            msg = "No open instruction can be confirmed without changing the price. The rest need you."
    elif intent == "set_status":
        st = cls.get("status") or "confirmed"
        if not ids:
            msg = "Tell me which lines (for example LV0010), or open a line first."
        for x in ids:
            p = v["by_lv"][x]
            if st == "confirmed":
                if p.get("confirmed"):
                    continue
                acts.append({"action": "confirm_line", "lv_id": x, "params": {}, "text": _line_text(p), "act": "Confirm"})
            elif st == "unconfirmed":
                acts.append({"action": "unconfirm_line", "lv_id": x, "params": {}, "text": _line_text(p), "act": "Unconfirm"})
            elif st in ("flagged", "unflagged"):
                acts.append({"action": "flag_line", "lv_id": x, "params": {"flag": st == "flagged"},
                             "text": _line_text(p), "act": "Flag for review" if st == "flagged" else "Remove flag"})
            elif st in pipeline.STATUSES:
                acts.append({"action": "set_status", "lv_id": x, "params": {"status": st}, "text": _line_text(p),
                             "act": f"Set to {st.replace('_', ' ')}"})
    elif intent == "change_product":
        x = ids[0] if ids else lv_id
        if not x:
            msg = "Open a line first, then ask for another product."
        else:
            raw = raw_by[x]
            short = _shortlist(raw)
            cur = pipeline.effective_product(raw)
            want = (cls.get("product_id") or "").upper()
            if want in ("", "__NEXT__") or want not in short:
                if want and want != "__NEXT__" and want not in short:
                    msg = f"{want} is not one of the closest products for {x}. Pick it under Change product."
                    want = ""
                else:
                    want = next((c for c in short if c != cur), "")
            if want and want != cur:
                row = pipeline.catalog().get(want) or {}
                acts.append({"action": "change_product", "lv_id": x, "params": {"product_id": want},
                             "text": f"{cur or 'No product'} → {want} {row.get('description') or ''}".strip(),
                             "act": "Change product"})
    elif intent == "set_quantity":
        x = ids[0] if ids else lv_id
        q = cls.get("quantity")
        if not x or q is None or q < 0:
            msg = "Tell me the line and the new quantity, for example: set LV0010 to 6."
        else:
            p = v["by_lv"][x]
            acts.append({"action": "set_quantity", "lv_id": x, "params": {"quantity": float(q)},
                         "text": f"Quantity {swiss((p.get('pricing') or {}).get('quantity', p.get('quantity')), 0)} → "
                                 f"{swiss(q, 0) if float(q) == int(q) else swiss(q)} {p.get('unit') or ''}".strip(),
                         "act": "Set quantity"})
    return acts, msg


def _line_text(p: dict) -> str:
    return f"{p.get('title_en') or p.get('title_de') or ''} · CHF {swiss(_direct(p))}"


def _exec(t: dict, a: dict, by: str, batch: str) -> dict | None:
    act, x, prm = a["action"], a.get("lv_id"), a.get("params") or {}
    if act == "fill_quote":
        return _fill_quote(t, x, prm["unit_price"], prm.get("source"), by, batch, prm.get("proposal_id"))
    if act == "confirm_line":
        return store.change(t, by, "confirm", "position", x, {"confirmed": {"by": by, "at": store.now()},
                                                              "flagged": False}, batch=batch, text=f"Confirmed {x}")
    if act == "unconfirm_line":
        return store.change(t, by, "unconfirm", "position", x, {"confirmed": None}, batch=batch, text=f"Unconfirmed {x}")
    if act == "flag_line":
        return store.change(t, by, "flag", "position", x, {"flagged": bool(prm["flag"])}, batch=batch,
                            text=("Flagged " if prm["flag"] else "Unflagged ") + x)
    if act == "set_status":
        return store.change(t, by, "edit", "position", x, {"overrides.status": prm["status"]}, batch=batch,
                            text=f"{x}: status → {prm['status'].replace('_', ' ')}")
    if act == "change_product":
        return store.change(t, by, "edit", "position", x, {"overrides.product_id": prm["product_id"],
                                                           "overrides.install_code": None},
                            batch=batch, text=f"{x}: product → {prm['product_id']}")
    if act == "set_quantity":
        return store.change(t, by, "edit", "position", x, {"overrides.quantity": prm["quantity"]}, batch=batch,
                            text=f"{x}: quantity → {prm['quantity']:g}")
    if act == "confirm_instruction":
        return _confirm_instruction(t, prm["iid"], by, batch)
    return None


def _confirm_instruction(t: dict, iid: str, by: str, batch: str | None) -> dict | None:
    ins = store.resolve_target(t, "instruction", iid)
    if ins is None or ins.get("state", "open") != "open":
        return None
    return store.change(t, by, "instruction_confirmed", "instruction", iid,
                        {"state": "confirmed", "confirmed_by": by, "confirmed_at": store.now()},
                        batch=batch, text=f"Confirmed: {ins.get('type')}")


def _title(p: dict) -> str:
    return (p.get("title_en") or p.get("title_de") or "").strip()


def _finds(t: dict, v: dict, text: str, scope: str, lv_id: str | None) -> dict | None:
    """Questions answered by looking things up (no change, no plan): money at risk, same product
    elsewhere, a reminder draft. Deterministic, so they work the same with and without the LLM."""
    s = text.lower()
    if re.search(r"money at risk|most money|largest|biggest|highest|meiste[ns]? geld|grösste|größte", s):
        rows = sorted((p for p in v["positions"] if p.get("needs_review")), key=lambda p: -_direct(p))[:8]
        total = sum(_direct(p) for p in v["positions"] if p.get("needs_review"))
        return {"kind": "plan", "plan_id": None, "intent": "find", "method": "rules",
                "message": (f"The lines that still need you carry CHF {swiss(total, 0)} of direct cost. "
                            f"These {len(rows)} carry the most:"),
                "plan": [{"lv_id": p["lv_id"], "text": f"{_title(p)} · CHF {swiss(_direct(p))}", "action": "open"}
                         for p in rows]}
    if re.search(r"same product|other areas|elsewhere|gleiche[sn]? produkt|andere[nm]? (bereich|anlage)", s):
        x = (re.findall(r"\bLV\d{3,5}\b", text.upper()) or [lv_id])[0]
        cur = v["by_lv"].get(x) if x else None
        if not cur:
            return {"kind": "message", "plan_id": None, "plan": [], "intent": "find", "method": "rules",
                    "message": "Open a line first, then ask for the same product in other areas."}
        pid = (cur.get("pricing") or {}).get("product_id") or pipeline.effective_product(cur)
        group = next((g for g in t.get("quote_requests") or [] if x in (g.get("lv_ids") or [])), None)
        same, what = [], "the same product"
        if pid:
            same = [p for p in v["positions"] if p["lv_id"] != x and
                    ((p.get("pricing") or {}).get("product_id") or pipeline.effective_product(p)) == pid]
            what = f"product {pid}"
        if not same and group:
            same = [v["by_lv"][i] for i in group["lv_ids"] if i != x and i in v["by_lv"]]
            what = f"the same product type ({group.get('title')})"
        if not same:
            return {"kind": "message", "plan_id": None, "plan": [], "intent": "find", "method": "rules",
                    "message": f"No other line uses {what}."}
        return {"kind": "plan", "plan_id": None, "intent": "find", "method": "rules",
                "message": f"{len(same)} other line{'s' if len(same) != 1 else ''} use {what}:",
                "plan": [{"lv_id": p["lv_id"], "text": f"{p.get('system_key') or ''} · p. {p.get('page')} · "
                                                     f"{_title(p)}".strip(" ·"), "action": "open"} for p in same[:12]]}
    if re.search(r"remind|reminder|erinner|nachfass", s):
        groups = t.get("quote_requests") or []
        open_g = []
        for g in groups:
            missing = [i for i in g.get("lv_ids") or [] if i in v["by_lv"] and not v["by_lv"][i].get("supplier_quote")
                       and v["by_lv"][i].get("needs_review")]
            if missing:
                open_g.append((g, missing))
        if lv_id and scope == "line":
            open_g = [(g, m) for g, m in open_g if lv_id in (g.get("lv_ids") or [])] or open_g[:1]
        sent = [(g, m) for g, m in open_g if g.get("sent_at")]
        pick = sent[:1] or open_g[:1]
        if not pick:
            return {"kind": "message", "plan_id": None, "plan": [], "intent": "draft", "method": "rules",
                    "message": "Every supplier request has its answer. Nothing to remind."}
        g, missing = pick[0]
        rows = "\n".join(f"- {i} · Seite {v['by_lv'][i].get('page')} · {v['by_lv'][i].get('title_de')}" for i in missing[:12])
        more = f"\n- und {len(missing) - 12} weitere" if len(missing) > 12 else ""
        when = f" vom {g['sent_at'][8:10]}.{g['sent_at'][5:7]}.{g['sent_at'][:4]}" if g.get("sent_at") else ""
        body = (f"Betreff: Erinnerung Preisanfrage {g.get('title_de') or g.get('title')} · {t.get('name') or ''}\n\n"
                f"Guten Tag\n\nGerne erinnern wir Sie an unsere Preisanfrage{when}. Für folgende Positionen fehlt uns "
                f"noch Ihr Preis:\n{rows}{more}\n\nFür eine Antwort in den nächsten Tagen danken wir Ihnen.\n\n"
                f"Freundliche Grüsse\n[Ihr Name], Equans")
        return {"kind": "message", "plan_id": None, "plan": [], "intent": "draft", "method": "rules",
                "message": f"Reminder draft for {g.get('title')} ({len(missing)} open lines). Nothing is sent:\n\n{body}"}
    return None


def command(tid: str, text: str, scope: str = "tender", lv_id: str | None = None) -> dict:
    t = store.load(tid)
    if not t.get("positions"):
        raise HTTPException(409, "The tender is still being read")
    if lv_id and not any(p["lv_id"] == lv_id for p in t["positions"]):
        raise HTTPException(404, f"Line {lv_id} not found")
    v = pipeline.view(t)
    found = _finds(t, v, text, scope, lv_id)
    if found is not None:
        return found
    cls, method = _classify(t, v, text, scope, lv_id)
    direct_before = v["totals"].get("direct")

    if cls["intent"] == "explain":
        x = next((i.upper() for i in cls.get("lv_ids") or [] if i.upper() in v["by_lv"]), None) or lv_id
        if not x:
            return {"kind": "message", "plan_id": None, "plan": [], "method": method, "intent": "explain",
                    "message": "Open a line first, then ask why a number is what it is."}
        ex = explain(t, x, cls.get("field") or "labour")
        return {"kind": "explain", "plan_id": None, "plan": [], "method": method, "intent": "explain",
                "explain": ex, "message": ex["title"]}
    if cls["intent"] == "unsupported":
        return {"kind": "message", "plan_id": None, "plan": [], "method": method, "intent": "unsupported",
                "message": cls.get("reply") or _rules(text, scope, lv_id)["reply"]}

    acts, msg = _build_actions(t, v, cls, scope, lv_id)
    if not [a for a in acts if a["action"] != "none"]:
        return {"kind": "message", "plan_id": None, "plan": [a for a in acts if not a.get("hidden")], "method": method,
                "intent": cls["intent"], "message": msg or "Nothing to change.",
                "effect": {"direct_before": direct_before, "direct_after": direct_before}}

    # what-if on a copy: per action and overall effect on direct cost
    sim = copy.deepcopy(t)
    sim["rev"] = f"sim-{store.new_id('')}"
    per_line_before = {p["lv_id"]: _direct(p) for p in v["positions"]}
    for a in acts:
        try:
            _exec(sim, a, "Assist", "sim")
        except HTTPException:
            raise
        except Exception as e:
            a["error"] = str(e)
    sv = pipeline.view(sim, use_cache=False)
    for a in acts:
        if a.get("lv_id"):
            a["effect_direct"] = round(_direct(sv["by_lv"].get(a["lv_id"])) - per_line_before.get(a["lv_id"], 0), 2)
            a["needs_review_after"] = bool((sv["by_lv"].get(a["lv_id"]) or {}).get("needs_review"))
    direct_after = sv["totals"].get("direct")
    plan_id = store.new_id("p_")
    plan = {"id": plan_id, "text": text, "scope": scope, "lv_id": lv_id, "intent": cls["intent"], "method": method,
            "actions": acts, "created_at": store.now(), "state": "proposed",
            "effect": {"direct_before": direct_before, "direct_after": direct_after,
                       "delta": round((direct_after or 0) - (direct_before or 0), 2)}}
    with store.edit(tid, by=None, touch=False) as t2:
        plans = _assist_state(t2)["plans"]
        plans[plan_id] = plan
        # keep the last 20 plans
        for old in sorted(plans, key=lambda k: plans[k]["created_at"])[:-20]:
            plans.pop(old, None)
    summary = (f"Direct cost goes from {swiss(direct_before)} to {swiss(direct_after)}. Nothing has changed yet."
               if direct_before != direct_after else "Direct cost does not change. Nothing has changed yet.")
    return {"kind": "plan", "plan_id": plan_id, "intent": cls["intent"], "method": method,
            "plan": [{k: a.get(k) for k in ("lv_id", "iid", "text", "act", "action", "params", "effect_direct",
                                             "needs_review_after", "error")}
                     for a in acts if not a.get("hidden")],
            "effect": plan["effect"], "message": cls.get("reply") or msg or "This is what I would do", "summary": summary}


def apply(tid: str, plan_id: str) -> dict:
    batch = store.new_id("b_")
    entries = []
    with store.edit(tid) as t:
        plan = _assist_state(t)["plans"].get(plan_id)
        if plan is None:
            raise HTTPException(404, f"Plan {plan_id} not found")
        if plan["state"] != "proposed":
            raise HTTPException(409, f"Plan already {plan['state']}")
        for a in plan["actions"]:
            e = _exec(t, a, "Assist", batch)
            if e:
                entries.append(e)
        filled = {a["lv_id"] for a in plan["actions"] if a["action"] == "fill_quote"}
        for pid in {a["params"].get("proposal_id") for a in plan["actions"] if a["action"] == "fill_quote"}:
            _mark_items(t, pid, filled, "filled")
        plan["state"] = "applied"
        plan["applied_at"] = store.now()
        plan["batch"] = batch
    res = _result(tid, entries, batch)
    t = store.load(tid)
    v = pipeline.view(t)
    still = [x for x in {a["lv_id"] for a in plan["actions"] if a.get("lv_id")}
             if (v["by_lv"].get(x) or {}).get("needs_review")]
    res["still_in_review"] = sorted(still)
    res["text"] = "Done: " + res["text"][:1].lower() + res["text"][1:] if entries else "Nothing changed"
    return res
