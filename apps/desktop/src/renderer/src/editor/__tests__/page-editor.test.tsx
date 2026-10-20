/**
 * The page editor's interactions after ReUI's `rich-text-editor-2`, in a real
 * EditorView over markdown: the format bubble, the link bubble, Space to ask
 * the agent, the line hint, the Contents block, the block keys and the export.
 */
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askAgentTooltip, type AskAgentSeam } from '../askAgent'
import { spaceAsk, spaceAskAllowed, spaceAskPrompt } from '../askSpace'
import { blockActions } from '../blockActions'
import { contentsBlock, contentsLines } from '../contents'
import { noteToHtml, noteToText, noteBody } from '../export'
import { linkBubble } from '../linkBubble'
import { alignPreview, highlightSyntax } from '../marks'
import { COMMANDS_HINT, placeholderFor, SPACE_HINT } from '../placeholder'

const md = markdown({ base: markdownLanguage, extensions: [highlightSyntax] })

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

function mount(
  doc: string,
  selection: EditorSelection | { anchor: number; head?: number },
  extensions: Extension[],
): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  view = new EditorView({
    state: EditorState.create({ doc, selection, extensions: [md, ...extensions] }),
    parent,
  })
  ensureSyntaxTree(view.state, view.state.doc.length, 1000)
  return view
}

const onAsk = vi.fn<AskAgentSeam['onAsk']>()
beforeEach(() => {
  onAsk.mockReset()
  onAsk.mockResolvedValue({ ok: true })
})
const seam: AskAgentSeam = { targets: () => ({ sessions: [], initial: 'new' }), onAsk }

const q = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector<T & HTMLElement>(sel)
const click = (el: HTMLElement | null) => {
  expect(el).not.toBeNull()
  el!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  el!.click()
}
const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

