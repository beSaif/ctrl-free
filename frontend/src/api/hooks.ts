// React Query hooks. Every mutation invalidates all queries of its tender, so totals,
// tab counts and the footer update everywhere at once.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from './client'
import type {
  InstructionPatch,
  Outcome,
  PositionPatch,
  PricingPut,
  PricingResponse,
  QuoteProposal,
  ReviewVerdict,
  TenderSummary,
} from './types'

export const qk = {
  tenders: ['tenders'] as const,
  tender: (id: string) => ['tender', id] as const,
  positions: (id: string) => ['positions', id] as const,
  position: (id: string, lv: string) => ['position', id, lv] as const,
  candidates: (id: string, lv: string, q: string) => ['candidates', id, lv, q] as const,
  instructions: (id: string) => ['instructions', id] as const,
  pricing: (id: string) => ['pricing', id] as const,
  quotes: (id: string) => ['quotes', id] as const,
  assist: (id: string) => ['assist', id] as const,
  log: (id: string) => ['log', id] as const,
  results: ['results'] as const,
  reference: ['reference'] as const,
}

export function invalidateTender(qc: QueryClient, id: string) {
  return qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey
      return k[0] === 'tenders' || k[0] === 'results' || k[1] === id
    },
  })
}

const isReading = (t?: Pick<TenderSummary, 'status'> | null) => t?.status === 'reading'

export function useTenders() {
  return useQuery({
    queryKey: qk.tenders,
    queryFn: () => api.listTenders(),
    refetchInterval: (q) => (q.state.data?.some(isReading) ? 400 : false),
  })
}

export function useTender(id: string) {
  return useQuery({
    queryKey: qk.tender(id),
    queryFn: () => api.getTender(id),
    refetchInterval: (q) => (isReading(q.state.data) ? 400 : false),
  })
}

/** All positions of a tender (filtering and search happen client-side so every view shares one cache). */
export function usePositions(id: string, enabled = true) {
  return useQuery({ queryKey: qk.positions(id), queryFn: () => api.getPositions(id, 'all'), enabled })
}

export function usePosition(id: string, lv: string) {
  return useQuery({ queryKey: qk.position(id, lv), queryFn: () => api.getPosition(id, lv) })
}

export function useCandidates(id: string, lv: string, q = '') {
  return useQuery({ queryKey: qk.candidates(id, lv, q), queryFn: () => api.getCandidates(id, lv, q || undefined) })
}

export function useInstructions(id: string, enabled = true) {
  return useQuery({ queryKey: qk.instructions(id), queryFn: () => api.getInstructions(id, 'all'), enabled })
}

export function usePricing(id: string, enabled = true) {
  return useQuery({ queryKey: qk.pricing(id), queryFn: () => api.getPricing(id), enabled })
}

export function useQuotes(id: string, enabled = true) {
  return useQuery({ queryKey: qk.quotes(id), queryFn: () => api.getQuotes(id), enabled })
}

export function useAssist(id: string, enabled = true) {
  return useQuery({
    queryKey: qk.assist(id),
    queryFn: () => api.getAssist(id),
    enabled,
    refetchInterval: (q) => (q.state.data?.working_on.length ? 700 : false),
  })
}

export function useVerification(id: string) {
  return useQuery({ queryKey: ['verification', id] as const, queryFn: () => api.getVerification(id), staleTime: 30_000 })
}

/** One line's audit log (newest first). Keyed under the tender, so every mutation refreshes it. */
export function useLineLog(id: string, lv: string) {
  return useQuery({ queryKey: [...qk.log(id), lv] as const, queryFn: () => api.getLog(id, { lv_id: lv }) })
}

export function useResults() {
  return useQuery({ queryKey: qk.results, queryFn: () => api.getResults() })
}

export function useReference() {
  return useQuery({ queryKey: qk.reference, queryFn: () => api.getReference(), staleTime: 5 * 60_000 })
}

// ---- mutations -------------------------------------------------------------------

