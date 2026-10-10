// Supplier and Equans negotiated price lists (backend app/price_lists.py). Real backend only:
// the offline mock has no price lists, so these calls fail there and the tab says so.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { req } from './client'

export type PriceListKind = 'negotiated' | 'supplier'
export type PriceListState = 'in_effect' | 'inactive' | 'not_yet_valid' | 'expired'

export interface PriceListMeta {
  name: string
  supplier: string | null
  kind: PriceListKind
  valid_from: string | null
  valid_to: string | null
  currency: string
}

export interface TenderEffect {
  tender_id: string
  name: string
  direct_before: number
  direct_after: number
  direct_delta: number
  cost_delta: number
  lines_changed: number
}

export interface PriceList extends PriceListMeta {
  id: string
  file: string
  original_name: string
  active: boolean
  created_at: string
  rows: number
  matched: number
  state: PriceListState
  position: number
  counts: { rows: number; matched: number; unmatched: number; cheaper: number; dearer: number; in_use: number; changes: number }
  /** active list: what it saves now (without -> with); inactive list: what activating it would do */
  effect: TenderEffect[]
}

export interface PriceListRow {
  line: number
  product_id: string | null
  article_no: string | null
  manufacturer: string | null
  model: string | null
  description: string | null
  unit: string | null
  list_price: number | null
  discount_pct: number | null
  net_price: number | null
  matched_product_id: string | null
  match_by: 'product_id' | 'manufacturer+model' | 'model' | null
  catalog_net: number | null
  problem: string | null
  // detail only
  catalog_description?: string | null
  in_use?: boolean
  used_price?: number | null
  used_source?: string | null
}

export interface PriceListDetail extends PriceList {
  rows_detail: PriceListRow[]
}

export interface PriceListsResponse {
  lists: PriceList[]
  precedence: string[]
  demo_files: { name: string }[]
}

export type Mapping = Record<string, string | null>

export interface PriceListPreview {
  file_name: string
  headers: string[]
  mapping: Mapping
  fields: { key: string; label: string }[]
  missing: string[]
  title_lines: string[]
  meta: PriceListMeta
  rows: PriceListRow[]
  counts: { rows: number; matched: number; unmatched: number; cheaper: number; dearer: number }
  effect: TenderEffect[]
}

/** A file the estimator picked, or one of the demo files shipped with the backend. */
export type PriceListSource = { file: File } | { demo: string }

function form(src: PriceListSource, extra: Record<string, string | undefined>) {
  const f = new FormData()
  if ('file' in src) f.append('file', src.file)
  else f.append('demo', src.demo)
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) f.append(k, v)
  return f
}

const KEY = ['reference', 'price-lists'] as const

export function usePriceLists() {
  return useQuery({ queryKey: KEY, queryFn: () => req<PriceListsResponse>('GET', '/reference/price-lists') })
}

export function usePriceList(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => req<PriceListDetail>('GET', `/reference/price-lists/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
  })
}

export function previewPriceList(src: PriceListSource, mapping?: Mapping, meta?: Partial<PriceListMeta>) {
  return req<PriceListPreview>(
    'POST',
    '/reference/price-lists/preview',
    form(src, { mapping: mapping ? JSON.stringify(mapping) : undefined, meta: meta ? JSON.stringify(meta) : undefined }),
  )
}

/** Every change re-prices all tenders: refresh everything, as a catalogue import does. */
function useRefreshAll<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries() })
}

export function useCreatePriceList() {
  return useRefreshAll((v: { src: PriceListSource; mapping: Mapping; meta: PriceListMeta; activate: boolean }) =>
    req('POST', '/reference/price-lists', form(v.src, { mapping: JSON.stringify(v.mapping), meta: JSON.stringify(v.meta), activate: String(v.activate) })),
  )
}

export function usePatchPriceList() {
  return useRefreshAll((v: { id: string; patch: Partial<PriceListMeta> & { active?: boolean } }) =>
    req('PATCH', `/reference/price-lists/${encodeURIComponent(v.id)}`, v.patch),
  )
}

export function useOrderPriceLists() {
  return useRefreshAll((order: string[]) => req('PUT', '/reference/price-lists/order', { order }))
}

export function useDeletePriceList() {
  return useRefreshAll((id: string) => req('DELETE', `/reference/price-lists/${encodeURIComponent(id)}`))
}
