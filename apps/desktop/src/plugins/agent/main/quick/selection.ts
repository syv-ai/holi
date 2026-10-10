/**
 * What was selected in the app the person was in when they pressed the quick
 * agent's hotkey (docs/features/quick-agent.md): the frontmost app's focused
 * element, its `AXSelectedText`, through the Accessibility API. It reads
 * without touching anything, in about 100 ms, through `osascript`'s
 * JavaScript (JXA), so Holi ships no native module of its own.
 *
 * An app that does not expose its selection (many Electron apps, some
 * browsers' page content) sends nothing along. Holi does not press ⌘C in it
 * to find out: a clipboard manager would keep whatever that copied.
 *
 * NOTE: no `electron` import, so this loads under vitest.
 */
import { execFile } from 'node:child_process'
import type { QuickSelection } from '../../shared/quick'

/** The most of a selection a prompt carries: a page or two, not a book. */
export const MAX_SELECTION = 20_000
/** How long one read may take before Holi goes on without it. */
const JXA_TIMEOUT_MS = 1_500

/** The frontmost app, and its focused element's selected text if it says. */
export const READ_SELECTION_JXA = `
ObjC.import('AppKit')
ObjC.import('ApplicationServices')
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication
  if (app.isNil()) return JSON.stringify({})
  const out = { app: ObjC.unwrap(app.localizedName), pid: app.processIdentifier }
  const el = $.AXUIElementCreateApplication(app.processIdentifier)
  const focused = Ref()
  if ($.AXUIElementCopyAttributeValue(el, $('AXFocusedUIElement'), focused) !== 0) return JSON.stringify(out)
  const sel = Ref()
  const err = $.AXUIElementCopyAttributeValue(ObjC.castRefToObject(focused[0]), $('AXSelectedText'), sel)
  if (err === 0) {
    const text = ObjC.unwrap(ObjC.castRefToObject(sel[0]))
    if (typeof text === 'string') out.text = text
  }
  return JSON.stringify(out)
}`

export type RunJxa = (script: string) => Promise<string>

/** `osascript -l JavaScript`, its output, or a rejection. */
export const runJxa: RunJxa = (script) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: JXA_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
    child.stdin?.end()
  })

interface Read {
  app?: string
  pid?: number
  text?: string
}

function parse(stdout: string): Read {
  try {
    const value = JSON.parse(stdout.trim()) as unknown
    return typeof value === 'object' && value !== null ? (value as Read) : {}
  } catch {
    return {}
  }
}

/** A selection fit for a prompt: trimmed of blank lines around it, capped. */
export function fitSelection(app: string, text: string): QuickSelection | null {
  const trimmed = text.replace(/^\s*\n/, '').replace(/\s+$/, '')
  if (trimmed.trim() === '') return null
  const capped =
    trimmed.length > MAX_SELECTION
      ? `${trimmed.slice(0, MAX_SELECTION)}\n[… cut at ${MAX_SELECTION} characters]`
      : trimmed
  return { app, text: capped }
}

/**
 * The selection in the frontmost app, or null: nothing selected, Holi itself
 * (`selfPid`), or a read that failed. Never rejects.
 */
export async function readSelection(
  deps: { run?: RunJxa; selfPid?: number } = {},
): Promise<QuickSelection | null> {
  const run = deps.run ?? runJxa
  const read = parse(await run(READ_SELECTION_JXA).catch(() => ''))
  if (read.pid !== undefined && read.pid === deps.selfPid) return null
  return typeof read.text === 'string' ? fitSelection(read.app ?? 'another app', read.text) : null
}
