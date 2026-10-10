# What to improve: price accuracy and bid optimisation

10 Oct 2026, branch `v4`. Based on a full run of the Oberglatt tender (rules-only, with the committed LLM cache), the backend tests (143 passed), and a line-by-line look at the output.

## Summary

The 22 Equans examples are priced to the cent. But the price for the **full tender** is far from complete:

- **About CHF 300k of air-handling units is missing.** Three units have a catalogue match but no quantity, so they count as zero.
- **CHF 115,700 of project costs is switched off by default**, along with small material and supplier contingency.
- **174 of 255 lines add nothing to the price**, not even labour, because the product isn't in the catalogue.
- **No duration and no inflation.** The tender asks for installation times with a crew of 2 (p. 25) and fixes prices until 2029 (p. 21), but the app shows neither.

Fixing only the first two moves the cost from **CHF 869k to about CHF 1.35M** (+56%), and the 174 lines still aren't counted. A jury member who asks "is this the price for the whole tender?" would expose this. Impact ("a price an estimator would trust") is 30% of the score.

### Do tonight, in this order

| # | What | Why | Effort |
|---|---|---|---|
| 1 | Quantity 1 for device headings with a blank quantity (A1) | Adds about CHF 300k that is clearly in scope | 1 h |
| 2 | Turn on project costs and allowances for the full tender (A2) | The package README says they belong in the price | 30 min |
| 3 | Show "priced / not priced yet" honestly, with an estimate range (A3) | Turns the biggest weakness into a trust feature | 2 h |
| 4 | Award-points win model from tender p. 9 (C2) | Strongest stretch-goal story, fully traceable | 2–3 h |
| 5 | Expected-profit curve chart (C1) | Shows the trade-off instead of 3 dots | 1 h |
| 6 | Duration card: hours, weeks with a crew of 2, inflation line (D) | The tender asks for installation times (p. 25); prices are fixed until 2029 | 1–2 h |

---

## Where the numbers stand today

| | Value |
|---|---|
| Lines found | 309 (255 items + 54 total lines) |
| Calculated from the catalogue | 58 |
| Supplier quote needed: not in catalogue | **174** (priced at CHF 0) |
| Supplier quote needed: budget price | 9 (priced, 65% of direct cost) |
| Assumption applied | 8 |
| No quantity | 6 (priced at CHF 0) |
| Lines in the review queue | 197 |
| Direct cost | CHF 781,276 |
| Cost (after transport and overhead) | CHF 868,877 |
| Equans examples | prices 22/22, statuses 21/22 (LV0064 silencer, intended) |

---

## A. Accuracy of the price

### A1. Air-handling units with no quantity (biggest single gap)

The tender leaves the quantity column blank on the heading of each device ("Zuluftgerät 1-1 … Stk", p. 67) and lists the parts below it. The parser handles LV0042 and LV0095 correctly (qty 1), but four device headings stay without a quantity:

| Line | Page | Match | Budget price |
|---|---|---|---|
| LV0001 | 67 | P-AHU-1000 | 28,000 |
| LV0149 | 147 | P-AHU-10500 | 185,000 |
| LV0210 | 174 | P-AHU-3500 | 62,000 |
| LV0003, LV0155 | 71, 152 | none (exhaust units, stainless steel) | n/a |

With waste and installation hours, the three matched units are worth about **CHF 302k direct cost**.

**Fix:** when a device heading has a unit (`Stk`) but no number, and the name follows the "X-Y" device pattern, set quantity 1 with status `assumption_applied` and the reason "Tender gives no quantity for this device; 1 assumed from the heading 'Zuluftgerät 1-1' (p. 67)". See the existing handling in `backend/app/parser.py:983`. The estimator can still change it.

**Watch out:** the part lines under each device (casing sections, coils: LV0002, LV0043, LV0150–LV0154 …) are currently unpriced. If the AHU budget price covers the whole unit, mark those parts as "included in LV00xx" so they are never double counted later. Ask Equans which way they price it (see section E).

### A2. Project costs and allowances are off by default

`default_settings()` in `backend/app/reference.py:243` switches off:

| Item | Amount |
|---|---|
| Engineering 420 h × 145 | 60,900 |
| Commissioning 160 h × 155 | 24,800 |
| Hygiene inspection | 18,000 |
| Documentation | 12,000 |
| Small material 3.5% of catalogue material | about 5,800 |
| Supplier contingency 3% of package material | about 12,300 |

