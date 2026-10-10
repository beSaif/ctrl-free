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

## What it does

1. **Read** the tender. The parser detects systems (LA01–LA05, Montagesystem), sections and positions from the PDF's own layout, with page and bounding box for every line. A block that lists several sizes becomes several lines. Engineer lists and totals are excluded.
2. **Match.** Each line gets a shortlist of 5 catalogue products, scored in code by type, size and unit. The LLM picks one or "none", and can't invent an ID. Without an LLM the rules pick.
3. **Compute.** `backend/app/pricing.py` computes every line: material, hours with site factors, labour, direct cost. It reproduces all of Equans' golden numbers: 22/22 lines, the CHF 414'489.12 baseline and the 3 bid scenarios.
4. **Review.** A "needs you" queue sorted by money at risk, with the PDF crop beside each line and each number spelled out as a sentence. The estimator can confirm, change the product (with the tender's variant rule), edit quantities or hours, and undo.
5. **Instructions & norms.** Tender rules (pp. 36–41) quoted verbatim with page, sorted into adds cost / risk / scope / covered.
6. **Supplier quotes.** Lines not in the catalogue, or on budget prices, are grouped by product type into drafted German request emails. Assist reads the supplier's reply PDF and proposes the prices; nothing changes until the estimator says OK.
7. **Pricing.** Project costs, margins, overhead and site factors are all adjustable. Four price options show win chance and expected profit, based on the estimator's read of competition, appetite and price sensitivity.
8. **Export.** An offer workbook (.xlsx with live formulas and source comments), a pricing report PDF and a simplified SIA file. After the award, record the outcome to build up a results history.
9. **Verified.** `GET /api/tenders/{id}/verification` checks our output against Equans' 22 verified examples: 22/22 found, matched and priced to the cent.

## Repo

- `backend/`: FastAPI with the parser, matcher, pricing, exports, Assist and pipeline. Tests: `cd backend && uv run pytest -q`.
- `frontend/`: React, Vite and Tailwind; the v4 design (`research/design_v4`).
- `docs/SPEC.md`: data model and API contract. `docs/PRODUCTION.md`: path to production. `docs/DEMO.md`: 5-minute demo script.
- `problem_statement/`: case description, data package and the tender.
- `research/`: case research, the original pricing engine, and the design canvases.