describe('the format bubble (ReUI’s bubble bar)', () => {
  const select = (doc: string, needle: string) => {
    const i = doc.indexOf(needle)
    return EditorSelection.single(i, i + needle.length)
  }

  it('carries block type, the five marks, alignment, highlight, link, then Ask agent', () => {
    mount('some text', select('some text', 'text'), [askAgentTooltip('a.md', seam)])
    const labels = [...document.querySelectorAll('.cm-format-bar [data-toolbar-item]')].map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(labels).toEqual([
      'Block type, Text',
      'Bold',
      'Italic',
      'Underline',
      'Strikethrough',
      'Inline code',
      'Alignment, Align left',
      'Highlight',
      'Link',
      null, // Ask agent: named by its text
    ])
    expect(q('.cm-ask-agent-trigger')!.textContent).toBe('Ask agent')
  })

  it('has no Ask agent without an agent, and nothing over whitespace', () => {
    mount('a   b', EditorSelection.single(1, 4), [askAgentTooltip('a.md')])
    expect(q('.cm-format-bar')).toBeNull()
    view!.dispatch({ selection: { anchor: 0, head: 5 } })
    expect(q('.cm-format-bar')).not.toBeNull()
    expect(q('.cm-ask-agent-trigger')).toBeNull()
  })

  it('a mark toggles like its key and shows pressed', () => {
    mount('some text', select('some text', 'text'), [askAgentTooltip('a.md')])
    click(q('[aria-label="Bold"]'))
    expect(view!.state.doc.toString()).toBe('some **text**')
    expect(q('[aria-label="Bold"]')!.getAttribute('aria-pressed')).toBe('true')
    click(q('[aria-label="Underline"]'))
    expect(view!.state.doc.toString()).toBe('some **<u>text</u>**')
  })

  it('turns the block into a heading from its menu', () => {
    mount('some text', select('some text', 'text'), [askAgentTooltip('a.md')])
    click(q('[aria-label="Block type, Text"]'))
    const rows = [...document.querySelectorAll('.cm-format-row')].map((r) => r.textContent)
    expect(rows).toEqual(['Text⌘⌥0', 'Heading 1⌘⌥1', 'Heading 2⌘⌥2', 'Heading 3⌘⌥3'])
    click([...document.querySelectorAll<HTMLElement>('.cm-format-row')][2]!)
    expect(view!.state.doc.toString()).toBe('## some text')
  })

  it('highlights in a colour from its swatches, and removes it', () => {
    mount('some text', select('some text', 'text'), [askAgentTooltip('a.md')])
    click(q('[aria-label="Highlight"]'))
    click(q('[aria-label="Violet highlight"]'))
    expect(view!.state.doc.toString()).toBe('some <mark data-color="violet">text</mark>')
    click(q('[aria-label="Highlight"]'))
    expect(q('[aria-label="Violet highlight"]')!.getAttribute('aria-pressed')).toBe('true')
    click(q('[aria-label="Remove highlight"]'))
    expect(view!.state.doc.toString()).toBe('some text')
  })

  it('aligns from its menu', () => {
    mount('some text', select('some text', 'text'), [askAgentTooltip('a.md')])
    click(q('[aria-label="Alignment, Align left"]'))
    click([...document.querySelectorAll<HTMLElement>('.cm-format-row')][1]!)
    expect(view!.state.doc.toString()).toBe('<div align="center">\n\nsome text\n\n</div>')
  })

  it('links from its field, refusing what is not an address', () => {
    mount('some text', select('some text', 'text'), [askAgentTooltip('a.md')])
    click(q('[aria-label="Link"]'))
    const input = q<HTMLInputElement>('.cm-format-input-field') as unknown as HTMLInputElement
    input.value = 'not a link'
    input.dispatchEvent(new Event('input'))
    key(input, { key: 'Enter' })
    expect(q('.cm-format-error')!.textContent).toBe('Enter a web address, like example.com')
    expect(view!.state.doc.toString()).toBe('some text')
    input.value = 'example.com'
    input.dispatchEvent(new Event('input'))
    key(input, { key: 'Enter' })
    expect(view!.state.doc.toString()).toBe('some [text](https://example.com)')
  })

  it('⌘K opens the link field at a bare caret, and the address becomes its own link', async () => {
    mount('x ', EditorSelection.cursor(2), [askAgentTooltip('a.md')])
    key(view!.contentDOM, { key: 'k', ctrlKey: true })
    expect(q('.cm-format-bar')).not.toBeNull()
    await vi.waitFor(() => expect(q('.cm-format-input-field')).not.toBeNull())
    const input = q('.cm-format-input-field') as unknown as HTMLInputElement
    input.value = 'a.io'
    key(input, { key: 'Enter' })
    expect(view!.state.doc.toString()).toBe('x [a.io](https://a.io)')
  })

  it('in code, the marks step aside and Ask agent stays', () => {
    const doc = '```\ncode here\n```'
    mount(doc, select(doc, 'code here'), [askAgentTooltip('a.md', seam)])
    expect(q('[aria-label="Bold"]')).toBeNull()
    expect(q('.cm-ask-agent-trigger')).not.toBeNull()
  })

  it('walks with the arrow keys, one tab stop for the bar', () => {
    mount('some text', select('some text', 'text'), [askAgentTooltip('a.md')])
    const items = [
      ...document.querySelectorAll<HTMLElement>(
        '.cm-format-bar > [data-toolbar-item], .cm-format-group > [data-toolbar-item]',
      ),
    ]
    expect(items.filter((b) => b.tabIndex === 0)).toHaveLength(1)
    items[0]!.focus()
    key(items[0]!, { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Bold')
  })
})

describe('the link bubble', () => {
  it('shows the address, Edit and Remove at a caret in a link', () => {
    const open = vi.fn()
    mount('see [docs](https://a.io) now', EditorSelection.cursor(6), [
      askAgentTooltip('a.md'),
      linkBubble(open),
    ])
    const href = q('.cm-link-bubble-href')!
    expect(href.textContent).toBe('a.io')
    click(href)
    expect(open).toHaveBeenCalledWith('https://a.io')
    click(q('.cm-link-bubble [aria-label="Remove link"]'))
    expect(view!.state.doc.toString()).toBe('see docs now')
  })

  it('Edit opens the selection bubble’s link field on the link', () => {
    mount('see [docs](https://a.io) now', EditorSelection.cursor(6), [
      askAgentTooltip('a.md'),
      linkBubble(vi.fn()),
    ])
    click(q('.cm-link-bubble [aria-label="Edit link"]'))
    const sel = view!.state.selection.main
    expect(view!.state.sliceDoc(sel.from, sel.to)).toBe('docs')
  })
})

describe('Space on an empty line asks the agent', () => {
  const state = (doc: string, at: number) =>
    EditorState.create({ doc, selection: EditorSelection.cursor(at), extensions: md })

  it('is offered on an empty line of prose, and nowhere else', () => {
    expect(spaceAskAllowed(state('a\n\n', 2))).toBe(true)
    expect(spaceAskAllowed(state('a\n', 0))).toBe(false) // a line with text
    expect(spaceAskAllowed(state('- a\n  \n- b', 4))).toBe(false) // in a list
    expect(spaceAskAllowed(state('```\n\n```', 4))).toBe(false) // in a fence
    expect(spaceAskAllowed(state('---\nx: 1\n\n---\n', 9))).toBe(false) // frontmatter
    expect(
      spaceAskAllowed(
        EditorState.create({ doc: '', extensions: [md, EditorState.readOnly.of(true)] }),
      ),
    ).toBe(false)
  })

  it('sends the instruction with the note and the line', () => {
    expect(spaceAskPrompt('notes/a.md', 7, ' Draft an intro ')).toBe(
      'Draft an intro\n\n[From notes/a.md, line 7]',
    )
  })

  it('opens a field on Space, sends on Enter to a new session', async () => {
    mount('a\n\n', EditorSelection.cursor(2), [spaceAsk('a.md', seam, () => true)])
    key(view!.contentDOM, { key: ' ' })
    const field = q<HTMLTextAreaElement>(
      '.cm-space-ask .cm-ask-agent-field',
    ) as unknown as HTMLTextAreaElement
    expect(field).not.toBeNull()
    expect(view!.state.doc.toString()).toBe('a\n\n')
    field.value = 'Write the summary'
    key(field, { key: 'Enter' })
    await vi.waitFor(() =>
      expect(onAsk).toHaveBeenCalledWith('Write the summary\n\n[From a.md, line 2]', 'new'),
    )
  })

  it('Escape closes it and types the space after all', () => {
    mount('a\n\n', EditorSelection.cursor(2), [spaceAsk('a.md', seam, () => true)])
    key(view!.contentDOM, { key: ' ' })
    key(q('.cm-space-ask .cm-ask-agent-field')!, { key: 'Escape' })
    expect(q('.cm-space-ask')).toBeNull()
    expect(view!.state.doc.toString()).toBe('a\n \n')
  })

  it('is only a space when the setting is off, or with no agent', () => {
    mount('a\n\n', EditorSelection.cursor(2), [spaceAsk('a.md', seam, () => false)])
    key(view!.contentDOM, { key: ' ' })
    expect(q('.cm-space-ask')).toBeNull()
    expect(spaceAsk('a.md', undefined, () => true)).toEqual([])
  })
})

describe('the line hint', () => {
  const at = (doc: string, pos: number, spaceAsks = false) =>
    placeholderFor(
      EditorState.create({ doc, selection: EditorSelection.cursor(pos), extensions: md }),
      spaceAsks,
    )

  it('says what an empty line can do', () => {
    expect(at('a\n\n', 2)?.text).toBe(COMMANDS_HINT)
    expect(at('a\n\n', 2, true)?.text).toBe(SPACE_HINT)
  })

  it('names an empty heading’s level, and an empty item gets the commands hint', () => {
    expect(at('## ', 3)?.text).toBe('Heading 2')
    expect(at('- ', 2, true)?.text).toBe(COMMANDS_HINT)
  })

  it('says nothing on a line with text', () => {
    expect(at('text', 4)).toBeNull()
  })
})

describe('the Contents block', () => {
  it('finds [toc] lines outside fences', () => {
    const s = EditorState.create({ doc: '[toc]\n```\n[toc]\n```\n[TOC]' })
    expect(contentsLines(s).map((l) => l.from)).toEqual([0, 20])
  })

  it('draws the headings as links that jump, and its source under the caret', () => {
    const doc = 'intro\n\n[toc]\n\n# One\n\n## Two'
    mount(doc, EditorSelection.cursor(0), [contentsBlock])
    const links = [...document.querySelectorAll<HTMLElement>('.cm-contents-link')]
    expect(links.map((l) => l.textContent)).toEqual(['One', 'Two'])
    links[1]!.click()
    expect(view!.state.selection.main.head).toBe(doc.indexOf('## Two'))
    view!.dispatch({ selection: { anchor: doc.indexOf('[toc]') + 1 } })
    expect(q('.cm-contents')).toBeNull()
  })

  it('says when there is nothing to list', () => {
    mount('[toc]\n\nno headings', EditorSelection.cursor(10), [contentsBlock])
    expect(q('.cm-contents-empty')!.textContent).toContain('No headings yet')
  })
})

describe('an aligned block', () => {
  const doc = 'above\n\n<div align="center">\n\nmid\n\n</div>'
  const lines = () =>
    [...document.querySelectorAll<HTMLElement>('.cm-line')].map((l) => l.textContent)

  it('hides its wrapper off the caret and shows it with the caret inside', () => {
    mount(doc, EditorSelection.cursor(0), [alignPreview])
    expect(lines()).toEqual(['above', '', 'mid'])
    expect(q('.cm-align-center')!.textContent).toBe('mid')
    view!.dispatch({ selection: { anchor: doc.indexOf('mid') } })
    expect(lines()).toEqual(['above', '', '<div align="center">', '', 'mid', '', '</div>'])
    expect(document.querySelectorAll('.cm-align-tag')).toHaveLength(2)
  })
})

describe('the block keys', () => {
  const press = (init: KeyboardEventInit) => key(view!.contentDOM, init)

  it('⌘D duplicates the block from a caret', () => {
    mount('one\n\ntwo', EditorSelection.cursor(1), [blockActions])
    press({ key: 'd', ctrlKey: true })
    expect(view!.state.doc.toString()).toBe('one\n\none\n\ntwo')
  })

  it('⌘D with a selection still adds the next occurrence', () => {
    mount('one one', EditorSelection.single(0, 3), [
      blockActions,
      EditorState.allowMultipleSelections.of(true),
    ])
    press({ key: 'd', ctrlKey: true })
    expect(view!.state.selection.ranges).toHaveLength(2)
    expect(view!.state.doc.toString()).toBe('one one')
  })

  it('⌘⇧↑ moves the block above its sibling', () => {
    mount('- a\n- b', EditorSelection.cursor(5), [blockActions])
    press({ key: 'ArrowUp', ctrlKey: true, shiftKey: true })
    expect(view!.state.doc.toString()).toBe('- b\n- a')
  })

  it('⌘⌥2 makes a heading, and the same key turns it back', () => {
    mount('title', EditorSelection.cursor(0), [blockActions])
    press({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true })
    expect(view!.state.doc.toString()).toBe('## title')
    press({ key: '2', code: 'Digit2', ctrlKey: true, altKey: true })
    expect(view!.state.doc.toString()).toBe('title')
  })
})

describe('export', () => {
  const note =
    '---\ntitle: x\n---\n# Plan\n\nSee [[notes/ada.md|Ada]] and ==this==.\n\n- one\n- two\n\n[toc]\n'

  it('leaves the frontmatter behind', () => {
    expect(noteBody(note).startsWith('# Plan')).toBe(true)
  })

  it('renders HTML other tools read: wiki-links by label, highlight as <mark>', () => {
    const html = noteToHtml(note)
    expect(html).toContain('<h1>Plan</h1>')
    expect(html).toContain('See Ada and <mark>this</mark>.')
    expect(html).not.toContain('[toc]')
  })

  it('writes plain text, a blank line between blocks and a line per item', () => {
    expect(noteToText(note)).toBe('Plan\n\nSee Ada and this.\n\none\ntwo')
  })
})

describe('a done task', () => {
  it('reads as done: its text muted and struck through', async () => {
    const { livePreview } = await import('../livePreview')
    mount('- [x] shipped\n- [ ] open', EditorSelection.cursor(24), [livePreview])
    const done = [...document.querySelectorAll('.cm-task-done-text')].map((e) => e.textContent)
    expect(done).toEqual(['shipped'])
  })
})
