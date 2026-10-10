// Helpers shared by the line source popovers and the line history.
import type { T } from '../i18n'
import type { LogEntry } from '../api/types'

export const rec = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {})

/** `by` as recorded ("You" is translated, lower case inside a sentence; real names and "AI" / "Assist" are shown as given). */
export function whoLabel(by: string | undefined | null, t: T, inSentence = false) {
  if (!by) return '–'
  return by === 'You' ? t(inSentence ? 'you' : 'You') : by
}

/** Who made a change, inside a sentence: "you" for the person working now (or an unattributed change), else the name. */
export function changedBy(by: string | undefined | null, me: string | undefined, t: T): string {
  return !by || by === 'You' || by === me ? t('you') : by
}

/** The log entry that set `path` and is still in effect (log newest first; undone entries and undos skipped). */
export function lastChange(log: LogEntry[], path: string): LogEntry | undefined {
  return log.find((e) => !e.undone && e.action !== 'undo' && path in rec(e.after))
}
