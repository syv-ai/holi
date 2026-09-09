/**
 * A ```mermaid fence draws as a diagram, and shows its source when the caret is
 * in it (#6).
 *
 * The two things worth testing are both about what happens around the render
 * rather than about the render: that a widget which cannot render degrades to
 * the source the way a broken image degrades to alt text, and that `eq` is tight
 * enough that live preview's rebuild — which fires on every arrow key — does not
 * re-run mermaid.
 */
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import type { DecorationSet } from '@codemirror/view'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MermaidWidget, resetMermaidForTests } from '../mermaidWidget'
import { buildDecorations } from '../livePreview'
import { mermaidDecorations } from '../mermaid'

const render = vi.fn()
const initialize = vi.fn()

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initialize(...args),
    render: (id: string, source: string) => render(id, source),
  },
}))

beforeEach(() => {
  render.mockReset()
  initialize.mockReset()
  resetMermaidForTests()
})

/** Let the widget's `import()` and the mocked render both settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('MermaidWidget', () => {
  it('returns an element synchronously, before mermaid has resolved', () => {
    render.mockReturnValue(new Promise(() => {}))
    const dom = new MermaidWidget('graph TD; A-->B').toDOM()
    expect(dom).toBeInstanceOf(HTMLElement)
    // The source is what is on screen until the diagram arrives, so a slow
    // render never blanks the line.
    expect(dom.textContent).toContain('graph TD')
  })

  it('swaps in the SVG when the render resolves', async () => {
    render.mockResolvedValue({ svg: '<svg id="drawn"></svg>' })
    const dom = new MermaidWidget('graph TD; A-->B').toDOM()
    document.body.appendChild(dom)
    await settle()
    expect(dom.querySelector('#drawn')).not.toBeNull()
    dom.remove()
  })

  it('leaves the source visible when mermaid throws', async () => {
    // A diagram being wrong is an ordinary state of a document being written,
    // not an error state. It degrades the way a broken image does.
    render.mockRejectedValue(new Error('Parse error on line 2'))
    const dom = new MermaidWidget('graph TD; !!!').toDOM()
    document.body.appendChild(dom)
    await settle()
    expect(dom.textContent).toContain('graph TD; !!!')
    expect(dom.querySelector('svg')).toBeNull()
    dom.remove()
  })

  it('does not write into a widget that was destroyed while it rendered', async () => {
    // live preview rebuilds on every selection change, so a widget is routinely
    // gone before its render lands. Writing into a detached node is wasted work
    // at best and a leak at worst.
    let resolve: (v: { svg: string }) => void = () => {}
    render.mockReturnValue(new Promise((r) => (resolve = r)))
    const widget = new MermaidWidget('graph TD; A-->B')
    const dom = widget.toDOM()
    document.body.appendChild(dom)
    dom.remove()
    resolve({ svg: '<svg id="late"></svg>' })
    await settle()
    expect(dom.querySelector('#late')).toBeNull()
  })

  it('compares by source and by nothing else', () => {
    expect(new MermaidWidget('a').eq(new MermaidWidget('a'))).toBe(true)
    expect(new MermaidWidget('a').eq(new MermaidWidget('b'))).toBe(false)
  })

  it('imports and initializes mermaid once, however many diagrams there are', async () => {
    render.mockResolvedValue({ svg: '<svg></svg>' })
    for (const source of ['a', 'b', 'c']) {
      const dom = new MermaidWidget(source).toDOM()
      document.body.appendChild(dom)
      await settle()
      dom.remove()
    }
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(render).toHaveBeenCalledTimes(3)
  })
})

function stateFor(doc: string, cursor = 0, extra: Extension[] = []) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdown({ base: markdownLanguage }), ...extra],
  })
  ensureSyntaxTree(state, state.doc.length, 5_000)
  return state
}

function specs(set: DecorationSet) {
  const out: { from: number; to: number; spec: Record<string, unknown> }[] = []
  const iter = set.iter()
  while (iter.value) {
    out.push({ from: iter.from, to: iter.to, spec: iter.value.spec as Record<string, unknown> })
    iter.next()
  }
  return out
}

describe('a mermaid fence in live preview', () => {
  const MERMAID = 'text\n\n```mermaid\ngraph TD; A-->B\n```\n'

  it('replaces the fence with a diagram when the caret is elsewhere', () => {
    const decos = specs(mermaidDecorations(stateFor(MERMAID, 0)))
    const widget = decos.find((d) => d.spec['widget'] instanceof MermaidWidget)
    expect(widget).toBeDefined()
    expect(widget!.spec['block']).toBe(true)
    // The fence's own lines, whole — a block replace that covers part of a line
    // makes CodeMirror throw.
    expect(widget!.from).toBe(MERMAID.indexOf('```mermaid'))
    expect(widget!.to).toBe(MERMAID.length - 1)
  })

  it('carries the body without the fence delimiters', () => {
    const decos = specs(mermaidDecorations(stateFor(MERMAID, 0)))
    const widget = decos.find((d) => d.spec['widget'] instanceof MermaidWidget)!.spec[
      'widget'
    ] as MermaidWidget
    expect(widget.source).toBe('graph TD; A-->B')
  })

  it('shows the source when the caret is inside it', () => {
    const caret = MERMAID.indexOf('graph')
    expect(specs(mermaidDecorations(stateFor(MERMAID, caret)))).toHaveLength(0)
  })

  it('shows the source when the caret rests on the closing fence, like any element', () => {
    // Edge-inclusive, the same rule D91 gave every other element.
    expect(specs(mermaidDecorations(stateFor(MERMAID, MERMAID.length - 1)))).toHaveLength(0)
  })

  it('leaves the code-line painting to live preview, which never stopped', () => {
    // The two do not negotiate: live preview paints every fence's lines, and a
    // block replace simply means those lines are not rendered.
    const decos = specs(buildDecorations(stateFor(MERMAID, 0), 0, MERMAID.length))
    expect(decos.some((d) => String(d.spec['class'] ?? '').includes('cm-code-line'))).toBe(true)
  })

  it('leaves a fence in another language alone', () => {
    const doc = 'text\n\n```python\ndef f(): pass\n```\n'
    expect(specs(mermaidDecorations(stateFor(doc, 0)))).toHaveLength(0)
  })

  it('leaves a fence still being typed alone', () => {
    // No closing line yet: there is nothing between the fences to draw, and
    // guessing at one would redraw on every keystroke.
    const doc = 'text\n\n```mermaid\n'
    expect(specs(mermaidDecorations(stateFor(doc, 0)))).toHaveLength(0)
  })

  it('leaves a fence with no info string alone', () => {
    const doc = 'text\n\n```\nplain\n```\n'
    const decos = specs(mermaidDecorations(stateFor(doc, 0)))
    expect(decos.some((d) => d.spec['widget'] instanceof MermaidWidget)).toBe(false)
  })
})
