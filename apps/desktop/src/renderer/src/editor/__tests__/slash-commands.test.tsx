/**
 * A plugin's slash command answers after a wait (an app runs it), and the
 * person may keep typing meanwhile. Its `replace` must take the place of the
 * text it was given and nothing else.
 */
import { CompletionContext, type Completion } from '@codemirror/autocomplete'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { slashCommandsWith, type SlashResult } from '../slash'

let view: EditorView | null = null
afterEach(() => view?.destroy())

/** `doc` with the caret at its end and `/up` typed over the selection `from..to`,
 *  then the command picked; `answer` settles what the command answers. */
async function pick(doc: string, from: number, to: number) {
  let answer!: (r: SlashResult) => void
  const { source, extension } = slashCommandsWith(
    () => [{ name: 'up', run: () => new Promise<SlashResult>((r) => (answer = r)) }],
    'a.md',
  )
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [extension],
      selection: { anchor: from, head: to },
    }),
  })
  view.dispatch({
    changes: { from, to, insert: '/up' },
    selection: EditorSelection.cursor(from + 3),
    userEvent: 'input.type',
  })
  const result = await source(new CompletionContext(view.state, from + 3, true))
  const option = result!.options.find((o) => o.label === '/up')!
  ;(option.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(
    view,
    option,
    result!.from,
    from + 3,
  )
  return { view, answer: (r: SlashResult) => answer(r) }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe("a plugin's slash command", () => {
  it('replaces the text it was given', async () => {
    const { view, answer } = await pick('say hello there', 4, 9)
    answer({ replace: 'HELLO' })
    await settle()
    expect(view.state.doc.toString()).toBe('say HELLO there')
  })

  it('keeps what was typed into that text while it ran, and adds its answer after', async () => {
    const { view, answer } = await pick('say hello there', 4, 9)
    // The command's text is `hello`, selected at 4..9; the person edits it.
    view.dispatch({ changes: { from: 4, to: 5, insert: 'J' } })
    answer({ replace: 'HELLO' })
    await settle()
    expect(view.state.doc.toString()).toBe('say JelloHELLO there')
  })
})
