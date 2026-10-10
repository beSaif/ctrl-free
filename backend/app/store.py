"""JSON-file persistence per tender, plus the audit log.

Layout: config.TENDERS_DIR/<id>/{tender.pdf, state.json, pages.json, pages/}
- state.json   the Tender document (docs/SPEC.md data model)
- pages.json   {page: text} from the parser (kept out of state.json to keep it small)
- pages/       rendered page PNG cache

Every write goes through `edit(tid)` (lock per tender, atomic replace). Reads use a
small in-process cache keyed on the file's mtime and return deep copies, so callers may
freely add computed fields to what they get back.
"""
from __future__ import annotations

import contextvars
import copy
import json
import os
import secrets
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from . import config

_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()
_cache: dict[str, tuple[int, dict]] = {}


class NotFound(KeyError):
    pass


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def new_id(prefix: str = "t_") -> str:
    return prefix + secrets.token_hex(3)


# ---------------------------------------------------------------- who is acting
# The API middleware sets the current person from the X-Actor header (config.PEOPLE). Code that
# writes by="You" is attributed to that person automatically; without a known header it stays "You".

_actor: contextvars.ContextVar[dict | None] = contextvars.ContextVar("actor", default=None)


def person(actor_id: str | None) -> dict | None:
    return next((p for p in config.PEOPLE if p["id"] == actor_id), None) if actor_id else None


def set_actor(actor_id: str | None) -> contextvars.Token:
    return _actor.set(person(actor_id))


def reset_actor(token: contextvars.Token) -> None:
    _actor.reset(token)


def actor() -> dict | None:
    """The person behind the current request ({id, name, role, role_label}), None for "You"."""
    return _actor.get()


def me() -> str:
    """Display name to stamp into data (confirmed.by, sent_by, changed_by ...)."""
    a = _actor.get()
    return a["name"] if a else "You"


def _who(by: str | None) -> str | None:
    return me() if by == "You" else by


def lock(tid: str) -> threading.RLock:
    with _locks_guard:
        if tid not in _locks:
            _locks[tid] = threading.RLock()
        return _locks[tid]


def tender_dir(tid: str) -> Path:
    if not tid or "/" in tid or ".." in tid:
        raise NotFound(tid)
    return config.TENDERS_DIR / tid


def pdf_path(tid: str) -> Path:
    return tender_dir(tid) / "tender.pdf"


def state_path(tid: str) -> Path:
    return tender_dir(tid) / "state.json"


def exists(tid: str) -> bool:
    try:
        return state_path(tid).exists()
    except NotFound:
        return False


def list_ids() -> list[str]:
    if not config.TENDERS_DIR.exists():
        return []
    return sorted(p.name for p in config.TENDERS_DIR.iterdir() if (p / "state.json").exists())


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{threading.get_ident()}.tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _read(tid: str) -> dict:
    path = state_path(tid)
    try:
        mtime = path.stat().st_mtime_ns
    except FileNotFoundError:
        raise NotFound(tid) from None
    hit = _cache.get(tid)
    if hit and hit[0] == mtime:
        return hit[1]
    data = json.loads(path.read_text("utf-8"))
    _cache[tid] = (mtime, data)
    return data


def load(tid: str) -> dict:
    """A private deep copy of the tender state."""
    with lock(tid):
        return copy.deepcopy(_read(tid))


