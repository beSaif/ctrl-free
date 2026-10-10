import { createContext, useContext } from 'react'
import type { Position } from '../api/types'

export interface AssistCtx {
  tenderId: string
  trayOpen: boolean
  setTrayOpen: (v: boolean) => void
  barOpen: boolean
  openBar: () => void
  closeBar: () => void
  /** The line the user is looking at (set by the line detail page). */
  line: Position | null
  setLine: (p: Position | null) => void
  dismissed: Set<string>
  dismiss: (key: string) => void
}

export const Ctx = createContext<AssistCtx | null>(null)

export function useAssistCtx(): AssistCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAssistCtx outside AssistProvider')
  return c
}

/** Same, but returns null outside a tender (for shared components). */
export function useMaybeAssistCtx(): AssistCtx | null {
  return useContext(Ctx)
}
