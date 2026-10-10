// Swiss number and date formatting. 439'000 and 372'700.12, 22.09.2026 10:00.
import { getLang, type Lang } from '../i18n'

const MINUS = '−'

/** "Today" for the app. VITE_TODAY (e.g. 2026-09-10) pins the calendar day for demos; the time of day stays real. */
export function now(): Date {
  const pinned = import.meta.env.VITE_TODAY as string | undefined
  const real = new Date()
  if (!pinned) return real
  const [y, m, d] = pinned.split('-').map(Number)
  if (!y || !m || !d) return real
  return new Date(y, m - 1, d, real.getHours(), real.getMinutes(), real.getSeconds())
}

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 439'000 / 372'700.12. Negative numbers use a real minus sign. */
export function fmtNum(n: number | null | undefined, decimals = 0): string {
  if (!isNum(n)) return '–'
  const neg = n < 0 && Math.abs(n) >= 0.5 * Math.pow(10, -decimals)
  const parts = Math.abs(n).toFixed(decimals).split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "'")
  return (neg ? MINUS : '') + parts.join('.')
}

export const fmt2 = (n: number | null | undefined) => fmtNum(n, 2)
export const fmt0 = (n: number | null | undefined) => fmtNum(n, 0)

/** +1'040.00 / −1'040.00 */
export function fmtSigned(n: number, decimals = 2): string {
  if (Math.abs(n) < 0.5 * Math.pow(10, -decimals)) return fmtNum(0, decimals)
  return (n > 0 ? '+' : MINUS) + fmtNum(Math.abs(n), decimals)
}

/** Quantities: no trailing zeros (5, 12.5, 440). */
export function fmtQty(n: number | null | undefined): string {
  if (!isNum(n)) return '–'
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? fmtNum(r, 0) : fmtNum(r, r * 10 === Math.round(r * 10) ? 1 : 2)
}

export function fmtPct(n: number | null | undefined, decimals = 1): string {
  if (!isNum(n)) return '–'
  return n.toFixed(decimals) + '%'
}

/** Win chance etc. 0.63 -> 63% */
export function fmtShare(n: number | null | undefined): string {
  if (!isNum(n)) return '–'
  return Math.round(n * 100) + '%'
}

const pad = (n: number) => String(n).padStart(2, '0')

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 22.09.2026 10:00 */
export function fmtDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso)
  if (!d) return '–'
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 22.09.2026 */
export function fmtDate(iso: string | null | undefined): string {
  const d = parseDate(iso)
  if (!d) return '–'
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_DE = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.']

/** 10 Sep / 10. Sept. */
export function fmtShortDate(iso: string | null | undefined, lang: Lang): string {
  const d = parseDate(iso)
  if (!d) return '–'
  return lang === 'de' ? `${d.getDate()}. ${MONTHS_DE[d.getMonth()]}` : `${d.getDate()} ${MONTHS_EN[d.getMonth()]}`
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function daysUntil(iso: string | null | undefined): number | null {
  const d = parseDate(iso)
  if (!d) return null
  return Math.round((startOfDay(d) - startOfDay(now())) / 86400000)
}

/** "12 days left" / "noch 12 Tage" */
export function fmtDaysLeft(iso: string | null | undefined, lang: Lang): string {
  const n = daysUntil(iso)
  if (n === null) return lang === 'de' ? 'Frist unbekannt' : 'due date unknown'
  if (lang === 'de') {
    if (n > 1) return `noch ${n} Tage`
    if (n === 1) return 'noch 1 Tag'
    if (n === 0) return 'heute fällig'
    return n === -1 ? 'seit 1 Tag abgelaufen' : `seit ${-n} Tagen abgelaufen`
  }
  if (n > 1) return `${n} days left`
  if (n === 1) return '1 day left'
  if (n === 0) return 'due today'
  return n === -1 ? 'closed 1 day ago' : `closed ${-n} days ago`
}

/** "just now", "5 min ago", "10 Sep" */
export function fmtUpdated(iso: string | null | undefined, lang: Lang): string {
  const d = parseDate(iso)
  if (!d) return '–'
  const mins = (Date.now() - d.getTime()) / 60000
  if (mins < 2) return lang === 'de' ? 'gerade eben' : 'just now'
  if (mins < 60) return lang === 'de' ? `vor ${Math.floor(mins)} Min.` : `${Math.floor(mins)} min ago`
  if (startOfDay(d) === startOfDay(new Date())) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return fmtShortDate(iso, lang)
}

export function fmtBytes(n: number | null | undefined): string {
  if (!isNum(n)) return ''
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/** Parse a user-typed number, accepting 1'234.50, 1 234,50 and 1234.5. Returns null when empty/invalid. */
export function parseNum(s: string): number | null {
  const t = s.trim().replace(/['’\s]/g, '').replace(',', '.')
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** Display unit for a position. Normalises m2 -> m². */
export function fmtUnit(u: string | null | undefined): string {
  if (!u) return ''
  if (getLang() === 'de' && u === 'pc') return 'Stk'
  if (u === 'm2') return 'm²'
  if (u === 'm3') return 'm³'
  return u
}

/** German unit as in the tender (Stk, m2). */
export function deUnit(u: string | null | undefined): string {
  if (!u) return ''
  if (u === 'pc') return 'Stk'
  if (u === 'm²' || u === 'm2') return 'm2'
  if (u === 'LS') return 'psch'
  return u
}

/** BKP 244 Lüftungsanlagen -> BKP 244 Lüftung (short form used in lists). */
export function shortTrade(trade: string): string {
  return trade.replace(/s?anlagen$/, '')
}

/** Label for an English rendering of tender text: honest about the word-by-word glossary fallback. */
export function translationLabel(method: string | null | undefined): string {
  return method === 'glossary' ? 'Rough word-by-word translation' : 'Machine translation'
}
