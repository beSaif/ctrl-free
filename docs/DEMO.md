# 5-minute demo script

Set up beforehand: `./dev.sh`, browser at http://localhost:5173, the Oberglatt tender already processed, working as **Lea Meier · Junior** (top bar).
Start clean: no active price lists (Reference → Price lists) and no learned matches (Reference → Learned matches), unless you want to show the re-upload in step 5.
Keep `backend/data/demo/supplier_reply_silencers.pdf` and `supplier_reply_silencers_competitor.pdf` (a second supplier, Akustik Demo Partner AG) ready in Finder for drag and drop.

1. **The problem (15 s).** "An estimator gets this: 202 pages of German. Today it's Ctrl+F through handbooks and Excel. Watch."
2. **Upload (20 s).** New tender → upload the PDF (or the demo button). Reading all 202 pages takes about 4 seconds. Name, client and due date are read from p. 9.
3. **Overview (10 s).** "3 steps left before you can submit." The aside shows "Verified against Equans' examples: 22/22".
4. **One line, every number traceable (60 s).** Lines → LV0010, the supply air valve on p. 78.
   - Click **"Read from p. 78"** next to the quantity: the quoted tender line, highlighted in the PDF crop.
   - Click **"From the install rule"** next to the hours: 0.65 h per pc, each site factor with its value and its key in `project_parameters.json` → **Open in Reference data** lands on the DIFFUSER row.
   - **Tender asks · We offer**: Trox Hesco Z-LVS is named as an example ("z.B."), so DemoVent DV-Z-100 is an equivalent product: type ✓ size ✓ unit ✓.
   - Scroll to **History**: read from p. 78 → matched by the rules → every change since, with who.
5. **The estimator corrects, ctrl-free learns (40 s).** LV0021, the inspection cover on p. 81, has no match. Change product → search "inspection cover" → P-FIR-004 (400×200, size ✓; same product family, "check it fits") → use it. Back on the line: **Apply to 8 similar lines** (one undoable batch). Reference → **Learned matches** shows the rule, taught by Lea on Oberglatt LV0021. "The next tender with this wording comes back matched."
6. **Supplier loop (35 s).** LV0066, the 600×600×1750 silencer on p. 107, on a budget price. The request covers every silencer in the tender (the list shows each line and its status). Drop `supplier_reply_silencers.pdf` → "Assist found a quote: 5'150 vs budget 5'400" → Fill all 3 → marked "Assist", approved by Lea, undoable.
   - *Several suppliers (optional, 20 s).* Drop `supplier_reply_silencers_competitor.pdf` on "Another supplier answered?" (or both PDFs at once). The line now compares both suppliers: unit price, line total, Δ vs budget, "Lowest" on the cheaper one, delivery and validity behind the supplier's name. **Use this** switches the quote (undoable); **All 3 lines of this request** shows each supplier's total and *Use the cheapest for each line*.
7. **Price decision (45 s).** Pricing → **Costs**: raise overhead one step; the row shows its CHF effect and "default 8.5%", and "What changed from defaults" lists it at the top. → **Strategy**: set competition to "Strong" and we-want-it to "Must win"; the win-chance and expected-profit chart moves, and the recommendation says which option maximises expected profit and what Aggressive costs. Pick Target → "Use CHF X".
8. **Senior review (25 s).** Switch to **Marco Keller · Senior** → Changes: what the AI picked with low confidence, what Assist filled, what Lea changed, each before → after with its CHF effect. Approve all shown; revert one; it's undone everywhere.
9. **Export (20 s).** **Filled tender (LV)**: the original PDF with our selling prices on the dotted lines and totals per section and system. Open a page thumbnail. Also the workbook with live formulas and source comments, and the SIA file the tender asks for on p. 9.
10. **Close (10 s).** "LLM picks, code computes, estimator decides, senior signs off. Runs on Azure OpenAI; SIA 451 into SEAP is the next step."

## Equans' questions: where to show the answer

| Question | Show |
|---|---|
| Equivalent products from other makers? | Line → **Tender asks · We offer**; Change product shows the checks per candidate. A make named with "z.B." or without wording is offered as equivalent; only "vorgeschrieben" or "kein Ersatz" prescribes it, and then another make needs a variant reason (p. 36). Try LV0010 (example make) and LV0064 (silencer 1000 vs 900 mm: differs). |
| Where does this number come from? | The note next to each number on a line opens its source and links to the Reference row. |
| Their own catalogue and supplier prices? | Reference → **Price lists** → Import `backend/data/demo/equans_negotiated_prices_2026.csv` → activate: direct cost drops by about CHF 10'231. The line's unit price says which list it came from. Order: typed > quote > negotiated > supplier list > catalogue. |
| Is the 22/22 still true with our own prices? | Yes: the check prices Equans' examples with the standard catalogue they were computed with, whatever price list is active. |
| Several suppliers, pick the best? | Line → drop several replies at once; with two or more offers the line shows a comparison with **Use this** per supplier and, per request, *Use {supplier} for all N lines* or *Use the cheapest for each line*. The request email's To field takes several addresses. Demo: the two silencer PDFs above. |
| Learning from past behaviour? | Reference → **Learned matches**. Re-upload the tender: the Overview says how many lines were matched from what you taught. |
| Traceability and history of every change? | Line → **History**; tender → **Changes** (filter by person, type, AI low confidence). |
| PDF order instead of by type? | Lines → **Group by: Tender order**: systems and sections as printed, with subtotals. |
| "Applies to" for instructions? | Instructions → a rule → **Choose lines** (L): pick by system, section or product type. Confirm and next (Enter). |
| Strategy, not only calculation? | Pricing → **Strategy**: chart, recommendation, what happens if competition is one step stronger or weaker. |
| Expected output? | Export → **Filled tender (LV)**, and the Overview's last step links to it. |

If the jury asks "does it work on any page?": let them pick a page, then switch the Lines to Tender order or open the full page viewer.
