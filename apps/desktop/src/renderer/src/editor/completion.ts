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
  })
}
