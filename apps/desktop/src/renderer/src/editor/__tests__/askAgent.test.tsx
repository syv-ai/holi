/**
 * Ask the agent about a selection (#5).
 *
 * The prompt is the interesting half. Its line numbers are exact because
 * CodeMirror holds the range — the affordance this is adopted from recovers them
 * by searching the source for the selected substring, which is approximate by
 * construction and simply wrong when the passage appears twice.
 */
import { waitFor } from '@/test/render'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askAgentTooltip, askPrompt, promptForSelection, selectionPrompt } from '../askAgent'
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

/** The trigger, which is the only button until the form is open. */
const button = () =>
  document.querySelector<HTMLButtonElement>('.cm-ask-agent button:not(.cm-ask-agent-send)')
const field = () => document.querySelector<HTMLTextAreaElement>('.cm-ask-agent-field')

/** ⌘/Ctrl + Enter. A plain Enter is a newline, so a multi-line message cannot be
 *  sent half written. */
const sendKey = (input: HTMLTextAreaElement) =>
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))

/** mousedown, not click: the tooltip is outside the content, so a plain click
 *  moves focus and collapses the selection the message is about. */
const press = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

describe('askPrompt', () => {
  const QUOTE = '[From a.md, line 1]\n> one'

  it('puts the instruction first and the passage under it', () => {
    // The instruction is the sentence to act on; a quote reads as context for
    // what precedes it.
    expect(askPrompt('Tighten this', QUOTE)).toBe(`Tighten this\n\n${QUOTE}`)
  })

  it('sends the passage alone when nothing was typed', () => {
    // What the button did before it grew a field, and "look at this" is a real
    // thing to want to say.
    expect(askPrompt('', QUOTE)).toBe(QUOTE)
    expect(askPrompt('   \n  ', QUOTE)).toBe(QUOTE)
  })

  it('does not carry the field’s stray whitespace into the message', () => {
    expect(askPrompt('  Tighten this\n', QUOTE)).toBe(`Tighten this\n\n${QUOTE}`)
  })
})

