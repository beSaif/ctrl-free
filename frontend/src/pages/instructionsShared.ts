import { useSearchParams } from 'react-router-dom'
import type { T } from '../i18n'
import type { Instruction } from '../api/types'
import { C } from '../lib/lines'

export type InsTab = 'open' | 'all' | 'cost' | 'risk' | 'scope' | 'covered'
export const INS_TABS: InsTab[] = ['open', 'all', 'cost', 'risk', 'scope', 'covered']

export const IMPACT: Record<string, [string, string]> = {
  cost: ['Adds cost', C.attn],
  risk: ['Risk', C.ink],
  scope: ['Scope', C.faint],
  covered: ['Covered', C.accent],
}

export function impactOf(kind: string, t: T): [string, string] {
  const v = IMPACT[kind] ?? [kind, C.muted]
  return [t(v[0]), v[1]]
}

export function useInsTab(): [InsTab, (k: InsTab) => void] {
  const [params, setParams] = useSearchParams()
  const v = params.get('tab') as InsTab | null
  return [v && INS_TABS.includes(v) ? v : 'open', (k) => setParams({ tab: k }, { replace: true })]
}

export function insQueue(all: Instruction[], tab: InsTab) {
  return all.filter((i) => (tab === 'open' ? i.state === 'open' : tab === 'all' || i.kind === tab))
}

export function sourceHint(all: Instruction[], t: T) {
  if (!all.length) return ''
  const pages = all.map((i) => i.page)
  const sections = all.map((i) => i.section).filter(Boolean) as string[]
  const sec = sections.sort((a, b) => sections.filter((x) => x === b).length - sections.filter((x) => x === a).length)[0]
  const lo = Math.min(...pages)
  const hi = Math.max(...pages)
  const pp = lo === hi ? t('PDF p. {a}', { a: lo }) : t('PDF pp. {a} to {b}', { a: lo, b: hi })
  return sec ? t('Quoted from {s}, {pp}', { s: sec, pp }) : t('Quoted from the tender, {pp}', { pp })
}

