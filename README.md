# ctrl-free

sprintd Hackathon, 9–11 Oct 2026, Zurich. Equans case: **From tender to first price.**

ctrl-free reads a 202-page Swiss German ventilation tender (BKP 244 LV) and finds every priced position. It matches each position to Equans' catalogue and install rules and computes a first price where every number links back to the tender page or a reference row. The estimator reviews what needs them, asks suppliers for missing prices, chooses an offer price from scenarios with win chances, and exports the offer.

> **LLM picks, code computes, estimator decides.**

## Run it

```bash
cp .env.example .env        # add OPENAI_API_KEY (or Azure OpenAI vars); optional, it runs rules-only without
./dev.sh                    # backend on :8000, frontend on :5173
open http://localhost:5173
```

Requirements: `uv` (Python 3.12) and `pnpm` (Node 20+). Click **New tender** and then either upload the PDF or press **Use the Oberglatt demo tender**.

The frontend falls back to built-in demo data when the backend is not reachable. Set `VITE_USE_MOCK=1` to force this. `frontend/.env.development` pins "today" to 10 Sep 2026 so the Oberglatt deadline shows as "12 days left". Remove that file to use the real date.

Two looks: the ctrl-free style (default) and the Equans brand style (Roboto, Dark blue, Turquoise and Dark green, Equans logo). Switch under the person menu → Style, or open any page with `?theme=equans` / `?theme=ctrlfree`. Colours are CSS variables in `frontend/src/index.css`.

## What it does

1. **Read** the tender. The parser detects systems (LA01–LA05, Montagesystem), sections and positions from the PDF's own layout, with page and bounding box for every line. A block that lists several sizes becomes several lines. Engineer lists and totals are excluded.
2. **Match.** Each line gets a shortlist of 5 catalogue products, scored in code by type, size and unit. The LLM picks one or "none", and can't invent an ID. Without an LLM the rules pick. A make named in the tender is treated as an example unless the tender says only that make is accepted. Every line shows "Tender asks · We offer", attribute by attribute (type, size, fire class, length, unit, make).
3. **Learn.** When the estimator corrects a match, ctrl-free keeps it as a rule: this tender wording → this product, who taught it and on which line. "Apply to N similar lines" uses it in the same tender, and new tenders use it first, marked "Learned from Oberglatt LV0021". Reference → Learned matches lists every rule with how often it was applied, confirmed or overridden.
4. **Compute.** `backend/app/pricing.py` computes every line: material, hours with site factors, labour, direct cost. It reproduces all of Equans' golden numbers: 22/22 lines, the CHF 414'489.12 baseline and the 3 bid scenarios. The net price follows a fixed order: price typed on the line > supplier quote > Equans' negotiated price lists > supplier price lists > standard catalogue. Price lists, the catalogue and the install rules import from Excel (.xlsx, .xls), ODS, CSV/TSV, JSON or a PDF with a table, with German or English column names.
5. **Review, with every number traceable.** A "needs you" queue sorted by money at risk, with the PDF crop beside each line. The note beside each number (quantity, unit price, hours, rate, waste) opens its source: the quoted tender line, the catalogue or price-list row, or the install rule with each site factor and its parameter key. A link opens that row in Reference data. Each line has its full history, from "read from p. 78" and the AI's pick to every later change, with who and the value before. The list can be grouped by type or in the tender's printed order.
6. **AI → junior → senior.** Every change is stamped with the person who made it (person switcher in the top bar). The Changes screen shows what the AI, Assist and each person did, before → after, with the CHF effect. The senior approves, reverts or comments.
7. **Instructions & norms.** Tender rules (pp. 36–41) quoted verbatim with page, sorted into adds cost / risk / scope / covered. A line picker selects the lines a rule applies to by system, section or product type.
8. **Supplier quotes.** Lines not in the catalogue, or on budget prices, are grouped by product type into drafted German request emails. Assist reads the suppliers' replies (several PDFs or e-mails at once, the supplier taken from the letterhead or sender) and proposes the prices; nothing changes until the estimator says OK. When several suppliers quote the same line, the line compares their offers (lowest marked, delivery and validity on demand) and the estimator uses one, one supplier for the whole request, or the cheapest per line, undoable.
9. **Pricing in two steps.** *Costs*: project costs, overhead, transport and site factors, each with its live CHF effect, its default and who changed it. *Strategy*: the estimator's read of competition, appetite and price sensitivity, a win-chance and expected-profit chart over the offer price, four options with their margins set right next to their prices, and a recommendation in plain words.
10. **Export.** The original tender PDF filled in, with selling prices on the dotted lines, totals per section and system, and a cover page. Also an offer workbook (.xlsx with live formulas and source comments), a pricing report PDF and a simplified SIA file. After the award, record the outcome to build up a results history.
11. **Verified.** `GET /api/tenders/{id}/verification` checks our output against Equans' 22 verified examples: 22/22 found, matched and priced to the cent.

## Repo

- `backend/`: FastAPI with the parser, matcher, pricing, exports, Assist and pipeline. Tests: `cd backend && uv run pytest -q`.
- `frontend/`: React, Vite and Tailwind; the v4 design (`research/design_v4`).
- `docs/SPEC.md`: data model and API contract. `docs/PRODUCTION.md`: path to production. `docs/DEMO.md`: 5-minute demo script.
- `problem_statement/`: case description, data package and the tender.
- `research/`: case research, the original pricing engine, and the design canvases.
