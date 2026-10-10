// In-memory mock backend implementing the same Api as client.ts, so the UI runs standalone.
// Pricing follows research/pricing_engine.py (golden: direct 372'700.12, cost 414'489.12,
// scenarios 426'000/0.69, 432'000/0.63, 444'000/0.49). State persists in localStorage.
import catalogCsv from './mockdata/catalog.csv?raw'
import rulesCsv from './mockdata/productivity.csv?raw'
import {
  INSTRUCTIONS,
  LINES,
  PROJECT_PARAMETERS,
  QUOTE_GROUPS,
  SEED_REPLY,
  SYSTEMS,
  TENDER_META,
  type RawLine,
} from './mockdata/oberglatt'
import { DEFAULT_PEOPLE, type Api, type ExportKind } from './client'
import type {
  AssistApplyResult,
  AssistDone,
  AssistPlan,
  AssistPlanStep,
  AssistProposal,
  AssistTray,
  AssistWork,
  Candidate,
  CatalogRow,
  ChangesResponse,
  ChecklistItem,
  Instruction,
  InstructionPatch,
  LogEntry,
  Outcome,
  Overrides,
  Position,
  PositionDetail,
  PositionPatch,
  PositionPrice,
  PricingPut,
  PricingResponse,
  PricingSettings,
  QuoteGroup,
  QuoteProposal,
  ReferenceResponse,
  RuleRow,
  Scenario,
  Snapshot,
  SupplierQuote,
  TenderDetail,
  TenderSummary,
  Totals,
} from './types'

// ---- reference data ------------------------------------------------------------

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  for (const line of text.trim().split(/\r?\n/)) {
    const cells: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') q = !q
      else if (c === ',' && !q) {
        cells.push(cur)
        cur = ''
      } else cur += c
    }
    cells.push(cur)
    rows.push(cells)
  }
  const [head, ...body] = rows
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])))
}

const CATALOG: CatalogRow[] = parseCsv(catalogCsv).map((r) => ({
  product_id: r.product_id,
  category: r.category,
  subcategory: r.subcategory,
  manufacturer: r.manufacturer,
  model: r.model,
  description: r.description,
  unit: r.unit === 'm2' ? 'm²' : r.unit,
  list_price_chf: Number(r.list_price_chf),
  discount_pct: Number(r.discount_pct),
  net_cost_chf: Number(r.net_cost_chf),
  install_code: r.install_code,
  source_type: r.source_type,
  supplier_quote_required: r.supplier_quote_required === 'true',
}))
const CAT: Record<string, CatalogRow> = Object.fromEntries(CATALOG.map((c) => [c.product_id, c]))

const RULES: RuleRow[] = parseCsv(rulesCsv).map((r) => ({
  install_code: r.install_code,
  work_type: r.work_type,
  unit: r.unit === 'm2' ? 'm²' : r.unit,
  base_hours_per_unit: Number(r.base_hours_per_unit),
  labour_role: r.labour_role,
  default_hourly_rate_chf: Number(r.default_hourly_rate_chf),
  factor_keys: r.factor_keys ? r.factor_keys.split('|') : [],
}))
const RULE: Record<string, RuleRow> = Object.fromEntries(RULES.map((r) => [r.install_code, r]))
const RAW: Record<string, RawLine> = Object.fromEntries(LINES.map((l) => [l.lv, l]))

const P = PROJECT_PARAMETERS
const PROJECT_COST_ITEMS = [
  { key: 'engineering', hours: P.project_costs.engineering_hours, rate: P.project_costs.engineering_rate_chf_per_h },
  { key: 'commissioning', hours: P.project_costs.commissioning_hours, rate: P.project_costs.commissioning_rate_chf_per_h },
  { key: 'hygiene', amount: P.project_costs.hygiene_inspection_chf },
  { key: 'documentation', amount: P.project_costs.documentation_chf },
].map((x) => ({ ...x, amount: x.amount ?? (x.hours ?? 0) * (x.rate ?? 0) }))

const DEFAULT_SETTINGS: PricingSettings = {
  competition: -0.05,
  appetite: 0.05,
  sensitivity: 0.05,
  ref_win: 0.55,
  margins: { Aggressive: 2.5, Target: 4.0, Standard: 5.5, Conservative: 6.5 },
  overhead_pct: 8.5,
  transport_pct: 2.5,
  material_waste_pct: 4.0,
  small_material_pct: 3.5,
  supplier_contingency_pct: 3.0,
  include_small_material: false,
  include_supplier_contingency: false,
  factors: { ...P.productivity_factors },
  project_costs: { engineering: false, commissioning: false, hygiene: false, documentation: false },
  chosen: null,
  notes: { competition: '', appetite: '', sensitivity: '' },
  changed_by: {},
}

const FACTOR_LABEL: Record<string, string> = {
  site_efficiency: 'site efficiency',
  mounting_height_school: 'ceiling height',
  mounting_height_sports_hall: 'ceiling height, sports hall',
  school_logistics: 'school logistics',
  timber_interface: 'timber interface',
}

// ---- state ---------------------------------------------------------------------

interface MockPos {
  overrides: Overrides
  supplier_quote: SupplierQuote | null
  variant_reason: string | null
  confirmed: { by: string; at: string } | null
  flagged: boolean
}
interface MockInstr {
  state: string
  kind: string
  applies_to: string[]
  confirmed_by: string | null
  confirmed_at: string | null
}
interface Reply {
  id: string
  file: string
  received_at: string
  group: string
  lines: { lv_id: string; pos_no: string; unit_price: number }[]
}
type Op = { op: 'fill' | 'fill_confirm' | 'confirm_instr' | 'note'; lv_id?: string; iid?: string; unit_price?: number; source?: string }
interface MockLog extends LogEntry {
  snapshot?: { positions: Record<string, MockPos>; instructions: Record<string, MockInstr> }
  undone?: boolean
}
interface MockTender {
  id: string
  name: string
  client: string
  trade: string
  file_name: string
  page_count: number
  file_size: number
  due_at: string | null
  profile: string
  created_at: string
  updated_at: string
  updated_by: string
  reading: { started: number; duration: number } | null
  status: 'reading' | 'ready' | 'submitted' | 'awarded'
  positions: Record<string, MockPos>
  instructions: Record<string, MockInstr>
  pricing: PricingSettings
  sent: Record<string, { at: string; by: string } | null>
  replies: Reply[]
  working: (AssistWork & { until: number })[]
  done: AssistDone[]
  plans: Record<string, { ops: Op[]; label: string; detail: string }>
  log: MockLog[]
  submission: Snapshot | null
  outcome: Outcome | null
}
interface Db {
  v: number
  tenders: MockTender[]
  imported: Record<string, string>
}

const STORE_KEY = 'ctrlfree.mock.v3'
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100
const nowIso = () => new Date().toISOString()
let seq = Date.now() % 100000
const uid = (p: string) => `${p}_${(seq++).toString(36)}`

