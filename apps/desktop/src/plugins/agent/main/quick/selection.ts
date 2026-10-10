/**
 * What was selected in the app the person was in when they pressed the quick
 * agent's hotkey (docs/features/quick-agent.md).
 *
 * Two ways, both through `osascript`'s JavaScript (JXA), so Holi ships no
 * native module of its own:
 *
 * 1. **The Accessibility API.** The frontmost app's focused element, its
 *    `AXSelectedText`. Reads without touching anything, in about 100 ms.
 * 2. **⌘C, then the clipboard put back.** Some apps (Electron ones, many
 *    browsers' page content) do not expose their selection, so Holi posts ⌘C
 *    to the app, waits for the clipboard to change, reads it, and writes back
 *    every item that was there before. Nothing changes if nothing was copied.
 *    What a file manager copies is files, which come along as their paths.
 *
 * Both need the Accessibility permission, and both must run before the panel
 * takes the keyboard: a ⌘C posted after it would go to the panel.
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

/** ⌘C to the frontmost app, the copied text, and the clipboard as it was. */
export const COPY_SELECTION_JXA = `
ObjC.import('AppKit')
ObjC.import('CoreGraphics')
function run() {
  const pb = $.NSPasteboard.generalPasteboard
  const before = pb.changeCount
  const saved = []
  const items = pb.pasteboardItems
  for (let i = 0; i < items.count; i++) {
    const item = items.objectAtIndex(i)
    const types = item.types
    const entry = []
    for (let j = 0; j < types.count; j++) {
      const type = types.objectAtIndex(j)
      const data = item.dataForType(type)
      if (!data.isNil()) entry.push([type, data])
    }
    saved.push(entry)
  }
  const source = $.CGEventSourceCreate($.kCGEventSourceStatePrivate)
  for (const down of [true, false]) {
    const key = $.CGEventCreateKeyboardEvent(source, 8, down)
    $.CGEventSetFlags(key, $.kCGEventFlagMaskCommand)
    $.CGEventPost($.kCGHIDEventTap, key)
  }
  let changed = false
  for (let k = 0; k < 40 && !changed; k++) {
    delay(0.01)
    changed = pb.changeCount !== before
  }
  if (!changed) return JSON.stringify({})
  let out = {}
  // A file copied (Finder) is its path, not its name: a path the agent can read.
  const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({}))
  const paths = []
  if (!urls.isNil()) {
    for (let i = 0; i < urls.count; i++) {
      const url = urls.objectAtIndex(i)
      if (url.isFileURL) paths.push(ObjC.unwrap(url.path))
    }
  }
  if (paths.length > 0) out = { text: paths.join('\\n') }
  else {
    const copied = pb.stringForType($.NSPasteboardTypeString)
    if (!copied.isNil()) out = { text: ObjC.unwrap(copied) }
  }
  pb.clearContents
  if (saved.length > 0) {
    const restored = $.NSMutableArray.alloc.init
    for (const entry of saved) {
      const item = $.NSPasteboardItem.alloc.init
      for (const [type, data] of entry) item.setDataForType(data, type)
      restored.addObject(item)
    }
    pb.writeObjects(restored)
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
  const first = parse(await run(READ_SELECTION_JXA).catch(() => ''))
  const app = first.app ?? 'another app'
  if (first.pid !== undefined && first.pid === deps.selfPid) return null
  // An app that answers says what is selected, nothing included: only one
  // that does not answer is asked by ⌘C.
  if (typeof first.text === 'string') return fitSelection(app, first.text)
  const copied = parse(await run(COPY_SELECTION_JXA).catch(() => ''))
  return typeof copied.text === 'string' ? fitSelection(app, copied.text) : null
}
