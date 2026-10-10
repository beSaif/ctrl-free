// Assist hooks and helpers shared by the tray, the command bar and the in-place proposal.
import type { T } from '../i18n'
import { useAssist } from '../api/hooks'
import type { AssistProposal } from '../api/types'
import { useAssistCtx } from './context'

export function proposalTitle(p: AssistProposal, t: T, lang: string): string {
  if (lang === 'en' || !p.kind) return p.title
  if (p.kind === 'quotes') return t('Fill {n} quotes', { n: p.lines?.length ?? 0 })
  if (p.kind === 'instructions')
    return t('Confirm {n} instructions that do not change the price', { n: p.instruction_ids?.length ?? 0 })
  return p.title
}

export function useOpenProposals() {
  const { tenderId } = useAssistCtx()
  const { data } = useAssist(tenderId)
  return data?.needs_ok ?? []
}

export function useLineProposal(tenderId: string, lv: string) {
  const { data } = useAssist(tenderId)
  const ctx = useAssistCtx()
  for (const p of data?.needs_ok ?? []) {
    if (p.kind !== 'quotes') continue
    const line = p.lines?.find((l) => l.lv_id === lv)
    if (line) return { proposal: p, line, dismissed: ctx.dismissed.has(`${p.id}:${lv}`) }
  }
  return null
}