function freshTender(id: string, opts: Partial<MockTender> = {}): MockTender {
  const positions: Record<string, MockPos> = {}
  for (const l of LINES)
    positions[l.lv] = {
      overrides: { quantity: null, product_id: null, unit_price: null, hours: null, install_code: null },
      supplier_quote: null,
      variant_reason: null,
      confirmed: null,
      flagged: false,
    }
  const instructions: Record<string, MockInstr> = {}
  for (const i of INSTRUCTIONS)
    instructions[i.id] = {
      state: 'confirmed' in i && i.confirmed ? 'confirmed' : 'open',
      kind: i.kind,
      applies_to: [...i.applies_to],
      confirmed_by: 'confirmed' in i && i.confirmed ? 'You' : null,
      confirmed_at: 'confirmed' in i && i.confirmed ? '2026-09-10T09:30:00' : null,
    }
  return {
    id,
    name: TENDER_META.name,
    client: TENDER_META.client,
    trade: TENDER_META.trade,
    file_name: TENDER_META.file_name,
    page_count: TENDER_META.page_count,
    file_size: TENDER_META.file_size,
    due_at: TENDER_META.due_at,
    profile: 'school',
    created_at: nowIso(),
    updated_at: nowIso(),
    updated_by: 'You',
    reading: null,
    status: 'ready',
    positions,
    instructions,
    pricing: clone(DEFAULT_SETTINGS),
    sent: {},
    replies: [],
    working: [],
    done: [
      { text: 'Drafted 3 supplier requests', at: '2026-09-09T17:05:00' },
      { text: 'Read the tender: 22 lines priced, 12 instructions found', at: '2026-09-09T17:04:00' },
    ],
    plans: {},
    log: [],
    submission: null,
    outcome: null,
    ...opts,
  }
}

function seed(): Db {
  const t = freshTender('t_oberglatt', {
    created_at: '2026-09-09T17:00:00',
    updated_at: '2026-09-10T16:20:00',
    replies: [clone(SEED_REPLY)],
  })
  return { v: 3, tenders: [t], imported: { catalog: '2026-09-09', rules: '2026-09-09', parameters: '2026-09-09' } }
}

function load(): Db {
  try {
    if (typeof location !== 'undefined' && location.search.includes('reset-demo')) localStorage.removeItem(STORE_KEY)
    const s = localStorage.getItem(STORE_KEY)
    if (s) {
      const d = JSON.parse(s) as Db
      if (d.v === 3) return d
    }
  } catch {
    /* ignore */
  }
  return seed()
}

const db: Db = load()
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db))
  } catch {
    /* storage full or blocked: keep in memory */
  }
}

export function resetMockData() {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch {
    /* ignore */
  }
  const fresh = seed()
  db.tenders = fresh.tenders
  db.imported = fresh.imported
}

const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms))

class NotFound extends Error {}
function tender(id: string): MockTender {
  const t = db.tenders.find((x) => x.id === id)
  if (!t) throw new NotFound(`Tender ${id} not found`)
  tick(t)
  return t
}

// ---- reading simulation ----------------------------------------------------------

function tick(t: MockTender) {
  if (t.reading && Date.now() - t.reading.started >= t.reading.duration) {
    t.reading = null
    t.status = 'ready'
    t.updated_at = nowIso()
    save()
  }
  const n = Date.now()
  if (t.working.some((w) => w.until <= n)) t.working = t.working.filter((w) => w.until > n)
}

function progressOf(t: MockTender) {
  if (!t.reading) return { stage: 'done', page: t.page_count, pages: t.page_count, message: 'Done' }
  const f = Math.min(1, (Date.now() - t.reading.started) / t.reading.duration)
  const pages = t.page_count
  if (f < 0.6) {
    const page = Math.max(1, Math.round((f / 0.6) * pages))
    return { stage: 'parsing', page, pages, message: `Reading p. ${page} of ${pages}` }
  }
  const lines = LINES.length
  if (f < 0.7) return { stage: 'meta', page: pages, pages, message: 'Reading name, client and due date' }
  if (f < 0.8) return { stage: 'translating', page: pages, pages, message: 'Translating line titles' }
  if (f < 0.9) {
    const done = Math.round(((f - 0.8) / 0.1) * lines)
    return { stage: 'matching', page: pages, pages, done, total: lines, message: `Matching products · ${done} of ${lines}` }
  }
  if (f < 0.96) return { stage: 'pricing', page: pages, pages, done: lines, total: lines, message: 'Pricing lines' }
  return { stage: 'instructions', page: pages, pages, message: 'Finding instructions and norms' }
}

// ---- pricing -------------------------------------------------------------------------

function productOf(t: MockTender, lv: string): CatalogRow {
  const s = t.positions[lv]
  return CAT[s.overrides.product_id ?? RAW[lv].product]
}

function pricePos(t: MockTender, lv: string, extra: Partial<Overrides> = {}, ignoreQuote = false, withCalc = true): PositionPrice {
  const raw = RAW[lv]
  const st = t.positions[lv]
  const o = { ...st.overrides, ...extra }
  const prod = CAT[o.product_id ?? raw.product]
  const install = o.install_code ?? prod.install_code
  const rule = RULE[install] ?? RULE.UNKNOWN
  const s = t.pricing
  const qty = o.quantity ?? raw.qty
  let unit = prod.net_cost_chf
  let src = prod.source_type === 'supplier_package' ? 'supplier_package' : 'catalog'
  const quote = !ignoreQuote && !extra.product_id ? st.supplier_quote : null
  if (quote && prod.supplier_quote_required) {
    unit = quote.unit_price
    src = 'supplier_quote'
  } else if (o.unit_price != null) {
    unit = o.unit_price
    src = 'manual'
  }
  const waste = s.material_waste_pct
  const material = r2(qty * unit * (1 + waste / 100))
  const keys = (Array.isArray(rule.factor_keys) ? rule.factor_keys : []).map((k) =>
    t.profile === 'sports_hall' && k === 'mounting_height_school' ? 'mounting_height_sports_hall' : k,
  )
  let f = 1
  const factors = keys.map((k) => {
    const v = s.factors[k] ?? 1
    const applied = k === 'site_efficiency' ? 1 / v : v
    f *= applied
    return { key: k, value: v, applied: Math.round(applied * 10000) / 10000, op: k === 'site_efficiency' ? '÷' : '×' }
  })
  const calcHours = qty * rule.base_hours_per_unit * f
  const hours = o.hours ?? calcHours
  const rate = rule.default_hourly_rate_chf
  const labour = r2(hours * rate)
  const direct = r2(material + labour)
  const role = rule.labour_role.replace(/_/g, ' ')
  const u = raw.unit === 'm2' ? 'm²' : raw.unit
  const qtyS = String(qty)
  const factorWords = factors.map((x) => `${x.op} ${x.value.toFixed(2)} ${FACTOR_LABEL[x.key] ?? x.key}`).join(' ')
  return {
    quantity: qty,
    net_unit_cost: unit,
    unit_price_source: src,
    waste_pct: waste,
    material,
    base_hours_per_unit: rule.base_hours_per_unit,
    factors,
    hours: r2(hours),
    rate,
    role,
    labour,
    direct,
    explain: {
      material: `${qtyS} ${u} × CHF ${unit.toFixed(2)} × (1 + ${waste}% waste) = CHF ${material.toFixed(2)}`,
      hours:
        o.hours != null
          ? `${r2(hours).toFixed(2)} h, typed by you`
          : `${qtyS} ${u} × ${rule.base_hours_per_unit.toFixed(2)} h ${factorWords} = ${r2(hours).toFixed(2)} h`,
      labour: `${r2(hours).toFixed(2)} h × CHF ${rate}/h (${role}) = CHF ${labour.toFixed(2)}`,
      direct: `${material.toFixed(2)} + ${labour.toFixed(2)} = CHF ${direct.toFixed(2)}`,
    },
    sources: {
      product: `catalog.csv row ${prod.product_id}`,
      install_rule: `productivity.csv ${install}`,
      quantity: `Tender p. ${raw.page}`,
    },
    calculated: withCalc ? calcBase(t, lv, raw.qty, prod.net_cost_chf, r2(raw.qty * rule.base_hours_per_unit * f)) : undefined,
  }
}

