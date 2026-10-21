/**
 * An app's slash commands (docs/features/vault-apps.md): the vocabulary the
 * runner document main serves, the renderer that runs it, and the check on
 * what a command answers share.
 *
 * A command is a script in the bundle that calls `holi.command(fn)`. Picked
 * from the slash menu, it is loaded in a hidden frame on the app's own
 * `holi-app:` origin, given `{ text, line, path }`, and answers with what to
 * do to the note.
 */

/** The query parameter that makes a `holi-app:` URL the runner document for
 *  one of the app's commands rather than its entry document. */
export const COMMAND_PARAM = 'command'

/** How long a command may take before it is given up on. */
export const COMMAND_TIMEOUT_MS = 10_000

/** The most text a command may put in a note. */
export const MAX_COMMAND_TEXT = 1_000_000

/** What a command is given: the selection it was typed over (or empty), the
 *  caret's line, and the note's path. */
export interface CommandInput {
  text: string
  line: string
  path: string
}

/**
 * What a command answers, checked: text that replaces the selection, text
 * inserted after it, a path or view to open, an instruction for the agent,
 * or nothing.
 */
export type CommandAction =
  { replace: string } | { insert: string } | { open: string } | { agent: string } | null

const ACTIONS = ['replace', 'insert', 'open', 'agent'] as const

const SHAPE =
  'a command answers with text, or one of { replace }, { insert }, { open }, { agent }, or nothing'

/**
 * A command's answer as an action, or an error naming what was wrong: it came
 * out of an app's code, so nothing about it is trusted. A bare string is a
 * replace; `undefined` and `null` are nothing.
 */
export function commandActionOf(value: unknown): CommandAction | { error: string } {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return checkText({ replace: value }, value)
  if (typeof value !== 'object' || Array.isArray(value)) return { error: SHAPE }
  const keys = Object.keys(value)
  const key = ACTIONS.find((a) => keys.length === 1 && keys[0] === a)
  if (key === undefined) return { error: SHAPE }
  const text = (value as Record<string, unknown>)[key]
  if (typeof text !== 'string') return { error: `${key} must be a string` }
  if ((key === 'open' || key === 'agent') && text.trim() === '') {
    return { error: `${key} must not be empty` }
  }
  return checkText({ [key]: text } as Exclude<CommandAction, null>, text)
}

function checkText(action: Exclude<CommandAction, null>, text: string) {
  return text.length > MAX_COMMAND_TEXT ? { error: 'the answer is too long' } : action
}

/** What the runner posts back to the renderer, once. */
export type CommandOutcome = { ok: true; value: unknown } | { ok: false; error: string }
