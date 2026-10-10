"""LLM grouping of the LV line stream: which text lines belong to which quantity line.

The parser finds the lines, columns, units, quantities and page boxes (exact work). Deciding
which description belongs to which quantity line needs reading: planners write "bold title +
quantity, description below" or "description, quantity on its last line", sometimes both in
one section, and only the meaning settles cases like "– als Passlänge –" (a pipe, not the bend
below it). The LLM sees numbered lines with their layout cues and answers with line ids only;
it never retypes text or quantities. Every answer is validated (each quantity line in exactly
one item, each text line used exactly once, only known ids) and cached; a chunk whose answer
fails validation twice is left to the parser's rules.

    plan_groups(stream) -> Plan | None
"""
from __future__ import annotations

import logging
import os
from collections import Counter
from dataclasses import dataclass, field

from . import config, llm

log = logging.getLogger(__name__)

PROMPT_VERSION = "g4"
MODEL = os.getenv("LLM_GROUPING_MODEL") or config.LLM_MODEL_STRONG    # the small model fails the checks
REASONING = os.getenv("LLM_GROUPING_REASONING", "low")
MAX_LINES = 320          # lines per LLM chunk (a section is split after a quantity line beyond this)
CONTEXT_LINES = 25       # read-only lines from the previous chunk of the same section
STRUCT = ("section", "heading", "recap", "total")

