# Equans case team briefing: presentation script

About 10 minutes, 13 slides. Same text as the deck's speaker notes.

**1. Cover**
"Alright, quick one before we start building. I want everyone on the same page about the Equans case: what they actually want, what the data looks like, and how we're going to build it. About ten minutes, then we split up."

**2. The ask**
"So Equans prices construction tenders. Right now their estimators get a huge PDF and go line by line, Ctrl+F'ing through handbooks to find hours and prices. Our job is to give them a first price for every line automatically, and to show where every number came from. They said twice they don't want a perfect price model, they want something that works from start to finish. Look at the scoring on the right: impact and traceability together are half the points. Feasibility is a quarter, and that basically means 'could this run on Azure inside our process', so we mention Azure in the pitch."

**3. The big picture**
"Here's the whole chain. A town, in this case Oberglatt, publishes a tender on simap, the Swiss public tender website. Equans downloads the package. Inside it is the LV, which is basically a giant list of things to build, each line with a quantity and an empty price. An estimator fills those prices, adds margin, and submits through SEAP, their offer platform. Everything grey already exists. The orange box is us: we fill in the prices and show our sources. We don't need to connect to simap or SEAP. Our output just has to be easy to carry over, like an Excel file."

**4. What is an LV position**
"This is the tricky part. On the left is literally page 78. One block of German about a supply air valve, and at the bottom two sizes: 10 cm, 5 pieces, and 12.5 cm, 6 pieces. 'Stk' just means pieces. That one block has to become two rows, like on the right. There are no position numbers in this PDF, so how do we find positions? We read the PDF text line by line, and whenever a line ends with a unit and a number, like 'Stk 5' or 'm2 12', that's the end of a position. The lines above it are its description. If a block has two of those lines, it becomes two positions. Always keep the page number, because that's our traceability."

**5. The starter package**
"We got six files. The PDF is the hard one: 202 pages, but the text is real text, so no OCR. Pages 1 to 66 are conditions; pages 67 to 199 are the actual price list, split into five ventilation systems. The other five files are easy tables: a catalogue of 56 products with prices, install rules with hours per unit, project parameters like overhead and margin, 22 example positions we can test against, and the expected answers for those 22."

**6. The maths is solved**
"Good news: the maths is already done. Take the first example, 5 supply valves. Material is 5 times 74.80 times 1.04 for waste, so 388.96. Hours are 5 times 0.65 hours, times a few site factors, so 4.35 hours. Times 96 francs an hour is 417.30. Add them up: 806.26, exactly Equans' own answer. I wrote a small Python script for this, pricing_engine.py, and it's in our Project. You give it a quantity, a product and an install code; it reads the catalogue and parameter files and gives back material, hours, labour and total, plus the formula behind each one. I ran it on all 22 examples and every number matches, the bid scenarios too. It doesn't read the PDF or choose products, that's the parser and the matcher. So nobody needs to worry about the pricing logic."

**7. The pipeline**
"So here's what we build. Five steps. Parse the PDF into rows. Match each row to a catalogue item, and this is the only place we use the LLM: it picks one of five candidates, or says 'no match'. Then plain Python does all the maths. Then the estimator reviews it in a grid, with the PDF highlighted next to it and a panel that explains each number. Then we export to Excel. We call it a glass box: the opposite of a black box, because you can see how every price was made. Why keep the LLM away from the numbers? A study this year from Ljubljana tested recent models, GPT-5 and Claude Sonnet 4.5, on drafting quotes from customer emails. They picked the right items about half the time and got quantities right at most 15%. To be fair, their task was harder than ours, because our quantities are printed in the LV. But the lesson holds: maths in code is exact, gives the same answer every time, and we can show where every number came from."

**8. How matching works**
"So how do we get those five candidates? Three steps. First, turn the German text into simple English attributes: supply air valve, DN100, pieces. Converting 10 cm into DN100 is done in code. Second, a quick search in code: throw out catalogue items with the wrong unit, score the rest by how many words they share with our position, and keep the top five. This table is the actual result for the first valve. Notice the top two tie: to a word search, the DN100 and the DN125 valve look the same. That's why the last step exists. The LLM looks at these five and has to answer with one ID from the list, or say none. It picks P-AIR-001, exactly Equans' answer. And because it can only pick from the list, it can never make up a product."

**9. Ground rules**
"Two things to keep in mind. First, the PDF has traps: no position numbers, several sizes in one block, the sports hall section writes the quantity at the start of the line, and some lines have no quantity at all. Second, and this is important: we build for any tender, not just this one. Equans said it in the intro. No hardcoded page numbers or product IDs. The catalogue only has 56 items, so lots of lines won't match, and that's fine: they get a status like 'supplier quote needed', never a fake price. The 22 examples are for testing, not for tuning. If we're confident, we let the jury pick a random page in the demo and price it live."

**10. Bid optimization**
"This is the stretch goal Equans really cares about. Instead of one price, we show three options. Aggressive: lower margin, 426k, about a 69% chance to win. Target: 432k, 63%. Conservative: 444k, 49%, but more profit if we win. These numbers are for the 22 examples only. Equans told us estimators decide this by gut feel today, based on things like how many competitors there are. Also a nice find on page 9 of the tender, which is how the client scores the bids. Every bid gets points out of 100, and price is worth up to 60 of them. The cheapest bid gets all 60, and a bid 50% more expensive gets zero. So if the cheapest bid is 400k and we bid 420k, that's 5% more: we lose a tenth of the price points and get 54 instead of 60. Every 1% above the cheapest costs 1.2 points, which we'd have to win back on quality, capacity or apprentices. That's a real rule we can build the optimizer on."

**11. Who does what**
"Four lanes. P1 does the parser, PDF to rows. P2 does matching and checks accuracy against the 22 examples. P3 builds the review UI. P4 handles the pricing engine, Excel export, bid range and the supplier quote flow, plus the pitch. Before anyone starts, we agree on what a row looks like: id, system, section, text, quantity, unit, page, status. Then we can all work in parallel. First goal: one row going all the way from PDF to price by tomorrow morning."

**12. The demo**
"This is what we're aiming for on Sunday. Five minutes. Upload the PDF, rows fill in, click the first valve and show it matches Equans' number exactly. Show a supplier quote item getting filled in. Swap a match, and the total changes. Move the competitor slider on the bid range. Export to Excel. Close with 'LLM picks, code computes, estimator decides.' Everything we build should serve this flow."

**13. Questions and next step**
"Last thing. There are a few questions we need to ask Equans tonight, mainly what to include in the full total, what SEAP takes in, and what Azure access we get. Then we start on the parser right away, because that's the hard part. All the details are in the playbook doc in our Project. Questions? Okay, let's go."
