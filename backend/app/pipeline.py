"""Background processing of a tender, and the compute-on-read pricing view.

Pipeline (one thread per tender):
  parse (progress per page) -> meta -> translate -> match (progress done/total)
  -> instructions -> quote groups -> status -> ready
Each LLM stage is wrapped: on failure the run continues with a fallback and a warning is
recorded on the tender (`warnings`).

Prices are never stored: `view(t)` prices every position through pricing.py with the
tender's settings and system profile, derives status and needs_review, and builds totals.
The result is memoised per (tender rev, reference version).
"""
from __future__ import annotations

import copy
import importlib
import logging
import threading
import time
import traceback
from typing import Any, Callable

from . import config, store

log = logging.getLogger("ctrlfree.pipeline")

# ---------------------------------------------------------------- module adapters


def mod(name: str):
    """Import app.<name> if it exists (other agents build these in parallel)."""
    try:
        return importlib.import_module(f"app.{name}")
    except ImportError as e:  # module missing (or its own import failed)
        if getattr(e, "name", None) not in (f"app.{name}", name):
            log.warning("app.%s failed to import: %s", name, e)
        return None


def reference():
    return mod("reference")


def catalog() -> dict[str, dict]:
    r = reference()
    return r.load_catalog() if r else {}


def rules() -> dict[str, dict]:
    r = reference()
    return r.load_rules() if r else {}


def reference_version() -> tuple:
    files = [config.REFERENCE_DIR / n for n in ("catalog.csv", "productivity.csv", "project_parameters.json")]
    pl = mod("price_lists")
    return tuple(f.stat().st_mtime_ns if f.exists() else 0 for f in files) + (pl.version() if pl else 0,)


def default_settings() -> dict:
    return reference().default_settings()


def settings_of(t: dict) -> dict:
    return reference().merge_settings(t.get("pricing") or {})


# ---------------------------------------------------------------- pricing on read

STATUSES = ["calculated", "supplier_quote_required", "assumption_applied", "review_required",
            "insufficient_information", "out_of_scope", "non_priceable"]


def system_profile(t: dict, pos: dict) -> str:
    return mod("pricing").position_profile(pos, t.get("systems") or [], t.get("profile") or "school")


def price(t: dict, pos: dict, settings: dict | None = None, product_id: str | None = None) -> dict | None:
    """PositionPrice for one position; `product_id` prices it as if that product were picked."""
    pricing = mod("pricing")
    settings = settings or settings_of(t)
    p = pos
    if product_id is not None:
        p = copy.deepcopy(pos)
        ov = p.setdefault("overrides", {})
        ov["product_id"] = product_id
        ov["install_code"] = None   # the install rule follows the product
        ov["unit_price"] = None
        p["supplier_quote"] = None
    try:
        return pricing.price_position(p, settings, system_profile=system_profile(t, pos))
    except Exception as e:  # never let one bad line break the screen
        log.warning("price_position failed for %s: %s", pos.get("lv_id"), e)
        return None


def price_and_status(t: dict, pos: dict, settings: dict) -> dict:
    """Copy of the position with pricing, status, status_reason, needs_review (pricing.py rules)."""
    pricing = mod("pricing")
    try:
        return pricing.evaluate_position(pos, settings, system_profile(t, pos))
    except Exception as e:
        log.warning("evaluate_position failed for %s: %s", pos.get("lv_id"), e)
        return {**pos, "pricing": None, "status": "review_required",
                "status_reason": f"Could not price this line: {e}", "needs_review": True}


_view_cache: dict[str, tuple[tuple, dict]] = {}
_view_lock = threading.Lock()


def view(t: dict, use_cache: bool = True) -> dict:
    """{positions (priced), totals, settings, by_lv}. Memoised per tender revision.

    Pass use_cache=False for a modified copy (what-if), so the memo is not polluted."""
    key = (t.get("rev"), reference_version())
    hit = _view_cache.get(t["id"]) if use_cache else None
    if hit and hit[0] == key:
        return hit[1]
    settings = settings_of(t)
    positions = [price_and_status(t, p, settings) for p in t.get("positions") or []]
    totals = compute_totals(t, positions, settings)
    out = {"positions": positions, "totals": totals, "settings": settings,
           "by_lv": {p["lv_id"]: p for p in positions}}
    if use_cache:
        with _view_lock:
            _view_cache[t["id"]] = (key, out)
    return out


def compute_totals(t: dict, positions: list[dict], settings: dict) -> dict:
    return mod("pricing").project_totals(positions, settings, t.get("systems") or [], t.get("profile") or "school")


