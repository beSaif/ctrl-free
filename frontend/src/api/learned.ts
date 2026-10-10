// Equivalent products ("Tender asks · We offer") and learned matches: types, fetches and hooks for
// GET /api/learned, PATCH|DELETE /api/learned/{id} and POST .../positions/{lv}/apply-similar.
// The line detail and candidates carry the comparison fields; read them with `lineExtras(p)`.
// In mock mode there are no learned rules and the actions are not offered.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, useApiMode } from './client'
import { invalidateTender } from './hooks'
import type { Candidate, Match, Position } from './types'

export type Verdict = 'same' | 'equivalent' | 'differs' | 'unknown'
export type MakeKind = 'example' | 'prescribed' | 'open' | 'none'

export interface CompareRow {
  key: string
  attribute: string
  tender: string | null
  /** the tender line the value was read from, verbatim */
  snippet: string | null
  product: string | null
  verdict: Verdict
  note?: string
}

export interface Comparison {
  product_id: string
  verdict: Verdict
  rows: CompareRow[]
  summary: {
    tender: string | null
    make_kind: MakeKind
    product: string | null
    checks: { key: string; attribute: string; verdict: Verdict }[]
  }
}

export interface MakeRule {
  kind: MakeKind
  make: string | null
  model: string | null
  wording: string | null
  snippet: string | null
  explicit: boolean
  inherited: boolean
  product_manufacturer?: string | null
  manufacturer_differs?: boolean
  variant_needed?: boolean
  variant_rule?: { id: string; type: string; page: number; section?: string; text_de: string; text_en?: string } | null
}

export interface LearnedRef {
  rule_id: string
  tender_id: string
  tender_name: string | null
  lv_id: string
  page?: number
  by: string
  at: string
  times_confirmed?: number
  times_overridden?: number
}

export interface Similar {
  signature: string
  label: string
  product_id: string
  confirm: boolean
  lv_ids: string[]
  count: number
}

export interface LineExtras {
  comparison: Comparison | null
  matchComparison: Comparison | null
  makeRule: MakeRule | null
  similar: Similar | null
  learned: LearnedRef | null
  rulesPick: { product_id: string | null; label: string; confidence: number; reason: string; method?: string } | null
}

type F1Match = Match & {
  comparison?: Comparison | null
  make_rule?: MakeRule
  learned?: LearnedRef
  rules_pick?: LineExtras['rulesPick']
}
type F1Position = Position & {
  comparison?: Comparison | null
  make_rule?: MakeRule
  similar?: Similar | null
  match?: F1Match | null
}

/** The equivalence and learning fields of a line (present on the line detail; partly on list rows). */
export function lineExtras(p: Position | undefined | null): LineExtras {
  const x = (p ?? {}) as F1Position
  const m = x.match ?? null
  return {
    comparison: x.comparison ?? null,
    matchComparison: m?.comparison ?? null,
    makeRule: x.make_rule ?? m?.make_rule ?? null,
    similar: x.similar ?? null,
    learned: m?.method === 'learned' ? (m.learned ?? null) : null,
    rulesPick: m?.method === 'learned' ? (m.rules_pick ?? null) : null,
  }
}

export function candidateComparison(c: Candidate): Comparison | null {
  return (c as Candidate & { comparison?: Comparison | null }).comparison ?? null
}

export function candidateTag(c: Candidate): 'learned' | 'rules_pick' | null {
  const tag = (c as Candidate & { tag?: string }).tag
  return tag === 'learned' || tag === 'rules_pick' ? tag : null
}

/** A product is a variant under the tender's rule: it differs from what the tender specifies, or the
 *  tender prescribes a make and this product is from another one. */
export function isVariantOf(cmp: Comparison | null): boolean {
  return !!cmp && cmp.verdict === 'differs'
}

// ---- Reference -> Learned matches ---------------------------------------------------------

export interface LearnedEvidence {
  kind: 'taught' | 'confirmed' | 'applied' | 'overridden'
  tender_id: string
  tender_name: string | null
  lv_id: string
  page?: number
  by: string
  at: string
  exists: boolean
}

export interface LearnedRule {
  id: string
  signature: string
  label: string
  wording_de: string | null
  text_de?: string | null
  unit?: string | null
  product_id: string
  install_code: string | null
  note: string | null
  product: { description?: string; manufacturer?: string; model?: string; unit?: string; net_cost_chf?: number } | null
  enabled: boolean
  active: boolean
  stopped: 'disabled' | 'overridden' | null
  times_applied: number
  times_confirmed: number
  times_overridden: number
  from: (Omit<LearnedEvidence, 'kind'> & { exists: boolean }) | null
  last_applied_at: string | null
  evidence: LearnedEvidence[]
}

export interface LearnedResponse {
  rules: LearnedRule[]
  counts: { total: number; active: number; applied: number }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
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
  return res.json() as Promise<T>
}

const EMPTY: LearnedResponse = { rules: [], counts: { total: 0, active: 0, applied: 0 } }
const KEY = ['learned'] as const

export function useLearned() {
  const mode = useApiMode()
  return useQuery({
    queryKey: [...KEY, mode],
    queryFn: () => (mode === 'real' ? call<LearnedResponse>('GET', '/learned') : Promise.resolve(EMPTY)),
    enabled: mode !== 'pending',
  })
}

export function useSetLearnedEnabled() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => call('PATCH', `/learned/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export function useDeleteLearned() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => call('DELETE', `/learned/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  })
}

export interface ApplySimilarResult {
  applied: number
  lv_ids: string[]
  batch: string
  log_id: string | null
  product_id: string
}

export function useApplySimilar(tenderId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (lv: string) => call<ApplySimilarResult>('POST', `/tenders/${tenderId}/positions/${encodeURIComponent(lv)}/apply-similar`),
    onSuccess: async () => {
      await Promise.all([invalidateTender(qc, tenderId), qc.invalidateQueries({ queryKey: KEY })])
    },
  })
}
