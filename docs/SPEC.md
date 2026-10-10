# ctrl-free v4: build spec and shared contract

Source of truth for all builders. The UI design is in `research/design_v4/*.dc.html`
(v4 "Table full flow" screens N01–N11 plus the Assist layer S01–S03). The problem is in
`problem_statement/**/README.md` and `research/sprintd Zurich 2026 Equans case playbook.pdf`.

Principle: **LLM picks, code computes, estimator decides.** The LLM never produces a price.
Every number is computed in Python from the tender (quantity, page) and reference data
(catalog, install rules, project parameters), and carries an explain trail.

Build for any tender. No hardcoded page numbers, system names, product IDs or example rows
in the pipeline code. The 22 examples in `example_lv_positions.csv` are a test set only.

## Layout

```
backend/              Python 3.12, uv, FastAPI (run: cd backend && uv run uvicorn app.main:app --reload --port 8000)
  app/
    config.py         paths, env (.env at repo root), model names
    parser.py         PDF -> Tender meta skeleton + systems + positions (+ bboxes)          [parser agent]
    pricing.py        generalized pricing_engine: position pricing, totals, scenarios      [pricing agent]
    export.py         xlsx with live formulas, pricing report PDF, SIA-like file            [pricing agent]
    llm.py            OpenAI / Azure OpenAI client, JSON-schema calls, disk cache          [llm agent]
    matcher.py        attribute normalization, shortlist (top 5), LLM pick                 [llm agent]
    instructions.py   tender rules ("Instructions & norms") from the conditions pages      [llm agent]
    meta.py           tender name, client, trade, due date, submission rule, award criteria [llm agent]
    quotes.py         supplier request drafts, reading supplier replies                     [llm agent]
    translate.py      DE -> EN for position titles/descriptions (batched, cached)          [llm agent]
    store.py          JSON-file persistence per tender, audit log                           [api agent]
    pipeline.py       background job: parse -> meta -> translate -> match -> price -> instr [api agent]
    assist.py         Assist tray/command planning (proposals only; never applies silently) [api agent]
    main.py           FastAPI routes (below)                                                [api agent]
  data/reference/     catalog.csv, productivity.csv, project_parameters.json (defaults)
  data/llm_cache/     cached LLM responses (committed; makes demo fast and deterministic)
  data/tenders/<id>/  tender.pdf, state.json (gitignored)
  tests/              pytest: golden 22/22, parser recall, API smoke
frontend/             Vite + React 19 + TS + Tailwind v4 + react-router + TanStack Query (pnpm dev, proxy /api -> :8000)
```

Starter package (read-only): `problem_statement/Schulhaus_Oberglatt_Hackathon_Starter_Package_v2/`
(tender PDF `BKP_244_LV_Lueftung_260804.pdf`, `example_lv_positions.csv`, `expected_output_example.json`).
Reference engine: `research/pricing_engine.py` (reproduces all golden numbers; keep that behaviour).

## Data model (JSON, snake_case; pydantic models live in `app/models.py`)

