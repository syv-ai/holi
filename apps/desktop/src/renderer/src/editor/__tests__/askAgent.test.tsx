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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askAgentTooltip,
  askPrompt,
  promptForSelection,
  selectionPrompt,
  type AskAgentSeam,
  type AskTarget,
} from '../askAgent'
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

/** The trigger, which is the only button until the popover is open. */
const button = () => document.querySelector<HTMLButtonElement>('.cm-ask-agent-trigger')
const field = () => document.querySelector<HTMLTextAreaElement>('.cm-ask-agent-field')

/** ⌘/Ctrl + Enter. A plain Enter is a newline, so a multi-line message cannot be
 *  sent half written. */
const sendKey = (input: HTMLTextAreaElement) =>
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))

/** mousedown, not click: the tooltip is outside the content, so a plain click
 *  moves focus and collapses the selection the message is about. */
const press = (el: HTMLElement) =>
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))

/** Where an ask went, and what the popover was told back. */
const onAsk = vi.fn<AskAgentSeam['onAsk']>()
beforeEach(() => {
  onAsk.mockReset()
  onAsk.mockResolvedValue({ ok: true })
})

/** The seam the tooltip is given: which sessions exist, which is offered first,
 *  and somewhere to send. */
const seam = (sessions: AskTarget[] = [], initial: string | 'new' = 'new'): AskAgentSeam => ({
  targets: () => ({ sessions, initial }),
  onAsk,
})

/** The target row's options, as they read. */
const targets = () =>
  [...document.querySelectorAll('.cm-ask-agent-target')].map((el) => el.textContent)
const chosen = () =>
  document.querySelector('.cm-ask-agent-target[aria-checked="true"]')?.textContent ?? null
