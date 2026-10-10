/**
 * The ctrl-free walkthrough, filmed against the throwaway copy from demo/serve.sh.
 *
 *   ./serve.sh   (other terminal)   then   pnpm voice && pnpm record
 *
 * Each clip holds until its narration line (voice/lines.json + voice/manifest.json) has been spoken,
 * so run `pnpm voice` first. Every run starts from a clean slate: no tenders, no learned matches.
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { DPR, LAUNCH_ARGS, SIZE, click, cut, finish, hold, moveTo, point, prepare, roll, sleep, smoothScroll, type } from './film'

const BASE = process.env.DEMO_BASE ?? 'http://localhost:5273'
const ROOT = new URL('..', import.meta.url).pathname
const PDF = join(ROOT, '..', 'problem_statement', 'Schulhaus_Oberglatt_Hackathon_Starter_Package_v2', 'BKP_244_LV_Lueftung_260804.pdf')
const REPLY = join(ROOT, '..', 'backend', 'data', 'demo', 'supplier_reply_silencers.pdf')
const PRICES = join(ROOT, '..', 'backend', 'data', 'demo', 'equans_negotiated_prices_2026.csv')

const LEA = 'Junior'
const MARCO = 'Senior'

// --- clips last as long as their narration --------------------------------------------------------
type LineSpec = { id: string; clip: string; offset?: number }
const LINES: LineSpec[] = JSON.parse(readFileSync(join(ROOT, 'voice', 'lines.json'), 'utf8'))
const VOICE: Record<string, { seconds: number }> = JSON.parse(readFileSync(join(ROOT, 'voice', 'manifest.json'), 'utf8'))

let clip = ''
let rolledAt = 0
async function start(page: Page, name: string, who: string) {
  await roll(page, name, who)
  clip = name
  rolledAt = Date.now()
}
/** Stay on camera until this clip's lines (or only line `id`) have been spoken, plus `pad` seconds. */
async function untilSpoken(pad = 0.5, id?: string) {
  const mine = LINES.filter((l) => l.clip === clip && (!id || l.id === id))
  const end = Math.max(0, ...mine.map((l) => (l.offset ?? 0.3) + (VOICE[l.id]?.seconds ?? 0)))
  const left = (end + pad) * 1000 - (Date.now() - rolledAt)
  if (left > 0) await sleep(left)
}

// --- a clean slate -------------------------------------------------------------------------------
async function reset() {
  const api = (path: string, init?: RequestInit) => fetch(`${BASE}/api${path}`, init).then((r) => r.json())
  for (const t of (await api('/tenders')) as { id: string }[]) await api(`/tenders/${t.id}`, { method: 'DELETE' })
  for (const r of ((await api('/learned')) as { rules: { id: string }[] }).rules) await api(`/learned/${r.id}`, { method: 'DELETE' })
  for (const l of ((await api('/reference/price-lists')) as { lists: { id: string }[] }).lists) await api(`/reference/price-lists/${l.id}`, { method: 'DELETE' })
}

/** Switch person the way the app remembers it (localStorage), off camera; the next goto picks it up. */
const workAs = (page: Page, id: 'lea' | 'marco') => page.evaluate(`localStorage.setItem('ctrlfree.actor', '${id}')`)