```jsonc
// Tender (state.json root)
{
  "id": "t_ab12cd",                     // short random id
  "name": "Neubau Primarschule Erlenstrasse, Oberglatt",
  "client": "Gemeinde Oberglatt",
  "trade": "BKP 244 Lüftungsanlagen",
  "file_name": "BKP_244_LV_Lueftung_260804.pdf",
  "page_count": 202, "file_size": 3007418,
  "due_at": "2026-09-22T10:00:00",       // ISO local time, null if unknown
  "meta_sources": {"name": 9, "due_at": 9, "client": 9},   // page numbers per field
  "submission_rule": {"page": 9, "heading": "1.14 Adresse und Frist ...", "text_de": "...", "text_en": "..."},
  "award_criteria": [{"label": "Preis", "points": 60, "page": 9, "rule_de": "...", "rule_en": "..."}],
  "status": "reading" | "ready" | "submitted" | "awarded" | "error",
  "progress": {"stage": "parsing|meta|translating|matching|pricing|instructions|done", "page": 112, "pages": 202, "done": 0, "total": 0, "message": "Reading p. 112 of 202"},
  "created_at": "...", "updated_at": "...", "updated_by": "You",
  "profile": "school" | "sports_hall",
  "systems": [System], "positions": [Position], "instructions": [Instruction],
  "pricing": PricingSettings, "submission": Snapshot | null, "outcome": Outcome | null,
  "quote_requests": [QuoteRequest], "assist": AssistState, "log": [LogEntry]
}

// System: read from the PDF's own headings (e.g. "244.01 LA01 Nebenräume UG")
{"code": "244.01", "key": "LA01", "name": "Nebenräume UG", "label": "244.01 LA01 Nebenräume UG",
 "pages": [67, 98], "lot": null, "profile": "school" | "sports_hall"}   // profile drives factor overrides (Turnhalle -> mounting_height_sports_hall)

// Position (one priced LV line)
{
  "lv_id": "LV0001",                       // sequential in document order (generated, not from PDF)
  "system": "244.01 LA01 Nebenräume UG", "system_key": "LA01",
  "section": "C", "section_name": "Armaturen und Instrumente",
  "page": 78,
  "text_de": "Zuluft - Tellerventil\naus Kunststoff, mit Luftmengeneinstellung\n...\nGrösse Ø 10 cm",   // full block, verbatim
  "title_de": "Zuluft-Tellerventil aus Kunststoff, Ø 10 cm",   // short line shown in tables (built by parser, may be refined by LLM)
  "title_en": "Supply air valve, plastic, DN100",              // translate.py
  "variant_de": "Ø 10 cm",                  // the size line when a block has several sizes, else null
  "quantity": 5.0 | null, "unit": "pc|m|m2|kg|h|LS|system|null", "unit_raw": "Stk",
  "kind": "item" | "lump_sum" | "text_only" | "subtotal",
  "make_hint": "Trox Hesco", "model_hint": "Z-LVS", "offer_ref": "P241783" | null,
  "attributes": {"type": "supply air valve", "dn_mm": 100, "dims_mm": [400,300,1250], "thickness_mm": null, "fire_class": null, "material": "plastic"},
  "source": {"page": 78, "page_size": [595.0, 842.0],
             "block_bbox": [x0,y0,x1,y1],     // whole description block, PDF points, origin top-left
             "qty_bbox": [x0,y0,x1,y1],       // the line where the quantity was read
             "lines": [{"text": "Grösse Ø 10 cm   Stk 5", "bbox": [...], "role": "desc|qty|other_qty"}]},
  "match": {
    "product_id": "P-AIR-001" | null, "install_code": "DIFFUSER" | null,
    "confidence": 0.92, "label": "Strong|Close|Weak|None",
    "reason": "Type and size match (Ø 10 cm = DN100)",
    "method": "llm|rules|manual|cache",
    "candidates": [{"product_id": "P-AIR-002", "score": 0.57, "why": "Right type, wrong size: tender says Ø 10 cm"}]   // top 5 incl. chosen
  },
  "status": "calculated|supplier_quote_required|assumption_applied|review_required|insufficient_information|out_of_scope|non_priceable",
  "status_reason": "Supplier package: budget price until a quote is entered",
  "overrides": {"quantity": null, "product_id": null, "unit_price": null, "hours": null, "install_code": null},
  "supplier_quote": {"unit_price": 5150.0, "source": "Supplier reply.pdf p.1 pos 2", "received_at": "...", "request_id": "q_1"} | null,
  "variant_reason": null,                  // required text when product differs from the tender's specified make
  "confirmed": {"by": "You", "at": "..."} | null,
  "flagged": false,
  "needs_review": true,                    // computed: true when the estimator must look (see rules)
  "pricing": PositionPrice | null          // computed by pricing.py, never stored stale (recompute on every read/change)
}

// PositionPrice (pricing.py output)
{"quantity": 5.0, "net_unit_cost": 74.8, "unit_price_source": "catalog|supplier_package|supplier_quote|manual",
 "waste_pct": 4.0, "material": 388.96, "base_hours_per_unit": 0.65,
 "factors": [{"key": "site_efficiency", "value": 0.88, "applied": 1.1364, "op": "÷"}, {"key": "mounting_height_school", "value": 1.1, "applied": 1.1, "op": "×"}],
 "hours": 4.35, "rate": 96, "role": "installer", "labour": 417.3, "direct": 806.26,
 "explain": {"material": "5 pc × CHF 74.80 × (1 + 4% waste) = CHF 388.96",
             "hours": "5 pc × 0.65 h ÷ 0.88 site efficiency × 1.10 ceiling height × 1.07 school logistics = 4.35 h",
             "labour": "4.35 h × CHF 96/h (installer) = CHF 417.30",
             "direct": "388.96 + 417.30 = CHF 806.26"},
 "sources": {"product": "catalog.csv row P-AIR-001", "install_rule": "productivity.csv DIFFUSER", "quantity": "Tender p. 78"}}

// Instruction (tender rule, quoted verbatim)
{"id": "i_01", "type": "Brandschutzklappen",   // the tender's margin label / heading
 "page": 38, "section": "3.3.4 Technische Vorschriften Lüftung / Klima",
 "text_de": "...verbatim...", "text_en": "...", "bbox": [..] | null,
 "kind": "cost|risk|scope|covered",
 "applies_to": ["LV0004"], "applies_label": "LV0004", "applies_long": "LV0004 Fire damper EI90-S DN100, 4 pc, p. 79.",
 "why": "The matched product already includes the actuator...",
 "state": "open|confirmed|not_relevant", "confirmed_by": null, "confirmed_at": null}

// PricingSettings (per tender; defaults from project_parameters.json)
{"competition": -0.05, "appetite": 0.05, "sensitivity": 0.05, "ref_win": 0.55,
 "margins": {"Aggressive": 2.5, "Target": 4.0, "Standard": 5.5, "Conservative": 6.5},
 "overhead_pct": 8.5, "transport_pct": 2.5,
 "material_waste_pct": 4.0, "small_material_pct": 3.5, "supplier_contingency_pct": 3.0,
 "include_small_material": false, "include_supplier_contingency": false,
 "factors": {"site_efficiency": 0.88, "school_logistics": 1.07, "mounting_height_school": 1.1, "mounting_height_sports_hall": 1.25, "timber_interface": 1.08},
 "project_costs": {"engineering": false, "commissioning": false, "hygiene": false, "documentation": false},
 "chosen": "Target" | null, "notes": {"competition": "", "appetite": "", "sensitivity": ""},
 "changed_by": {"competition": {"by": "You", "at": "..."}}}

// Totals (pricing.py project_totals)
{"material": ..., "labour": ..., "direct": ..., "project_costs": ..., "small_material": ..., "supplier_contingency": ...,
 "transport": ..., "overhead": ..., "cost": ..., "standard_price": 439000,
 "by_system": [{"system": "...", "direct": ..., "lines": 31, "to_review": 3}], "by_category": [...],
 "coverage": {"calculated": 120, "supplier_quote_required": 18, ...}, "budget_direct": 271261.0, "budget_share": 0.73,
 "scenarios": [{"name": "Aggressive", "margin_pct": 2.5, "bid": 426000, "win": 0.69, "profit": 11511, "expected": 7986.03, "best": false}],
 "buildup": [{"label": "Direct cost, 194 lines", "value": ...}], "win_explain": "Why 63%: it starts at 55%, plus 5 because we want the job, ..."}
```

