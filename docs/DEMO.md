# 5-minute demo script

Set up beforehand: `./dev.sh`, browser at http://localhost:5173, the Oberglatt tender already processed.
Keep `backend/data/demo/supplier_reply_silencers.pdf` ready in Finder for drag and drop.

1. **The problem (20 s).** "An estimator gets this: 202 pages of German. Today it's Ctrl+F through handbooks and Excel. Watch."
2. **Upload (30 s).** New tender → upload the PDF (or the demo button). The list shows "Reading p. X of 202"; reading the whole tender takes about 4 seconds. Name, client and due date are read from p. 9.
3. **Overview (20 s).** "3 steps left before you can submit." Every line has a first price or a clear next step. The aside shows "Verified against Equans' examples: 22/22".
4. **One line, fully traceable (60 s).** Lines → LV0010, the supply air valve on p. 78. The PDF crop highlights "Stk 5". Walk through the sentences: 5 pc × CHF 74.80 × (1 + 4% waste) = 388.96; 4.35 h × CHF 96 = 417.30; total **806.26**, the same as Equans' own answer.
5. **The estimator stays in control (40 s).** Change product → pick DN125 → the tender's variant rule (p. 36) asks for a reason → totals update everywhere → Undo.
6. **Supplier loop (60 s).** Open LV0066, the 600×600×1750 silencer on p. 107 (on a budget price). One German request email is drafted for every silencer in the tender (the Silencers group), with the tender's Schalldämpfer rule (p. 39) quoted. Drop `supplier_reply_silencers.pdf` → "Assist found a quote: 5'150 vs budget 5'400" → Fill all 3 (LV0018, LV0066, LV0178) → marked "Assist", undoable. "Assist never changes a price without your OK."
7. **Price decision (50 s).** Pricing → set competition to "Strong" and we-want-it to "Must win" → win chances move, and "Why 63%" explains it in words. Switch on project costs. Pick Target → "Use CHF X".
8. **Export (20 s).** The workbook with live formulas and source comments, the pricing report, and the SIA file the tender asks for on p. 9. Mark as submitted; after the award the outcome goes into Results history so the next bid learns.
9. **Close (10 s).** "LLM picks, code computes, estimator decides. Runs on Azure OpenAI; the full SIA 451 into SEAP is the next step."

If the jury asks "does it work on any page?": let them pick a page, then filter the Lines by that page or open the full page viewer.
