// Fetch wrappers for every endpoint in docs/SPEC.md, plus the mock/real switch.
// Mode: VITE_USE_MOCK=1 forces the in-memory mock. Otherwise GET /api/health decides
// once at startup; when the backend is not reachable the mock takes over.
import { useSyncExternalStore } from 'react'
import type {
  AssistApplyResult,
  AssistPlan,
  AssistTray,
  Candidate,
  ChecklistItem,
  Explain,
  Instruction,
  InstructionPatch,
  InstructionsResponse,
  LogEntry,
  Outcome,
  PositionDetail,
  PositionPatch,
  PositionsResponse,
  PricingPut,
  PricingResponse,
  ProjectCostItem,
  AssistProposal,
  Totals,
  QuoteGroup,
  QuoteProposal,
  ReferenceResponse,
  ResultsResponse,
  Snapshot,
  TenderDetail,
  TenderSummary,
  Verification,
} from './types'

export type ExportKind = 'xlsx' | 'report.pdf' | 'sia'

export interface Api {
  listTenders(): Promise<TenderSummary[]>
  createTender(form: FormData): Promise<TenderSummary>
  createDemoTender(): Promise<TenderSummary>
  getTender(id: string): Promise<TenderDetail>
  getPositions(id: string, filter?: string, q?: string): Promise<PositionsResponse>
  getPosition(id: string, lv: string): Promise<PositionDetail>
  patchPosition(id: string, lv: string, body: PositionPatch): Promise<PositionDetail>
  getCandidates(id: string, lv: string, q?: string): Promise<Candidate[]>
  getInstructions(id: string, filter?: string): Promise<InstructionsResponse>
  patchInstruction(id: string, iid: string, body: InstructionPatch): Promise<Instruction>
  getPricing(id: string): Promise<PricingResponse>
  putPricing(id: string, body: PricingPut): Promise<PricingResponse>
  resetPricing(id: string): Promise<PricingResponse>
  getQuotes(id: string): Promise<QuoteGroup[]>
  markQuoteSent(id: string, group: string, sent: boolean): Promise<unknown>
  readQuote(id: string, input: File | string, lvId?: string): Promise<QuoteProposal[]>
  applyQuotes(id: string, proposals: QuoteProposal[], proposalId?: string): Promise<AssistApplyResult>
  /** Apply a tray proposal as a whole (e.g. confirm the instructions that do not change the price). */
  applyProposal(id: string, proposalId: string): Promise<AssistApplyResult>
  getChecklist(id: string): Promise<ChecklistItem[]>
  submit(id: string, option?: string): Promise<Snapshot>
  putOutcome(id: string, outcome: Outcome): Promise<unknown>
  getResults(): Promise<ResultsResponse>
  getReference(): Promise<ReferenceResponse>
  importReference(kind: string, file: File): Promise<unknown>
  getAssist(id: string): Promise<AssistTray>
  assistCommand(id: string, body: { text: string; scope: 'line' | 'tender'; lv_id?: string }): Promise<AssistPlan>
  applyPlan(id: string, planId: string): Promise<AssistApplyResult>
  undo(id: string, logId: string): Promise<unknown>
  explain(id: string, lv: string, field: string): Promise<Explain>
  getLog(id: string): Promise<LogEntry[]>
  /** Our lines vs the Equans verified examples (null when not available, e.g. mock or another tender). */
  getVerification(id: string): Promise<Verification | null>
  /** URL of the rendered page image, or null when there is none (mock mode). */
  pageImageUrl(id: string, page: number, scale?: number): string | null
  /** Starts a file download for an export. */
  download(id: string, kind: ExportKind): Promise<void>
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} }
  if (body instanceof FormData) init.body = body
  else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const res = await fetch('/api' + path, init)
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = await res.json()
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg || 'Request failed')
  }
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('content-type') || ''
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>
}