Golden check (must hold with default settings and the 22 example positions priced through
`pricing.py`): direct 372'700.12, cost baseline 414'489.12 (= direct × 1.025 × 1.085),
scenarios 426'000/0.69/7'986.03, 432'000/0.63/10'951.01, 444'000/0.49/14'418.68.
Project costs, small material and supplier contingency are OFF by default (golden subset uses none).

### Status rules (pricing + matching decide; UI shows plain words)
| status | when | UI label EN / DE |
|---|---|---|
| calculated | catalog product matched with confidence ≥ 0.75, qty known | Priced / Kalkuliert |
| assumption_applied | matched, but an attribute was assumed (finish, make) or confidence 0.5–0.75 | Priced, with a guess / Mit Annahme |
| supplier_quote_required | matched product has `supplier_quote_required=true` (budget price used until quote) or offer_ref present | Ask supplier / Lieferantenofferte |
| review_required | no confident match (top candidate < 0.5) but a priceable item | Check this / Prüfen |
| insufficient_information | unit present but no quantity, or quantity 0 | Missing info / Angaben fehlen |
| out_of_scope | belongs to another trade / lot excluded by estimator / "bauseits" | Not priced / Nicht kalkuliert |
| non_priceable | headings, totals ("Total Kanäle B"), pure text, engineer lists | Not priced / Nicht kalkuliert |

