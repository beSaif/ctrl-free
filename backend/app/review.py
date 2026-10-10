"""Review trail for the senior estimator ("Changes" screen): who changed what, before → after, the
CHF impact, and whether a senior has approved it.

Sources:
- the audit log (store.append_log): every change by a person or by Assist. Reviews are stored on
  the entry itself (`entry["reviews"]`), and each review is logged as its own entry (action "review").
- AI decisions: one entry per priceable line, synthesised from position.match (product picked,
  method, confidence) and the parser's reading (quantity, unit, page). They are not in the log;
  their reviews live in t["ai_reviews"][lv_id] and only count while the AI's product is unchanged.

State of an entry: "reverted" (undone), "approved" (by a senior, or made/OK'd by a senior), "to_review",
or for a confident AI decision "auto" (shown for traceability, nothing to do).
"""
from __future__ import annotations

import copy
from typing import Any

from . import pipeline, store

SKIP_ACTIONS = {"undo", "review"}
LOW_STATUSES = {"review_required", "assumption_applied"}


class Forbidden(Exception):
    pass


def can_review() -> bool:
    """Only a senior approves or reverts; requests without a person (scripts, tests) may too."""
    a = store.actor()
    return a is None or a.get("role") == "senior"


# ---------------------------------------------------------------- entry helpers


def _types(e: dict) -> list[str]:
    tg = (e.get("target") or {}).get("kind")
    keys = set(e.get("after") or {}) | set(e.get("before") or {})
    if tg == "instruction":
        return ["instruction"]
    if tg == "pricing" or e.get("action") == "pricing_reset":
        return ["pricing"]
    if tg == "quote":
        return ["quotes"]
    if tg != "position":
        return ["tender"]
    out = []
    for path, typ in (("overrides.product_id", "product"), ("overrides.install_code", "product"),
                      ("variant_reason", "product"), ("overrides.unit_price", "price"),
                      ("supplier_quote", "quotes"), ("overrides.quantity", "quantity"),
                      ("overrides.hours", "hours"), ("overrides.status", "line"),
                      ("confirmed", "confirm"), ("flagged", "confirm")):
        if path in keys and typ not in out:
            out.append(typ)
    return out or ["line"]


def _unset(obj: dict, path: str) -> None:
    parts = path.split(".")
    cur: Any = obj
    for part in parts[:-1]:
        cur = cur.get(part) if isinstance(cur, dict) else None
    if isinstance(cur, dict):
        cur.pop(parts[-1], None)


def _apply(obj: dict, values: dict, drop_none: bool = False) -> None:
    for path, val in (values or {}).items():
        if val is None and drop_none:
            _unset(obj, path)
        else:
            store.set_path(obj, path, val)


def _product_label(pid: str | None) -> str | None:
    row = pipeline.catalog().get(pid) if pid else None
    return (row.get("description") or None) if row else None


def _position_fields(t: dict, e: dict, raw: dict) -> tuple[list[dict], dict | None]:
    """Readable before/after per changed field, with what an empty override means (the calculated
    value), and the line-total impact of this change on its own."""
    before, after = e.get("before") or {}, e.get("after") or {}
    pb, pa = copy.deepcopy(raw), copy.deepcopy(raw)
    _apply(pb, before)
    _apply(pa, after)
    try:
        prb, pra = pipeline.price(t, pb), pipeline.price(t, pa)
    except Exception:
        prb = pra = None
    effective = {"overrides.quantity": "quantity", "overrides.unit_price": "net_unit_cost", "overrides.hours": "hours",
                 "overrides.product_id": "product_id"}
    fields = []
    for path in after:
        b, a = before.get(path), after.get(path)
        f: dict[str, Any] = {"path": path}
        if path == "supplier_quote":
            f["path"] = "supplier_quote.unit_price"
            b, a = (b or {}).get("unit_price"), (a or {}).get("unit_price")
        elif path == "confirmed":
            b, a = bool(b), bool(a)
        elif path in effective:
            key = effective[path]
            if b is None and prb:
                b, f["before_calculated"] = prb.get(key), True
            if a is None and pra:
                a, f["after_calculated"] = pra.get(key), True
        if isinstance(a, dict) or isinstance(b, dict):
            continue
        if isinstance(a, list) or isinstance(b, list):
            a, b = ", ".join(map(str, a or [])), ", ".join(map(str, b or []))
        f["before"], f["after"] = b, a
        if path in ("overrides.product_id", "match.product_id"):
            f["before_label"], f["after_label"] = _product_label(b), _product_label(a)
        fields.append(f)
    impact = None
    if prb is not None or pra is not None:
        d = round(float((pra or {}).get("direct") or 0) - float((prb or {}).get("direct") or 0), 2)
        impact = {"value": d, "basis": "line"}
    return fields, impact


