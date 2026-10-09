Early accessThe platform is live but still rough. Things may break. [Report a bug or send feedback](https://app.sprintd.org/feedback)

[sprintd Zurich · Cases](https://app.sprintd.org/events/sprintd-zurich/cases)

Bid intelligenceEquans

# From tender to priced offer, without the manual work

## The problem today

Every public tender published on simap still means hours of searching through documents, quantities, specifications and calculations before pricing can even begin. Estimators work out material quantities and assembly times largely by hand and from experience. It is slow, errors creep in, and in an industry with thin margins a wrong bid or a missed opportunity costs real money.

## The expected outcome

A prototype that turns a tender package into a transparent, reviewable, pricing-ready offer. It extracts the relevant information, identifies the bill of quantities (Leistungsverzeichnis, LV) positions, matches them with reference data, suggests quantities, assembly times and prices, and shows every assumption so an estimator can check, adjust and defend the number.

## Who it serves

Equans estimators and bid teams preparing public-procurement offers on the SEAP platform.

### Data

Equans provides a Hacker Package built around a real public tender: a school building project in Oberglatt (Schulhaus Oberglatt). All data is synthetic, so you can use it freely with no restrictions.

What is inside: a README and a quickstart guide, the tender documentation and bill of quantities (LV), a product catalogue with pricing references, productivity and installation benchmarks, project parameters and calculation assumptions as JSON, verified example positions and mappings, and reference outputs to validate and test your results.

Download the ZIP here: https://drive.google.com/file/d/112ooe5qVG6FTd8\_j2cVtyygu\_7\_bltOk/view?usp=drive\_link

Everything follows one common data model that connects tender positions, products, installation logic and pricing, so you spend your time on the product, not on data cleaning or setting up a search server. Equans tested the package internally: a price can be produced directly from the parameters.

### Technology

Use whatever helps you bring the idea to life. You are free to choose your technology, framework, AI service or prototyping tool. No integration with Equans systems is required. Equans itself works with Microsoft Azure and OpenAI, so a solution that could run there is a plus for feasibility, but it is not a must.

Available to every builder at this event regardless of case: Exoscale compute with GPU access (20 team accounts, Anastasios on site Friday 16:30), OpenAI API credits (USD 75 per builder), ElevenLabs credits, n8n Cloud Pro.

OPEN: which Azure accounts or credits the teams on your case get, who hands them out, and whether anything outside Azure and OpenAI is allowed.

### Core use case

Take the Schulhaus Oberglatt tender from the package. An estimator imports the tender package into your tool. The tool extracts the relevant information, identifies the scope items and LV positions, connects them with the reference data (products, installation benchmarks, prices) and generates a transparent first price. The estimator stays in control the whole time: every quantity, assembly time and parameter can be checked and adjusted before the final offer and profit margin are calculated.

Today these steps are done by hand: reading the dossier, extracting quantities, looking up products and times, and assembling the offer..

### Business value

Turn hours of document hunting into minutes of decision-making. Give estimators a transparent, pricing-ready starting point so they can focus on what people do best: judging competitiveness, balancing risk and protecting margin. A faster and more consistent first price reduces both wrong bids and missed opportunities. A win on Sunday is a prototype that produces a first price for the Oberglatt tender that an Equans estimator would trust and could defend.

### Optional stretch goals

Bid optimisation: go beyond a single price. Show how different pricing scenarios affect margin, competitiveness and strategic positioning, and help the estimator understand the trade-offs instead of searching for one perfect number.

### Presentation format

Sunday 09:00 to 11:00, team pitches in the Equans room: 5 minutes live demo, 3 minutes questions from the Equans team, 2 minutes change-over. Slides are optional, a working demo matters more. Equans picks its case winner by 12:00, who pitches again in the Grande Finale (13:00 to 14:30) in front of a neutral jury for the overall prize.

Friday: Equans presents the case on stage from 18:10 (about 5 minutes, in English), followed by a deep dive with the Equans team until 19:00.

The Equans case winner presents to Equans leadership and advances to the Grande Finale to compete for the sprintd overall prize. Equans business experts are on site throughout the sprint.

### Key presentation elements

Show how a tender package becomes a pricing-ready offer: from documents and LV to structured positions, quantities and assembly times, a price recommendation and a transparent offer an estimator can review and refine. Show the numbers behind the price, not only the price, and what happens when the estimator changes a parameter.

### Prototype requirements

Must have: a working prototype on the provided data that runs the journey from tender package to offer, with every number traceable to the tender or the reference data. Plus a short note (a few sentences or one slide) on the path to production. Everything else belongs in the stretch goals.

## How the jury scores

| Criterion | Weight | What we reward |
| --- | --- | --- |
| Creativity & innovation | 10% | A fresh, practical approach to tender pricing. |
| Feasibility | 25% | Could run on Azure and fits into the existing bid process. |
| Design & usability | 15% | Usable by an estimator without training. |
| Impact & relevance | 30% | Produces a price an estimator would trust. |
| Traceability | 20% | Every number and recommendation links back to the tender. |

## Prize

Internship, direct entry or paid follow-up with Equans (up to 2 spots), plus gift packages for the top 3 teams on this case.

From tender to priced offer, without the manual work · sprintd Zurich · sprintd