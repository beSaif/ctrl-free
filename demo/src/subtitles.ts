import type { Line } from './data'

export type Cue = { from: number; until: number; text: string }

const MAX = 60 // 1360 px of 38 px type fits ~67 characters; keep a margin so no cue wraps

/** Splits a piece with no comma to break at into two near-equal halves at a space, so it never wraps. */
function halve(s: string): string[] {
  if (s.length <= MAX) return [s]
  const mid = s.length / 2
  let at = -1
  for (let i = 0; i < s.length; i++) if (s[i] === ' ' && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i
  return at < 0 ? [s] : [...halve(s.slice(0, at)), ...halve(s.slice(at + 1))]
}

/** Splits a line into subtitle-sized pieces at sentence ends, then at commas if still long, then at a space. */
function chunks(text: string): string[] {
  const sentences = text.split(/(?<=[.?!])\s+/)
  const out: string[] = []
  for (const s of sentences) {
    if (s.length <= MAX) {
      out.push(s)
      continue
    }
    let cur = ''
    for (const part of s.split(/(?<=,|\.\.\.)\s+/)) {
      if (cur && (cur + ' ' + part).length > MAX) {
        out.push(cur)
        cur = part
      } else cur = cur ? `${cur} ${part}` : part
    }
    if (cur) out.push(cur)
  }
  return out.flatMap(halve)
}

/** Subtitle cues, timed by each piece's share of the line's characters. */
export function cues(lines: Line[]): Cue[] {
  const all: Cue[] = []
  for (const line of lines) {
    const parts = chunks(line.text)
    const total = parts.reduce((a, p) => a + p.length, 0)
    const span = line.seconds - 0.15
    let t = line.at
    for (const p of parts) {
      const d = (span * p.length) / total
      all.push({ from: t, until: t + d, text: p.replace(/\.\.\.$/, '…').replace(/\.\.\./g, '…') })
      t += d
    }
  }
  return all
}