function useTenderMutation<V, R>(id: string, fn: (v: V) => Promise<R>, onData?: (qc: QueryClient, r: R, v: V) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, v) => {
      onData?.(qc, r, v)
      await invalidateTender(qc, id)
    },
  })
}

export function usePatchPosition(id: string) {
  return useTenderMutation(
    id,
    ({ lv, body }: { lv: string; body: PositionPatch }) => api.patchPosition(id, lv, body),
    (qc, r, v) => {
      if (r && typeof r === 'object' && 'lv_id' in r) qc.setQueryData(qk.position(id, v.lv), r)
    },
  )
}

export function usePatchInstruction(id: string) {
  return useTenderMutation(id, ({ iid, body }: { iid: string; body: InstructionPatch }) => api.patchInstruction(id, iid, body))
}

export function usePutPricing(id: string) {
  return useTenderMutation(
    id,
    (body: PricingPut) => api.putPricing(id, body),
    (qc, r) => {
      if (r && (r as PricingResponse).totals) qc.setQueryData(qk.pricing(id), r)
    },
  )
}

export function useResetPricing(id: string) {
  return useTenderMutation(
    id,
    (keys?: string[]) => api.resetPricing(id, keys),
    (qc, r) => {
      if (r && (r as PricingResponse).totals) qc.setQueryData(qk.pricing(id), r)
    },
  )
}

export function useMarkSent(id: string) {
  return useTenderMutation(id, ({ group, sent }: { group: string; sent: boolean }) => api.markQuoteSent(id, group, sent))
}

export function useReadQuote(id: string) {
  return useTenderMutation(id, ({ input, lv }: { input: File | string; lv?: string }) => api.readQuote(id, input, lv))
}

export function useApplyQuotes(id: string) {
  return useTenderMutation(id, ({ lines, proposalId }: { lines: QuoteProposal[]; proposalId?: string }) => api.applyQuotes(id, lines, proposalId))
}

export function useApplyProposal(id: string) {
  return useTenderMutation(id, (proposalId: string) => api.applyProposal(id, proposalId))
}

export function useAssistCommand(id: string) {
  return useMutation({
    mutationFn: (body: { text: string; scope: 'line' | 'tender'; lv_id?: string }) => api.assistCommand(id, body),
  })
}

export function useApplyPlan(id: string) {
  return useTenderMutation(id, (planId: string) => api.applyPlan(id, planId))
}

export function useUndo(id: string) {
  return useTenderMutation(id, (logId: string) => api.undo(id, logId))
}

export function useSubmit(id: string) {
  return useTenderMutation(id, (option?: string) => api.submit(id, option))
}

export function usePutOutcome(id: string) {
  return useTenderMutation(id, (o: Outcome) => api.putOutcome(id, o))
}

export function useCreateTender() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { demo: true } | { form: FormData }) => ('demo' in v ? api.createDemoTender() : api.createTender(v.form)),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tenders }),
  })
}

export function useDeleteTender() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteTender(id),
    // only the lists: the open tender's own queries would refetch into a 404 before we navigate away
    onSuccess: () => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'tenders' || q.queryKey[0] === 'results' }),
  })
}

export function useImportReference() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ kind, file }: { kind: string; file: File }) => api.importReference(kind, file),
    // new catalogue prices or install rules re-price every tender: refresh everything, not only this screen
    onSuccess: () => qc.invalidateQueries(),
  })
}

// ---- who did what (Changes screen) ------------------------------------------------

export function usePeople() {
  return useQuery({ queryKey: ['people'] as const, queryFn: () => api.getPeople(), staleTime: Infinity })
}

export function useChanges(id: string, enabled = true) {
  return useQuery({ queryKey: ['changes', id] as const, queryFn: () => api.getChanges(id), enabled })
}

export function useReviewChanges(id: string) {
  return useTenderMutation(
    id,
    ({ logIds, verdict, note }: { logIds: string[]; verdict: ReviewVerdict; note?: string }) => api.reviewChanges(id, logIds, verdict, note),
    (qc, r) => {
      if (r?.entries) qc.setQueryData(['changes', id], r)
    },
  )
}