function calcBase(t: MockTender, lv: string, quantity: number, net: number, hours: number) {
  const none = { quantity: null, product_id: null, unit_price: null, hours: null, install_code: null }
  return { quantity, net_unit_cost: net, hours, direct: pricePos(t, lv, none, true, false).direct }
}

function statusOf(t: MockTender, lv: string, price: PositionPrice) {
  const prod = productOf(t, lv)
  if (!(price.quantity > 0)) return { status: 'insufficient_information', reason: 'No quantity: type the quantity from the tender' }
  if (prod.supplier_quote_required)
    return t.positions[lv].supplier_quote
      ? { status: 'supplier_quote_required', reason: 'Supplier quote entered: confirm to use it' }
      : { status: 'supplier_quote_required', reason: 'Supplier package: budget price until a quote is entered' }
  return { status: 'calculated', reason: '' }
}

const REVIEW_STATES = ['supplier_quote_required', 'review_required', 'assumption_applied', 'insufficient_information']

function toPosition(t: MockTender, lv: string): Position {
  const raw = RAW[lv]
  const st = t.positions[lv]
  const pricing = pricePos(t, lv)
  const { status, reason } = statusOf(t, lv, pricing)
  const prod = productOf(t, lv)
  const sys = SYSTEMS[raw.sys]
  const x0 = 70
  const y0 = 150 + (Number(raw.lv.slice(-2)) % 3) * 180
  const lines = raw.lines.map(([text, role], i) => ({
    text,
    role,
    bbox: [x0, y0 + i * 14, 525, y0 + i * 14 + 12] as [number, number, number, number],
  }))
  const qtyLine = lines.find((l) => l.role === 'qty')
  const manual = st.overrides.product_id && st.overrides.product_id !== raw.product
  return {
    lv_id: lv,
    system: sys.label,
    system_key: sys.key,
    section: raw.section,
    section_name: raw.sectionName,
    page: raw.page,
    text_de: raw.lines.map((l) => l[0].replace(/\s{3,}(Stk|m2)\s+\d+$/, '')).join('\n'),
    title_de: raw.de,
    title_en: raw.en,
    variant_de: null,
    quantity: raw.qty,
    unit: raw.unit === 'm2' ? 'm²' : raw.unit,
    unit_raw: raw.unit === 'm2' ? 'm2' : 'Stk',
    kind: 'item',
    make_hint: raw.make ?? null,
    model_hint: raw.model ?? null,
    offer_ref: null,
    attributes: {},
    source: {
      page: raw.page,
      page_size: [595, 842],
      block_bbox: [x0 - 4, y0 - 4, 529, y0 + lines.length * 14 + 2],
      qty_bbox: qtyLine?.bbox ?? null,
      lines,
    },
    match: {
      product_id: raw.product,
      install_code: raw.install,
      confidence: manual ? 1 : raw.match.confidence,
      label: manual ? 'Strong' : raw.match.label,
      reason: manual ? 'Chosen by you' : raw.match.reason,
      method: manual ? 'manual' : 'cache',
    },
    status,
    status_reason: reason,
    overrides: { ...st.overrides },
    supplier_quote: st.supplier_quote,
    variant_reason: st.variant_reason,
    confirmed: st.confirmed,
    flagged: st.flagged,
    needs_review: !st.confirmed && REVIEW_STATES.includes(status),
    pricing,
    product: prod,
  }
}

const isOpen = (p: Position) => !p.confirmed && (!!p.needs_review || !!p.flagged)

function totalsOf(t: MockTender): Totals {
  const s = t.pricing
  const ps = LINES.map((l) => toPosition(t, l.lv))
  const material = r2(ps.reduce((a, p) => a + (p.pricing?.material ?? 0), 0))
  const labour = r2(ps.reduce((a, p) => a + (p.pricing?.labour ?? 0), 0))
  const direct = r2(ps.reduce((a, p) => a + (p.pricing?.direct ?? 0), 0))
  const budgetLines = ps.filter((p) => p.pricing?.unit_price_source === 'supplier_package')
  const budget_direct = r2(budgetLines.reduce((a, p) => a + (p.pricing?.direct ?? 0), 0))
  const project_costs = PROJECT_COST_ITEMS.reduce((a, i) => a + (s.project_costs[i.key] ? i.amount : 0), 0)
  const small_material = s.include_small_material ? r2((material * s.small_material_pct) / 100) : 0
  const pkgMaterial = ps
    .filter((p) => p.pricing && ['supplier_package', 'supplier_quote'].includes(p.pricing.unit_price_source))
    .reduce((a, p) => a + (p.pricing?.material ?? 0), 0)
  const supplier_contingency = s.include_supplier_contingency ? r2((pkgMaterial * s.supplier_contingency_pct) / 100) : 0
  const base = direct + project_costs + small_material + supplier_contingency
  const transport = (base * s.transport_pct) / 100
  const overhead = ((base + transport) * s.overhead_pct) / 100
  const cost = base + transport + overhead
  const std = s.margins.Standard ?? 5.5
  const ref = cost / (1 - std / 100)
  const standard_price = Math.ceil(ref / 1000) * 1000
  const order = ['Aggressive', 'Target', 'Standard', 'Conservative']
  const scenarios: Scenario[] = order
    .filter((n) => s.margins[n] !== undefined)
    .map((name) => {
      const m = s.margins[name]
      const bid = Math.ceil(cost / (1 - m / 100) / 1000) * 1000
      const rel = (bid / ref - 1) * 100
      const p = Math.min(0.95, Math.max(0.05, s.ref_win + s.appetite + s.competition - s.sensitivity * rel))
      return { name, margin_pct: m, bid, win: Math.round(p * 100) / 100, profit: r2(bid - cost), expected: r2(p * (bid - cost)) }
    })
  const best = scenarios.reduce((a, b) => (b.expected > a.expected ? b : a), scenarios[0])
  scenarios.forEach((x) => (x.best = x === best))
  const coverage: Record<string, number> = {}
  ps.forEach((p) => (coverage[p.status] = (coverage[p.status] ?? 0) + 1))
  const by_system = Object.values(SYSTEMS).map((sy) => {
    const ls = ps.filter((p) => p.system_key === sy.key)
    return { system: sy.label, direct: r2(ls.reduce((a, p) => a + (p.pricing?.direct ?? 0), 0)), lines: ls.length, to_review: ls.filter(isOpen).length }
  })
  return {
    material,
    labour,
    direct,
    project_costs,
    small_material,
    supplier_contingency,
    transport: r2(transport),
    overhead: r2(overhead),
    cost: r2(cost),
    standard_price,
    by_system,
    coverage,
    budget_direct,
    budget_share: direct ? budget_direct / direct : 0,
    scenarios,
    lines: ps.length,
    project_cost_items: PROJECT_COST_ITEMS.map((i) => ({ key: i.key, amount: i.amount, hours: i.hours, rate: i.rate })),
  }
}

// ---- summaries -----------------------------------------------------------------------