SYSTEM = """You read the bill of quantities (Leistungsverzeichnis, LV) of a Swiss building-services \
tender, given as numbered PDF lines in reading order. Group the lines into priced items.

Line format: `id KIND flags | text  [unit qty]`
KIND  Q = quantity line (unit/quantity in the quantity columns). Every Q belongs to exactly one item.
      T = text line: assign it.
      S = section heading, H = heading, X = subtotal/total line: structure, never assign.
      C = context line from before this chunk: never assign.
flags B = starts in a bold font; +Npt = larger font than the body text; >N = indented N pt from the
      text column's left edge; gap before the line: (none) same paragraph, ¶ blank line,
      ¶¶ larger gap, P new page.

How to group:
- An item has one or more Q lines. Several Q lines share one description when they are sizes or
  variants of the same thing (a size table under one description, "B x H" rows, "Grösse" rows) or
  a short list of parts under one lead-in line ("Einbau der folgenden Feldgeräte"): make ONE item
  with all those Q ids and the shared description as its text.
- Planners lay out items differently, sometimes within one section, so decide per item:
  (a) title first: the Q line names the item (often bold or larger) and its description follows
      below it, until the next item starts;
  (b) text first: the description comes first and the Q line is its last line (the sentence runs
      into the Q line, or the Q line is only a size/variant/count).
  Use layout AND meaning: which item does the text actually describe? "– als Passlänge –" describes
  a pipe, not a bend; "wie vorbeschrieben, jedoch …" starts a new item that refers back to the
  previous one; a lower-case line usually continues the sentence above it. A line directly below a
  Q line in the same paragraph (no gap flag) usually still belongs to that Q line's item.
- Intros are rare: general text for a whole section or group of separately described items, never
  the description of one item. Typical: a section preamble (a heading without quantity, a general
  description, Fabrikat / Offerte / Kontakt / Material for every item below) before items that each
  have their own title; a sub-heading over table rows of different items ("Zuluft"); text after the
  last item of a group that applies to all of them (commissioning of all units before a subtotal).
  An intro applies to two or more items; give their Q ids. A heading directly above one item's
  description is part of that item.
- Devices: a large unit (Zuluftgerät, Lüftungsgerät …) whose long description contains component
  lines with their own quantity ("1 Leerteil  [Stk. 1]"). Each component is an item with
  parent = the device's Q id; text that describes a component goes to the component, the rest of
  the description to the device. A device whose heading has no quantity of its own is an item
  with qty [] and its description as text; its components use parent = the first text id of that
  device item. Use qty [] only for such devices. Inside a device description, part lines without a
  quantity of their own ("1 Geräteanschluss ganzer Querschnitt", "1 Straubfilterteil") and their
  details belong to the device; only lines carrying a quantity are components, and a component's
  text is just the detail lines that describe that component.
- Add-ons: a Q line right after an item that only adds an option to it (colour "Farbe NCS …",
  coating, mounting frame, extension) is an item of its own, not a size variant. The main item's
  heading is context for the add-on: make it an intro applying to both instead of copying text.
- Text after a lump-sum Q line that lists what the lump sum includes belongs to that item.
- Running page headers, legends or notes that describe no item go to other.
- If the chunk starts in the middle of an item (text belonging to a C quantity line), make an item
  with qty = [that C id] and those text ids.

Every T id must appear exactly once across items[].text, intros[].text and other. Every Q id
exactly once across items[].qty. Use only ids shown; never invent ids."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items", "intros", "other"],
    "properties": {
        "items": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["qty", "text", "parent"],
            "properties": {
                "qty": {"type": "array", "items": {"type": "integer"}},
                "text": {"type": "array", "items": {"type": "integer"}},
                "parent": {"type": ["integer", "null"]},
            }}},
        "intros": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["text", "applies_to"],
            "properties": {
                "text": {"type": "array", "items": {"type": "integer"}},
                "applies_to": {"type": "array", "items": {"type": "integer"}},
            }}},
        "other": {"type": "array", "items": {"type": "integer"}},
    },
}


@dataclass
class Plan:
    """Grouping of one line stream. Ids are stream indexes (Line.idx).

    A device without a quantity of its own is an item with qty [] whose components have
    parent = its first text id."""
    items: list = field(default_factory=list)     # {"qty": [..], "text": [..], "parent": int | None}
    intros: list = field(default_factory=list)    # {"text": [..], "applies_to": [..]}
    other: list = field(default_factory=list)
    failed_chunks: list = field(default_factory=list)   # (first id, last id, reason) left to rules
    stats: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- rendering

def _profile(stream) -> dict:
    txt = [l for l in stream if l.kind == "text" and l.size]
    body = Counter(round(l.size) for l in txt).most_common(1)[0][0] if txt else None
    xs = [round(l.desc_bbox[0]) for l in stream if l.kind == "text" and l.desc_bbox]
    left = Counter(xs).most_common(1)[0][0] if xs else None
    return {"body": body, "left": left}


_GAP = {"tight": "", "blank": "¶", "strong": "¶¶", "page": "P", "break": "P"}


def _render(l, kind: str, prof: dict) -> str:
    flags = []
    if l.bold:
        flags.append("B")
    if l.size and prof["body"] and l.size >= prof["body"] + 0.75:
        flags.append(f"+{l.size - prof['body']:.0f}pt")
    if l.desc_bbox and prof["left"] is not None and abs(l.desc_bbox[0] - prof["left"]) > 3:
        flags.append(f">{l.desc_bbox[0] - prof['left']:.0f}")
    g = _GAP.get(l.gap, "")
    if g:
        flags.append(g)
    text = l.text or ("" if l.pos_text is None else l.pos_text)
    if kind == "Q":
        q = " ".join(x for x in (l.unit_raw, l.qty_raw) if x)
        text = f"{text}  [{q}]" if text else f"(no text)  [{q}]"
    return f"{l.idx} {kind} {' '.join(flags)} | {text}".replace("  |", " |")


def _kinds(stream) -> dict:
    """Line idx -> render kind; subtotal continuation lines (lower-case, tight) count as X."""
    out = {}
    after_total = False
    for l in stream:
        if l.kind == "total":
            out[l.idx], after_total = "X", True
            continue
        if after_total and l.kind == "text" and l.gap == "tight" and l.text[:1].islower():
            out[l.idx] = "X"
            continue
        after_total = False
        out[l.idx] = {"qty": "Q", "text": "T", "section": "S", "heading": "H", "recap": "X"}.get(l.kind, "")
    return out


def _chunks(stream, kinds) -> list[tuple[list, list]]:
    """[(context lines, chunk lines)] per system and section; long sections split after a Q line."""
    sections: list[list] = []
    cur: list = []
    sysi = None
    for l in stream:
        if not kinds.get(l.idx):
            continue                                   # dots
        if l.system_idx != sysi or l.kind == "section":
            if cur:
                sections.append(cur)
            cur, sysi = [], l.system_idx
        cur.append(l)
    if cur:
        sections.append(cur)
    out = []
    for sec in sections:
        start = 0
        while start < len(sec):
            end = len(sec)
            if end - start > MAX_LINES:
                # split after the last Q line before the limit (whole items stay together mostly)
                cut = next((k for k in range(start + MAX_LINES, start + MAX_LINES // 2, -1)
                            if kinds[sec[k].idx] == "Q"), start + MAX_LINES)
                end = cut + 1
            ctx = sec[max(0, start - CONTEXT_LINES):start]
            out.append((ctx, sec[start:end]))
            start = end
    return out


def _user(ctx, chunk, kinds, prof) -> str:
    lines = [_render(l, "C", prof) for l in ctx] + [_render(l, kinds[l.idx], prof) for l in chunk]
    return "\n".join(lines)


# --------------------------------------------------------------------------- validation

def _tidy(ans: dict, ctx, chunk, kinds) -> dict:
    """Drop structure / quantity / context ids listed as text (bookkeeping slips, not grouping)."""
    t_ids = {l.idx for l in chunk if kinds[l.idx] == "T"}
    known = {l.idx for l in chunk} | {l.idx for l in ctx}
    keep = lambda ids: [i for i in ids if i in t_ids or i not in known]    # noqa: E731
    return {"items": [{**it, "text": keep(it["text"])} for it in ans["items"]],
            "intros": [{**i, "text": keep(i["text"])} for i in ans["intros"]],
            "other": keep(ans["other"])}


def _validate(ans: dict, ctx, chunk, kinds) -> str | None:
    """None if the answer is consistent, else a short description of the first problem."""
    t_ids = {l.idx for l in chunk if kinds[l.idx] == "T"}
    q_ids = {l.idx for l in chunk if kinds[l.idx] == "Q"}
    ctx_q = {l.idx for l in ctx if kinds[l.idx] == "Q"}
    seen_t: Counter = Counter()
    seen_q: Counter = Counter()
    heads = {min(it["text"]) for it in ans["items"] if not it["qty"] and it["text"]}
    parents = {it["parent"] for it in ans["items"] if it["parent"] is not None}
    for it in ans["items"]:
        if not it["qty"]:
            if not it["text"]:
                return "an item without qty ids and without text"
            if min(it["text"]) not in parents:
                return f"item without qty (text {min(it['text'])}) is not the parent of any component"
        for q in it["qty"]:
            if q in ctx_q:
                if len(it["qty"]) != 1:
                    return f"context qty {q} mixed with other qty ids"
                continue
            if q not in q_ids:
                return f"qty id {q} is not a Q line of this chunk"
            seen_q[q] += 1
        if it["parent"] is not None and it["parent"] not in q_ids | ctx_q | heads:
            return f"parent {it['parent']} is neither a Q id nor the first text id of a device without qty"
        seen_t.update(it["text"])
    for intro in ans["intros"]:
        seen_t.update(intro["text"])
    seen_t.update(ans["other"])
    unknown = [i for i in seen_t if i not in t_ids]
    if unknown:
        return f"ids {sorted(unknown)[:8]} are not T lines of this chunk"
    dup = [i for i, n in seen_t.items() if n > 1]
    if dup:
        return f"text ids {sorted(dup)[:8]} used more than once"
    missing = sorted(t_ids - set(seen_t))
    if missing:
        return f"text ids {missing[:12]} not assigned"
    dq = [q for q, n in seen_q.items() if n > 1]
    if dq:
        return f"qty ids {sorted(dq)[:8]} in more than one item"
    mq = sorted(q_ids - set(seen_q))
    if mq:
        return f"qty ids {mq[:12]} not in any item"
    return None


# --------------------------------------------------------------------------- main

def _group_chunk(ctx, chunk, kinds, prof, model, reasoning):
    user = _user(ctx, chunk, kinds, prof)
    system = SYSTEM + f"\n\n(prompt {PROMPT_VERSION})"
    ans = llm.call_json(system, user, SCHEMA, model=model, name="lv_grouping", reasoning=reasoning,
                        timeout=180)
    ans = _tidy(ans, ctx, chunk, kinds)
    err = _validate(ans, ctx, chunk, kinds)
    if err is None:
        return ans, None
    retry = user + f"\n\nYour previous answer was invalid: {err}. Answer again, following every rule."
    ans = llm.call_json(system, retry, SCHEMA, model=model, name="lv_grouping", reasoning=reasoning,
                        timeout=180)
    ans = _tidy(ans, ctx, chunk, kinds)
    err = _validate(ans, ctx, chunk, kinds)
    return (ans, None) if err is None else (None, err)


def plan_groups(stream, model: str | None = None, reasoning: str | None = None,
                max_workers: int = 8) -> Plan | None:
    """Group the classified line stream with the LLM. None when no LLM answer is available at all."""
    if not stream:
        return None
    model = model or MODEL
    reasoning = reasoning or REASONING
    prof = _profile(stream)
    kinds = _kinds(stream)
    chunks = _chunks(stream, kinds)
    results = llm.map_concurrent(lambda c: _group_chunk(c[0], c[1], kinds, prof, model, reasoning),
                                 chunks, max_workers=max_workers)
    plan = Plan()
    by_qty: dict = {}
    n_ok = 0
    for (ctx, chunk), res in zip(chunks, results):
        if isinstance(res, Exception) or res[0] is None:
            reason = str(res) if isinstance(res, Exception) else res[1]
            plan.failed_chunks.append((chunk[0].idx, chunk[-1].idx, reason[:200]))
            continue
        n_ok += 1
        ans = res[0]
        for it in ans["items"]:
            key = tuple(sorted(it["qty"]))
            if not key:                                     # device without a quantity of its own
                plan.items.append({"qty": [], "text": sorted(it["text"]), "parent": None})
                continue
            if len(key) == 1 and key[0] in by_qty:          # continuation of an item from the context
                by_qty[key[0]]["text"].extend(it["text"])
                continue
            item = {"qty": sorted(it["qty"]), "text": sorted(it["text"]), "parent": it["parent"]}
            plan.items.append(item)
            for q in item["qty"]:
                by_qty[q] = item
        for intro in ans["intros"]:
            targets = sorted(set(intro["applies_to"]))
            if len(targets) == 1 and targets[0] in by_qty and \
                    not any(t < targets[0] for t in by_qty[targets[0]]["text"]):
                # the "intro" of one item without text of its own above it is that item's description
                by_qty[targets[0]]["text"].extend(intro["text"])
            elif not targets:
                plan.other.extend(intro["text"])
            else:
                plan.intros.append({"text": sorted(intro["text"]), "applies_to": targets})
        plan.other.extend(ans["other"])
    for item in plan.items:
        item["text"].sort()
    if not n_ok:
        return None
    plan.stats = {"mode": "llm", "chunks": len(chunks), "failed": len(plan.failed_chunks), "model": model,
                  "prompt": PROMPT_VERSION}
    return plan