/** Accepts either a bare array or {key: [...]} so small backend shape differences do not break the UI. */
function arr<T>(x: unknown, ...keys: string[]): T[] {
  if (Array.isArray(x)) return x as T[]
  if (x && typeof x === 'object') {
    for (const k of keys) {
      const v = (x as Record<string, unknown>)[k]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

const enc = encodeURIComponent
const qs = (o: Record<string, string | undefined>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== '')
  return p.length ? '?' + p.map(([k, v]) => `${k}=${enc(v as string)}`).join('&') : ''
}

// ---- normalisers: map small differences in the backend's shapes onto the SPEC types ----------

type Obj = Record<string, unknown>
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function normQuoteGroup(g: QuoteGroup): QuoteGroup {
  const o = g as unknown as Obj
  return { ...g, sent: g.sent ?? !!o.sent_at, body: g.body ?? str(o.body_de) ?? g.email?.body }
}

function normApply(r: unknown): AssistApplyResult {
  const o = (r ?? {}) as Obj
  const still = Array.isArray(o.still_in_review) ? (o.still_in_review as string[]) : []
  return {
    log_id: str(o.log_id) ?? str(o.undo_id) ?? (Array.isArray(o.log_ids) ? str((o.log_ids as unknown[])[0]) : undefined),
    message: str(o.message) ?? str(o.text),
    detail: str(o.detail) ?? (still.length ? `${still.join(', ')} ${still.length === 1 ? 'is' : 'are'} still in review.` : undefined),
    applied: num(o.applied),
  }
}

function normPricing(r: PricingResponse): PricingResponse {
  const t = r.totals as Totals & Obj
  const items = (t.project_cost_items ?? (t.project_costs_detail as ProjectCostItem[] | undefined)) || undefined
  return { ...r, totals: { ...t, lines: t.lines ?? num(t.lines_priced) ?? num(t.lines_total), project_cost_items: items } }
}

function normResults(r: unknown): ResultsResponse {
  const o = (Array.isArray(r) ? { rows: r } : (r ?? {})) as Obj
  const rows = ((o.rows as Obj[]) ?? []).map((x) => {
    const res = str(x.result)
    return {
      tender_id: str(x.tender_id) ?? str(x.id) ?? '',
      name: str(x.name) ?? '',
      trade: str(x.trade) ?? '',
      offer_price: num(x.offer_price) ?? num(x.our_offer) ?? null,
      winning_price: num(x.winning_price) ?? null,
      gap_pct: num(x.gap_pct) ?? null,
      bidders: num(x.bidders) ?? null,
      competition_call: (x.competition_call as string | number | null) ?? num(x.competition_value) ?? null,
      result: res === 'won' || res === 'lost' ? res : null,
      option: str(x.option) ?? null,
    }
  })
  return { rows, recorded: num(o.recorded), stats: ((o.stats ?? o.learned) as Obj | null) ?? null }
}

function normTray(r: Obj): AssistTray {
  const needs = ((r.needs_ok as Obj[]) ?? []).map((p): AssistProposal => {
    const kind = str(p.kind) ?? ''
    if (kind === 'supplier_reply' || kind === 'quotes') {
      const items = ((p.lines ?? p.items) as Obj[]) ?? []
      return {
        id: str(p.id) ?? '',
        kind: 'quotes',
        title: str(p.title) ?? '',
        source: str(p.source),
        received_at: str(p.received_at),
        lines: items.map((it) => {
          const unit = num(it.unit_price) ?? 0
          const budget = num(it.budget)
          const st = str(it.state)
          return {
            lv_id: str(it.lv_id) ?? '',
            unit_price: unit,
            budget,
            source: str(it.source) ?? str(p.source) ?? '',
            delta: num(it.delta),
            pos_no: str(it.pos_no) ?? str(it.reply_pos_no) ?? str(it.reply_pos) ?? (num(it.reply_pos) !== undefined ? String(it.reply_pos) : undefined),
            text_de: str(it.text_de) ?? str(it.reply_text) ?? str(it.title_de),
            quantity: num(it.quantity),
            state: st && st !== 'open' ? st : budget !== undefined && unit > budget ? 'above budget' : 'below budget',
          }
        }),
      }
    }
    if (kind === 'confirm_instructions' || kind === 'instructions') {
      const items = (p.items as Obj[]) ?? []
      return {
        id: str(p.id) ?? '',
        kind: 'instructions',
        title: str(p.title) ?? '',
        text: str(p.text) ?? str(p.detail),
        instruction_ids: (p.instruction_ids as string[]) ?? items.map((i) => str(i.id) ?? ''),
        plan_id: str(p.plan_id),
      }
    }
    return { ...(p as unknown as AssistProposal), text: str(p.text) ?? str(p.detail) }
  })
  const working = ((r.working_on as Obj[]) ?? []).map((w) => ({
    id: str(w.id) ?? '',
    text: str(w.text) ?? str(w.title) ?? '',
    page: num(w.page),
    pages: num(w.pages),
  }))
  const done = ((r.done as Obj[]) ?? []).map((d) => ({
    id: str(d.id),
    text: str(d.text) ?? '',
    at: str(d.at),
    lv_id: str(d.lv_id),
    log_id: str(d.log_id) ?? (d.undoable ? str(d.id) : undefined),
    undoable: !!d.undoable && !d.undone,
    undone: !!d.undone,
  }))
  return { needs_ok: needs, working_on: working, done }
}

function normPlan(r: Obj): AssistPlan {
  const kind = str(r.kind)
  const plan = ((r.plan as Obj[]) ?? []).map((a) => ({
    lv_id: str(a.lv_id),
    text: str(a.text) ?? '',
    action: str(a.act) ?? str(a.action) ?? '',
  }))
  const ex = r.explain as Obj | undefined
  return {
    plan_id: str(r.plan_id) ?? null,
    plan,
    effect: (r.effect as AssistPlan['effect']) ?? null,
    answer: str(r.answer) ?? (kind === 'message' || !r.plan_id ? (str(r.message) ?? null) : null),
    kind: kind === 'plan' && !r.plan_id ? 'finds' : kind,
    explain: ex ? { field: str(ex.field) ?? '', title: str(ex.title), steps: (ex.steps as Explain['steps']) ?? [], sources: ex.sources as string[] } : undefined,
  }
}

export const realApi: Api = {
  listTenders: async () => arr<TenderSummary>(await req('GET', '/tenders'), 'tenders'),
  createTender: (form) => req('POST', '/tenders', form),
  createDemoTender: () => req('POST', '/tenders/demo'),
  getTender: (id) => req('GET', `/tenders/${id}`),
  getPositions: async (id, filter, q) => {
    const r = await req<PositionsResponse | PositionsResponse['positions']>('GET', `/tenders/${id}/positions${qs({ filter, q })}`)
    return Array.isArray(r) ? { positions: r } : r
  },
  getPosition: (id, lv) => req('GET', `/tenders/${id}/positions/${enc(lv)}`),
  patchPosition: (id, lv, body) => req('PATCH', `/tenders/${id}/positions/${enc(lv)}`, body),
  getCandidates: async (id, lv, q) =>
    arr<Candidate>(await req('GET', `/tenders/${id}/positions/${enc(lv)}/candidates${qs({ q })}`), 'candidates', 'items'),
  getInstructions: async (id, filter) => {
    const r = await req<InstructionsResponse | Instruction[]>('GET', `/tenders/${id}/instructions${qs({ filter })}`)
    return Array.isArray(r) ? { instructions: r } : r
  },
  patchInstruction: (id, iid, body) => req('PATCH', `/tenders/${id}/instructions/${enc(iid)}`, body),
  getPricing: async (id) => normPricing(await req('GET', `/tenders/${id}/pricing`)),
  putPricing: async (id, body) => normPricing(await req('PUT', `/tenders/${id}/pricing`, body)),
  resetPricing: async (id) => normPricing(await req('POST', `/tenders/${id}/pricing/reset`)),
  getQuotes: async (id) => arr<QuoteGroup>(await req('GET', `/tenders/${id}/quotes`), 'groups', 'quotes').map(normQuoteGroup),
  markQuoteSent: (id, group, sent) => req('POST', `/tenders/${id}/quotes/${enc(group)}/sent?sent=${sent}`, { sent }),
  readQuote: async (id, input, lvId) => {
    const f = new FormData()
    if (typeof input === 'string') f.append('text', input)
    else f.append('file', input)
    if (lvId) f.append('lv_id', lvId)
    return arr<QuoteProposal>(await req('POST', `/tenders/${id}/quotes/read`, f), 'proposals', 'items')
  },
  applyQuotes: async (id, proposals, proposalId) =>
    normApply(await req('POST', `/tenders/${id}/quotes/apply`, { proposals, proposal_id: proposalId ?? null })),
  applyProposal: async (id, proposalId) => normApply(await req('POST', `/tenders/${id}/assist/proposals/${enc(proposalId)}/apply`)),
  getChecklist: async (id) => arr<ChecklistItem>(await req('GET', `/tenders/${id}/export/checklist`), 'items', 'checklist'),
  submit: (id, option) => req('POST', `/tenders/${id}/submit`, option ? { option } : {}),
  putOutcome: (id, outcome) => req('PUT', `/tenders/${id}/outcome`, outcome),
  getResults: async () => normResults(await req<unknown>('GET', '/results')),
  getReference: () => req('GET', '/reference'),
  importReference: (kind, file) => {
    const f = new FormData()
    f.append('file', file)
    return req('POST', `/reference/${enc(kind)}`, f)
  },
  getAssist: async (id) => normTray(await req<Record<string, unknown>>('GET', `/tenders/${id}/assist`)),
  assistCommand: async (id, body) => normPlan(await req<Record<string, unknown>>('POST', `/tenders/${id}/assist/command`, body)),
  applyPlan: async (id, planId) => normApply(await req('POST', `/tenders/${id}/assist/plans/${enc(planId)}/apply`)),
  undo: (id, logId) => req('POST', `/tenders/${id}/assist/undo/${enc(logId)}`),
  explain: (id, lv, field) => req('GET', `/tenders/${id}/explain/${enc(lv)}${qs({ field })}`),
  getLog: async (id) => arr<LogEntry>(await req('GET', `/tenders/${id}/log`), 'log', 'entries'),
  getVerification: async (id) => {
    try {
      const r = await req<Verification>('GET', `/tenders/${id}/verification`)
      return r && r.loaded && r.rows?.length ? r : null
    } catch {
      return null
    }
  },
  pageImageUrl: (id, page, scale = 2) => `/api/tenders/${id}/pages/${page}.png?scale=${scale}`,
  download: async (id, kind) => {
    const a = document.createElement('a')
    a.href = `/api/tenders/${id}/export/${kind}`
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  },
}

// ---- mode switch -------------------------------------------------------------

export type ApiMode = 'pending' | 'real' | 'mock'
let mode: ApiMode = 'pending'
const modeListeners = new Set<() => void>()
let implPromise: Promise<Api> | null = null

function setMode(m: ApiMode) {
  mode = m
  modeListeners.forEach((f) => f())
}

async function backendUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2500)
    const r = await fetch('/api/health', { signal: ctrl.signal })
    clearTimeout(timer)
    if (!r.ok) return false
    // Vite answers unknown paths with index.html; only JSON counts as a live backend.
    return (r.headers.get('content-type') || '').includes('json')
  } catch {
    return false
  }
}