def priced_tender(t: dict) -> dict:
    """The tender with priced positions (what exports and the report consume)."""
    v = view(t)
    out = dict(t)
    out["positions"] = v["positions"]
    out["pricing"] = v["settings"]
    return out


# ---------------------------------------------------------------- the background job

_running: dict[str, threading.Thread] = {}


def is_running(tid: str) -> bool:
    th = _running.get(tid)
    return bool(th and th.is_alive())


def wait(tid: str, timeout: float | None = None) -> bool:
    """Block until the tender's background run finishes. True when nothing is running any more."""
    th = _running.get(tid)
    if th is not None:
        th.join(timeout)
    return not is_running(tid)


def start_processing(tid: str) -> threading.Thread:
    if is_running(tid):
        return _running[tid]
    th = threading.Thread(target=run, args=(tid,), name=f"pipeline-{tid}", daemon=True)
    _running[tid] = th
    th.start()
    return th


def _set_progress(tid: str, **progress) -> None:
    with store.edit(tid, by=None, touch=False) as t:
        t["progress"] = {**(t.get("progress") or {}), **progress}


def _warn(tid: str, stage: str, err: Exception | str) -> None:
    msg = str(err)
    log.warning("pipeline %s %s: %s", tid, stage, msg)
    with store.edit(tid, by=None, touch=False) as t:
        t.setdefault("warnings", []).append({"stage": stage, "message": msg[:500], "at": store.now()})


def _progress_args(args: tuple, kwargs: dict) -> tuple[int, int]:
    """Accept progress(page, pages), progress(done=, total=) or progress({...})."""
    if args and isinstance(args[0], dict):
        d = args[0]
        return int(d.get("page") or d.get("done") or 0), int(d.get("pages") or d.get("total") or 0)
    vals = list(args) + [kwargs.get(k) for k in ("page", "done", "pages", "total") if k in kwargs]
    nums = [int(v) for v in vals if isinstance(v, (int, float))]
    return (nums[0] if nums else 0), (nums[1] if len(nums) > 1 else 0)


def _throttled(fn: Callable[[int, int], None], every: float = 0.25) -> Callable[..., None]:
    last = [0.0]

    def cb(*args, **kwargs):
        a, b = _progress_args(args, kwargs)
        now = time.monotonic()
        if now - last[0] >= every or (b and a >= b):
            last[0] = now
            fn(a, b)
    return cb


def run(tid: str) -> dict:
    """Run the whole pipeline synchronously. Returns timings per stage."""
    timings: dict[str, float] = {}
    t0 = time.monotonic()
    try:
        _run(tid, timings)
    except Exception as e:  # unexpected: mark the tender as failed, keep the trace
        log.exception("pipeline failed for %s", tid)
        with store.edit(tid, by=None, touch=False) as t:
            t["status"] = "error"
            t["progress"] = {**(t.get("progress") or {}), "stage": "error",
                             "message": f"Could not read the tender: {e}"}
            t.setdefault("warnings", []).append({"stage": "pipeline", "message": traceback.format_exc()[-1500:],
                                                 "at": store.now()})
    timings["total"] = round(time.monotonic() - t0, 2)
    with store.edit(tid, by=None, touch=False) as t:
        t["timings"] = timings
    _running.pop(tid, None)
    return timings


def _stage(timings: dict, name: str):
    class _T:
        def __enter__(self):
            self.t = time.monotonic()

        def __exit__(self, *exc):
            timings[name] = round(time.monotonic() - self.t, 2)
            return False
    return _T()


def _rules_only(fn: Callable[[], Any], default: Any) -> Any:
    """Second try of a stage without the LLM (after the LLM path raised); never raises."""
    try:
        return fn() or default
    except Exception as e:  # noqa: BLE001
        log.warning("rules-only fallback failed: %s", e)
        return default


def _run(tid: str, timings: dict) -> None:
    llm = mod("llm")
    if llm is None or not hasattr(llm, "time_budget"):
        return _run_stages(tid, timings)
    # bound the total time spent waiting on a live LLM; after the budget every stage runs on rules
    with llm.time_budget():
        return _run_stages(tid, timings)