`needs_review` = status in {supplier_quote_required (no quote yet), review_required, assumption_applied, insufficient_information} and not confirmed.
Lines tab "to review" count = positions with needs_review. Confirming a line clears it (logged).

## API (FastAPI, all under /api, JSON)

```
GET    /api/health
GET    /api/tenders                                  -> [TenderSummary]  (id,name,client,trade,file_name,page_count,due_at,status,progress,open_work{lines_to_review,instructions_to_confirm,price_chosen},offer_price,standard_price,updated_at,updated_by)
POST   /api/tenders  (multipart: file, name?, client?, trade?, due_at?, profile?)   -> TenderSummary (status=reading; pipeline runs in background)
POST   /api/tenders/demo                             -> creates a tender from the starter-package PDF (for the demo button)
GET    /api/tenders/{id}                             -> TenderSummary + overview {steps[], totals, facts}
GET    /api/tenders/{id}/positions?filter=review|all|<status>&q=   -> {positions:[Position w/ pricing], groups:[{key,title,title_de,count,to_review}], counts{}}
GET    /api/tenders/{id}/positions/{lv_id}           -> Position + pricing + candidates detail (each candidate with catalog row and line total if picked) + related instructions + quote group
PATCH  /api/tenders/{id}/positions/{lv_id}           body: {quantity?, product_id?, unit_price?, hours?, install_code?, variant_reason?, status?, reset?: true, confirm?: true, unconfirm?: true, flag?: bool}
GET    /api/tenders/{id}/positions/{lv_id}/candidates?q=   -> top 5 (or search all) with line totals and diff vs current
GET    /api/tenders/{id}/pages/{n}.png?scale=2       -> rendered page image (PyMuPDF, cached)
GET    /api/tenders/{id}/pages/{n}/text              -> words/lines with bboxes (optional)
GET    /api/tenders/{id}/pdf                         -> original PDF
GET    /api/tenders/{id}/instructions?filter=open|all|cost|risk|scope|covered -> {instructions, counts}
PATCH  /api/tenders/{id}/instructions/{iid}          body: {state?: confirmed|not_relevant|open, kind?, applies_to?}
GET    /api/tenders/{id}/pricing                     -> {settings, defaults, totals, changed_count}
PUT    /api/tenders/{id}/pricing                     body: partial PricingSettings -> same as GET (recomputed)
POST   /api/tenders/{id}/pricing/reset
GET    /api/tenders/{id}/quotes                      -> quote groups (same product type across systems) with draft email (DE)
POST   /api/tenders/{id}/quotes/{group}/sent         -> mark request sent
POST   /api/tenders/{id}/quotes/read  (multipart file | text)  -> Assist proposals [{lv_id, unit_price, budget, source, delta}] (does NOT apply)
POST   /api/tenders/{id}/quotes/apply body: {proposals:[{lv_id, unit_price, source}]}  -> applies + logs (undoable)
GET    /api/tenders/{id}/export/xlsx                 -> offer workbook with live formulas
GET    /api/tenders/{id}/export/report.pdf           -> pricing report
GET    /api/tenders/{id}/export/sia                  -> SIA-style interface file (simplified, documented as "planned format")
GET    /api/tenders/{id}/export/checklist            -> open points before submit
POST   /api/tenders/{id}/submit                      -> snapshot
PUT    /api/tenders/{id}/outcome                     body: Outcome
GET    /api/results                                  -> results history rows + learned stats (when >= 3)
GET    /api/reference                                -> {catalog, rules, parameters, source}
POST   /api/reference/{kind}  (multipart csv/json)   -> import new version
GET    /api/tenders/{id}/assist                      -> tray {needs_ok:[Proposal], working_on:[...], done:[...]}
POST   /api/tenders/{id}/assist/command  {text, scope: line|tender, lv_id?} -> {plan:[{lv_id?, text, action}], effect:{direct_before, direct_after}, plan_id}
POST   /api/tenders/{id}/assist/plans/{plan_id}/apply   -> applies plan (logged, undoable)
POST   /api/tenders/{id}/assist/undo/{log_id}
GET    /api/tenders/{id}/explain/{lv_id}?field=labour|material|hours -> sentence steps with sources
GET    /api/tenders/{id}/log
```

