import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLang, useT } from '../i18n'
import { usePositions, useQuotes, useReference } from '../api/hooks'
import type { CatalogRow } from '../api/types'
import { buildRows, filterCounts, type LineFilter } from '../lib/lines'

const FILTERS: LineFilter[] = ['review', 'priced', 'all', 'check', 'missing', 'notpriced']

export function useLineFilter(): [LineFilter, string, (f: LineFilter, q?: string) => void] {
  const [params, setParams] = useSearchParams()
  const f = params.get('f') as LineFilter | null
  const filter = f && FILTERS.includes(f) ? f : 'review'
  const q = params.get('q') ?? ''
  const set = (nf: LineFilter, nq = q) => {
    const p: Record<string, string> = { f: nf }
    if (nq) p.q = nq
    setParams(p, { replace: true })
  }
  return [filter, q, set]
}

export function useLineQueue(id: string, filter: LineFilter, q: string) {
  const t = useT()
  const lang = useLang()
  const pq = usePositions(id)
  const qq = useQuotes(id)
  const positions = useMemo(() => pq.data?.positions ?? [], [pq.data])
  const quotes = useMemo(() => qq.data ?? [], [qq.data])
  const built = useMemo(() => buildRows(positions, quotes, filter, q, t, lang), [positions, quotes, filter, q, t, lang])
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