describe('the selection tooltip', () => {
  it('offers nothing when nothing is selected', () => {
    mount('one\ntwo', EditorSelection.single(0), [askAgentTooltip('a.md', () => {})])
    expect(button()).toBeNull()
  })

  it('offers a button over a selection', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    expect(button()).not.toBeNull()
    expect(button()!.textContent).toBe('Ask agent')
  })

  it('opens a field rather than sending straight away', () => {
    // The whole point of the field: a passage on its own is not an instruction.
    const onAsk = vi.fn()
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    press(button()!)
    expect(onAsk).not.toHaveBeenCalled()
    expect(field()).not.toBeNull()
  })

  it('is a field and nothing else — the placeholder is the only instruction', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    press(button()!)
    // No send button: a second control beside a field you are already typing in
    // is a thing to look at rather than a thing to use.
    expect(document.querySelectorAll('.cm-ask-agent button')).toHaveLength(0)
    expect(field()!.placeholder).toContain('⌘↵')
  })

  it('marks the bubble as open, which is what animates', () => {
    // The first version animated the FIELD, inside a bubble that arrived
    // instantly at full size — so there was nothing to see. The class goes on at
    // the press rather than at mount, because this element is rebuilt on every
    // selection change and a mount-time animation would replay through a drag.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    const bubble = document.querySelector('.cm-ask-agent')!
    expect(bubble.classList.contains('cm-ask-agent-open')).toBe(false)
    press(button()!)
    expect(bubble.classList.contains('cm-ask-agent-open')).toBe(true)
  })

  it('grows with what is typed rather than scrolling inside a fixed box', () => {
    // jsdom lays nothing out, so the height the browser would report is stated
    // here. What is being tested is that the field takes it, and takes it again.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    press(button()!)
    const input = field()!
    let content = 40
    Object.defineProperty(input, 'scrollHeight', { get: () => content })

    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input.style.height).toBe('40px')

    content = 160
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input.style.height).toBe('160px')

    // And back down: `height: auto` before measuring is what lets a message cut
    // short lose the height of its longest draft.
    content = 60
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input.style.height).toBe('60px')
  })

  /**
   * The blink he reported: a newline made the bubble flash down over the passage
   * and jump back up.
   *
   * CodeMirror places the tooltip with an inline `top` and only corrects it on
   * its next measure, a frame later, so a taller bubble grows downward first.
   * jsdom lays nothing out, so the two heights are stated here; what is being
   * tested is that the growth is taken off `top` in the same tick.
   */
  const growable = () => {
    const bubble = document.querySelector<HTMLElement>('.cm-ask-agent')!
    const input = field()!
    input.style.height = '40px'
    let content = 40
    Object.defineProperty(input, 'scrollHeight', { get: () => content })
    Object.defineProperty(bubble, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: parseFloat(input.style.height) || 0 }) as DOMRect,
    })
    return { bubble, input, grow: (to: number) => {
      content = to
      input.dispatchEvent(new Event('input', { bubbles: true }))
    } }
  }

  it('holds its bottom edge still as it grows, so it does not blink', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    press(button()!)
    const { bubble, grow } = growable()
    bubble.classList.add('cm-tooltip-above')
    bubble.style.top = '300px'
    grow(100) // 60px taller
    expect(bubble.style.top).toBe('240px')
  })

  it('lets it grow downward when the bubble is below the passage', () => {
    // CodeMirror flips it when there is no room above, and then growing down is
    // the correct direction. Compensating anyway would walk it up the screen.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    press(button()!)
    const { bubble, grow } = growable()
    bubble.classList.add('cm-tooltip-below')
    bubble.style.top = '300px'
    grow(100)
    expect(bubble.style.top).toBe('300px')
  })

  it('scrolls only once it has nowhere left to grow', () => {
    // The app paints its own scrollbars, so Chromium gives up overlay ones and a
    // box that is scrollable by a fraction of a pixel shows a permanent track.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', () => {})])
    press(button()!)
    const input = field()!
    input.style.maxHeight = '100px'
    let content = 40
    Object.defineProperty(input, 'scrollHeight', { get: () => content })

    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input.style.height).toBe('40px')
    expect(input.style.overflowY).toBe('hidden')

    content = 300
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input.style.height).toBe('100px')
    expect(input.style.overflowY).toBe('auto')

    // And back: shrinking below the cap takes the bar away again.
    content = 60
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(input.style.height).toBe('60px')
    expect(input.style.overflowY).toBe('hidden')
  })

  it('sends what was typed, above the passage', () => {
    const onAsk = vi.fn()
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    press(button()!)
    const input = field()!
    input.value = 'Rewrite this in one sentence'
    sendKey(input)
    expect(onAsk).toHaveBeenCalledWith(
      'Rewrite this in one sentence\n\n[From a.md, line 1]\n> one',
    )
  })

  it('takes a plain Enter as a newline rather than as send', () => {
    // A message about a passage is often more than one line, and a bare Enter
    // would send it half written.
    const onAsk = vi.fn()
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    press(button()!)
    const input = field()!
    input.value = 'first line'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onAsk).not.toHaveBeenCalled()
  })

  it('sends the passage alone when the field is left empty', () => {
    const onAsk = vi.fn()
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    press(button()!)
    sendKey(field()!)
    expect(onAsk).toHaveBeenCalledWith('[From a.md, line 1]\n> one')
  })

  it('lets go of the passage once it is sent, which is what closes the popover', async () => {
    // The tooltip exists because the selection is not empty, so collapsing it is
    // the whole of how this closes — one mechanism rather than a second dismiss
    // path that would have to agree with the first.
    const onAsk = vi.fn()
    const v = mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    press(button()!)
    sendKey(field()!)
    expect(v.state.selection.main.empty).toBe(false) // still selected while it fades
    await waitFor(() => expect(v.state.selection.main.empty).toBe(true))
    expect(v.state.selection.main.head).toBe(3) // the caret lands after the passage
    expect(field()).toBeNull()
    expect(button()).toBeNull()
  })

  it('sends once however many times the key is pressed', async () => {
    // The passage is still selected during the fade, so the field is still there
    // to type into.
    const onAsk = vi.fn()
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    press(button()!)
    const input = field()!
    sendKey(input)
    sendKey(input)
    sendKey(input)
    expect(onAsk).toHaveBeenCalledTimes(1)
  })

  it('Escape goes back to the button, not out of the editor', () => {
    // Escape here means "not this", not "stop selecting" — the selection is
    // still what the tooltip is anchored to.
    const onAsk = vi.fn()
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', onAsk)])
    press(button()!)
    field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(field()).toBeNull()
    expect(button()).not.toBeNull()
    expect(onAsk).not.toHaveBeenCalled()
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
