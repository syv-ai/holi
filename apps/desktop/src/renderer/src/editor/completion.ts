/**
 * The one completion popup.
 *
 * `autocompletion()` is installed in three places — the notes stack, the mail
 * composer, and settings files — and before this module each of them wore
 * CodeMirror's own chrome. They all go through `holiCompletion` now, which is
 * what makes "the popup is ours" true by construction rather than by
 * remembering to style a fourth call site later. `test/completion.test.ts`
 * fails if one appears.
 */
import { autocompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { GLYPHS, SVG_ATTRS } from './completion-icons'

/**
 * Stamped on the popup element by `tooltipClass`, and the whole reason the
 * chrome in `theme.ts` can win the cascade.
 *
 * **Measured, 2026-09-13.** Base themes all land under one generated prefix,
 * which cancels, so a rule wins on its own weight. CodeMirror writes
 * `.cm-tooltip.cm-tooltip-autocomplete > ul` at (0,2,1). The block this
 * replaced wrote `.cm-tooltip-autocomplete > ul` at (0,1,1) and therefore did
 * nothing at all: read out of the running app's stylesheets, the popup's font,
 * height, padding and selected row were every one of them CodeMirror's. A
 * third class on every selector is what stops that happening again, and
 * `test/completion.test.ts` asserts each selector carries it.
 */
export const COMPLETION_CLASS = 'cm-holi-completion'

/** Stamped on rows whose source is ours, and only those. */
export const OPTION_CLASS = 'cm-holi-option'

/** Our sources name their glyph in `type`, which CodeMirror accepts as any
 *  string. The prefix is what tells our rows from a library's. */
export const HOLI_TYPE_PREFIX = 'holi-'

/** A `Completion` with the two extra fields our renderers read. CodeMirror
 *  ignores both and carries them through untouched. */
export interface HoliCompletion extends Completion {
  /** The trailing pill: a task's due date, and nothing that the glyph already
   *  says. */
  meta?: string
  /** Drawn instead of the type glyph, for a note whose vault gave it one. */
  emoji?: string
}

export function holiOptionClass(completion: Completion): string {
  return (completion.type?.startsWith(HOLI_TYPE_PREFIX) ?? false) ? OPTION_CLASS : ''
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * The row's left glyph: the note's own emoji when its vault gave it one,
 * otherwise the glyph its `type` names. `null` for any row we do not author,
 * which leaves CodeMirror's icon showing — the table menu needs it.
 *
 * Built through `DOMParser` rather than `innerHTML`, so nothing here ever
 * parses a string as HTML into the live document.
 */
export function holiIcon(completion: Completion): Node | null {
  const { emoji } = completion as HoliCompletion
  if (emoji !== undefined && emoji !== '') {
    const span = document.createElement('span')
    span.className = 'cm-holi-icon cm-holi-emoji'
    span.textContent = emoji
    return span
  }
  const glyph = completion.type === undefined ? undefined : GLYPHS[completion.type]
  if (glyph === undefined) return null
  const parsed = new DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${glyph}</svg>`,
    'image/svg+xml',
  )
  const svg = document.createElementNS(SVG_NS, 'svg')
  for (const [name, value] of Object.entries(SVG_ATTRS)) svg.setAttribute(name, value)
  // The type rides on the element so the chrome can colour a task's glyph by
  // its status without the renderer knowing what a status looks like.
  svg.setAttribute('class', `cm-holi-icon cm-holi-icon-${completion.type}`)
  for (const child of [...parsed.documentElement.children]) svg.appendChild(child)
  return svg
}

/** The trailing pill. Only what the glyph does not already say: a task's status
 *  is drawn on the left, so this carries its due date or nothing. */
export function holiMeta(completion: Completion): Node | null {
  const { meta } = completion as HoliCompletion
  if (meta === undefined || meta === '') return null
  const span = document.createElement('span')
  span.className = 'cm-holi-meta'
  span.textContent = meta
  return span
}

/**
 * The `↵` on the selected row.
 *
 * Rendered on every row of ours and revealed by CSS, because CodeMirror moves
 * the selection by toggling `aria-selected` WITHOUT re-rendering the rows: a
 * hint rendered for the selected option only would be drawn once and then go
 * stale on the first arrow key.
 */
export function holiEnterHint(completion: Completion): Node | null {
  if (holiOptionClass(completion) === '') return null
  const span = document.createElement('span')
  span.className = 'cm-holi-enter'
  span.textContent = '↵'
  return span
}

/**
 * **`icons` stays on, and that is not an oversight.** Turning it off deletes
 * `.cm-completionIcon`, which is the element every one of
 * `codemirror-markdown-tables`' rules hangs from — its menu would silently lose
 * its look. CodeMirror keeps rendering the element and `theme.ts` hides it on
 * our rows only.
 */
export function holiCompletion(sources: CompletionSource[]): Extension {
  return autocompletion({
    override: sources,
    tooltipClass: () => COMPLETION_CLASS,
    optionClass: holiOptionClass,
    // CodeMirror's own positions: icons 20, label 50, detail 80.
    addToOptions: [
      { render: holiIcon, position: 20 },
      { render: holiMeta, position: 90 },
      { render: holiEnterHint, position: 95 },
    ],
  })
}