They are off so that the 22-example subset matches Equans' golden numbers. That's right for the check, but the package README defines the full price as including "engineering/project management + transport/equipment + special costs".

**Fix:** two modes. "Equans example check" keeps everything off and is used only by `/verification`. The tender itself starts with everything on, and the build-up says so.

### A3. 174 lines add nothing to the price

Every line whose product isn't in the 56-item catalogue gets `pricing = null`, so even its **labour** is missing, although most have an obvious install rule. What's missing:

| Group | Lines | Possible install rule |
|---|---|---|
| Silencers (other sizes) | 14 | SILENCER |
| Insulation 15 / 100 mm, fire insulation EI30/EI60 | 14 | INSULATION_30 / _60 |
| Inspection covers | 12 | FIRE_ACCESS |
| Fire penetration seals | 8 | FIRE_SEAL_RECT / _ROUND |
| Air diffusers, grilles, valves | 15 | DIFFUSER |
| Flow controllers | 4 | VAV / CAV_CONTROLLER |
| Ducts (ground pipes, bends, sleeves) | 8 | DUCT_FITTING |
| Leak tests, "Installation and transport", field devices | 14 | hours or per system |
| Sensors, smoke detectors | 20 | CONTROL_POINT |
| Ceiling panels, hoods, coatings, other | 29 | review |

**Fix, in three tiers, each clearly labelled:**

1. **Labour now, material later.** If the install rule is clear, compute the hours and labour, and show material as "waiting for quote". This is fully traceable, because the hours come from `productivity.csv`.
2. **Estimate the material from similar catalogue items**, for example price per m² of face area for rectangular silencers, or price by diameter for circular parts. Label it "Estimate from P-SIL-001…004, not a quote" and keep the line in the review queue.
3. **Show a range for the rest:** "174 lines not priced yet, estimated CHF X–Y." Never show a single total as if it were complete.

Show coverage at the top of the Pricing page: "Priced: 84 of 255 lines; estimated: N; open: M."

### A4. Services and leak tests

Some tender lines are **work Equans does**, not things it buys. The app sends them all to "ask a supplier" at CHF 0. LV0111 (p. 135, 176 h of installation work) shows the right handling already: 176 h × CHF 96 = CHF 16,896.

| Lines | What the tender asks | What it really is | Fix |
|---|---|---|---|
| LV0035, LV0082, LV0136, LV0198, LV0250 (p. 84 …) "Montage und Transport", qty 1 per system | Install, test run, balancing, commissioning, instructing staff, transport to site | Already in the project-wide costs: transport 2.5%, commissioning 160 h, and the hours on every product line | Status "Covered by: transport + commissioning", linked to those amounts. **No new price**, or it's counted twice. |
| LV0199, LV0251 (p. 168, 193) install client-supplied field devices | Install devices from building automation (BKP 237); hygiene inspection per SWKI VA 104-1 | Labour (`CONTROL_POINT`, 1.1 h per device) + the project cost "Hygiene inspection CHF 18,000" | Price the labour; link the hygiene part to the project cost |
| LV0004, LV0045, LV0056, LV0096, LV0160, LV0211 duct leak tests | Testing company e.g. Schmidlin AG, smoke test, report | An **outside testing company**, so a supplier quote **is** right | Group all 6 into one quote request |

Today these lines are counted **zero times** (unpriced, and project costs off). If someone later prices them *and* turns on project costs, they're counted **twice**. The "covered by" link makes each piece of work count exactly once, and shows where.

**Small bug seen here:** LV0111's English text contains a Russian word ("for монтаж/installation work"), an LLM translation glitch. Add a check that the English text uses only Latin characters.

**Check for double counting:** `productivity.csv` has `COMMISSION_SYSTEM` (16 h per system) and the project costs also have commissioning (160 h). Decide which one applies, and show it in one place only.

### A5. Silencer length check

LV0064 / LV0065 / LV0119 / LV0228 / LV0229: the tender asks for 1000 mm (500 mm on LV0065), and the catalogue's P-SIL-002 is 900 mm. Today only the LLM notices. Add length to `_size_state` in `backend/app/matcher.py` so the rules flag it too (this was already the next step in `llm_matching_findings.md`).