def _plain_fields(e: dict) -> list[dict]:
    before, after = e.get("before") or {}, e.get("after") or {}
    # an empty pricing setting means the project-parameter default: show that value
    defaults = pipeline.default_settings() if (e.get("target") or {}).get("kind") == "pricing" else {}
    out = []
    for path, a in after.items():
        if path.startswith("changed_by.") or path.startswith("assist."):
            continue
        b = before.get(path)
        f: dict[str, Any] = {"path": path}
        if defaults and b is None and store.get_path(defaults, path) is not None:
            b, f["before_default"] = store.get_path(defaults, path), True
        if defaults and a is None and store.get_path(defaults, path) is not None:
            a, f["after_default"] = store.get_path(defaults, path), True
        if isinstance(a, dict) or isinstance(b, dict):
            continue
        if isinstance(a, list) or isinstance(b, list):
            a, b = ", ".join(map(str, a or [])), ", ".join(map(str, b or []))
        f["before"], f["after"] = b, a
        out.append(f)
    return out


def _price_of(t: dict) -> float | None:
    tot = pipeline.view(t, use_cache=False)["totals"]
    return tot.get("offer_price") if tot.get("offer_price") is not None else tot.get("standard_price")


def _pricing_impact(t: dict, e: dict) -> dict | None:
    """Price change from this pricing change alone (offer price if chosen, else price at standard margin)."""
    try:
        tb, ta = copy.deepcopy(t), copy.deepcopy(t)
        for x in (tb, ta):
            x["log"] = []
        if (e.get("target") or {}).get("kind") == "pricing":
            tb["pricing"] = tb.get("pricing") or {}
            ta["pricing"] = ta.get("pricing") or {}
            _apply(tb["pricing"], e.get("before"), drop_none=True)
            _apply(ta["pricing"], e.get("after"), drop_none=True)
        else:
            _apply(tb, e.get("before"))
            _apply(ta, e.get("after"))
        b, a = _price_of(tb), _price_of(ta)
        if a is None or b is None:
            return None
        return {"value": round(a - b, 2), "basis": "price"}
    except Exception:
        return None


def _review_record(verdict: str, note: str | None) -> dict:
    a = store.actor()
    return {"verdict": verdict, "note": (note or "").strip() or None, "by": store.me(),
            "actor": a["id"] if a else None, "role": a["role"] if a else None, "at": store.now()}


def _state(e: dict, reviews: list[dict], reverted: dict | None) -> tuple[str, str | None]:
    """(state, why) for a logged change."""
    if e.get("undone"):
        return "reverted", None
    if _repriced_line(e):
        return "auto", "price_list"
    verdicts = [r for r in reviews if r.get("verdict") in ("approved", "reopened")]
    if verdicts and verdicts[-1]["verdict"] == "approved":
        return "approved", None
    if e.get("role") == "senior":
        return "approved", "made_by_senior"
    if e.get("approved_by_role") == "senior":
        return "approved", "ok_by_senior"
    return "to_review", None


def _repriced_line(e: dict) -> bool:
    """A line re-priced because a price list was switched on/off or reordered: a consequence of that one
    decision (reviewed on its tender-level entry), shown for traceability but nothing to approve per line."""
    return e.get("action") == "price_list" and (e.get("target") or {}).get("kind") == "position"


def is_change(e: dict) -> bool:
    return e.get("action") not in SKIP_ACTIONS and bool(e.get("after"))


