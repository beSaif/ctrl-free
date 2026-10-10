// Types mirroring docs/SPEC.md (snake_case, as sent by the FastAPI backend).
// Fields marked optional are either optional in the SPEC or extras the UI can use when present.

export type TenderStatus = 'reading' | 'ready' | 'submitted' | 'awarded' | 'error'

export interface Progress {
  stage: 'parsing' | 'meta' | 'translating' | 'matching' | 'pricing' | 'instructions' | 'done' | string
  page?: number
  pages?: number
  done?: number
  total?: number
  message?: string
}

export interface OpenWork {
  lines_to_review: number
  lines_total?: number
  instructions_to_confirm: number
  price_chosen: boolean
}

export interface SubmissionRule {
  page: number
  heading: string
  text_de: string
  text_en: string
  text_en_method?: string
  bbox?: number[] | null
  /** Plain sentences built by code from the rule (where to, what, by when); null when not recognisable. */
  summary?: { short_en: string; short_de: string; full_en: string; full_de: string } | null
}

export interface AwardCriterion {
  label: string
  points: number
  page: number
  rule_de?: string
  rule_en?: string
  rule_en_method?: string
  /** Price criterion only: plain sentence built from the points and the zero-points threshold. */
  summary_en?: string
  summary_de?: string
  zero_above_pct?: number | null
}

export interface TenderSummary {
  id: string
  name: string
  client: string
  trade: string
  file_name: string
  page_count: number
  file_size?: number
  due_at: string | null
  status: TenderStatus
  progress?: Progress | null
  open_work?: OpenWork
  offer_price?: number | null
  /** false when offer_price is only the standard-margin price (not chosen yet) */
  offer_price_final?: boolean
  standard_price?: number | null
  created_at?: string
  updated_at?: string
  updated_by?: string
  profile?: 'school' | 'sports_hall' | string
  meta_sources?: Record<string, number>
  submission_rule?: SubmissionRule | null
  award_criteria?: AwardCriterion[]
  submission?: Snapshot | null
  outcome?: Outcome | null
  error?: string | null
}

export interface OverviewStep {
  key: string
  done: boolean
  title?: string
  text?: string
}

export interface TenderDetail extends TenderSummary {
  overview?: {
    steps?: OverviewStep[]
    totals?: Totals
    facts?: Record<string, unknown>
  }
  systems?: System[]
}

export interface System {
  code: string
  key: string
  name: string
  label: string
  pages: number[]
  lot?: string | null
  profile?: string
}

export type PositionStatus =
  | 'calculated'
  | 'supplier_quote_required'
  | 'assumption_applied'
  | 'review_required'
  | 'insufficient_information'
  | 'out_of_scope'
  | 'non_priceable'

export type Bbox = [number, number, number, number]

export interface SourceLine {
  text: string
  bbox?: Bbox | number[] | null
  role?: 'desc' | 'qty' | 'other_qty' | string
}

export interface PositionSource {
  page: number
  page_size?: [number, number] | number[]
  block_bbox?: Bbox | number[] | null
  qty_bbox?: Bbox | number[] | null
  lines?: SourceLine[]
}

export interface Candidate {
  product_id: string
  score?: number
  why?: string
  description?: string
  model?: string
  manufacturer?: string
  unit?: string
  unit_price?: number
  net_cost_chf?: number
  install_code?: string
  line_total?: number
  diff?: number
  current?: boolean
  suggested?: boolean
  supplier_quote_required?: boolean
  standard_price?: number
  catalog?: Partial<CatalogRow>
}

export interface Match {
  product_id: string | null
  install_code: string | null
  confidence: number
  label: 'Strong' | 'Close' | 'Weak' | 'None' | string
  reason: string
  method?: string
  candidates?: Candidate[]
}

export interface Overrides {
  quantity: number | null
  product_id: string | null
  unit_price: number | null
  hours: number | null
  install_code: string | null
}

export interface SupplierQuote {
  unit_price: number
  source: string
  received_at?: string
  request_id?: string
  by?: 'You' | 'Assist' | string
  log_id?: string
}

export interface PriceFactor {
  key: string
  value: number
  applied: number
  op: '÷' | '×' | string
}

export interface PositionPrice {
  quantity: number
  net_unit_cost: number
  unit_price_source: 'catalog' | 'supplier_package' | 'supplier_quote' | 'manual' | string
  waste_pct: number
  material: number
  base_hours_per_unit: number
  factors: PriceFactor[]
  hours: number
  rate: number
  role: string
  labour: number
  direct: number
  explain?: Record<string, string>
  sources?: Record<string, string>
  /** extras some backends send: what the line would cost without overrides */
  calculated?: { quantity?: number; net_unit_cost?: number; hours?: number; direct?: number }
  calculated_hours?: number
  hours_overridden?: boolean
}

