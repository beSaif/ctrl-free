# LLM matching: what the first live run showed

10 Oct 2026. First run of the full Oberglatt tender with the LLM switched on (gpt-5.4-mini for picks, gpt-5.4 for the harder calls). Until then the pipeline had only run rules-only because the OpenAI account had no billing.

## The run

- 32 s for the whole tender, 34 LLM calls, about 200k input and 20k output tokens. Every answer is cached in `backend/data/llm_cache/`, so a rerun takes about 3 s and works offline.
- The LLM picked the same product as the code on every line but one. The exception was LV0224 (p. 187, flow controller), where the code found nothing and the LLM suggested a Weak match. The code still warns that the catalogue product is a variable-flow controller and the tender asks for a constant one, so the line stays in the review queue.
- No price changed. The 22 Equans examples, the CHF 414'489.12 baseline and the 3 bid scenarios still match to the cent.

## What went wrong: confidence labels

The products were right, but the labels (Strong, Close, Weak) got worse. The label decides whether a line counts as done or goes to the review queue.

The old rule: when the code and the LLM agreed on the product, keep the higher of the two confidences, and lower it to Close whenever the LLM listed any assumption. This caused two problems.

1. **Too fussy.** About 10 exact matches were downgraded to Close because the LLM noted something unimportant, like "Colour not specified, architect's choice assumed" (LV0116, p. 135). They went to review for no reason.
2. **Too confident.** About 25 lines were upgraded from Close to Strong where the code had rightly seen only a partial fit. Example: LV0080 (p. 110) asks for a temperature-and-humidity sensor, the catalogue only has a temperature sensor, and the LLM called it Strong.

Result: 192 → 201 lines to review.

## What went right: a real catch

On the DN100 silencers (LV0064, LV0065, LV0119, LV0228, LV0229), the LLM disagreed with the code. The catalogue's only DN100 silencer, P-SIL-002 (CS-100-900), is 900 mm long, but the tender asks for 1000 mm (500 mm on LV0065). The code only checked type and diameter and missed it. The existing safety rule did its job: the code's product and price stayed, the line dropped to Close, and the LLM's objection was recorded for the estimator.

Equans' own example counts LV0064 as plainly "calculated", so our status score against their answers is now 21/22. The prices are still 22/22. This is a good demo moment: "the AI spotted 900 vs 1000 mm, the code kept the price and asked you."

## The fix

New rule in `combine_picks` (`backend/app/matcher.py`): **when the code and the LLM agree on the product, the code keeps its label and the LLM only adds its reason.** The LLM's assumptions are kept as `llm_notes` on the match, but they don't change the status. When they disagree, nothing changes: the code's match stays, capped at Close, with the disagreement recorded.

This follows the project's rule: "LLM picks, code computes, estimator decides". The label is computed, so code owns it.

| | Rules only | LLM, old rule | LLM, new rule |
|---|---|---|---|
| Lines to review | 192 | 201 | 197 |
| Prices match Equans | 22/22 | 22/22 | 22/22 |
| Status matches Equans | 22/22 | 21/22 | 21/22 |

The 5 extra review lines compared with rules-only are mostly the silencer length warnings, which are real.

## Takeaways

- Where the LLM is useful: finding a mismatch the code doesn't check (here, silencer length), and suggesting something where the code has no match.
- Where it isn't reliable: judging its own confidence. It upgrades partial matches and downgrades exact ones over trivial details.
- Next step: add length to the code's size check (`_size_state`) so the 900 vs 1000 mm mismatch is caught without the LLM.