# ---------------------------------------------------------------- AI decisions


def _ai_low(p: dict) -> bool:
    m = p.get("match") or {}
    if m.get("product_id"):
        return m.get("label") != "Strong"
    return p.get("status") in LOW_STATUSES


def _ai_entries(t: dict, v: dict) -> list[dict]:
    reviews = t.get("ai_reviews") or {}
    at = t.get("read_at") or t.get("created_at")
    out = []
    for p in v["positions"]:
        if p.get("kind") in ("subtotal", "text_only") or p.get("status") == "non_priceable":
            continue
        m = p.get("match") or {}
        pid = m.get("product_id")
        low = _ai_low(p)
        rv = [r for r in reviews.get(p["lv_id"]) or [] if r.get("product_id") == pid]
        verdicts = [r for r in rv if r.get("verdict") in ("approved", "reopened")]
        approved = bool(verdicts) and verdicts[-1]["verdict"] == "approved"
        method = m.get("method") or "rules"
        out.append({
            "id": f"ai:{p['lv_id']}", "at": at, "by": "AI", "action": "ai_match", "lv_id": p["lv_id"],
            "target": {"kind": "position", "id": p["lv_id"]}, "types": ["product"], "undoable": False,
            "text": m.get("reason") or None,
            "fields": [
                {"path": "match.product_id", "before": None, "after": pid, "after_label": _product_label(pid)},
                {"path": "quantity", "before": None, "after": p.get("quantity"), "unit": p.get("unit")},
            ],
            "ai": {"method": "llm" if method in ("llm", "cache") else method, "confidence": m.get("confidence"),
                   "label": m.get("label"), "low": low, "page": p.get("page"), "unit": p.get("unit"),
                   "assumptions": m.get("assumptions") or []},
            "impact": {"value": float((p.get("pricing") or {}).get("direct") or 0), "basis": "line_total"},
            "reviews": rv,
            "state": "approved" if approved else "to_review" if low else "auto",
        })
    return out


# ---------------------------------------------------------------- views


def changes(t: dict) -> dict:
    """Every change (people, Assist) plus the AI decisions, newest first, with lines and counts."""
    v = pipeline.view(t)
    log = t.get("log") or []
    undo_of = {e["undoes"]: e for e in log if e.get("action") == "undo" and e.get("undoes")}
    raw_by_lv = {p["lv_id"]: p for p in t.get("positions") or []}
    entries = []
    for e in reversed(log):
        if not is_change(e):
            continue
        tg = e.get("target") or {}
        out = {k: e.get(k) for k in ("id", "at", "by", "actor", "role", "approved_by", "approved_by_role", "action",
                                     "lv_id", "target", "text", "batch")}
        out["types"] = _types(e)
        out["undoable"] = bool(e.get("undoable", True)) and not e.get("undone")
        if e.get("action") == "price_list":
            out["fields"] = _plain_fields(e)
            d = e.get("direct_delta")
            out["impact"] = {"value": d, "basis": "line" if tg.get("kind") == "position" else "direct"} if d is not None else None
        elif tg.get("kind") == "position" and tg.get("id") in raw_by_lv:
            out["fields"], out["impact"] = _position_fields(t, e, raw_by_lv[tg["id"]])
        else:
            out["fields"] = _plain_fields(e)
            out["impact"] = _pricing_impact(t, e) if "pricing" in out["types"] else None
        if tg.get("kind") == "instruction":
            ins = store.resolve_target(t, "instruction", tg.get("id")) or {}
            out["instruction"] = {"id": ins.get("id"), "type": ins.get("type"), "page": ins.get("page")}
        u = undo_of.get(e["id"])
        out["reverted"] = {"by": u.get("by"), "at": u.get("at")} if u else None
        out["reviews"] = e.get("reviews") or []
        out["state"], out["state_why"] = _state(e, out["reviews"], out["reverted"])
        entries.append(out)
    ai = _ai_entries(t, v)
    lines = {}
    for e in entries + ai:
        x = e.get("lv_id")
        p = v["by_lv"].get(x) if x else None
        if p and x not in lines:
            lines[x] = {"lv_id": x, "title_en": p.get("title_en"), "title_de": p.get("title_de"), "page": p.get("page"),
                        "system": p.get("system"), "status": p.get("status"), "unit": p.get("unit"),
                        "direct": float((p.get("pricing") or {}).get("direct") or 0)}
    a = store.actor()
    return {"entries": entries + ai, "lines": lines, "summary": summary(t, v, entries, ai),
            "me": {"name": store.me(), "role": a["role"] if a else None, "can_review": can_review()}}