export interface CatalogRow {
  product_id: string
  category: string
  subcategory?: string
  manufacturer?: string
  model: string
  description: string
  unit: string
  list_price_chf?: number
  discount_pct?: number
  net_cost_chf: number
  install_code: string
  source_type: 'catalog' | 'supplier_package' | string
  supplier_quote_required: boolean
}

export interface Position {
  lv_id: string
  system: string
  system_key?: string
  section?: string
  section_name?: string
  page: number
  /** place in the tender's printed order (parser stream index) */
  pdf_order?: number
  text_de: string
  title_de: string
  title_en?: string
  variant_de?: string | null
  quantity: number | null
  unit: string | null
  unit_raw?: string
  kind?: 'item' | 'lump_sum' | 'text_only' | 'subtotal' | string
  make_hint?: string | null
  model_hint?: string | null
  offer_ref?: string | null
  attributes?: Record<string, unknown>
  source?: PositionSource
  match?: Match | null
  status: PositionStatus | string
  status_reason?: string
  overrides?: Partial<Overrides>
  supplier_quote?: SupplierQuote | null
  variant_reason?: string | null
  confirmed?: { by: string; at: string } | null
  flagged?: boolean
  needs_review?: boolean
  pricing?: PositionPrice | null
  /** optional extra: catalogue row of the matched product */
  product?: Partial<CatalogRow> | null
}

export interface PositionGroup {
  key: string
  title: string
  title_de?: string
  count: number
  to_review?: number
}

export interface PositionsResponse {
  positions: Position[]
  groups?: PositionGroup[]
  counts?: Record<string, number>
}

export interface PositionDetail extends Position {
  candidates?: Candidate[]
  instructions?: Instruction[]
  quote_group?: QuoteGroup | null
}

export interface PositionPatch {
  quantity?: number | null
  product_id?: string | null
  unit_price?: number | null
  hours?: number | null
  install_code?: string | null
  variant_reason?: string | null
  status?: string
  reset?: boolean
  confirm?: boolean
  unconfirm?: boolean
  flag?: boolean
}

export type InstructionKind = 'cost' | 'risk' | 'scope' | 'covered'
export type InstructionState = 'open' | 'confirmed' | 'not_relevant'

export interface Instruction {
  id: string
  type: string
  page: number
  section?: string
  text_de: string
  text_en?: string
  text_en_method?: string
  bbox?: number[] | null
  page_size?: number[] | null
  kind: InstructionKind | string
  applies_to?: string[]
  applies_label?: string
  applies_long?: string
  why?: string
  state: InstructionState | string
  confirmed_by?: string | null
  confirmed_at?: string | null
  /** the lines ctrl-free suggested (kept when the estimator changes applies_to) */
  suggested_applies_to?: string[]
  suggested_kind?: string
  /** product family the rule is about, e.g. "silencer" */
  family?: string | null
}

/** Product family of the priceable lines, to pick "all silencers" in one click. */
export interface LineFamily {
  key: string
  label: string
  label_de?: string
  lv_ids: string[]
}

export interface InstructionsResponse {
  instructions: Instruction[]
  counts?: Record<string, number>
  families?: LineFamily[]
}

export interface InstructionPatch {
  state?: InstructionState
  kind?: string
  applies_to?: string[]
}

export type OptionName = 'Aggressive' | 'Target' | 'Standard' | 'Conservative' | string

export interface PricingSettings {
  competition: number
  appetite: number
  sensitivity: number
  ref_win: number
  margins: Record<string, number>
  overhead_pct: number
  transport_pct: number
  material_waste_pct: number
  small_material_pct: number
  supplier_contingency_pct: number
  include_small_material: boolean
  include_supplier_contingency: boolean
  factors: Record<string, number>
  project_costs: Record<string, boolean>
  chosen: OptionName | null
  notes: Record<string, string>
  changed_by?: Record<string, { by: string; at: string }>
}

export interface Scenario {
  name: OptionName
  margin_pct: number
  bid: number
  win: number
  profit: number
  expected: number
  best?: boolean
}

export interface ProjectCostItem {
  key: string
  label?: string
  amount: number
  hours?: number
  rate?: number
}

export interface Totals {
  material: number
  labour: number
  direct: number
  project_costs: number
  small_material: number
  supplier_contingency: number
  transport: number
  overhead: number
  cost: number
  standard_price: number
  by_system?: { system: string; direct: number; lines: number; to_review: number }[]
  by_category?: { category: string; direct: number; lines: number }[]
  coverage?: Record<string, number>
  budget_direct?: number
  budget_share?: number
  scenarios: Scenario[]
  buildup?: { label: string; value: number }[]
  win_explain?: string
  lines?: number
  project_cost_items?: ProjectCostItem[]
}