function impl(): Promise<Api> {
  if (!implPromise) {
    implPromise = (async () => {
      const forced = String(import.meta.env.VITE_USE_MOCK ?? '') === '1'
      if (!forced && (await backendUp())) {
        setMode('real')
        return realApi
      }
      const m = await import('./mock')
      setMode('mock')
      return m.mockApi
    })()
  }
  return implPromise
}

export function useApiMode(): ApiMode {
  return useSyncExternalStore(
    (cb) => {
      modeListeners.add(cb)
      return () => modeListeners.delete(cb)
    },
    () => mode,
    () => mode,
  )
}

export function getApiMode(): ApiMode {
  return mode
}

/** Synchronous page-image URL for render code: null until the mode is known or in mock mode. */
export function pageImageUrl(id: string, page: number, scale = 2): string | null {
  return mode === 'real' ? realApi.pageImageUrl(id, page, scale) : null
}

type AsyncKeys = { [K in keyof Api]: Api[K] extends (...a: never[]) => Promise<unknown> ? K : never }[keyof Api]

/** `api.x(...)` waits for the mode decision, then calls the real or mock implementation. */
export const api = new Proxy({} as Pick<Api, AsyncKeys>, {
  get(_t, prop: string) {
    return async (...args: unknown[]) => {
      const a = await impl()
      const fn = (a as unknown as Record<string, (...x: unknown[]) => unknown>)[prop]
      return fn.apply(a, args)
    }
  },
})

// kick off detection right away
void impl()