### A6. Smaller items to check

- **Material waste on supplier packages.** The 4% waste is also applied to the AHUs (LV0042: CHF 98,000 → 101,920). Waste makes sense for duct and insulation, not for a whole AHU. Ask Equans; the README formula applies it everywhere.
- **Wrong size read from a heading.** LV0001's attributes have `dims_mm: [1, 230]` and `size_text: "1x230"`, taken from "1-1" or "230V", not from the real size (780 × 1460 × 1670). It didn't change the match here, but it could on another tender.
- **LV0255 "Mounting rail, example", 500 m (p. 197, Montagesystem Flachdach).** The word "example" suggests a placeholder in the tender. Check that it's a real line. The whole Montagesystem system is priced at CHF 0.
- **LV0202** (insulation 100 mm, p. 169) has no quantity. Check whether the PDF really leaves it blank.

---

## B. Measuring accuracy (so improvements don't break things)

The 22 examples cover only 9% of the lines. Before changing the matcher or parser:

1. **Label 40–60 more lines by hand** (an hour of work for two people), especially the "not in catalogue" groups and the AHU blocks. Save them next to `backend/data/reference/benchmark/`.
2. **Measure each step separately:** lines found (parser), product and install rule correct (matcher), status correct, and price within 1%.
3. **Add a full-tender regression test** to `backend/tests/` that checks the totals (lines, priced, cost) and fails if they change unexpectedly. Today a parser change could drop 30 lines and every test would still pass.
4. **Keep LLM-on and LLM-off runs side by side** (as in `llm_matching_findings.md`) and report both.

---

## C. Bid optimisation

### How it works today
Win chance = 55% + 5 (we want it) − 5 (strong competition) − 5 points for each 1% above the standard price. Expected profit = win chance × (price − cost). The option with the highest expected profit is marked "best."

### C1. "Best" is almost always the most expensive option
On the 22-example subset (cost CHF 414,489), the best margin is about **8% (CHF 451k, 41% win chance)**, above every scenario, so Conservative always gets the tag. The result depends almost entirely on one guessed number:

| Points lost per 1% of price | Best margin |
|---|---|
| 0.03 | 11% |
| 0.05 (Equans) | 8% |
| 0.08 | 6% |

**Build:** a chart with price (or margin) on the bottom and expected profit going up, the four scenarios as dots, and a shaded band for sensitivity 0.03–0.08. That matches the case text: "understand the trade-offs instead of searching for one perfect number."

### C2. Win chance from the tender's own award rule (p. 9)
The parser already extracts it:

- Price is worth **60 of 100 points**. The lowest offer gets all 60, and 150% of the lowest gets 0, so **every 1% above the lowest offer costs 1.2 points**.
- Quality 25, capacity 10, apprentices 5.

So 3 more quality points than a competitor buys about 2.5% of price headroom. The estimator enters (a) where competitors usually land compared with our cost (low / likely / high) and (b) our expected non-price points compared with theirs. Simulate a few thousand competitor draws and count how often we have the most points. Keep Equans' linear model as the default so the 22/22 check holds.

### C3. Overhead is paid whether we win or not
The 8.5% overhead is mostly fixed. If you measure the value of winning against cost before overhead, the best margin drops from **about 8% to about 4.3%, with a 60% win chance (CHF 434k)**. Add one switch ("overhead is fixed") and explain it in one sentence.

### C4. Cost uncertainty: chance of losing money
65% of direct cost is on budget prices, and many lines aren't priced yet (A3). Give each price source an uncertainty (catalogue ±0, quote ±2%, budget ±15%, estimate ±25%, adjustable) and show for each scenario: **"chance this job loses money."** The same numbers rank supplier quote requests by how much they would narrow the range.

### C5. Learn from results
The app already stores outcomes (simap number, winner, winning price, bidders, rank) and starts learning after 3. Add one field, **"lowest competing offer"** (from the bid-opening record, BöB Art. 37), because that is what calibrates C2. Data sources: Equans' own bid history, bid-opening records, simap award notices (Art. 48), and debriefings. Don't seed fake history for the demo.

---

## D. How long the job takes

The app doesn't show this today: no duration, crew size or schedule anywhere. But the tender asks for it, and it affects the price.

### What the tender says