function summary(t: MockTender): TenderSummary {
  const reading = t.status === 'reading'
  const positions = reading ? [] : LINES.map((l) => toPosition(t, l.lv))
  const totals = reading ? null : totalsOf(t)
  const chosen = t.pricing.chosen
  const offer = chosen && totals ? (totals.scenarios.find((s) => s.name === chosen)?.bid ?? null) : null
  return {
    id: t.id,
    name: t.name,
    client: t.client,
    trade: t.trade,
    file_name: t.file_name,
    page_count: t.page_count,
    file_size: t.file_size,
    due_at: t.due_at,
    status: t.status,
    progress: progressOf(t),
    open_work: {
      lines_to_review: positions.filter(isOpen).length,
      instructions_to_confirm: reading ? 0 : Object.values(t.instructions).filter((i) => i.state === 'open').length,
      price_chosen: !!chosen,
    },
    offer_price: t.submission?.offer_price ?? offer,
    standard_price: totals?.standard_price ?? null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    updated_by: t.updated_by,
    profile: t.profile,
    meta_sources: reading ? {} : TENDER_META.meta_sources,
    submission_rule: reading ? null : TENDER_META.submission_rule,
    award_criteria: reading ? [] : TENDER_META.award_criteria,
    submission: t.submission,
    outcome: t.outcome,
  }
}

function touch(t: MockTender) {
  t.updated_at = nowIso()
  t.updated_by = 'You'
}

function instructionOf(t: MockTender, id: string): Instruction {
  const base = INSTRUCTIONS.find((i) => i.id === id)!
  const st = t.instructions[id]
  return {
    id,
    type: base.type,
    page: base.page,
    section: base.section,
    text_de: base.text_de,
    text_en: base.text_en,
    bbox: [70, 200, 525, 280],
    page_size: [595, 842],
    kind: st.kind,
    applies_to: st.applies_to,
    applies_label: base.applies_label,
    applies_long: base.applies_long,
    why: base.why,
    state: st.state,
    confirmed_by: st.confirmed_by,
    confirmed_at: st.confirmed_at,
  }
}

function quoteGroups(t: MockTender): QuoteGroup[] {
  return QUOTE_GROUPS.map((g) => {
    const sent = t.sent[g.id]
    const n = g.lv_ids.length
    const subject = `Preisanfrage ${g.title_de} (${n} ${n === 1 ? 'Position' : 'Positionen'}) · Primarschule Erlenstrasse Oberglatt, BKP 244`
    const lines = g.lv_ids.map((id) => {
      const r = RAW[id]
      return `${id} · Seite ${r.page} · ${r.de} · ${r.qty} ${r.unit === 'm2' ? 'm2' : 'Stk'}`
    })
    const body = [
      'Guten Tag',
      `Für das Projekt ${t.name} (BKP 244 Lüftung) bitten wir Sie um ein Angebot für folgende Positionen:`,
      lines.join('\n'),
      ...(g.rule ? [`Anforderungen gemäss Ausschreibung (${g.rule.ref}):`, `«${g.rule.text_de}»`] : []),
      'Bitte nennen Sie uns Netto-Einheitspreis, Lieferzeit und Gültigkeit. Die Preise gelten als Festpreise bis Bauvollendung.',
      'Freundliche Grüsse\n[Your name], Equans',
    ].join('\n\n')
    return {
      id: g.id,
      key: g.id,
      title: g.title,
      title_de: g.title_de,
      lv_ids: g.lv_ids,
      sent: !!sent,
      sent_at: sent?.at ?? null,
      sent_by: sent?.by ?? null,
      subject,
      body,
      rule: g.rule,
    }
  })
}

// ---- candidates ------------------------------------------------------------------------

function sizes(desc: string): number[] {
  const dn = desc.match(/DN\s?(\d+)/i)
  if (dn) return [Number(dn[1])]
  const d = desc.match(/(\d+)\s?x\s?(\d+)(?:\s?x\s?(\d+))?/)
  if (d) return d.slice(1).filter(Boolean).map(Number)
  const mm = desc.match(/(\d+)\s?mm/)
  return mm ? [Number(mm[1])] : []
}
const sameSize = (a: number[], b: number[]) => a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i])

const PREFERRED: Record<string, string[]> = { LV0001: ['P-AIR-001', 'P-AIR-002', 'P-AIR-003', 'P-DAM-001', 'P-FIR-001'] }

function tenderSize(raw: RawLine): string {
  const m = raw.de.match(/(Ø\s?[\d.]+\s?cm|[\d.]+ x [\d.]+(?: x [\d.]+)? (?:mm|cm)|\d+ mm)/)
  return m ? m[1] : raw.de
}

function candidatesOf(t: MockTender, lv: string, q?: string): Candidate[] {
  const raw = RAW[lv]
  const sug = CAT[raw.product]
  const cur = productOf(t, lv)
  const curTotal = pricePos(t, lv).direct
  const sugSize = sizes(sug.description)
  const why = (p: CatalogRow): string => {
    if (p.product_id === sug.product_id) return raw.match.reason
    const sz = sameSize(sizes(p.description), sugSize)
    if (p.category === sug.category && p.subcategory === sug.subcategory)
      return sz ? 'Same type and size, different model' : `Right type, wrong size: tender says ${tenderSize(raw)}`
    if (p.category === sug.category)
      return sz
        ? `Right size, but ${(p.subcategory ?? '').toLowerCase()}, not ${(sug.subcategory ?? '').toLowerCase()}`
        : `Same category, different type and size`
    return sz ? 'Same size, different product type' : 'Different product type'
  }
  let pool: CatalogRow[]
  if (q && q.trim()) {
    const toks = q.toLowerCase().split(/\s+/).filter(Boolean)
    pool = CATALOG.filter((p) =>
      toks.every((tk) => `${p.product_id} ${p.description} ${p.model} ${p.category} ${p.subcategory}`.toLowerCase().includes(tk)),
    ).slice(0, 20)
  } else if (PREFERRED[lv]) {
    pool = PREFERRED[lv].map((id) => CAT[id])
  } else {
    const score = (p: CatalogRow) => {
      if (p.product_id === sug.product_id) return 10
      let s = 0
      if (p.category === sug.category) s += 0.3
      if (p.subcategory === sug.subcategory) s += 0.2
      if (p.install_code === sug.install_code) s += 0.1
      if (sameSize(sizes(p.description), sugSize)) s += 0.15
      return s
    }
    pool = [...CATALOG].sort((a, b) => score(b) - score(a)).slice(0, 5)
    if (!pool.includes(cur)) pool = [...pool.slice(0, 4), cur]
  }
  return pool.map((p, i) => {
    const total = pricePos(t, lv, { product_id: p.product_id, install_code: p.install_code, unit_price: null }, true).direct
    return {
      product_id: p.product_id,
      score: p.product_id === sug.product_id ? raw.match.confidence : Math.max(0.1, 0.6 - i * 0.08),
      why: why(p),
      description: p.description,
      model: p.model,
      manufacturer: p.manufacturer,
      unit: p.unit,
      unit_price: p.net_cost_chf,
      net_cost_chf: p.net_cost_chf,
      install_code: p.install_code,
      line_total: total,
      diff: r2(total - curTotal),
      current: p.product_id === cur.product_id,
      suggested: p.product_id === sug.product_id,
      supplier_quote_required: p.supplier_quote_required,
      catalog: p,
    }
  })
}

// ---- assist ----------------------------------------------------------------------------

function snapshot(t: MockTender) {
  return { positions: clone(t.positions), instructions: clone(t.instructions) }
}

function addLog(t: MockTender, by: string, action: string, text: string, lv_id?: string, snap?: MockLog['snapshot']): MockLog {
  const e: MockLog = { id: uid('log'), at: nowIso(), by, action, text, lv_id, undoable: !!snap, snapshot: snap }
  t.log.unshift(e)
  if (t.log.length > 200) t.log.length = 200
  return e
}

