# Path to production

**In one paragraph (for the slide):** ctrl-free runs as two containers, a FastAPI service and a static React app, on Azure Container Apps. Azure OpenAI in Switzerland North (or a Swiss-hosted model) handles matching and translation. Tender files and state go to Azure Blob Storage and Postgres. Entra ID handles sign-in for the estimators. Every price is computed in plain code from Equans' own catalogue, install rules and parameters, so moving to production is mostly swapping the reference files for live data and the export for the real SIA 451 interface into SEAP.

## What already fits Azure
- **LLM provider:** `backend/app/llm.py` switches to `AzureOpenAI` when `AZURE_OPENAI_ENDPOINT` is set. No code change.
- **The LLM never computes a number.** It only picks from a short list of catalogue IDs, or answers "none". Every price is deterministic and repeatable, and every LLM answer is cached and auditable.
- **Rules-only mode:** set `LLM_OFFLINE=1` (or lose the LLM) and the pipeline still runs end to end. On the 22 verified examples the rules-only matcher scores 22/22.
- **Stateless API:** the API holds no state of its own. State lives per tender (JSON today, Postgres/Cosmos tomorrow), and the PDF is stored next to it (Blob).

## Steps
| Step | Today (prototype) | Production |
|---|---|---|
| Hosting | `dev.sh` on a laptop | Azure Container Apps: backend and frontend images, autoscale to zero |
| LLM | OpenAI API (rules-only fallback) | Azure OpenAI in Switzerland North, private endpoint, or a Swiss-hosted model |
| Reference data | CSV/JSON in `backend/data/reference`, imported in the UI; supplier and negotiated price lists (CSV/XLSX) with precedence | Sync from Equans' ERP, supplier price feeds and productivity handbooks, versioned |
| Storage | JSON per tender on disk | Postgres for state, Blob for PDFs and exports, audit log table |
| Auth | demo person switcher (junior / senior); every log entry carries the name and role; senior approves on the Changes screen | Entra ID SSO with the same roles; approvals as a required step before submission |
| Export | xlsx with live formulas, report PDF, simplified SIA CSV | Full SIA 451 interface file and a SEAP import |
| Supplier quotes | drafted German emails, reply PDF read by Assist | Outlook/Graph integration: send the request, and replies land in the tender automatically |
| Bid optimisation | parameters plus the estimator's read | Learn from Results history (award notices from simap), using p. 9 award scoring per tender |
| Learning | learned matches in a JSON file, applied first on new tenders, disabled when overridden more than confirmed | Shared across estimators in Postgres, reviewed by a senior before they apply company-wide |
| Positions | free-text LV parser (any layout with Mass-Gattg./Massbetrag columns) | Add NPK-coded LVs (exact match on NPK numbers) and SIA 451 input |

## Risks and how we handle them
- **A wrong match goes into the price.** The match is restricted to the catalogue. Confidence and status are shown on every line, the review queue is sorted by money at risk, and nothing is final without "Confirm".
- **New tender layouts.** The parser detects columns from the header row, not from fixed positions. Unknown lines get a status, never a forced price.
- **Data privacy.** Tenders are public documents. Prices and margins stay in Equans' Azure tenant.
