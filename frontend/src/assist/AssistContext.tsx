import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Position } from '../api/types'
import { Ctx } from './context'

function loadDismissed(id: string): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem('ctrlfree.dismissed.' + id) || '[]') as string[])
  } catch {
    return new Set()
  }
}

export function AssistProvider({ tenderId, children }: { tenderId: string; children: ReactNode }) {
  const [trayOpen, setTray] = useState(false)
  const [barOpen, setBar] = useState(false)
  const [line, setLine] = useState<Position | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed(tenderId))

  const openBar = useCallback(() => {
    setTray(false)
    setBar(true)
  }, [])
  const closeBar = useCallback(() => setBar(false), [])
  const setTrayOpen = useCallback((v: boolean) => {
    setTray(v)
    if (v) setBar(false)
  }, [])
  const dismiss = useCallback(
    (key: string) => {
      setDismissed((prev) => {
        const n = new Set(prev)
        n.add(key)
        try {
          sessionStorage.setItem('ctrlfree.dismissed.' + tenderId, JSON.stringify([...n]))
        } catch {
          /* ignore */
        }
        return n
      })
    },
    [tenderId],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setTray(false)
        setBar((b) => !b)
      } else if (e.key === 'Escape') {
        setBar(false)
        setTray(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo(
    () => ({ tenderId, trayOpen, setTrayOpen, barOpen, openBar, closeBar, line, setLine, dismissed, dismiss }),
    [tenderId, trayOpen, setTrayOpen, barOpen, openBar, closeBar, line, dismissed, dismiss],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
