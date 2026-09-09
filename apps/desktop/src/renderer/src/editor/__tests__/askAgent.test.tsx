/**
 * Ask Claude about a selection (#5).
 *
 * The prompt is the interesting half. Its line numbers are exact because
 * CodeMirror holds the range — the affordance this is adopted from recovers them
 * by searching the source for the selected substring, which is approximate by
 * construction and simply wrong when the passage appears twice.
 */
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askAgentTooltip, promptForSelection, selectionPrompt } from '../askAgent'
import { baseEditorExtensions, mailComposerExtensions, plainTextExtensions } from '../extensions'

describe('selectionPrompt', () => {
  it('names the note and the line range, then quotes every line', () => {
    expect(selectionPrompt('projects/roadmap.md', 12, 13, 'Ship the thing.\nThen the other.')).toBe(
      '[From projects/roadmap.md, lines 12-13]\n> Ship the thing.\n> Then the other.',
    )
  })

  it('says "line 12", not "lines 12-12"', () => {
    expect(selectionPrompt('a.md', 12, 12, 'one line')).toBe('[From a.md, line 12]\n> one line')
  })

  it('quotes a blank line inside the selection rather than dropping it', () => {
    // A quote with holes in it is a different passage from the one selected.
    expect(selectionPrompt('a.md', 1, 3, 'one\n\nthree')).toBe(
      '[From a.md, lines 1-3]\n> one\n>\n> three',
    )
  })

  it('carries the path verbatim, so the agent can open what it is asked about', () => {
    expect(selectionPrompt('nøter/æøå.md', 1, 1, 'x')).toContain('[From nøter/æøå.md, line 1]')
  })
})

const stateFor = (doc: string, selection: EditorSelection, readOnly = false) =>
  EditorState.create({
    doc,
    selection,
    extensions: readOnly ? [EditorState.readOnly.of(true)] : [],
  })

describe('promptForSelection', () => {
  const DOC = 'one\ntwo\nthree\nfour'

  it('is null when nothing is selected', () => {
    expect(promptForSelection(stateFor(DOC, EditorSelection.single(2)), 'a.md')).toBeNull()
  })

  it('takes the line numbers from the range, not from a search', () => {
    // "two" also appears inside "two" only once here, but the point is that the
    // range decides: a substring search would have to guess.
    const from = DOC.indexOf('two')
    const to = DOC.indexOf('three') + 'three'.length
    const prompt = promptForSelection(stateFor(DOC, EditorSelection.single(from, to)), 'a.md')
    expect(prompt).toBe('[From a.md, lines 2-3]\n> two\n> three')
  })

  it('is right about a passage that appears twice, which is the whole point', () => {
    const doc = 'ship it\nlater\nship it'
    const second = doc.lastIndexOf('ship it')
    const prompt = promptForSelection(
      stateFor(doc, EditorSelection.single(second, second + 'ship it'.length)),
      'a.md',
    )
    expect(prompt).toBe('[From a.md, line 3]\n> ship it')
  })
})

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

function mount(doc: string, selection: EditorSelection, extensions: unknown[]): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({ doc, selection, extensions: extensions as never }),
    parent,
  })
  return view
}

const button = () => document.querySelector<HTMLButtonElement>('.cm-ask-agent button')

describe('the selection tooltip', () => {
  it('offers nothing when nothing is selected', () => {
    mount('one\ntwo', EditorSelection.single(0), [askAgentTooltip('a.md', () => {})])
    expect(button()).toBeNull()
  })

  it('offers a button over a selection', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    expect(button()).not.toBeNull()
  })

  it('hands over the finished prompt when pressed', () => {
    const onAsk = vi.fn()
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    // mousedown, not click: the tooltip is outside the content, so a plain click
    // moves focus and collapses the selection it is about to send.
    button()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(onAsk).toHaveBeenCalledWith('[From a.md, line 1]\n> one')
  })

  it('offers nothing on a locked file', () => {
    // A reconcile is resolving it. Handing that to a second conversation
    // mid-merge is the one case this must not offer.
    mount('one\ntwo', EditorSelection.single(0, 3), [
      EditorState.readOnly.of(true),
      askAgentTooltip('a.md', () => {}),
    ])
    expect(button()).toBeNull()
  })

  it('appears and disappears as the selection does', () => {
    const v = mount('one\ntwo', EditorSelection.single(0), [askAgentTooltip('a.md', () => {})])
    expect(button()).toBeNull()
    v.dispatch({ selection: EditorSelection.single(0, 3) })
    expect(button()).not.toBeNull()
    v.dispatch({ selection: EditorSelection.single(3) })
    expect(button()).toBeNull()
  })
})

describe('which stacks get it', () => {
  const deps = {
    docExists: () => true,
    taskByPath: () => null,
    readNote: async () => null,
    mentionData: () => ({ notes: [], tasks: [] }),
    nav: () => ({ openNote: () => {}, openExternal: () => {} }),
    notePath: 'note.md',
    askAgent: () => {},
  }

  it('the notes editor does', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), baseEditorExtensions(deps))
    expect(button()).not.toBeNull()
  })

  it('the mail composer does not — it knows nothing about a vault', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), mailComposerExtensions())
    expect(button()).toBeNull()
  })

  it('the plain editor does not — a .json is not a note', () => {
    mount('{"a":1}', EditorSelection.single(0, 3), plainTextExtensions('data.json'))
    expect(button()).toBeNull()
  })
})