def _run_stages(tid: str, timings: dict) -> None:
    pdf = str(store.pdf_path(tid))

    # 1. parse ---------------------------------------------------------
    _set_progress(tid, stage="parsing", message="Reading the tender")
    with _stage(timings, "parse"):
        def on_page(page: int, pages: int):
            _set_progress(tid, stage="parsing", page=page, pages=pages,
                          message=f"Reading p. {page} of {pages}" if pages else f"Reading p. {page}")
        parser = mod("parser")
        if parser is None:
            raise RuntimeError("The PDF parser (app/parser.py) is not available")
        parsed = parser.parse_tender(pdf, progress=_throttled(on_page))
    pages_text = parsed.get("pages_text") or {}
    store.save_pages_text(tid, pages_text)
    positions = parsed.get("positions") or []
    for p in positions:
        p.setdefault("overrides", {})
        p.setdefault("supplier_quote", None)
        p.setdefault("variant_reason", None)
        p.setdefault("confirmed", None)
        p.setdefault("flagged", False)
        p.setdefault("match", None)
    with store.edit(tid, by=None, touch=False) as t:
        t["page_count"] = parsed.get("page_count") or len(pages_text) or t.get("page_count")
        t["systems"] = parsed.get("systems") or []
        t["positions"] = positions
        t["conditions_pages"] = parsed.get("conditions_pages") or []
        if t.get("pricing") is None:
            t["pricing"] = {}
        # the dominant system profile becomes the tender profile unless the user chose one
        if "profile" not in (t.get("user_fields") or []):
            profs = [s.get("profile") for s in t["systems"] if s.get("profile")]
            if profs:
                t["profile"] = max(set(profs), key=profs.count)
        t["progress"] = {**t["progress"], "stage": "meta", "page": t["page_count"], "pages": t["page_count"],
                         "message": f"Read {len(positions)} lines from {t['page_count']} pages"}

    # 2-4. meta and translate run in threads while matching runs here ---------
    results: dict[str, Any] = {}

    def _meta():
        t0 = time.monotonic()
        meta_mod = mod("meta")
        try:
            results["meta"] = (meta_mod.extract_meta(pages_text, pdf=pdf) or {}) if meta_mod else {}
        except Exception as e:
            _warn(tid, "meta", e)
            results["meta"] = _rules_only(lambda: meta_mod.extract_meta(pages_text, pdf=pdf, use_llm=False), {})
        timings["meta"] = round(time.monotonic() - t0, 2)

    def _translate():
        t0 = time.monotonic()
        tr = mod("translate")
        try:
            results["translate"] = (tr.translate_titles(copy.deepcopy(positions)) or {}) if tr else {}
        except Exception as e:
            _warn(tid, "translate", e)
            results["translate"] = _rules_only(lambda: tr.translate_titles(copy.deepcopy(positions), use_llm=False), {})
        timings["translate"] = round(time.monotonic() - t0, 2)

    side = [threading.Thread(target=f, name=f"{f.__name__}-{tid}", daemon=True) for f in (_meta, _translate)]
    for th in side:
        th.start()

    priceable = [p for p in positions if p.get("kind") in (None, "item", "lump_sum")]
    _set_progress(tid, stage="matching", done=0, total=len(priceable),
                  message=f"Matching {len(priceable)} lines to the catalogue")
    with _stage(timings, "match"):
        matcher = mod("matcher")
        matches: dict = {}
        if matcher is not None:
            def on_match(done: int, total: int):
                _set_progress(tid, stage="matching", done=done, total=total,
                              message=f"Matching lines to the catalogue ({done} of {total})")
            try:
                matches = matcher.match_positions(copy.deepcopy(positions), list(catalog().values()),
                                                  progress=_throttled(on_match)) or {}
            except Exception as e:
                _warn(tid, "match", e)
                matches = _rules_only(lambda: matcher.match_positions(copy.deepcopy(positions), list(catalog().values()),
                                                                      use_llm=False), {})
        else:
            _warn(tid, "match", "Matcher not available: lines have no product yet")
    _set_progress(tid, stage="translating", message="Translating line titles")
    for th in side:
        th.join()

    meta = results.get("meta") or {}
    translations = results.get("translate") or {}
    with store.edit(tid, by=None, touch=False) as t:
        user = set(t.get("user_fields") or [])
        for k in ("name", "client", "trade", "due_at"):
            if meta.get(k) and k not in user:
                t[k] = meta[k]
        for k in ("meta_sources", "submission_rule", "award_criteria"):
            if meta.get(k) is not None:
                t[k] = meta[k]
        extra = {k: v for k, v in meta.items() if k not in
                 ("name", "client", "trade", "due_at", "meta_sources", "submission_rule", "award_criteria")}
        if extra:
            t["meta"] = extra
        for p in t["positions"]:
            tx = translations.get(p["lv_id"]) or {}
            for k in ("title_en", "description_en"):
                if tx.get(k):
                    p[k] = tx[k]
            m = matches.get(p["lv_id"])
            if m is not None:
                p["match"] = m
        t["progress"] = {**t["progress"], "stage": "instructions", "message": "Reading the instructions and norms"}
        positions = copy.deepcopy(t["positions"])

    # 5. instructions --------------------------------------------------
    with _stage(timings, "instructions"):
        ins_mod = mod("instructions")
        instructions = []
        if ins_mod is not None:
            try:
                # positions already carry title_en (translate stage), so no `titles` map is needed
                instructions = ins_mod.extract_instructions(pages_text, positions, list(catalog().values()),
                                                            pdf=pdf) or []
            except Exception as e:
                _warn(tid, "instructions", e)
                instructions = _rules_only(lambda: ins_mod.extract_instructions(
                    pages_text, positions, list(catalog().values()), pdf=pdf, use_llm=False), [])
        for i, ins in enumerate(instructions, 1):
            ins.setdefault("id", f"i_{i:02d}")
            ins.setdefault("state", "open")
            ins.setdefault("confirmed_by", None)
            ins.setdefault("confirmed_at", None)
            ins.setdefault("applies_to", [])
        with store.edit(tid, by=None, touch=False) as t:
            t["instructions"] = instructions
            t["progress"] = {**t["progress"], "stage": "pricing", "message": "Pricing every line"}

    # 6. quote groups + drafts ----------------------------------------
    with _stage(timings, "quotes"):
        t = store.load(tid)
        try:
            groups = build_quote_groups(t)
        except Exception as e:
            _warn(tid, "quotes", e)
            groups = []
        with store.edit(tid, by=None, touch=False) as t2:
            t2["quote_requests"] = groups

    # 7. status + done -------------------------------------------------
    with _stage(timings, "pricing"):
        t = store.load(tid)
        v = view(t)
        with store.edit(tid, by=None, touch=False) as t2:
            # status is not written back: reads always derive it afresh (pricing.derive_status)
            n = len(t2["positions"])
            to_review = sum(1 for p in v["positions"] if p["needs_review"])
            priced = v["totals"].get("lines_priced") or 0
            lines = v["totals"].get("lines_priceable") or n
            t2["status"] = "ready"
            t2["progress"] = {**t2["progress"], "stage": "done", "done": n, "total": n,
                              "message": f"{lines} lines, {priced} priced, {to_review} to review"}
            t2["read_at"] = store.now()
            store.append_log(t2, "Assist", "read_tender", target=("tender", tid), undoable=False,
                             text=(f"Read the tender: {lines} lines, {priced} priced, "
                                   f"{len(t2['instructions'])} instructions found"))
            if t2.get("quote_requests"):
                store.append_log(t2, "Assist", "draft_requests", target=("tender", tid), undoable=False,
                                 text=f"Drafted {len(t2['quote_requests'])} supplier requests")


