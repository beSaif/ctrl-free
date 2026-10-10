import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { usePositions, useQuotes, useReference } from '../api/hooks'
import type { CatalogRow } from '../api/types'
import { buildRows, filterCounts, type LineFilter, type LineGroupBy } from '../lib/lines'

const FILTERS: LineFilter[] = ['review', 'priced', 'all', 'check', 'missing', 'notpriced']

/** Filter, search and grouping live in the URL (?f=&q=&g=order), so links and Back keep the view. */
export function useLineFilter(): [LineFilter, string, (f: LineFilter, q?: string) => void, LineGroupBy, (g: LineGroupBy) => void] {
  const [params, setParams] = useSearchParams()
  const f = params.get('f') as LineFilter | null
  const filter = f && FILTERS.includes(f) ? f : 'review'
  const q = params.get('q') ?? ''
  const group = lineGroupOf(params)
  const write = (nf: LineFilter, nq: string, ng: LineGroupBy) => {
    const p: Record<string, string> = { f: nf }
    if (nq) p.q = nq
    if (ng === 'order') p.g = ng
    setParams(p, { replace: true })
  }
  return [filter, q, (nf, nq = q) => write(nf, nq, group), group, (ng) => write(filter, q, ng)]
}

function lineGroupOf(params: URLSearchParams): LineGroupBy {
  return params.get('g') === 'order' ? 'order' : 'type'
}

/** URL params for the grouping (empty for the default view). */
export function groupParam(g: LineGroupBy): Record<string, string> {
  return g === 'order' ? { g } : {}
}

/** The list's rows and queue; the grouping comes from the URL, so the line detail's Previous/Next follow it. */
export function useLineQueue(id: string, filter: LineFilter, q: string) {
  const t = useT()
  const lang = useLang()
  const [params] = useSearchParams()
  const group = lineGroupOf(params)
  const pq = usePositions(id)
  const qq = useQuotes(id)
  const positions = useMemo(() => pq.data?.positions ?? [], [pq.data])
  const quotes = useMemo(() => qq.data ?? [], [qq.data])
  const built = useMemo(() => buildRows(positions, quotes, filter, q, t, lang, group), [positions, quotes, filter, q, t, lang, group])
  const counts = useMemo(() => filterCounts(positions), [positions])
  return { ...built, counts, positions, quotes, isLoading: pq.isLoading || qq.isLoading, error: pq.error }
}

export function useCatalog(): Record<string, CatalogRow> {
  const { data } = useReference()
  return useMemo(() => Object.fromEntries((data?.catalog ?? []).map((c) => [c.product_id, c])), [data])
}

export function linesQuery(filter: LineFilter, q: string, extra?: Record<string, string>) {
  const p = new URLSearchParams({ f: filter, ...(q ? { q } : {}), ...extra })
  return '?' + p.toString()
}