All mutating calls append a LogEntry `{id, at, by: "You"|"Assist", action, lv_id?, before, after, undoable}`.

## UI (frontend) — implement v4 exactly as designed

Design tokens from the v4 files: font Work Sans (UI) + JetBrains Mono (numbers, ids, pages);
ink #121212, muted #5A5A57, faint #8A8A86, rule #DEDEDB, row rule #EDEDEA, panel #F6F6F4,
accent #1F4FD8 (hover #163A9E), selected-row bg #EEF2FD with inset 3px accent bar,
attention #C2410C, highlight #FCE9DC, radius 2px, no shadows, no gradients, no emoji.
Swiss number format: 439'000 and 372'700.12. EN | DE toggle in the header (both languages; DE uses the tender text).

Screens (routes):
- `/` N01 Tenders: tabs In calculation / Submitted / Awarded, search, table with due date + days left, open work, offer price; a tender being read shows "Reading p. X of Y" with progress bar (poll).
- `/new` N02 New tender dialog: upload PDF (and "Use the Oberglatt demo tender"), fields prefilled when meta is read, starting values select.
- `/t/:id` N03 Overview: "N steps left before you can submit" checklist (review lines, confirm instructions, choose price, export, outcome) + aside (due, price so far, tender facts). Tender sub-nav tabs with counts (Lines "6 to review", Instructions "10 to confirm", Pricing "price not chosen").
- `/t/:id/lines` N04 Lines: filter tabs (To review, All, and by status), grouped by product type, table columns Page · Description (tender text) · Qty · Unit · Product · Unit price · Total · Match · Status. Footer totals bar (Material, Labour, Direct, Cost incl. transport and overhead, Price at standard margin). Keyboard J/K next/prev, Enter confirm.
- `/t/:id/lines/:lv` N04b Line detail (full screen pattern): left = tender PDF crop of the page with the block highlighted (qty row in #FCE9DC) + "Open full page"; tender rule for this line (from instructions); right = "Price for this line" editable quantity/product/unit price/hours with sentence explain, material/labour/line total, "Reset to calculated values"; Supplier quote section (group request draft email in German, copy, mark sent, enter quote); Confirm (Enter) / Flag for review / Undo.
- `/t/:id/lines/:lv/product` N05 Change product: PDF crop + the 5 closest products (radio rows with why, unit price, line total, diff), search all, variant warning with the tender's Varianten rule and reason input, Use this product.
- `/t/:id/instructions` (+ `/:iid`) N06/N06b Instructions & norms: tabs To confirm / All / Adds cost / Risk / Scope / Covered; table; detail with verbatim German, machine translation, suggested impact/applies to/why, Confirm / Change / Not relevant / Undo.
- `/t/:id/pricing` N07 Pricing: your read (competition, appetite, sensitivity segmented controls with effect text and note), project costs toggles, More settings (margins/overhead steppers, allowances and site factors -> all lines recalc), offer price card, Pick a price table (4 options, best expected profit tag), cost build-up, "Use CHF X and continue to export".
- `/t/:id/export` N08 Export: before-you-submit checklist (not blocking), submission rule quote from the tender, files (xlsx, SIA, report.pdf), Mark as submitted.
- `/t/:id/outcome` N09 Outcome: submitted snapshot, record the award form, comparison.
- `/results` N10 Results history. `/reference` N11 Reference data (catalog, install rules, parameters tabs; import).
- Assist layer S01–S03: in-place proposals on the line detail ("Assist found a quote for this line"), drop zone "Got the supplier's answer?", Ctrl K command bar (shows a plan first, Do it / Change), tray button in header (Needs your OK / Working on / Done). Assist never changes a price without the user's OK; filled values are marked and undoable.
