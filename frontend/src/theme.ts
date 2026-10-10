// Look: the ctrl-free v4 style (default) or the Equans brand style. Colours live in CSS variables
// (index.css), so switching only sets data-theme on <html>. Persisted in localStorage; ?theme=equans
// in the URL picks it too (handy for demo links).
import { useSyncExternalStore } from 'react'

export type Theme = 'ctrlfree' | 'equans'
export const THEMES: { id: Theme; label: string }[] = [
  { id: 'ctrlfree', label: 'ctrl-free' },
  { id: 'equans', label: 'Equans' },
]

const KEY = 'ctrlfree.theme'

function readTheme(): Theme {
  try {
    const q = new URLSearchParams(window.location.search).get('theme')
    if (q === 'equans' || q === 'ctrlfree') {
      localStorage.setItem(KEY, q)
      return q
    }
    return localStorage.getItem(KEY) === 'equans' ? 'equans' : 'ctrlfree'
  } catch {
    return 'ctrlfree'
  }
}

let theme: Theme = typeof window !== 'undefined' ? readTheme() : 'ctrlfree'
const listeners = new Set<() => void>()
if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme

export function setTheme(x: Theme) {
  theme = x
  try {
    localStorage.setItem(KEY, x)
  } catch {
    /* private mode: keep in memory */
  }
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = x
  listeners.forEach((f) => f())
}

export function getTheme(): Theme {
  return theme
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getTheme,
    getTheme,
  )
}