function replyLines(t: MockTender, r: Reply) {
  return r.lines.map((l) => {
    const budget = CAT[RAW[l.lv_id].product].net_cost_chf
    const q = t.positions[l.lv_id].supplier_quote
    const filled = !!q && Math.abs(q.unit_price - l.unit_price) < 0.005
    const before = pricePos(t, l.lv_id, {}, true).direct
    const after = pricePos(t, l.lv_id, { unit_price: l.unit_price }, true).direct
    return {
      lv_id: l.lv_id,
      unit_price: l.unit_price,
      budget,
      source: `${r.file}, p. 1, Pos. ${l.pos_no}`,
      delta: r2(after - before),
      pos_no: l.pos_no,
      text_de: RAW[l.lv_id].de,
      quantity: RAW[l.lv_id].qty,
      state: filled ? 'filled' : l.unit_price > budget ? 'above budget' : 'below budget',
    }
  })
}

const SAFE_KINDS = ['scope', 'covered']

function trayOf(t: MockTender): AssistTray {
  const needs_ok: AssistProposal[] = []
  for (const r of t.replies) {
    const lines = replyLines(t, r)
    if (lines.every((l) => l.state === 'filled')) continue
    const g = QUOTE_GROUPS.find((x) => x.id === r.group)
    needs_ok.push({
      id: r.id,
      kind: 'quotes',
      title: `Fill ${lines.length} ${(g?.title ?? 'supplier').toLowerCase().replace(/s$/, '')} quotes`,
      source: r.file,
      received_at: r.received_at,
      lines,
    })
  }
  const open = INSTRUCTIONS.filter((i) => t.instructions[i.id].state === 'open')
  const safe = open.filter((i) => SAFE_KINDS.includes(t.instructions[i.id].kind))
  if (safe.length) {
    const planId = 'p_instr'
    t.plans[planId] = {
      ops: safe.map((i) => ({ op: 'confirm_instr', iid: i.id })),
      label: `Confirmed ${safe.length} instructions for you`,
      detail: '',
    }
    const cost = open.filter((i) => t.instructions[i.id].kind === 'cost').length
    const risk = open.filter((i) => t.instructions[i.id].kind === 'risk').length
    needs_ok.push({
      id: 'instr',
      kind: 'instructions',
      title: `Confirm ${safe.length} instructions that do not change the price`,
      text: `All ${safe.length} are Scope or Covered and their lines already match. The ${cost} that add cost and the ${risk} risks stay with you.`,
      instruction_ids: safe.map((i) => i.id),
      plan_id: planId,
    })
  }
  return {
    needs_ok,
    working_on: t.working.map(({ id, text, page, pages }) => ({ id, text, page, pages })),
    done: t.done.slice(0, 8),
  }
}

function applyOps(t: MockTender, ops: Op[]) {
  for (const o of ops) {
    if ((o.op === 'fill' || o.op === 'fill_confirm') && o.lv_id && o.unit_price != null) {
      t.positions[o.lv_id].supplier_quote = {
        unit_price: o.unit_price,
        source: o.source ?? 'Supplier reply',
        received_at: nowIso(),
        by: 'Assist',
      }
      if (o.op === 'fill_confirm') t.positions[o.lv_id].confirmed = { by: 'You', at: nowIso() }
    }
    if (o.op === 'confirm_instr' && o.iid) {
      const i = t.instructions[o.iid]
      i.state = 'confirmed'
      i.confirmed_by = 'You'
      i.confirmed_at = nowIso()
    }
  }
}

function markAssistLog(t: MockTender, ops: Op[], logId: string) {
  for (const o of ops) if (o.lv_id && t.positions[o.lv_id].supplier_quote) t.positions[o.lv_id].supplier_quote!.log_id = logId
}

function commandPlan(t: MockTender, text: string, scope: string, lv?: string): AssistPlan {
  const s = text.toLowerCase()
  const directBefore = totalsOf(t).direct
  const effectOf = (ops: Op[]) => {
    const copy = clone(t)
    applyOps(copy, ops)
    return { direct_before: directBefore, direct_after: totalsOf(copy).direct }
  }
  const replyFor = (id?: string) => t.replies.find((r) => r.lines.some((l) => l.lv_id === id))
  const activeLines = t.replies.flatMap((r) => replyLines(t, r).map((l) => ({ ...l, file: r.file })))
  const fmt = (n: number) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'")

  if (/below budget|at or below|unter budget|unter dem budget|bis budget/.test(s)) {
    const lines = activeLines.filter((l) => !t.positions[l.lv_id].confirmed)
    if (!lines.length)
      return { plan_id: null, plan: [], answer: 'There is no supplier reply with open lines. Drop the reply on a line first.', kind: 'plan' }
    const ops: Op[] = lines
      .filter((l) => l.unit_price <= (l.budget ?? 0))
      .map((l) => ({ op: 'fill_confirm', lv_id: l.lv_id, unit_price: l.unit_price, source: l.source }))
    const steps: AssistPlanStep[] = lines.map((l) => ({
      lv_id: l.lv_id,
      text: `Quote ${fmt(l.unit_price)}, budget ${fmt(l.budget ?? 0)}`,
      action: l.unit_price <= (l.budget ?? 0) ? 'fill and confirm' : 'leave in review',
    }))
    const kept = lines.filter((l) => l.unit_price > (l.budget ?? 0)).map((l) => l.lv_id)
    const filled = ops.map((o) => o.lv_id!)
    const id = uid('plan')
    t.plans[id] = {
      ops,
      label: `Done: ${filled.length} ${filled.length === 1 ? 'quote' : 'quotes'} filled and confirmed`,
      detail:
        `${filled.join(' and ')} now ${filled.length === 1 ? 'uses' : 'use'} the supplier's prices.` +
        (kept.length ? ` ${kept.join(' and ')} ${kept.length === 1 ? 'is' : 'are'} still in review because ${kept.length === 1 ? 'its quote is' : 'their quotes are'} above budget.` : ''),
    }
    return { plan_id: id, plan: steps, effect: effectOf(ops), kind: 'plan' }
  }
  if (/instruction|anweisung|vorgabe/.test(s)) {
    const safe = INSTRUCTIONS.filter((i) => t.instructions[i.id].state === 'open' && SAFE_KINDS.includes(t.instructions[i.id].kind))
    if (!safe.length) return { plan_id: null, plan: [], answer: 'No open instruction that leaves the price unchanged.', kind: 'plan' }
    const ops: Op[] = safe.map((i) => ({ op: 'confirm_instr', iid: i.id }))
    const id = uid('plan')
    t.plans[id] = { ops, label: `Done: ${safe.length} instructions confirmed`, detail: 'The ones that add cost and the risks stay with you.' }
    return {
      plan_id: id,
      plan: safe.map((i) => ({ text: `${i.type} · p. ${i.page}`, action: 'confirm' })),
      effect: effectOf(ops),
      kind: 'plan',
    }
  }
  if (/remind|erinner/.test(s)) {
    const open = QUOTE_GROUPS.flatMap((g) => g.lv_ids).filter((id) => !t.positions[id].supplier_quote)
    const id = uid('plan')
    t.plans[id] = { ops: [{ op: 'note' }], label: 'Done: reminder drafted', detail: 'Find it in the supplier quote section of each line. Nothing was sent.' }
    return { plan_id: id, plan: open.map((lv_id) => ({ lv_id, text: RAW[lv_id].de, action: 'add to reminder' })), effect: null, kind: 'plan' }
  }
  if (/other areas|same product|anderen bereich|gleiche produkt/.test(s) && lv) {
    const prod = productOf(t, lv)
    const same = LINES.filter((l) => l.lv !== lv && CAT[l.product].category === prod.category)
    return {
      plan_id: null,
      plan: same.map((l) => ({ lv_id: l.lv, text: `${l.de} · ${SYSTEMS[l.sys].label}`, action: 'open' })),
      answer: same.length ? null : 'No other line uses this product type.',
      kind: 'finds',
    }
  }
  if (/money|risk|geld|risiko|largest|grösste/.test(s)) {
    const ps = LINES.map((l) => toPosition(t, l.lv)).filter(isOpen).sort((a, b) => (b.pricing?.direct ?? 0) - (a.pricing?.direct ?? 0))
    return {
      plan_id: null,
      plan: ps.map((p) => ({ lv_id: p.lv_id, text: `${p.title_de} · CHF ${fmt(p.pricing?.direct ?? 0)}`, action: 'open' })),
      answer: ps.length ? null : 'No line needs you.',
      kind: 'finds',
    }
  }
  if (/fill|quote|offerte|eintragen|übernehm/.test(s)) {
    const target = scope === 'line' && lv ? [lv] : activeLines.map((l) => l.lv_id)
    const lines = activeLines.filter((l) => target.includes(l.lv_id) && l.state !== 'filled')
    if (!lines.length || !replyFor(lines[0]?.lv_id))
      return { plan_id: null, plan: [], answer: 'No supplier reply covers this line yet. Drop the reply on the line and Assist reads it.', kind: 'plan' }
    const ops: Op[] = lines.map((l) => ({ op: 'fill', lv_id: l.lv_id, unit_price: l.unit_price, source: l.source }))
    const id = uid('plan')
    t.plans[id] = { ops, label: `Done: ${ops.length} ${ops.length === 1 ? 'quote' : 'quotes'} filled`, detail: 'Confirm each line when you have checked it.' }
    return {
      plan_id: id,
      plan: lines.map((l) => ({ lv_id: l.lv_id, text: `Quote ${fmt(l.unit_price)}, budget ${fmt(l.budget ?? 0)}`, action: 'fill' })),
      effect: effectOf(ops),
      kind: 'plan',
    }
  }
  return {
    plan_id: null,
    plan: [],
    answer: 'I can fill quotes from supplier replies, confirm instructions, draft reminders and find lines. Try one of the suggestions.',
    kind: 'plan',
  }
}

