/**
 * The one completion popup. Every `autocompletion()` (notes stack, mail
 * composer, settings files) goes through `holiCompletion`, so the chrome is
 * ours by construction. `test/completion.test.ts` fails on a new call site.
 */
import { autocompletion, type Completion, type CompletionSource } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { GLYPHS, SVG_ATTRS } from './completion-icons'

/**
 * Stamped on the popup by `tooltipClass` so the chrome in `theme.ts` wins the
 * cascade. Base themes share one generated prefix, so a rule wins on its own
 * weight, and CodeMirror writes `.cm-tooltip.cm-tooltip-autocomplete > ul` at
 * (0,2,1). A third class on every selector beats it;
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
  /** Trailing text: a task's due date. */
  meta?: string
  /** Drawn instead of the type glyph, for a note whose vault gave it one. */
  emoji?: string
}

export function holiOptionClass(completion: Completion): string {
  return (completion.type?.startsWith(HOLI_TYPE_PREFIX) ?? false) ? OPTION_CLASS : ''
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * The row's left glyph: the note's emoji, else the glyph its `type` names.
 * `null` for rows we do not author, leaving CodeMirror's icon (the table menu
 * needs it). Built through `DOMParser`, never `innerHTML` into the document.
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
  // The type rides on the element so the chrome can colour a task by status.
  svg.setAttribute('class', `cm-holi-icon cm-holi-icon-${completion.type}`)
  for (const child of [...parsed.documentElement.children]) svg.appendChild(child)
  return svg
}

/** The trailing meta text, when there is one. */
export function holiMeta(completion: Completion): Node | null {
  const { meta } = completion as HoliCompletion
  if (meta === undefined || meta === '') return null
  const span = document.createElement('span')
  span.className = 'cm-holi-meta'
  span.textContent = meta
  return span
}

/**
 * The `↵` on the selected row. Rendered on every row and revealed by CSS:
 * CodeMirror moves the selection by toggling `aria-selected` without
 * re-rendering rows.
 */
export function holiEnterHint(completion: Completion): Node | null {
  if (holiOptionClass(completion) === '') return null
  const span = document.createElement('span')
  span.className = 'cm-holi-enter'
  span.textContent = '↵'
  return span
}

/**
 * `icons` stays on: turning it off deletes `.cm-completionIcon`, which every
 * `codemirror-markdown-tables` menu rule hangs from. `theme.ts` hides it on our
 * rows only.
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
