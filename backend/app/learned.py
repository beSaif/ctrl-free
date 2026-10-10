"""Learned matches: what estimators chose, remembered across tenders.

When an estimator changes a line's product, confirms a Weak/Close match (or one with an assumption), or
sets a product on an unmatched line, a rule is recorded: tender wording signature -> product (+ install
rule if they overrode it). New tenders consult the rules after the matcher: a line with the same signature
gets the taught product with method "learned"; the code/LLM pick stays in the candidate list.

    signature(position) -> (sig_id, parts, label)          type + key attributes + unit, never the LV id
    record_patch(t, lv_id, entries)                          learn from the log entries one PATCH made
    retract(log_ids)                                         undo: forget what those entries taught
    apply_rules(tid, positions, matches) -> matches          pipeline: learned rules come first
    similar(t, v, lv_id) / apply_similar(tid, lv_id, by)     "Apply to N similar lines in this tender"
    rules_view() / set_enabled(rid, on) / delete(rid)        Reference -> Learned matches

A rule is one (signature, product) pair with evidence entries {kind: taught|confirmed|applied|overridden,
tender_id, tender_name, lv_id, page, by, at, log_id}; the counters are derived from the evidence, so an
undo removes exactly what it taught. Per signature the rule with the best record applies; a rule
overridden more often than confirmed stops applying (teaching counts as the first confirmation).

Store: learned.json next to the tenders folder (it survives deleting a tender, and a test that points
TENDERS_DIR at a temp folder gets its own empty store). LEARNED_PATH or PATH_OVERRIDE change the place.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from . import config, matcher, store

PATH_OVERRIDE: Path | None = None
_lock = threading.RLock()
LEARNED_CONFIDENCE = 0.95
KEEP = ("taught", "confirmed")
SKIP_KINDS = ("text_only", "subtotal")


def store_path() -> Path:
    if PATH_OVERRIDE:
        return Path(PATH_OVERRIDE)
    if os.getenv("LEARNED_PATH"):
        return Path(os.environ["LEARNED_PATH"])
    return config.TENDERS_DIR.parent / "learned.json"


def _load() -> dict:
    p = store_path()
    if not p.exists():
        return {"rules": []}
    try:
        data = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return {"rules": []}
    return data if isinstance(data.get("rules"), list) else {"rules": []}


def _save(data: dict) -> None:
    p = store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.{threading.get_ident()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, p)


def load_rules() -> list[dict]:
    with _lock:
        return copy.deepcopy(_load()["rules"])


# ---------------------------------------------------------------- signature


def _head(position: dict) -> str:
    first = str(position.get("text_de") or position.get("title_de") or "").strip().split("\n", 1)[0]
    return re.sub(r"[^a-z0-9äöü]+", " ", first.lower()).strip()


def signature(position: dict) -> tuple[str, dict, str]:
    """(id, parts, label) of the tender wording: what kind of item, its key attributes and the unit."""
    a = matcher.normalize(position)
    unit = matcher.canon_unit(position.get("unit") or position.get("unit_raw"))
    size = None
    if a.get("dn_mm"):
        size = f"DN{a['dn_mm']}"
    elif a.get("dims_mm"):
        size = "x".join(str(int(v)) for v in sorted(a["dims_mm"], reverse=True)) + " mm"
    elif a.get("thickness_mm"):
        size = f"{a['thickness_mm']} mm thick"
    parts: dict[str, Any] = {
        "type": a.get("type"), "flow": a.get("flow"), "size": size,
        "length_mm": a.get("length_mm"), "fire": (a.get("fire_class") or "")[:4] or None,
        "angle": a.get("angle_deg"), "material": a.get("material"), "unit": unit,
    }
    if not size and a.get("airflow_m3h"):
        parts["airflow"] = a["airflow_m3h"]
    if not a.get("type"):
        parts["head"] = _head(position)  # no type read: the heading words are the signature
    parts = {k: v for k, v in parts.items() if v not in (None, "", [])}
    key = json.dumps(parts, sort_keys=True, ensure_ascii=False)
    sid = "s_" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
    label_bits = [parts.get("type") or f"«{parts.get('head', '')}»", parts.get("flow") and f"{parts['flow']} air",
                  parts.get("material"), parts.get("size"),
                  parts.get("length_mm") and f"L {int(parts['length_mm'])} mm", parts.get("fire"),
                  parts.get("angle") and f"{parts['angle']}°",
                  parts.get("airflow") and f"{parts['airflow']:,.0f} m³/h".replace(",", "'"),
                  parts.get("unit") and f"per {parts['unit']}"]
    return sid, parts, " · ".join(str(b) for b in label_bits if b)


def _rule_id(sid: str, product_id: str) -> str:
    return "r_" + hashlib.sha1(f"{sid}|{product_id}".encode("utf-8")).hexdigest()[:8]


# ---------------------------------------------------------------- counters / views


def counts(rule: dict) -> dict:
    ev = rule.get("evidence") or []
    c = {"times_confirmed": sum(1 for e in ev if e.get("kind") in KEEP),
         "times_overridden": sum(1 for e in ev if e.get("kind") == "overridden"),
         "times_applied": sum(1 for e in ev if e.get("kind") == "applied")}
    c["active"] = bool(rule.get("enabled", True)) and c["times_overridden"] <= c["times_confirmed"] and c["times_confirmed"] > 0
    return c


def source(rule: dict) -> dict | None:
    """Who taught the rule, where and when: the first teaching."""
    ev = [e for e in rule.get("evidence") or [] if e.get("kind") in KEEP]
    if not ev:
        return None
    e = min(ev, key=lambda x: x.get("at") or "")
    return {k: e.get(k) for k in ("tender_id", "tender_name", "lv_id", "page", "by", "at")}


def best_rule(sid: str, rules: list[dict]) -> dict | None:
    """The rule that applies for a signature: active, best record (confirmed - overridden), latest taught."""
    cands = [(r, counts(r)) for r in rules if r.get("signature") == sid]
    cands = [(r, c) for r, c in cands if c["active"]]
    if not cands:
        return None
    return max(cands, key=lambda rc: (rc[1]["times_confirmed"] - rc[1]["times_overridden"],
                                      max((e.get("at") or "") for e in rc[0].get("evidence") or [{}])))[0]


def _date(iso: str | None) -> str:
    try:
        return datetime.fromisoformat(iso or "").strftime("%-d %b %Y")
    except ValueError:
        return iso or ""


def learned_reason(src: dict) -> str:
    return (f"Learned from {src.get('tender_name') or src.get('tender_id')} {src.get('lv_id')}, "
            f"chosen by {src.get('by') or 'an estimator'} on {_date(src.get('at'))}")


# ---------------------------------------------------------------- recording


def _evidence(kind: str, t: dict, pos: dict, by: str | None, log_id: str | None) -> dict:
    return {"kind": kind, "tender_id": t.get("id"), "tender_name": t.get("name"), "lv_id": pos.get("lv_id"),
            "page": pos.get("page"), "by": by or "You", "at": store.now(), "log_id": log_id}


def _same_line(e: dict, t: dict, pos: dict) -> bool:
    return e.get("tender_id") == t.get("id") and e.get("lv_id") == pos.get("lv_id")


def _add(data: dict, t: dict, pos: dict, product_id: str, kind: str, by: str | None, log_id: str | None,
         install_code: str | None = None, note: str | None = None) -> dict:
    """Add evidence to the (signature, product) rule; one entry per line and kind group, so changing and then
    confirming the same line counts once."""
    sid, parts, label = signature(pos)
    rid = _rule_id(sid, product_id)
    rule = next((r for r in data["rules"] if r["id"] == rid), None)
    if rule is None:
        rule = {"id": rid, "signature": sid, "sig": parts, "label": label,
                "wording_de": pos.get("title_de") or _head(pos), "text_de": str(pos.get("text_de") or "")[:600],
                "unit": parts.get("unit"), "product_id": product_id, "install_code": None, "note": None,
                "enabled": True, "created_at": store.now(), "evidence": []}
        data["rules"].append(rule)
    if install_code:
        rule["install_code"] = install_code
    if note:
        rule["note"] = note
    group = KEEP if kind in KEEP else (kind,)
    if not any(e.get("kind") in group and _same_line(e, t, pos) for e in rule["evidence"]):
        rule["evidence"].append(_evidence(kind, t, pos, by, log_id))
    rule["updated_at"] = store.now()
    return rule


def _forget_line(data: dict, t: dict, pos: dict, kinds=KEEP, product_id: str | None = None) -> None:
    for r in data["rules"]:
        if product_id and r["product_id"] != product_id:
            continue
        r["evidence"] = [e for e in r.get("evidence") or [] if not (e.get("kind") in kinds and _same_line(e, t, pos))]
    _prune(data)


def _prune(data: dict) -> None:
    """A rule nobody taught or confirmed any more is gone."""
    data["rules"] = [r for r in data["rules"] if any(e.get("kind") in KEEP for e in r.get("evidence") or [])]


def _teachable(pos: dict) -> bool:
    """A confirmation teaches when the match needed the estimator: not a plain Strong code match."""
    m = pos.get("match") or {}
    return m.get("method") == "learned" or m.get("label") in ("Weak", "Close", "None") or bool(m.get("assumptions"))


def record_patch(t: dict, lv_id: str, entries: list[dict]) -> list[str]:
    """Learn from the log entries one PATCH of a line added (the entry's `by` is who taught it).
    Returns the ids of the rules touched."""
    pos = store.resolve_target(t, "position", lv_id)
    if pos is None or pos.get("kind") in SKIP_KINDS:
        return []
    m = pos.get("match") or {}
    learned_from = (m.get("learned") or {}).get("rule_id") if m.get("method") == "learned" else None
    touched: list[str] = []
    with _lock:
        data = _load()
        for e in entries:
            if e.get("lv_id") != lv_id or e.get("action") == "undo":
                continue
            after, before, by = e.get("after") or {}, e.get("before") or {}, e.get("by")
            act = e.get("action")
            if act == "reset":
                _forget_line(data, t, pos)
                continue
            if act == "unconfirm":
                _forget_line(data, t, pos, kinds=("confirmed",))
                continue
            if "overrides.product_id" in after:
                new = after["overrides.product_id"]
                old = before.get("overrides.product_id")
                if old and old != new:
                    _forget_line(data, t, pos, product_id=old)  # the estimator changed their mind on this line
                if new and new != m.get("product_id"):
                    if learned_from:
                        r = next((r for r in data["rules"] if r["id"] == learned_from), None)
                        if r is not None and not any(x.get("kind") == "overridden" and _same_line(x, t, pos)
                                                     for x in r["evidence"]):
                            r["evidence"].append(_evidence("overridden", t, pos, by, e.get("id")))
                            touched.append(r["id"])
                    ic = (pos.get("overrides") or {}).get("install_code")
                    touched.append(_add(data, t, pos, new, "taught", by, e.get("id"), ic, pos.get("variant_reason"))["id"])
                elif new is None and m.get("product_id") and _teachable(pos) and act == "edit":
                    # back to the suggested product, chosen explicitly
                    touched.append(_add(data, t, pos, m["product_id"], "confirmed", by, e.get("id"))["id"])
            elif after.get("overrides.install_code"):
                pid = (pos.get("overrides") or {}).get("product_id") or m.get("product_id")
                if pid:
                    touched.append(_add(data, t, pos, pid, "taught", by, e.get("id"), after["overrides.install_code"])["id"])
            if act == "confirm":
                pid = (pos.get("overrides") or {}).get("product_id") or m.get("product_id")
                if pid and ((pos.get("overrides") or {}).get("product_id") or _teachable(pos)):
                    touched.append(_add(data, t, pos, pid, "confirmed", by, e.get("id"),
                                        (pos.get("overrides") or {}).get("install_code"))["id"])
        _prune(data)
        _save(data)
    return touched


def retract(log_ids: list[str]) -> int:
    """Forget the evidence those log entries added (after an undo). Returns how many entries were removed."""
    ids = {x for x in log_ids if x}
    if not ids:
        return 0
    with _lock:
        data = _load()
        n = 0
        for r in data["rules"]:
            before = len(r.get("evidence") or [])
            r["evidence"] = [e for e in r.get("evidence") or [] if e.get("log_id") not in ids]
            n += before - len(r["evidence"])
        if n:
            _prune(data)
            _save(data)
        return n


# ---------------------------------------------------------------- applying (pipeline)


def apply_rules(tid: str, positions: list[dict], matches: dict[str, dict], rows_by_id: dict[str, dict] | None = None,
                tender_name: str | None = None) -> dict[str, dict]:
    """Matches with learned rules applied first. The code/LLM pick is kept as `rules_pick` and stays in the
    candidate list. Only lines where the rule changes something (product, install rule, or a match that
    needed review) are marked learned."""
    from . import equivalence

    with _lock:
        data = _load()
        rules = data["rules"]
        if not rules:
            return matches
        if rows_by_id is None:
            rows_by_id = {r["product_id"]: r for r in matcher.load_catalog()}
        by_lv = {p["lv_id"]: p for p in positions}
        out = dict(matches)
        t_stub = {"id": tid, "name": tender_name}
        applied = 0
        for p in positions:
            lv = p["lv_id"]
            m = matches.get(lv)
            if m is None or p.get("kind") in SKIP_KINDS:
                continue
            sid, _parts, _label = signature(p)
            rule = best_rule(sid, rules)
            if rule is None:
                continue
            row = rows_by_id.get(rule["product_id"])
            unit = matcher.canon_unit(p.get("unit") or p.get("unit_raw"))
            if row is None or (unit and row.get("unit") and row["unit"] != unit):
                continue  # product gone from the catalogue, or sold per another unit
            ic = rule.get("install_code") or row.get("install_code")
            needed_review = m.get("label") != "Strong" or bool(m.get("assumptions"))
            if m.get("product_id") == rule["product_id"] and m.get("install_code") == ic and not needed_review:
                continue  # the code already gets it right: nothing learned to show
            src = source(rule) or {}
            c = counts(rule)
            cands = [dict(x) for x in m.get("candidates") or []]
            for x in cands:
                if x.get("product_id") == m.get("product_id") and m.get("product_id") != rule["product_id"]:
                    x["tag"] = "rules_pick"
            mine = next((x for x in cands if x.get("product_id") == rule["product_id"]), None)
            if mine is None:
                mine = {"product_id": rule["product_id"], "score": None}
                cands.insert(0, mine)
            mine["why"] = learned_reason(src)
            mine["tag"] = "learned"
            new = {**m, "product_id": rule["product_id"], "install_code": ic,
                   "confidence": LEARNED_CONFIDENCE, "label": "Strong", "method": "learned",
                   "reason": learned_reason(src), "assumptions": [], "candidates": cands,
                   "learned": {"rule_id": rule["id"], **src, "times_confirmed": c["times_confirmed"],
                               "times_overridden": c["times_overridden"]},
                   "rules_pick": {k: m.get(k) for k in ("product_id", "label", "confidence", "reason", "method")}}
            new.pop("llm_disagreed", None)
            new.pop("llm_notes", None)
            out[lv] = equivalence.annotate(p, new, rows_by_id, by_lv.get(p.get("parent_lv_id")))
            if not any(e.get("kind") == "applied" and e.get("tender_id") == tid and e.get("lv_id") == lv
                       for e in rule["evidence"]):
                rule["evidence"].append(_evidence("applied", t_stub, p, "Assist", None))
            applied += 1
        if applied:
            _save(data)
        return out


# ---------------------------------------------------------------- similar lines in the same tender


def _effective(p: dict) -> str | None:
    return (p.get("overrides") or {}).get("product_id") or (p.get("match") or {}).get("product_id")


def similar(t: dict, lv_id: str, needs_review: dict[str, bool] | None = None) -> dict | None:
    """Lines of this tender with the same wording signature that differ from what the estimator decided on
    this line: another product, or still open while this one is confirmed. Only after a decision on this line
    (a product chosen, or the line confirmed); confirmed lines are left alone."""
    pos = store.resolve_target(t, "position", lv_id)
    if pos is None or pos.get("kind") in SKIP_KINDS:
        return None
    pid = _effective(pos)
    if not pid or not ((pos.get("overrides") or {}).get("product_id") or pos.get("confirmed")):
        return None
    sid, _parts, label = signature(pos)
    review = needs_review or {}
    lv_ids = []
    for p in t.get("positions") or []:
        if p["lv_id"] == lv_id or p.get("kind") in SKIP_KINDS or p.get("confirmed"):
            continue
        other = _effective(p) != pid
        still_open = bool(pos.get("confirmed")) and review.get(p["lv_id"], True)
        if (other or still_open) and signature(p)[0] == sid:
            lv_ids.append(p["lv_id"])
    return {"signature": sid, "label": label, "product_id": pid, "confirm": bool(pos.get("confirmed")),
            "lv_ids": lv_ids, "count": len(lv_ids)}


def apply_similar(tid: str, lv_id: str, by: str = "You", needs_review: dict[str, bool] | None = None) -> dict:
    """Give the similar lines this line's product (and confirm them when this line is confirmed), as one
    undoable batch in the tender log. They count as applications of what this line taught."""
    with store.edit(tid, by=by) as t:
        sim = similar(t, lv_id, needs_review)
        if not sim or not sim["lv_ids"]:
            raise ValueError("No similar lines to apply this to")
        src = store.resolve_target(t, "position", lv_id)
        pid, ic = sim["product_id"], (src.get("overrides") or {}).get("install_code")
        batch = store.new_id("b_")
        first: dict[str, dict] = {}  # lv_id -> its first log entry in the batch
        for x in sim["lv_ids"]:
            p = store.resolve_target(t, "position", x)
            if _effective(p) != pid:
                upd = {"overrides.product_id": None if (p.get("match") or {}).get("product_id") == pid else pid,
                       "overrides.install_code": ic}
                e = store.change(t, by, "edit", "position", x, upd, batch=batch,
                                 text=f"{x}: product → {pid}, as on {lv_id} (same tender wording)")
                if e:
                    first.setdefault(x, e)
            if sim["confirm"]:
                e = store.change(t, by, "confirm", "position", x, {"confirmed": {"by": store.me() if by == "You" else by, "at": store.now()}, "flagged": False},
                                 batch=batch, text=f"Confirmed {x}, as on {lv_id}")
                if e:
                    first.setdefault(x, e)
    with _lock:
        data = _load()
        rule = next((r for r in data["rules"] if r["id"] == _rule_id(signature(src)[0], pid)), None)
        if rule is not None:
            for x, e in first.items():
                p = store.resolve_target(t, "position", x)
                if not any(ev.get("kind") == "applied" and _same_line(ev, t, p) for ev in rule["evidence"]):
                    rule["evidence"].append(_evidence("applied", t, p, e.get("by"), e["id"]))
            _save(data)
    entries = list(first.values())
    return {"applied": len(first), "lv_ids": list(first), "batch": batch,
            "log_id": entries[0]["id"] if entries else None, "product_id": pid}


# ---------------------------------------------------------------- Reference -> Learned matches


def rules_view() -> dict:
    from . import pipeline

    cat = pipeline.catalog()
    tenders: dict[str, tuple[str | None, set[str]] | None] = {}

    def tender(tid: str | None) -> tuple[str | None, set[str]] | None:
        if not tid:
            return None
        if tid not in tenders:
            try:
                t = store.load(tid) if store.exists(tid) else None
                tenders[tid] = (t.get("name"), {p["lv_id"] for p in t.get("positions") or []}) if t else None
            except Exception:  # noqa: BLE001  a corrupt tender must not break the list
                tenders[tid] = None
        return tenders[tid]

    def line_exists(tid: str | None, lv: str | None) -> bool:
        x = tender(tid)
        return bool(x and lv and lv in x[1])

    def name(e: dict) -> str | None:
        x = tender(e.get("tender_id"))
        return (x[0] if x else None) or e.get("tender_name")

    out = []
    for r in load_rules():
        c = counts(r)
        src = source(r) or {}
        row = cat.get(r["product_id"]) or {}
        applied = [e for e in r.get("evidence") or [] if e.get("kind") == "applied"]
        stopped = None
        if not r.get("enabled", True):
            stopped = "disabled"
        elif c["times_overridden"] > c["times_confirmed"]:
            stopped = "overridden"
        out.append({
            "id": r["id"], "signature": r["signature"], "label": r.get("label"), "sig": r.get("sig"),
            "wording_de": r.get("wording_de"), "text_de": r.get("text_de"), "unit": r.get("unit"),
            "product_id": r["product_id"], "install_code": r.get("install_code"), "note": r.get("note"),
            "product": {k: row.get(k) for k in ("description", "manufacturer", "model", "unit", "net_cost_chf",
                                                "install_code")} if row else None,
            "enabled": r.get("enabled", True), **c, "stopped": stopped,
            "from": {**src, "exists": line_exists(src.get("tender_id"), src.get("lv_id"))} if src else None,
            "last_applied_at": max((e.get("at") or "" for e in applied), default=None),
            "created_at": r.get("created_at"), "updated_at": r.get("updated_at"),
            "evidence": [{**{k: e.get(k) for k in ("kind", "tender_id", "lv_id", "page", "by", "at")},
                          "tender_name": name(e), "exists": line_exists(e.get("tender_id"), e.get("lv_id"))}
                         for e in sorted(r.get("evidence") or [], key=lambda e: e.get("at") or "", reverse=True)[:300]],
        })
    out.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return {"rules": out, "counts": {"total": len(out), "active": sum(1 for x in out if x["active"]),
                                     "applied": sum(x["times_applied"] for x in out)}}


def set_enabled(rid: str, enabled: bool) -> dict:
    with _lock:
        data = _load()
        r = next((r for r in data["rules"] if r["id"] == rid), None)
        if r is None:
            raise store.NotFound(rid)
        r["enabled"] = bool(enabled)
        r["updated_at"] = store.now()
        _save(data)
    return next(x for x in rules_view()["rules"] if x["id"] == rid)


def delete(rid: str) -> None:
    with _lock:
        data = _load()
        n = len(data["rules"])
        data["rules"] = [r for r in data["rules"] if r["id"] != rid]
        if len(data["rules"]) == n:
            raise store.NotFound(rid)
        _save(data)


def rule_for(position: dict) -> dict | None:
    """The rule a line's wording maps to now (for the line detail), with its counters."""
    sid = signature(position)[0]
    r = best_rule(sid, load_rules())
    if r is None:
        return None
    return {"id": r["id"], "product_id": r["product_id"], "label": r.get("label"), **counts(r), "from": source(r)}