// ---- exports (mock: client-side files) ---------------------------------------------------

function saveBlob(name: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type: type + ';charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function exportFile(t: MockTender, kind: ExportKind) {
  const ps = LINES.map((l) => toPosition(t, l.lv))
  const tot = totalsOf(t)
  const slug = 'Oberglatt_BKP244'
  if (kind === 'xlsx') {
    const head = ['LV', 'Page', 'System', 'Description (tender)', 'Qty', 'Unit', 'Product', 'Unit price', 'Hours', 'Material', 'Labour', 'Direct', 'Status']
    const rows = ps.map((p) =>
      [p.lv_id, p.page, p.system, p.title_de, p.pricing?.quantity, p.unit, p.product?.product_id, p.pricing?.net_unit_cost, p.pricing?.hours, p.pricing?.material, p.pricing?.labour, p.pricing?.direct, p.status]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(';'),
    )
    saveBlob(`${slug}_offer_demo.csv`, [head.join(';'), ...rows, '', `Direct;;;;;;;;;;;${tot.direct}`, `Cost;;;;;;;;;;;${tot.cost}`].join('\n'), 'text/csv')
  } else if (kind === 'sia') {
    const rows = ps.map((p) => `${p.lv_id}\t${p.pricing?.quantity}\t${p.unit_raw}\t${p.pricing ? (p.pricing.direct / (p.pricing.quantity || 1)).toFixed(2) : ''}\t${p.title_de}`)
    saveBlob(`${slug}_SIA_demo.txt`, ['# Simplified SIA-style interface file (planned format, demo data)', ...rows].join('\n'))
  } else {
    const ch = tot.scenarios.find((s) => s.name === (t.pricing.chosen ?? 'Target'))
    saveBlob(
      `${slug}_pricing_report_demo.txt`,
      [
        `Pricing report · ${t.name}`,
        `Direct cost ${tot.direct.toFixed(2)} · Cost ${tot.cost.toFixed(2)} · Offer ${ch?.bid ?? '-'} (${ch?.name ?? '-'})`,
        '',
        ...ps.map((p) => `${p.lv_id} p.${p.page} ${p.title_de}: ${p.pricing?.explain?.direct ?? ''}`),
      ].join('\n'),
    )
  }
}

// ---- api -------------------------------------------------------------------------------

function settingsChanged(s: PricingSettings): number {
  const d = DEFAULT_SETTINGS
  let n = 0
  for (const k of ['competition', 'appetite', 'sensitivity', 'ref_win', 'overhead_pct', 'transport_pct', 'material_waste_pct', 'small_material_pct', 'supplier_contingency_pct', 'include_small_material', 'include_supplier_contingency'] as const)
    if (s[k] !== d[k]) n++
  for (const k of Object.keys(d.margins)) if (s.margins[k] !== d.margins[k]) n++
  for (const k of Object.keys(d.factors)) if (s.factors[k] !== d.factors[k]) n++
  for (const k of Object.keys(d.project_costs)) if (s.project_costs[k] !== d.project_costs[k]) n++
  return n
}

function pricingOf(t: MockTender): PricingResponse {
  return { settings: clone(t.pricing), defaults: clone(DEFAULT_SETTINGS), totals: totalsOf(t), changed_count: settingsChanged(t.pricing) }
}

function detailOf(t: MockTender, lv: string): PositionDetail {
  if (!RAW[lv]) throw new NotFound(`Line ${lv} not found`)
  const p = toPosition(t, lv)
  return {
    ...p,
    candidates: candidatesOf(t, lv),
    instructions: INSTRUCTIONS.filter((i) => t.instructions[i.id].applies_to.includes(lv)).map((i) => instructionOf(t, i.id)),
    quote_group: quoteGroups(t).find((g) => g.lv_ids.includes(lv)) ?? null,
  }
}

function emptyChanges(): ChangesResponse {
  const zero = { changes: 0, to_review: 0, approved: 0, reverted: 0, ai: 0, ai_to_review: 0, ai_approved: 0 }
  return { entries: [], lines: {}, summary: { ...zero, by_actor: [] }, me: { name: 'You', role: null, can_review: true } }
}