const notice = () => document.querySelector('.cm-ask-agent-notice')?.textContent ?? ''

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
    mount('one\ntwo', EditorSelection.single(0), [askAgentTooltip('a.md', seam())])
    expect(button()).toBeNull()
  })

  it('offers a button over a selection', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    expect(button()).not.toBeNull()
    expect(button()!.textContent).toBe('Ask agent')
  })

  it('opens a field rather than sending straight away', () => {
    // The whole point of the field: a passage on its own is not an instruction.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    expect(onAsk).not.toHaveBeenCalled()
    expect(field()).not.toBeNull()
  })

  it('carries no send button — the placeholder is the only instruction', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    // A second control beside a field you are already typing in is a thing to
    // look at rather than a thing to use. The target row is the exception, and
    // it answers a question the field cannot.
    const buttons = [...document.querySelectorAll('.cm-ask-agent button')]
    expect(buttons.every((b) => b.classList.contains('cm-ask-agent-target'))).toBe(true)
    expect(field()!.placeholder).toContain('⌘↵')
  })

  it('marks the bubble as open, which is what animates', () => {
    // The first version animated the FIELD, inside a bubble that arrived
    // instantly at full size — so there was nothing to see. The class goes on at
    // the press rather than at mount, because this element is rebuilt on every
    // selection change and a mount-time animation would replay through a drag.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    const bubble = document.querySelector('.cm-ask-agent')!
    expect(bubble.classList.contains('cm-ask-agent-open')).toBe(false)
    press(button()!)
    expect(bubble.classList.contains('cm-ask-agent-open')).toBe(true)
  })

  it('grows with what is typed rather than scrolling inside a fixed box', () => {
    // jsdom lays nothing out, so the height the browser would report is stated
    // here. What is being tested is that the field takes it, and takes it again.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
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
    return {
      bubble,
      input,
      grow: (to: number) => {
        content = to
        input.dispatchEvent(new Event('input', { bubbles: true }))
      },
    }
  }

  it('holds its bottom edge still as it grows, so it does not blink', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
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
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
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
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
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
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    const input = field()!
    input.value = 'Rewrite this in one sentence'
    sendKey(input)
    expect(onAsk).toHaveBeenCalledWith(
      'Rewrite this in one sentence\n\n[From a.md, line 1]\n> one',
      'new',
    )
  })

  it('takes a plain Enter as a newline rather than as send', () => {
    // A message about a passage is often more than one line, and a bare Enter
    // would send it half written.
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    const input = field()!
    input.value = 'first line'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onAsk).not.toHaveBeenCalled()
  })

  it('sends the passage alone when the field is left empty', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    sendKey(field()!)
    expect(onAsk).toHaveBeenCalledWith('[From a.md, line 1]\n> one', 'new')
  })

  it('lets go of the passage once it is sent, which is what closes the popover', async () => {
    // The tooltip exists because the selection is not empty, so collapsing it is
    // the whole of how this closes — one mechanism rather than a second dismiss
    // path that would have to agree with the first.
    const v = mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
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
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
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
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(field()).toBeNull()
    expect(button()).not.toBeNull()
    expect(onAsk).not.toHaveBeenCalled()
  })

  it('lists the live sessions, then New session', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [
      askAgentTooltip(
        'a.md',
        seam([
          { id: 'a', name: 'Fix the merge' },
          { id: 'b', name: 'Notes' },
        ]),
      ),
    ])
    press(button()!)
    // Tab order, then the one option that is always there.
    expect(targets()).toEqual(['Fix the merge', 'Notes', 'New session'])
  })

  it('offers the tab the drawer is showing first', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [
      askAgentTooltip(
        'a.md',
        seam(
          [
            { id: 'a', name: 'Fix the merge' },
            { id: 'b', name: 'Notes' },
          ],
          'b',
        ),
      ),
    ])
    press(button()!)
    expect(chosen()).toBe('Notes')
  })

  it('falls back to New session when the offered tab has gone', () => {
    // The list is read as the popover opens, and a session can end between two
    // selections. A name pointing at nothing is worse than the honest answer.
    mount('one\ntwo', EditorSelection.single(0, 3), [
      askAgentTooltip('a.md', seam([{ id: 'a', name: 'Fix the merge' }], 'gone')),
    ])
    press(button()!)
    expect(chosen()).toBe('New session')
  })

  it('sends to the session that was picked', () => {
    mount('one\ntwo', EditorSelection.single(0, 3), [
      askAgentTooltip('a.md', seam([{ id: 'a', name: 'Fix the merge' }], 'new')),
    ])
    press(button()!)
    press(document.querySelectorAll<HTMLElement>('.cm-ask-agent-target')[0]!)
    expect(chosen()).toBe('Fix the merge')

    sendKey(field()!)
    expect(onAsk).toHaveBeenCalledWith('[From a.md, line 1]\n> one', 'a')
  })

  it('picking a target does not collapse the passage it is about', () => {
    // The row is outside the editor's content, so a plain click would move focus
    // and take the highlight — and the highlight is what this tooltip exists for.
    const v = mount('one\ntwo', EditorSelection.single(0, 3), [
      askAgentTooltip('a.md', seam([{ id: 'a', name: 'Fix the merge' }])),
    ])
    press(button()!)
    const option = document.querySelectorAll<HTMLElement>('.cm-ask-agent-target')[0]!
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    option.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(v.state.selection.main.empty).toBe(false)
  })

  it('keeps the text, and says why, when the send is refused', async () => {
    // A session that ended between being picked and being sent to. The text is
    // still in the box, and the row above it can still choose somewhere else.
    onAsk.mockResolvedValue({ ok: false, message: 'That session has ended. Pick another one.' })
    const v = mount('one\ntwo', EditorSelection.single(0, 3), [
      askAgentTooltip('a.md', seam([{ id: 'a', name: 'Fix the merge' }], 'a')),
    ])
    press(button()!)
    const input = field()!
    input.value = 'Tighten this'
    sendKey(input)

    await waitFor(() => expect(notice()).toBe('That session has ended. Pick another one.'))
    expect(field()!.value).toBe('Tighten this')
    expect(v.state.selection.main.empty).toBe(false)
  })

  it('can be sent again after a refusal', async () => {
    onAsk.mockResolvedValueOnce({ ok: false, message: 'That session has ended.' })
    mount('one\ntwo', EditorSelection.single(0, 3), [
      askAgentTooltip('a.md', seam([{ id: 'a', name: 'Fix the merge' }], 'a')),
    ])
    press(button()!)
    sendKey(field()!)
    await waitFor(() => expect(notice()).not.toBe(''))

    press(document.querySelectorAll<HTMLElement>('.cm-ask-agent-target')[1]!) // New session
    sendKey(field()!)
    await waitFor(() => expect(onAsk).toHaveBeenCalledTimes(2))
    expect(onAsk).toHaveBeenLastCalledWith('[From a.md, line 1]\n> one', 'new')
  })

  it('does not reach back into the editor when the send lands after it has gone', async () => {
    // The send is a round trip now, and a spawn is long enough to select
    // something else meanwhile. Left unguarded, the fade would be armed on a
    // destroyed tooltip and, a fifth of a second later, collapse whatever is
    // selected by then and take focus back into the editor.
    let settle: (r: { ok: boolean }) => void = () => {}
    onAsk.mockImplementation(() => new Promise((res) => (settle = res)))
    const v = mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    sendKey(field()!)

    // A different passage: the tooltip is rebuilt, so the one that sent is gone.
    v.dispatch({ selection: EditorSelection.single(4, 7) })
    settle({ ok: true })

    await new Promise((res) => setTimeout(res, 250))
    expect(v.state.selection.main.empty).toBe(false)
    expect(v.state.selection.main.from).toBe(4)
  })

  it('says nothing about a refusal that arrives after Escape', async () => {
    // Escape put the trigger back. There is no box left to keep the text in and
    // no popover to say why, so the answer is to write to neither.
    let settle: (r: { ok: boolean; message?: string }) => void = () => {}
    onAsk.mockImplementation(() => new Promise((res) => (settle = res)))
    mount('one\ntwo', EditorSelection.single(0, 3), [askAgentTooltip('a.md', seam())])
    press(button()!)
    const input = field()!
    sendKey(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    settle({ ok: false, message: 'That session has ended.' })
    await new Promise((res) => setTimeout(res, 20))
    expect(notice()).toBe('')
    expect(button()).not.toBeNull()
  })

  it('offers nothing on a locked file', () => {
    // A reconcile is resolving it. Handing that to a second conversation
    // mid-merge is the one case this must not offer.
    mount('one\ntwo', EditorSelection.single(0, 3), [
      EditorState.readOnly.of(true),
      askAgentTooltip('a.md', seam()),
    ])
    expect(button()).toBeNull()
  })

  it('appears and disappears as the selection does', () => {
    const v = mount('one\ntwo', EditorSelection.single(0), [askAgentTooltip('a.md', seam())])
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
    askAgent: seam(),
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