def summary(t: dict, v: dict | None = None, entries: list[dict] | None = None, ai: list[dict] | None = None) -> dict:
    """Counts for the Overview, the export checklist and the screen's header."""
    if entries is None:
        log = t.get("log") or []
        entries = []
        for e in log:
            if is_change(e):
                st, _ = _state(e, e.get("reviews") or [], None)
                entries.append({"by": e.get("by"), "state": st})
    if ai is None:
        v = v or pipeline.view(t)
        ai = _ai_entries(t, v)
    by_actor: dict[str, dict] = {}
    for e in entries + ai:
        a = by_actor.setdefault(e["by"], {"by": e["by"], "total": 0, "to_review": 0, "approved": 0, "reverted": 0})
        a["total"] += 1
        if e["state"] in a:
            a[e["state"]] += 1
    count = lambda xs, st: sum(1 for e in xs if e["state"] == st)  # noqa: E731
    return {
        "changes": len(entries), "to_review": count(entries, "to_review"), "approved": count(entries, "approved"),
        "reverted": count(entries, "reverted"),
        "ai": len(ai), "ai_to_review": count(ai, "to_review"), "ai_approved": count(ai, "approved"),
        "by_actor": sorted(by_actor.values(), key=lambda a: (a["by"] != "AI", a["by"] != "Assist", a["by"])),
    }


# ---------------------------------------------------------------- reviews


def review(t: dict, log_id: str, verdict: str, note: str | None = None) -> dict:
    """Approve, revert (the existing undo) or comment on one change; the review itself is logged."""
    if verdict not in ("approved", "reverted", "comment", "reopened"):
        raise ValueError(f"Unknown verdict {verdict}")
    if verdict != "comment" and not can_review():
        raise Forbidden("Only a senior estimator can approve or revert changes")
    if verdict == "comment" and not (note or "").strip():
        raise ValueError("Write a comment first")
    rec = _review_record(verdict, note)
    words = {"approved": "Approved", "reverted": "Reverted", "comment": "Commented on", "reopened": "Reopened"}[verdict]
    if log_id.startswith("ai:"):
        lv_id = log_id[3:]
        pos = store.resolve_target(t, "position", lv_id)
        if pos is None:
            raise store.NotFound(log_id)
        if verdict == "reverted":
            raise ValueError("An AI decision cannot be reverted here: change the product on the line instead")
        pid = (pos.get("match") or {}).get("product_id")
        rec["product_id"] = pid
        t.setdefault("ai_reviews", {}).setdefault(lv_id, []).append(rec)
        le = store.append_log(t, store.me(), "review", target=("position", lv_id), undoable=False,
                              text=f"{words} the AI decision for {lv_id}" + (f": {rec['note']}" if rec["note"] else ""))
        le.update({"review_of": log_id, "verdict": verdict, "note": rec["note"]})
        return rec
    e = next((x for x in t.get("log") or [] if x["id"] == log_id), None)
    if e is None or not is_change(e):
        raise store.NotFound(log_id)
    if verdict == "reverted":
        from . import assist

        undone = store.undo(t, log_id)
        assist.reopen_after_undo(t, undone)
    tg = e.get("target") or {}
    e.setdefault("reviews", []).append(rec)
    le = store.append_log(t, store.me(), "review", target=(tg.get("kind"), tg.get("id")), lv_id=e.get("lv_id"),
                          undoable=False,
                          text=f"{words}: {e.get('text') or e.get('action')}" + (f" ({rec['note']})" if rec["note"] else ""))
    le.update({"review_of": log_id, "verdict": verdict, "note": rec["note"]})
    return rec
