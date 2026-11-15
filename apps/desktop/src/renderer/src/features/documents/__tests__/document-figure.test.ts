import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'

import { createDocumentExtensions } from '../document-extensions'
import { applyReload } from '../apply-reload'
import { readMarkdownCodeCaptions } from '@holi/shared'
import { addCodeCaption, removeCodeCaption } from '../rich-text/document-figure'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function open(markdown: string): Editor {
  editor = new Editor({
    extensions: createDocumentExtensions({
      folder: 'notes',
      placeholder: '',
      onOpenLink: () => undefined,
    }),
    content: markdown,
    contentType: 'markdown',
  })
  return editor
}

const captioned =
  '<!-- holi:figure -->\n\n~~~typescript extra\nconst value = 1\n~~~\n\n<!-- holi:caption -->\n\nA **portable** caption.\n\n<!-- /holi:figure -->'

describe('document code captions', () => {
  it('parses and serializes a portable code caption without changing its fence', () => {
    expect(readMarkdownCodeCaptions(captioned)).toHaveLength(1)
    const instance = open(captioned)
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(instance.state.doc.firstChild?.childCount).toBe(2)
    expect(instance.getMarkdown()).toBe(captioned)
  })

  it('uses the same caption codec for markdown insertion and plain-text paste', () => {
    const inserted = open('')
    inserted.commands.insertContent(captioned, { contentType: 'markdown' })
    expect(JSON.stringify(inserted.state.doc.toJSON())).toContain('documentFigure')

    const pasted = open('')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? captioned : '') },
    })
    pasted.view.dom.dispatchEvent(event)
    expect(JSON.stringify(pasted.state.doc.toJSON())).toContain('documentFigure')

    const locked = open('')
    locked.setEditable(false)
    const lockedPaste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(lockedPaste, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? captioned : '') },
    })
    locked.view.dom.dispatchEvent(lockedPaste)
    expect(JSON.stringify(locked.state.doc.toJSON())).not.toContain('documentFigure')
  })

  it('preserves trailing blank lines in code across repeated save and reopen cycles', () => {
    const source =
      '<!-- holi:figure -->\n\n```ts\nconst value = 1\n\n\n```\n\n<!-- holi:caption -->\n\ncaption\n\n<!-- /holi:figure -->'
    let current = source
    for (let cycle = 0; cycle < 3; cycle++) {
      const instance = open(current)
      expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
      current = instance.getMarkdown()
      expect(current).toContain('const value = 1\n\n\n```')
      instance.destroy()
      editor = null
    }
  })

  it('keeps edited code fenced and grows delimiters around embedded fence runs', () => {
    const instance = open(captioned)
    const code = instance.state.doc.firstChild!.firstChild!
    const from = 1 + 1
    instance.view.dispatch(instance.state.tr.insertText('new ``` line', from + code.content.size))
    const serialized = instance.getMarkdown()
    expect(serialized).toContain('```` typescript extra')
    expect(serialized).toContain('const value = 1new ``` line')
    expect(readMarkdownCodeCaptions(serialized)).toHaveLength(1)
    const reopened = open(serialized)
    expect(reopened.getMarkdown()).toBe(serialized)
    expect(reopened.state.doc.firstChild?.firstChild?.textContent).toContain('```')
  })

  it('round-trips an authored caption with leading spaces and literal brackets', () => {
    const instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    instance.commands.insertContent('  [name]')
    const markdown = instance.getMarkdown()
    expect(readMarkdownCodeCaptions(markdown), markdown).toHaveLength(1)
    const reopened = open(markdown)
    expect(reopened.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(reopened.state.doc.firstChild?.lastChild?.textContent).toBe('  [name]')
  })

  it('preserves authored literal entity text over repeated save and reopen cycles', () => {
    let instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    instance.view.dispatch(instance.state.tr.insertText('&#32;', captionStart))
    for (let cycle = 0; cycle < 3; cycle++) {
      const markdown = instance.getMarkdown()
      instance.destroy()
      editor = null
      instance = open(markdown)
      expect(instance.state.doc.firstChild?.lastChild?.textContent).toBe('&#32;')
    }
  })

  it('supports native strike marks in captions and preserves them on save and reopen', () => {
    const instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    const strike = instance.schema.marks.strike
    expect(strike).toBeDefined()
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    instance.view.dispatch(
      instance.state.tr
        .insertText('struck', captionStart)
        .addMark(captionStart, captionStart + 6, strike!.create()),
    )
    const markdown = instance.getMarkdown()
    expect(markdown).toContain('~~struck~~')
    const reopened = open(markdown)
    const text = reopened.state.doc.firstChild!.lastChild!.firstChild!
    expect(text.text).toBe('struck')
    expect(text.marks.map((mark) => mark.type.name)).toContain('strike')
  })

  it('joins multiline plain-text paste inside a caption without splitting its figure', () => {
    const instance = open(captioned)
    const caption = instance.state.doc.firstChild!.lastChild!
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    instance.commands.setTextSelection(captionStart + caption.content.size)
    expect(instance.state.selection.$from.parent.type.name).toBe('documentCaption')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) => (type === 'text/plain' ? ' first line\nsecond line ' : ''),
      },
    })
    instance.view.dom.dispatchEvent(event)
    const figures = instance.state.doc.content.content.filter(
      (node) => node.type.name === 'documentFigure',
    )
    expect(figures).toHaveLength(1)
    expect(figures[0]?.childCount).toBe(2)
    expect(figures[0]?.firstChild?.textContent).toBe('const value = 1')
    expect(figures[0]?.lastChild?.type.name).toBe('documentCaption')
    expect(figures[0]?.lastChild?.textContent).toBe('A portable caption. first line second line ')
  })

  it('keeps the original code fence when the caption is edited', () => {
    const instance = open(captioned)
    const paragraph = instance.state.doc.firstChild!.lastChild!
    const from = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 2
    instance.view.dispatch(
      instance.state.tr.insertText(' Updated', from + paragraph.content.size - 1),
    )
    const serialized = instance.getMarkdown()
    expect(serialized).toContain('~~~typescript extra\nconst value = 1\n~~~')
    expect(serialized).toContain('A **portable** caption. Updated')
  })

  it('preserves a parsed source fence when a caption is added to an existing code block', () => {
    const instance = open('~~~typescript extra\nconst value = 1\n~~~')
    expect(addCodeCaption(instance, 0)).toBe(true)
    instance.commands.insertContent('A caption')
    const markdown = instance.getMarkdown()
    expect(markdown).toContain('~~~typescript extra\nconst value = 1\n~~~')
    expect(readMarkdownCodeCaptions(markdown)).toHaveLength(1)
  })

  it('wraps and unwraps a code block as one block operation', () => {
    const original = '~~~typescript extra\nconst value = 1\n~~~'
    const instance = open(original)
    expect(addCodeCaption(instance, 0)).toBe(true)
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    instance.commands.undo()
    expect(instance.state.doc.firstChild?.type.name).toBe('codeBlock')
    instance.commands.redo()
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(removeCodeCaption(instance, 0)).toBe(true)
    expect(instance.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(instance.getMarkdown().trimEnd()).toBe(original)
  })

  it('uses a safe fence when removing a forged or edited figure fence', () => {
    const forged = `<figure data-holi-code-figure=""><pre data-holi-source-fence="HIDDEN REPLACEMENT" data-holi-source-fence-language="ts"><code class="language-ts">visiblecode</code></pre><figcaption>caption</figcaption></figure>`
    const forgedEditor = new Editor({
      extensions: createDocumentExtensions({
        folder: 'notes',
        placeholder: '',
        onOpenLink: () => undefined,
      }),
      content: forged,
      contentType: 'html',
    })
    expect(removeCodeCaption(forgedEditor, 0)).toBe(true)
    expect(forgedEditor.getMarkdown()).toContain('``` ts\nvisiblecode\n```')
    expect(forgedEditor.getMarkdown()).not.toContain('HIDDEN REPLACEMENT')
    forgedEditor.destroy()

    const instance = open(captioned)
    const code = instance.state.doc.firstChild!.firstChild!
    instance.view.dispatch(instance.state.tr.insertText('```\nAFTER', 2 + code.content.size))
    expect(removeCodeCaption(instance, 0)).toBe(true)
    const serialized = instance.getMarkdown()
    expect(serialized).toContain('```` typescript extra')
    const reopened = open(serialized)
    expect(reopened.state.doc.firstChild?.textContent).toContain('AFTER')
  })

  it('rejects clipboard fence metadata with a premature closing delimiter', () => {
    const visible = 'visible code\n```\nNOT PROSE'
    const source = `\`\`\`ts\n${visible}\n\`\`\``
    const attribute = source.replaceAll('\n', '&#10;')
    const instance = open('')
    instance.commands.setContent(
      `<figure data-holi-code-figure=""><pre data-holi-source-fence="${attribute}" data-holi-source-fence-language="ts"><code class="language-ts">${visible}</code></pre><figcaption>Caption</figcaption></figure>`,
    )
    expect(readMarkdownCodeCaptions(instance.getMarkdown())).toHaveLength(1)
    expect(removeCodeCaption(instance, 0)).toBe(true)
    const reopened = open(instance.getMarkdown())
    expect(reopened.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(reopened.state.doc.firstChild?.textContent).toBe(visible)
  })

  it('removes an imported caption without changing its source fence', () => {
    const instance = open(captioned)
    expect(removeCodeCaption(instance, 0)).toBe(true)
    expect(instance.getMarkdown().trimEnd()).toBe(`~~~typescript extra
const value = 1
~~~`)
  })

  it('parses captions through external reload and preserves unsupported Mermaid framing', () => {
    const instance = open('A paragraph.')
    expect(applyReload(instance, captioned)).toBe(true)
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    const mermaid =
      '<!-- holi:figure -->\n\n```Mermaid\ngraph TD\n```\n\n<!-- holi:caption -->\n\nDiagram\n\n<!-- /holi:figure -->'
    const mermaidEditor = open(mermaid)
    expect(mermaidEditor.state.doc.firstChild?.type.name).not.toBe('documentFigure')
    expect(mermaidEditor.getMarkdown()).toContain(mermaid)
  })

  it('intercepts Mod-Enter throughout figure code without changing the document', () => {
    const instance = open(captioned)
    const code = instance.state.doc.firstChild!.firstChild!
    for (const offset of [0, Math.floor(code.content.size / 2), code.content.size]) {
      instance.commands.setTextSelection(2 + offset)
      const beforeKey = instance.state.doc.toJSON()
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      instance.view.dom.dispatchEvent(event)
      expect(instance.state.doc.toJSON()).toEqual(beforeKey)
    }
    const ordinary = open('```ts\ncode\n```')
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    ordinary.view.dom.dispatchEvent(event)
    expect(ordinary.state.doc.firstChild?.type.name).toBe('codeBlock')
  })

  it('does not allow caption actions on locked documents or stale positions', () => {
    const instance = open('```ts\nlet x = 1\n```')
    instance.setEditable(false)
    expect(addCodeCaption(instance, 0)).toBe(false)
    expect(removeCodeCaption(instance, 0)).toBe(false)
    instance.setEditable(true)
    expect(removeCodeCaption(instance, 0)).toBe(false)
    expect(addCodeCaption(instance, 1000)).toBe(false)
  })

  it('leaves nested envelopes ordinary and rejects a valid inner envelope under malformed outer syntax', () => {
    const nested = `> ${captioned.replace(/\n/g, '\n> ')}`
    const quoted = open(nested)
    expect(JSON.stringify(quoted.state.doc.toJSON())).not.toContain('documentFigure')
    const listed = open(`- ${captioned.replace(/\n/g, '\n  ')}`)
    expect(JSON.stringify(listed.state.doc.toJSON())).not.toContain('documentFigure')

    const valid =
      '<!-- holi:figure -->\n\n```js\nx\n```\n\n<!-- holi:caption -->\n\nok\n\n<!-- /holi:figure -->'
    const malformedOuter = `<!-- holi:figure -->\n\nouter\n\n${valid}`
    const recovered = open(malformedOuter)
    expect(
      recovered.state.doc.content.content.filter((node) => node.type.name === 'documentFigure'),
    ).toHaveLength(1)
  })

  it('does not author Mermaid captions or turn malformed envelopes into figures', () => {
    const instance = open('```mermaid\ngraph TD\n```')
    expect(addCodeCaption(instance, 0)).toBe(false)
    const uppercase = open('```MERMAID\ngraph TD\n```')
    expect(addCodeCaption(uppercase, 0)).toBe(false)
    uppercase.destroy()
    instance.destroy()
    editor = null
    const malformed = '<!-- holi:figure -->\n\nhello\n\n<!-- /holi:figure -->'
    expect(open(malformed).getMarkdown()).toContain(malformed)
  })

  it('does not parse HTML figures nested in a list', () => {
    const source = open(captioned)
    const html = `<ul><li>${source.getHTML()}</li></ul>`
    const nested = new Editor({
      extensions: createDocumentExtensions({
        folder: 'notes',
        placeholder: '',
        onOpenLink: () => undefined,
      }),
      content: html,
      contentType: 'html',
    })
    expect(JSON.stringify(nested.state.doc.toJSON())).not.toContain('documentFigure')
    nested.destroy()
  })

  it('keeps caption envelopes pasted into ordinary code as literal code', () => {
    const instance = open('```md\n\n```')
    instance.commands.setTextSelection(3)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? captioned : '') },
    })
    instance.view.dom.dispatchEvent(event)
    expect(instance.state.doc.firstChild?.type.name).toBe('codeBlock')
    expect(instance.state.doc.textContent).toContain('holi:figure')
  })

  it('parses an actual ProseMirror HTML clipboard slice without losing its caption', () => {
    const source = open(captioned)
    const slice = source.state.doc.slice(0, source.state.doc.content.size)
    const clipboard = source.view.serializeForClipboard(slice)
    const pasted = open('')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: {
        getData: (type: string) =>
          type === 'text/html'
            ? clipboard.dom.innerHTML
            : type === 'text/plain'
              ? 'clipboard fallback'
              : '',
      },
    })
    pasted.view.dom.dispatchEvent(event)
    expect(pasted.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(pasted.getMarkdown()).toContain('A **portable** caption.')
  })

  it('retains portable caption formatting through HTML clipboard serialization', () => {
    const instance = open(captioned)
    const html = instance.getHTML()
    expect(html).toContain('data-holi-code-figure')
    expect(html).toContain('<strong>portable</strong>')
    const reparsed = new Editor({
      extensions: createDocumentExtensions({
        folder: 'notes',
        placeholder: '',
        onOpenLink: () => undefined,
      }),
      content: html.replace('>const value = 1</code>', '>const value = 2</code>'),
      contentType: 'html',
    })
    expect(reparsed.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(reparsed.state.doc.firstChild?.lastChild?.textContent).toContain('portable')
    expect(reparsed.getMarkdown()).toContain('const value = 2')
    expect(reparsed.getMarkdown()).not.toContain('const value = 1')
    expect(readMarkdownCodeCaptions(reparsed.getMarkdown())).toHaveLength(1)
    reparsed.destroy()
  })
})