async function main() {
  await reset()
  const browser = await chromium.launch({ args: LAUNCH_ARGS })
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: DPR })
  await prepare(ctx)
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept())

  await page.goto(`${BASE}/`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 760, 420)

  // 1. upload ------------------------------------------------------------------------------------
  await start(page, 'upload', LEA)
  await hold(1500)
  await click(page, page.getByRole('link', { name: 'New tender' }))
  await hold(900)
  const chooser = page.waitForEvent('filechooser')
  await click(page, page.getByText('Drop the tender PDF here or choose a file'))
  await (await chooser).setFiles(PDF)
  await hold(1200)
  await click(page, page.getByRole('button', { name: 'Create tender' }))
  await page.waitForURL(/\/t\/t_[^/]+$/, { timeout: 60_000 })
  await page.waitForLoadState('networkidle')
  await moveTo(page, 700, 300)
  await untilSpoken(0.3)
  const tender = page.url()

  // 2. overview ----------------------------------------------------------------------------------
  await start(page, 'overview', LEA)
  await hold(600)
  await point(page, page.getByText(/steps? left before you can submit/))
  await hold(2600)
  await point(page, page.getByText('Verified against Equans examples'))
  await untilSpoken()
  await cut()

  // 3. one line, every number traceable ----------------------------------------------------------
  await page.goto(`${tender}/lines/LV0010`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 600, 300)
  await start(page, 'trace-qty', LEA)
  await hold(2600)
  await click(page, page.getByText('Read from p. 78').first())
  await hold(1200)
  await point(page, page.getByText('Quantity read').first())
  await untilSpoken()
  await cut()
  await page.keyboard.press('Escape')
  await sleep(300)

  await start(page, 'trace-hours', LEA)
  await hold(500)
  await click(page, page.getByText('From the install rule').first())
  await hold(1500)
  await point(page, page.getByText('site efficiency').last())
  await untilSpoken()
  await cut()
  await page.keyboard.press('Escape')
  await sleep(300)

  await start(page, 'equivalent', LEA)
  await hold(600)
  await click(page, page.getByText('Tender asks').first())
  await hold(1200)
  await point(page, page.getByText('(example make)').first())
  await untilSpoken()
  await cut()

  // 4. the estimator corrects, ctrl-free learns -------------------------------------------------
  await page.goto(`${tender}/lines/LV0021`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 600, 300)
  await start(page, 'teach', LEA)
  await hold(900)
  await click(page, page.getByText('Change product').first())
  await hold(700)
  await click(page, page.getByRole('button', { name: /Search all \d+ products/ }))
  await type(page, page.getByPlaceholder('Search by name, size or product id'), 'inspection cover', { cps: 22, lead: 6 })
  await hold(700)
  await click(page, page.getByText('P-FIR-004').first())
  await hold(900)
  await click(page, page.getByRole('button', { name: 'Use this product' }))
  await page.waitForURL(/\/lines\/LV0021$/)
  await untilSpoken(0.1)

  await start(page, 'similar', LEA)
  const similar = page.getByRole('button', { name: /Apply to \d+ similar lines/ })
  await point(page, similar)
  await hold(1600)
  await click(page, similar)
  await hold(800)
  await point(page, page.getByText(/Applied to \d+ similar lines/))
  await untilSpoken()
  await cut()

  // 4b. the rule it keeps, and Equans' own prices (Reference data) ---------------------------------
  await page.goto(`${BASE}/reference?tab=learned`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 700, 500)
  await start(page, 'learned', LEA)
  await hold(900)
  await point(page, page.getByText(/Lea Meier · \d+ \w+/).first())
  await hold(1800)
  await point(page, page.getByRole('link', { name: /LV0021/ }).first())
  await hold(1500)
  await point(page, page.getByText('Applies to new tenders').first())
  await untilSpoken()
  await cut()

  await page.goto(`${BASE}/reference?tab=lists`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 900, 400)
  await start(page, 'pricelist', LEA)
  await hold(1200)
  await click(page, page.getByRole('button', { name: 'Import price list' }))
  await hold(700)
  const csv = page.waitForEvent('filechooser')
  await click(page, page.getByText('Drop the price list here or choose a file'))
  await (await csv).setFiles(PRICES)
  await hold(1200)
  await point(page, page.getByText(/^Activating it re-prices/).first())
  await hold(2600)
  await click(page, page.getByRole('button', { name: 'Save and activate' }))
  await page.getByText(/imported and on/).waitFor({ timeout: 30_000 })
  await hold(600)
  await point(page, page.getByText('compared with it off').first())
  await untilSpoken()
  await cut()

  // 5. supplier loop -----------------------------------------------------------------------------
  await page.goto(`${tender}/lines/LV0066`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 600, 300)
  await start(page, 'quote', LEA)
  await hold(1400)
  await point(page, page.getByText(/^Empty: budget price/).first())
  await hold(1200)
  const reply = page.waitForEvent('filechooser')
  await click(page, page.locator('label', { hasText: 'Choose file' }).first())
  await (await reply).setFiles(REPLY)
  const found = page.getByText('Assist found a quote for this line')
  await found.waitFor({ timeout: 30_000 })
  await point(page, found)
  await hold(2200)
  await click(page, page.getByRole('button', { name: /Fill all \d+ silencer lines/ }))
  await untilSpoken()
  await cut()

  // 5b. the tender's own rules ---------------------------------------------------------------------
  await page.goto(`${tender}/instructions`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 700, 400)
  await start(page, 'instructions', LEA)
  await hold(1500)
  await click(page, page.getByRole('tab', { name: /^Adds cost/ }).first())
  await hold(1800)
  await click(page, page.getByText('Filter', { exact: true }).first())
  await hold(1500)
  await moveTo(page, 420, 386) // the quoted sentence on the page crop
  await hold(1500)
  await point(page, page.getByText('Put in our price').first())
  await hold(1300)
  await point(page, page.getByText(/^Applies to/).first())
  const confirm = page.getByRole('button', { name: /^Confirm/ }).first()
  await untilSpoken(-1.6)
  await click(page, confirm)
  await hold(500)
  await cut()

  // 6. the price decision ------------------------------------------------------------------------
  await page.goto(`${tender}/pricing/strategy`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 600, 300)
  await start(page, 'strategy', LEA)
  await hold(1200)
  await point(page, page.getByRole('radio', { name: /^Strong/ }))
  await hold(1300)
  await click(page, page.getByRole('radio', { name: /Must win/ }))
  await hold(1500)
  await moveTo(page, 1000, 470)
  await hold(1500)
  await click(page, page.getByRole('radio', { name: /^Target/ }).first())
  await hold(1000)
  await point(page, page.getByRole('button', { name: /^Use CHF/ }))
  await untilSpoken(-0.8)
  await click(page, page.getByRole('button', { name: /^Use CHF/ }))
  await hold(300)
  await cut()

  // 7. senior review -----------------------------------------------------------------------------
  await page.waitForURL(/\/export$/)
  await page.getByText('Writing the prices into the tender').waitFor({ state: 'detached', timeout: 120_000 }).catch(() => {})
  await workAs(page, 'marco')
  await page.goto(`${tender}/changes`)
  await page.waitForLoadState('networkidle')
  await moveTo(page, 600, 300)
  await start(page, 'review', MARCO)
  await hold(1500)
  await click(page, page.getByRole('button', { name: /Lea Meier/ }).first())
  await hold(2500)
  await smoothScroll(page, 360)
  await hold(1500)
  await smoothScroll(page, -360)
  const approve = page.getByRole('button', { name: /^Approve all \d+ shown/ })
  await point(page, approve)
  await untilSpoken(-2.5)
  await click(page, approve)
  await untilSpoken()
  await cut()

  // 8. the filled tender checked against the original, held as the last frame ------------------
  await page.goto(`${tender}/pdf/78?mode=filled`) // warm the filled page off camera
  await page.waitForLoadState('networkidle')
  await page.goto(`${tender}/pdf/78`)
  await page.waitForLoadState('networkidle')
  await sleep(800)
  await moveTo(page, 1000, 300)
  await start(page, 'pdfcheck', MARCO)
  await hold(1400)
  await click(page, page.getByText('Filled', { exact: true }).first())
  await page.waitForLoadState('networkidle')
  await hold(1600)
  await click(page, page.locator('[data-pdf-line][aria-label^="LV0010,"]').first())
  await hold(900)
  await point(page, page.getByText('Selling price').first())
  await untilSpoken(0.3, 'l14')
  await cut()

  await browser.close()
  finish()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