def save(t: dict, by: str | None = None, touch: bool = True) -> None:
    tid = t["id"]
    with lock(tid):
        t["rev"] = int(t.get("rev") or 0) + 1
        if touch:
            t["updated_at"] = now()
            if by:
                t["updated_by"] = _who(by)
        raw = json.dumps(t, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        _atomic_write(state_path(tid), raw)
        _cache[tid] = (state_path(tid).stat().st_mtime_ns, copy.deepcopy(t))


@contextmanager
def edit(tid: str, by: str | None = "You", touch: bool = True) -> Iterator[dict]:
    """Load-modify-save under the tender lock. Raise inside the block to abort the save."""
    with lock(tid):
        t = copy.deepcopy(_read(tid))
        yield t
        save(t, by=by, touch=touch)


def create(pdf_bytes: bytes, file_name: str, fields: dict[str, Any] | None = None) -> dict:
    tid = new_id()
    while tender_dir(tid).exists():
        tid = new_id()
    d = tender_dir(tid)
    d.mkdir(parents=True)
    _atomic_write(d / "tender.pdf", pdf_bytes)
    fields = {k: v for k, v in (fields or {}).items() if v not in (None, "")}
    ts = now()
    t = {
        "id": tid,
        "name": fields.get("name") or Path(file_name).stem,
        "client": fields.get("client"),
        "trade": fields.get("trade"),
        "file_name": file_name,
        "page_count": None,
        "file_size": len(pdf_bytes),
        "due_at": fields.get("due_at"),
        "meta_sources": {},
        "submission_rule": None,
        "award_criteria": [],
        "status": "reading",
        "progress": {"stage": "queued", "page": 0, "pages": 0, "done": 0, "total": 0, "message": "Waiting to read"},
        "warnings": [],
        "created_at": ts,
        "updated_at": ts,
        "updated_by": me(),
        "profile": fields.get("profile") or "school",
        # fields the user typed; the pipeline never overwrites these
        "user_fields": sorted(k for k in ("name", "client", "trade", "due_at", "profile") if k in fields),
        "systems": [],
        "positions": [],
        "instructions": [],
        "pricing": None,
        "submission": None,
        "outcome": None,
        "quote_requests": [],
        "assist": {"proposals": [], "plans": {}},
        "exported": {},
        "log": [],
        "rev": 0,
    }
    save(t, touch=False)
    return t


def delete(tid: str) -> None:
    import shutil

    with lock(tid):
        shutil.rmtree(tender_dir(tid), ignore_errors=True)
        _cache.pop(tid, None)


# ---------------------------------------------------------------- pages text


def save_pages_text(tid: str, pages_text: dict) -> None:
    raw = json.dumps({str(k): v for k, v in (pages_text or {}).items()}, ensure_ascii=False).encode("utf-8")
    _atomic_write(tender_dir(tid) / "pages.json", raw)


def load_pages_text(tid: str) -> dict[int, str]:
    p = tender_dir(tid) / "pages.json"
    if not p.exists():
        return {}
    return {int(k): v for k, v in json.loads(p.read_text("utf-8")).items()}


# ---------------------------------------------------------------- audit log
# A LogEntry records one change on one target:
#   {id, at, by, action, lv_id?, target: {kind: position|instruction|pricing|tender|quote, id},
#    before: {path: value}, after: {path: value}, undoable, batch?, undone?}
# `before`/`after` map dotted paths (relative to the target object) to values, so undo is
# generic: write every `before` value back.


def get_path(obj: dict, path: str, default: Any = None) -> Any:
    cur: Any = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def set_path(obj: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        if not isinstance(cur.get(part), dict):
            cur[part] = {}
        cur = cur[part]
    cur[parts[-1]] = copy.deepcopy(value)


def resolve_target(t: dict, kind: str, ident: str | None) -> dict | None:
    if kind == "position":
        return next((p for p in t["positions"] if p["lv_id"] == ident), None)
    if kind == "instruction":
        return next((i for i in t["instructions"] if i["id"] == ident), None)
    if kind == "quote":
        return next((q for q in t.get("quote_requests") or [] if q.get("id") == ident), None)
    if kind == "pricing":
        if t.get("pricing") is None:
            t["pricing"] = {}
        return t["pricing"]
    if kind == "tender":
        return t
    return None


def append_log(
    t: dict,
    by: str,
    action: str,
    *,
    target: tuple[str, str | None],
    before: dict | None = None,
    after: dict | None = None,
    lv_id: str | None = None,
    undoable: bool = True,
    batch: str | None = None,
    text: str | None = None,
) -> dict:
    kind, ident = target
    by = _who(by)
    entry = {
        "id": new_id("l_"),
        "at": now(),
        "by": by,
        "action": action,
        "text": text,
        "lv_id": lv_id if lv_id is not None else (ident if kind == "position" else None),
        "target": {"kind": kind, "id": ident},
        "before": copy.deepcopy(before or {}),
        "after": copy.deepcopy(after or {}),
        "undoable": undoable,
    }
    if batch:
        entry["batch"] = batch
    a = actor()
    if a and by == a["name"]:
        entry["actor"], entry["role"] = a["id"], a["role"]
    elif a and by == "Assist" and undoable:
        # an Assist change is applied when a person says OK: record who
        entry["approved_by"], entry["approved_by_role"] = a["name"], a["role"]
    t.setdefault("log", []).append(entry)
    return entry


def change(
    t: dict,
    by: str,
    action: str,
    kind: str,
    ident: str | None,
    updates: dict[str, Any],
    *,
    batch: str | None = None,
    text: str | None = None,
    undoable: bool = True,
) -> dict | None:
    """Apply {path: value} to a target and log before/after. Returns the entry (None if no-op)."""
    obj = resolve_target(t, kind, ident)
    if obj is None:
        raise NotFound(f"{kind} {ident}")
    before, after = {}, {}
    for path, value in updates.items():
        old = get_path(obj, path)
        if old == value:
            continue
        before[path] = copy.deepcopy(old)
        after[path] = copy.deepcopy(value)
        set_path(obj, path, value)
    if not after:
        return None
    return append_log(t, by, action, target=(kind, ident), before=before, after=after,
                      batch=batch, text=text, undoable=undoable)


def undo(t: dict, log_id: str, by: str = "You") -> list[dict]:
    """Restore `before` for a log entry (and every entry of its batch). Returns undo entries."""
    entry = next((e for e in t.get("log", []) if e["id"] == log_id), None)
    if entry is None:
        raise NotFound(log_id)
    if not entry.get("undoable", True):
        raise ValueError("This change cannot be undone")
    if entry.get("undone"):
        raise ValueError("Already undone")
    group = [e for e in t["log"] if entry.get("batch") and e.get("batch") == entry["batch"] and not e.get("undone")] or [entry]
    out = []
    for e in reversed(group):
        tg = e.get("target") or {}
        obj = resolve_target(t, tg.get("kind"), tg.get("id"))
        if obj is None:
            continue
        for path, value in (e.get("before") or {}).items():
            set_path(obj, path, value)
        e["undone"] = True
        out.append(append_log(
            t, by, "undo", target=(tg.get("kind"), tg.get("id")), lv_id=e.get("lv_id"),
            before=e.get("after"), after=e.get("before"), undoable=False,
            text=f"Undid: {e.get('text') or e.get('action')}",
        ))
        out[-1]["undoes"] = e["id"]
    return out