export const mockApi: Api = {
  async listTenders() {
    await delay(80)
    db.tenders.forEach(tick)
    return db.tenders.map(summary)
  },
  async createTender(form) {
    await delay(300)
    const file = form.get('file')
    const fname = file instanceof File ? file.name : 'tender.pdf'
    const str = (k: string) => {
      const v = form.get(k)
      return typeof v === 'string' && v.trim() ? v.trim() : null
    }
    const t = freshTender(uid('t'), {
      name: str('name') ?? fname.replace(/\.pdf$/i, '').replace(/_/g, ' '),
      client: str('client') ?? TENDER_META.client,
      trade: str('trade') ?? TENDER_META.trade,
      due_at: str('due_at') ?? TENDER_META.due_at,
      profile: str('profile') ?? 'school',
      file_name: fname,
      file_size: file instanceof File ? file.size : 0,
      status: 'reading',
      reading: { started: Date.now(), duration: 12000 },
    })
    db.tenders.unshift(t)
    save()
    return summary(t)
  },
  async createDemoTender() {
    await delay(300)
    const t = freshTender(uid('t'), { status: 'reading', reading: { started: Date.now(), duration: 12000 }, replies: [clone(SEED_REPLY)] })
    db.tenders.unshift(t)
    save()
    return summary(t)
  },
  async deleteTender(id) {
    await delay(120)
    const t = tender(id)
    db.tenders = db.tenders.filter((x) => x !== t)
    save()
    return { ok: true }
  },
  async getTender(id) {
    await delay(60)
    const t = tender(id)
    const s = summary(t)
    if (t.status === 'reading') return s
    const totals = totalsOf(t)
    const ow = s.open_work!
    const detail: TenderDetail = {
      ...s,
      systems: Object.values(SYSTEMS).map((x) => ({ ...x, pages: [...x.pages], profile: 'school' })),
      overview: {
        steps: [
          { key: 'lines', done: ow.lines_to_review === 0 },
          { key: 'instructions', done: ow.instructions_to_confirm === 0 },
          { key: 'price', done: ow.price_chosen },
          { key: 'export', done: !!t.submission },
          { key: 'outcome', done: !!t.outcome },
        ],
        totals,
        facts: { catalog_products: CATALOG.length, install_rules: RULES.length, lines: LINES.length, instructions: INSTRUCTIONS.length },
      },
    }
    return detail
  },
  async getPositions(id, filter = 'all', q) {
    await delay(80)
    const t = tender(id)
    if (t.status === 'reading') return { positions: [], groups: [], counts: {} }
    let ps = LINES.map((l) => toPosition(t, l.lv))
    const counts: Record<string, number> = { all: ps.length, review: ps.filter(isOpen).length }
    ps.forEach((p) => (counts[p.status] = (counts[p.status] ?? 0) + 1))
    if (filter === 'review') ps = ps.filter(isOpen)
    else if (filter && filter !== 'all') ps = ps.filter((p) => p.status === filter)
    if (q && q.trim()) {
      const s = q.toLowerCase()
      ps = ps.filter((p) => `${p.lv_id} ${p.title_de} ${p.title_en} ${p.text_de} p. ${p.page} ${p.page}`.toLowerCase().includes(s))
    }
    const groups = Object.values(SYSTEMS).map((sy) => ({
      key: sy.key,
      title: sy.label,
      title_de: sy.label,
      count: ps.filter((p) => p.system_key === sy.key).length,
      to_review: ps.filter((p) => p.system_key === sy.key && isOpen(p)).length,
    }))
    return { positions: ps, groups, counts }
  },
  async getPosition(id, lv) {
    await delay(60)
    return detailOf(tender(id), lv)
  },
  async patchPosition(id, lv, body: PositionPatch) {
    await delay(120)
    const t = tender(id)
    const st = t.positions[lv]
    if (!st) throw new NotFound(`Line ${lv} not found`)
    const snap = snapshot(t)
    const prod = productOf(t, lv)
    const has = (k: keyof PositionPatch) => Object.prototype.hasOwnProperty.call(body, k)
    let action = 'edit'
    if (body.reset) {
      st.overrides = { quantity: null, product_id: null, unit_price: null, hours: null, install_code: null }
      st.supplier_quote = null
      st.variant_reason = null
      action = 'reset'
    }
    if (has('quantity')) st.overrides.quantity = body.quantity ?? null
    if (has('hours')) st.overrides.hours = body.hours ?? null
    if (has('product_id')) {
      const pid = body.product_id && body.product_id !== RAW[lv].product ? body.product_id : null
      st.overrides.product_id = pid
      st.overrides.install_code = null
      st.overrides.unit_price = null
      st.supplier_quote = null
      action = 'change product'
    }
    if (has('variant_reason')) st.variant_reason = body.variant_reason ?? null
    if (has('unit_price')) {
      if (productOf(t, lv).supplier_quote_required) {
        st.supplier_quote = body.unit_price != null ? { unit_price: body.unit_price, source: 'Typed by you', received_at: nowIso(), by: 'You' } : null
        action = 'quote'
      } else st.overrides.unit_price = body.unit_price ?? null
    }
    if (body.confirm) {
      st.confirmed = { by: 'You', at: nowIso() }
      st.flagged = false
      action = 'confirm'
    }
    if (body.unconfirm) {
      st.confirmed = null
      action = 'unconfirm'
    }
    if (has('flag')) {
      st.flagged = !!body.flag
      action = body.flag ? 'flag' : 'unflag'
    }
    void prod
    addLog(t, 'You', action, `${action} ${lv}`, lv, snap)
    touch(t)
    save()
    return detailOf(t, lv)
  },
  async getCandidates(id, lv, q) {
    await delay(80)
    return candidatesOf(tender(id), lv, q)
  },
  async getInstructions(id, filter = 'all') {
    await delay(60)
    const t = tender(id)
    const all = INSTRUCTIONS.map((i) => instructionOf(t, i.id))
    const counts: Record<string, number> = { all: all.length, open: all.filter((i) => i.state === 'open').length }
    for (const k of ['cost', 'risk', 'scope', 'covered']) counts[k] = all.filter((i) => i.kind === k).length
    const instructions = filter === 'all' ? all : filter === 'open' ? all.filter((i) => i.state === 'open') : all.filter((i) => i.kind === filter)
    return { instructions, counts }
  },
  async patchInstruction(id, iid, body: InstructionPatch) {
    await delay(100)
    const t = tender(id)
    const st = t.instructions[iid]
    if (!st) throw new NotFound(`Instruction ${iid} not found`)
    const snap = snapshot(t)
    if (body.state) {
      st.state = body.state
      st.confirmed_by = body.state === 'open' ? null : 'You'
      st.confirmed_at = body.state === 'open' ? null : nowIso()
    }
    if (body.kind) st.kind = body.kind
    if (body.applies_to) st.applies_to = body.applies_to
    addLog(t, 'You', 'instruction', `instruction ${iid}`, undefined, snap)
    touch(t)
    save()
    return instructionOf(t, iid)
  },
  async getPricing(id) {
    await delay(60)
    return pricingOf(tender(id))
  },
  async putPricing(id, body: PricingPut) {
    await delay(90)
    const t = tender(id)
    const s = t.pricing
    const by = { by: 'You', at: nowIso() }
    s.changed_by = s.changed_by ?? {}
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined) continue
      if (k === 'margins' || k === 'factors' || k === 'project_costs' || k === 'notes') {
        for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
          ;(s[k] as Record<string, unknown>)[kk] = vv
          if (k !== 'notes') s.changed_by[`${k}.${kk}`] = by
        }
      } else {
        ;(s as unknown as Record<string, unknown>)[k] = v
        if (k !== 'chosen') s.changed_by[k] = by
      }
    }
    touch(t)
    save()
    return pricingOf(t)
  },
  async resetPricing(id) {
    await delay(90)
    const t = tender(id)
    t.pricing = { ...clone(DEFAULT_SETTINGS), chosen: t.pricing.chosen, notes: t.pricing.notes }
    touch(t)
    save()
    return pricingOf(t)
  },
  async getQuotes(id) {
    await delay(60)
    return quoteGroups(tender(id))
  },
  async markQuoteSent(id, group, sent) {
    await delay(80)
    const t = tender(id)
    t.sent[group] = sent ? { at: nowIso(), by: 'You' } : null
    touch(t)
    save()
    return quoteGroups(t).find((g) => g.id === group)
  },
  async readQuote(id, input, lvHint) {
    const t = tender(id)
    const name = typeof input === 'string' ? 'Pasted email' : input.name
    const work = { id: uid('w'), text: `Reading ${name}`, page: 1, pages: 1, until: Date.now() + 1500 }
    t.working.push(work)
    await delay(1400)
    t.working = t.working.filter((w) => w.id !== work.id)
    const group =
      QUOTE_GROUPS.find((g) => lvHint && g.lv_ids.includes(lvHint)) ??
      QUOTE_GROUPS.find((g) => g.lv_ids.some((lv) => !t.positions[lv].supplier_quote)) ??
      QUOTE_GROUPS[0]
    const factors = [0.96, 1.03, 0.98, 0.95]
    const reply: Reply = {
      id: uid('r'),
      file: name,
      received_at: nowIso(),
      group: group.id,
      lines: group.lv_ids.map((lv, i) => ({
        lv_id: lv,
        pos_no: String(i + 1),
        unit_price: Math.round(CAT[RAW[lv].product].net_cost_chf * factors[i % factors.length] * 100) / 100,
      })),
    }
    t.replies = t.replies.filter((r) => r.group !== group.id)
    t.replies.push(reply)
    t.done.unshift({ text: `Read ${name}: ${reply.lines.length} prices found`, at: nowIso() })
    save()
    return replyLines(t, reply)
  },
  async applyQuotes(id, proposals: QuoteProposal[], _proposalId?: string) {
    await delay(150)
    const t = tender(id)
    const snap = snapshot(t)
    const ops: Op[] = proposals.map((p) => ({ op: 'fill', lv_id: p.lv_id, unit_price: p.unit_price, source: p.source }))
    applyOps(t, ops)
    const n = ops.length
    const file = proposals[0]?.source?.split(',')[0] ?? 'the reply'
    const e = addLog(t, 'Assist', 'fill quotes', `Filled ${n} ${n === 1 ? 'quote' : 'quotes'} from ${file}`, proposals[0]?.lv_id, snap)
    markAssistLog(t, ops, e.id)
    t.done.unshift({ id: e.id, text: e.text!, at: e.at, log_id: e.id, undoable: true })
    touch(t)
    save()
    return { log_id: e.id, message: e.text, applied: n }
  },
  async getChecklist(id): Promise<ChecklistItem[]> {
    await delay(60)
    const t = tender(id)
    const s = summary(t)
    return [
      { key: 'lines', level: s.open_work!.lines_to_review ? 'warn' : 'ok', text: `${s.open_work!.lines_to_review} lines to review` },
      { key: 'instructions', level: s.open_work!.instructions_to_confirm ? 'warn' : 'ok', text: `${s.open_work!.instructions_to_confirm} instructions to confirm` },
    ]
  },
  async submit(id, option) {
    await delay(200)
    const t = tender(id)
    const tot = totalsOf(t)
    const best = tot.scenarios.find((s) => s.best) ?? tot.scenarios[0]
    const ch = tot.scenarios.find((s) => s.name === (t.pricing.chosen ?? option)) ?? best
    if (!t.pricing.chosen) t.pricing.chosen = ch.name
    const snap: Snapshot = {
      at: nowIso(),
      by: 'You',
      offer_price: ch.bid,
      option: ch.name,
      margin_pct: ch.margin_pct,
      cost: tot.cost,
      direct: tot.direct,
      win: ch.win,
      settings: { competition: t.pricing.competition, appetite: t.pricing.appetite, sensitivity: t.pricing.sensitivity },
      notes: { ...t.pricing.notes },
    }
    t.submission = snap
    t.status = 'submitted'
    addLog(t, 'You', 'submit', `Marked as submitted at CHF ${ch.bid}`)
    touch(t)
    save()
    return snap
  },
  async putOutcome(id, outcome) {
    await delay(150)
    const t = tender(id)
    t.outcome = outcome
    if (outcome.result === 'won') t.status = 'awarded'
    else if (t.status === 'awarded') t.status = 'submitted'
    touch(t)
    save()
    return outcome
  },
  async getResults() {
    await delay(80)
    const rows = db.tenders
      .filter((t) => t.submission)
      .map((t) => {
        const o = t.outcome
        const win = o?.winning_price ?? null
        return {
          tender_id: t.id,
          name: t.name,
          trade: t.trade,
          offer_price: t.submission!.offer_price,
          winning_price: win,
          gap_pct: win ? (t.submission!.offer_price / win - 1) * 100 : null,
          bidders: o?.bidders ?? null,
          competition_call: t.submission!.settings?.competition ?? null,
          result: o?.result ?? null,
          option: t.submission!.option,
        }
      })
    const recorded = rows.filter((r) => r.winning_price).length
    return { rows, recorded, stats: null }
  },
  async getReference(): Promise<ReferenceResponse> {
    await delay(60)
    return {
      catalog: CATALOG,
      rules: RULES,
      parameters: PROJECT_PARAMETERS,
      source: {
        catalog: { file: 'catalog.csv', imported_at: db.imported.catalog },
        rules: { file: 'productivity.csv', imported_at: db.imported.rules },
        parameters: { file: 'project_parameters.json', imported_at: db.imported.parameters },
      },
    }
  },
  async importReference(kind, file) {
    await delay(300)
    db.imported[kind] = new Date().toISOString().slice(0, 10)
    save()
    return { ok: true, file: file.name, note: 'Demo mode: the file was not parsed' }
  },
  async getAssist(id) {
    await delay(60)
    return trayOf(tender(id))
  },
  async assistCommand(id, body) {
    await delay(400)
    const t = tender(id)
    const plan = commandPlan(t, body.text, body.scope, body.lv_id)
    save()
    return plan
  },
  async applyProposal(id, proposalId) {
    if (proposalId === 'instr') {
      trayOf(tender(id))
      return mockApi.applyPlan(id, 'p_instr')
    }
    throw new NotFound('Unknown proposal')
  },
  async applyPlan(id, planId): Promise<AssistApplyResult> {
    await delay(200)
    const t = tender(id)
    const plan = t.plans[planId]
    if (!plan) throw new NotFound('Plan expired. Ask again.')
    const snap = snapshot(t)
    applyOps(t, plan.ops)
    const e = addLog(t, 'Assist', 'plan', plan.label.replace(/^Done: /, ''), undefined, snap)
    markAssistLog(t, plan.ops, e.id)
    t.done.unshift({ id: e.id, text: e.text!, at: e.at, log_id: e.id, undoable: true })
    delete t.plans[planId]
    touch(t)
    save()
    return { log_id: e.id, message: plan.label, detail: plan.detail, applied: plan.ops.length }
  },
  async undo(id, logId) {
    await delay(120)
    const t = tender(id)
    const e = t.log.find((x) => x.id === logId)
    if (!e || !e.snapshot || e.undone) throw new NotFound('Nothing to undo')
    t.positions = clone(e.snapshot.positions)
    t.instructions = clone(e.snapshot.instructions)
    e.undone = true
    t.done = t.done.map((d) => (d.log_id === logId ? { ...d, undoable: false, text: d.text + ' (undone)' } : d))
    addLog(t, 'You', 'undo', `Undid: ${e.text}`)
    touch(t)
    save()
    return { ok: true }
  },
  async explain(id, lv, field) {
    await delay(60)
    const p = pricePos(tender(id), lv)
    return { field, steps: [{ text: p.explain?.[field] ?? '' }] }
  },
  async getLog(id, opts) {
    await delay(60)
    return tender(id)
      .log.filter((e) => !opts?.lv_id || e.lv_id === opts.lv_id)
      .map(({ snapshot: _s, ...e }) => e)
  },
  async getPeople() {
    return DEFAULT_PEOPLE
  },
  // the review trail needs the real backend; offline the Changes screen shows an empty trail
  async getChanges() {
    return emptyChanges()
  },
  async reviewChanges() {
    return emptyChanges()
  },
  async getVerification() {
    return null
  },
  pageImageUrl: () => null,
  async download(id, kind) {
    exportFile(tender(id), kind)
  },
}