# ---------------------------------------------------------------- quote groups


def build_quote_groups(t: dict) -> list[dict]:
    """Supplier request groups (same product type across systems) with a German draft."""
    v = view(t)
    quotes = mod("quotes")
    positions = v["positions"]
    raw_groups = quotes.group_for_quotes(positions, catalog=list(catalog().values()),
                                         instructions=t.get("instructions") or []) or []
    meta = {k: t.get(k) for k in ("name", "client", "trade", "due_at", "submission_rule")}
    out = []
    for i, g in enumerate(raw_groups, 1):
        g = dict(g)
        lv_ids = g.get("lv_ids") or g.get("positions") or []
        g["lv_ids"] = [x if isinstance(x, str) else x.get("lv_id") for x in lv_ids]
        g.setdefault("id", g.get("key") or f"q_{i}")
        g["id"] = str(g["id"])
        if not g.get("body_de"):
            try:
                draft = quotes.draft_request(meta, g, [v["by_lv"][x] for x in g["lv_ids"] if x in v["by_lv"]],
                                             t.get("instructions") or [])
                g.update(draft or {})
            except Exception as e:
                log.warning("draft_request failed for %s: %s", g["id"], e)
        g.setdefault("subject", f"Anfrage {g.get('title') or ''} - {t.get('name') or ''}".strip())
        g.setdefault("body_de", "")
        g.setdefault("sent_at", None)
        out.append(g)
    return out


def effective_product(p: dict) -> str | None:
    return (p.get("overrides") or {}).get("product_id") or (p.get("match") or {}).get("product_id")
