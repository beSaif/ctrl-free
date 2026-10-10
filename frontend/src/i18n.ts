// EN | DE. English strings are the keys; DE holds the German UI text. Tender text (German)
// is shown as-is in both languages. The choice is persisted in localStorage.
import { useCallback, useSyncExternalStore } from 'react'
import { DE } from './i18n.de'

export type Lang = 'en' | 'de'
export type Vars = Record<string, string | number>
export type T = (s: string, vars?: Vars) => string

const KEY = 'ctrlfree.lang'

function readLang(): Lang {
  try {
    return localStorage.getItem(KEY) === 'de' ? 'de' : 'en'
  } catch {
    return 'en'
  }
}

let lang: Lang = readLang()
const listeners = new Set<() => void>()
if (typeof document !== 'undefined') document.documentElement.lang = lang

export function setLang(l: Lang) {
  lang = l
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* private mode: keep in memory */
  }
  if (typeof document !== 'undefined') document.documentElement.lang = l
  listeners.forEach((f) => f())
}

export function getLang(): Lang {
  return lang
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getLang,
    getLang,
  )
}

export function translate(l: Lang, s: string, vars?: Vars): string {
  let out = l === 'de' ? (DE[s] ?? s) : s
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
  return out
}

export function useT(): T {
  const l = useLang()
  return useCallback((s: string, vars?: Vars) => translate(l, s, vars), [l])
}

/** Pick the singular or plural key, then translate: plural(t, n, '{n} line', '{n} lines') */
export function plural(t: T, n: number, one: string, many: string, vars?: Vars) {
  return t(n === 1 ? one : many, { n, ...vars })
}