| Topic | What it says | Page |
|---|---|---|
| Dates | Construction starts Feb 2027, rough installation Apr 2027, commissioning Mar 2029, handover Apr 2029 | 25 |
| Installation times | "The installation times stated by the contractor **with a crew of 2** … are the basis for planning and the construction programme." More fitters may be added to finish faster, at no extra price. | 25 |
| Award points | Capacity is worth **10 of 100 points**: staffing (foremen, skilled workers, helpers, apprentices, % of time) and whether the schedule can be met or beaten. A contractor schedule can be attached. | 62, 9 |
| Overall schedule | The client's Gantt chart: construction runs 535 days from 3 Feb 2027 | 65 |
| Fixed prices | "All offer prices are **fixed until completion**", with no claims for inflation | 9, 17, 21 |

### What we can compute already

Every priced line already has installation hours. Today's priced lines add up to **1,837 hours**:

| System | Hours |
|---|---|
| LA01 Side rooms basement | 120 |
| LA02 Dining rooms ground floor | 333 |
| LA03 Kitchen / dishwashing | 299 |
| LA04 Classrooms upper floor | 808 |
| LA05 Gym | 278 |
| **Total** | **1,837** |

With a crew of 2 at about 42 h per week each (84 h per week), that's **about 22 weeks (5 months) on site**. Adding the AHUs (A1) gives about 1,970 h, roughly 23–24 weeks. The 174 unpriced lines (A3) will add more, so show it as a minimum for now. Engineering (420 h) and commissioning (160 h) come on top, but are mostly done by other people.

### What to build

1. **A "Duration" card** on the Overview or Pricing page: total installation hours, weeks with a crew of 2, and weeks with 3 or 4. Every number links to the hours on the lines, with the tender's crew-of-2 rule quoted from p. 25.
2. **Hours by system on a timeline** against the tender's window (rough installation Apr 2027 to commissioning Mar 2029). Roughly 5 months of work in a window of almost 2 years means **the schedule isn't the risk here**. The crew can work in stages. Saying so directly helps the estimator fill in the capacity form (p. 62) with confidence.
3. **Pre-fill the capacity form (p. 62)** from the hours: suggested foreman / skilled worker / helper split and the % of time. That's 10 award points the app can help with, and it ties into the award-points model (C2).
4. **Add inflation to the price.** Prices are fixed until 2029, but the catalogue prices are from 2026. Work happens around 2027–2028, so material and labour will likely cost more than the catalogue says. Add an adjustable "inflation until midpoint of work" line to the build-up. For example, with 2% a year as an *assumption to confirm with Equans*, the midpoint around mid-2028 is about 1.75 years away, so about **+3.5% on material and labour**. Today this risk isn't in the price at all.

---

## E. Other product suggestions

- **Make 197 lines to review manageable:** "N lines under CHF 500 are X% of cost: confirm all", plus confirming a whole group (e.g. all diffusers in LA02) at once.
- **Explain LV0064 on the verification page** instead of showing it red: "we found 900 vs 1000 mm."
- **Cheapest compliant alternative** for lines covered by the tender's variant rule (p. 36), with total savings.
- **Tender revisions:** re-upload a revised LV and show which lines and how much of the price changed.
- **Load the demo price lists** (`equans_negotiated_prices_2026.csv`, `supplier_pricelist_demovent_2026.xlsx`): the Price lists page is empty in a fresh run, and they may cover some of the 174 lines.

---

## F. Questions for the Equans team (Friday deep dive or Sunday Q&A)

1. For an AHU, do you price the heading as one package, or each part line separately?
2. Do engineering, commissioning, hygiene and documentation always go into a full-tender price? And small material / supplier contingency?
3. Should material waste apply to supplier packages like AHUs?
4. Do you collect bid-opening records after each tender? What's your typical gap to the winning price?
5. How do you usually price lines that aren't in your catalogue before supplier quotes arrive: a rate per kg, per m², or experience?
6. With fixed prices until 2029 (p. 21), what inflation allowance do you usually add, and do your 2026 catalogue prices already include any?
7. How many working hours per week do you plan for a fitter, and how do you usually fill in the capacity form (p. 62)?

---

## G. Pitch wording if there's no time to fix A1–A3

Don't present CHF 869k as the tender price. Say: "84 of 255 lines priced from Equans' data; the rest are flagged with the next step, and here is what's still open." Being honest about coverage is part of traceability (20% of the score).