export interface PricingResponse {
  settings: PricingSettings
  defaults: PricingSettings
  totals: Totals
  changed_count: number
}

export type PricingPut = Partial<Omit<PricingSettings, 'margins' | 'factors' | 'project_costs' | 'notes'>> & {
  margins?: Record<string, number>
  factors?: Record<string, number>
  project_costs?: Record<string, boolean>
  notes?: Record<string, string>
}

export interface QuoteGroup {
  id: string
  key?: string
  title: string
  title_de?: string
  lv_ids: string[]
  sent?: boolean
  sent_at?: string | null
  sent_by?: string | null
  subject?: string
  body?: string
  email?: { to?: string; subject: string; body: string }
  rule?: { text_de: string; ref: string; page?: number } | null
}

export interface QuoteProposal {
  lv_id: string
  unit_price: number
  budget?: number
  source: string
  delta?: number
  pos_no?: string
  text_de?: string
  quantity?: number
}

export interface LogEntry {
  id: string
  at: string
  by: 'You' | 'Assist' | string
  action: string
  lv_id?: string
  before?: unknown
  after?: unknown
  undoable?: boolean
  text?: string
}

export interface AssistProposal {
  id: string
  kind: 'quotes' | 'instructions' | string
  title: string
  text?: string
  source?: string
  received_at?: string
  lines?: (QuoteProposal & { state?: string })[]
  instruction_ids?: string[]
  plan_id?: string
}

export interface AssistWork {
  id: string
  text: string
  page?: number
  pages?: number
}

export interface AssistDone {
  id?: string
  lv_id?: string
  text: string
  at?: string
  log_id?: string
  undoable?: boolean
  undone?: boolean
}

export interface AssistTray {
  needs_ok: AssistProposal[]
  working_on: AssistWork[]
  done: AssistDone[]
}

export interface AssistPlanStep {
  lv_id?: string
  text: string
  action: string
}

export interface AssistPlan {
  plan_id: string | null
  plan: AssistPlanStep[]
  effect?: { direct_before: number; direct_after: number } | null
  answer?: string | null
  kind?: string
  explain?: Explain
}

export interface AssistApplyResult {
  log_id?: string
  message?: string
  detail?: string
  applied?: number
}

export interface ExplainStep {
  text: string
  value?: string | number
  source?: string
}

export interface Explain {
  field: string
  title?: string
  steps: ExplainStep[]
  sources?: string[]
}

export interface Snapshot {
  at: string
  by: string
  offer_price: number
  option: OptionName
  margin_pct: number
  cost: number
  direct?: number
  win: number
  settings?: Partial<PricingSettings>
  notes?: Record<string, string>
}

export interface Outcome {
  notice_no?: string
  award_date?: string
  result?: 'won' | 'lost' | string
  winner?: string
  winning_price?: number | null
  bidders?: number | null
  rank?: number | null
  reason?: string
}

export interface ResultRow {
  tender_id: string
  name: string
  trade: string
  offer_price: number | null
  winning_price?: number | null
  gap_pct?: number | null
  bidders?: number | null
  competition_call?: number | string | null
  result?: string | null
  option?: string | null
}

export interface ResultsResponse {
  rows: ResultRow[]
  stats?: Record<string, unknown> | null
  recorded?: number
}

export interface RuleRow {
  install_code: string
  work_type: string
  unit: string
  base_hours_per_unit: number
  labour_role: string
  default_hourly_rate_chf: number
  factor_keys: string[] | string
}

export interface ReferenceResponse {
  catalog: CatalogRow[]
  rules: RuleRow[]
  parameters: Record<string, unknown>
  source?: Record<string, { file?: string; imported_at?: string; version?: string } | string>
}

export interface ChecklistItem {
  key: string
  level: 'ok' | 'warn' | 'info' | string
  text: string
}

export interface VerificationRow {
  example_id: string
  page: number
  description: string
  quantity: number
  unit: string
  our_lv_id: string | null
  found: boolean
  product_ok: boolean
  install_ok: boolean
  direct_ok: boolean
  status_ok: boolean
  our_direct: number | null
  golden_direct: number
}

export interface Verification {
  loaded: boolean
  source?: string
  rows: VerificationRow[]
  summary?: {
    total: number
    found: number
    product_ok: number
    install_ok: number
    direct_ok: number
    status_ok: number
    subset_direct_ours?: number
    subset_direct_golden?: number
    subset_direct_ok?: boolean
    scenarios_ok?: boolean
  }
}
