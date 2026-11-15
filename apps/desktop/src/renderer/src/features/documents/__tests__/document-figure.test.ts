import { Editor } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'

import { createDocumentExtensions } from '../document-extensions'
import { applyReload } from '../apply-reload'
import { readMarkdownCodeCaptions } from '@holi/shared'
import { addCodeCaption, addImageCaption, removeCodeCaption } from '../rich-text/document-figure'
import { blockTargetAtPos, duplicateBlock } from '../rich-text/rich-text-block-actions'

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
  it('adds and removes a caption with the complete image block', () => {
    const source = '![A cat](../assets/cat.png "A cat")'
    const instance = open(source)
    let imagePos = -1
    instance.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') imagePos = pos
    })
    expect(imagePos).toBeGreaterThanOrEqual(0)
    expect(addImageCaption(instance, imagePos)).toBe(true)
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(instance.getMarkdown()).toContain(source)
    expect(removeCodeCaption(instance, 0)).toBe(true)
    let remainingImages = 0
    instance.state.doc.descendants((node) => {
      if (node.type.name === 'image') remainingImages++
    })
    expect(remainingImages).toBe(1)
    expect(instance.getMarkdown()).toContain(source)
  })
  it('parses and serializes a portable code caption without changing its fence', () => {
    expect(readMarkdownCodeCaptions(captioned)).toHaveLength(1)
    const instance = open(captioned)
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(instance.state.doc.firstChild?.childCount).toBe(2)
    expect(instance.getMarkdown()).toBe(captioned)
  })

  it('opens and saves image captions with inline syntax and document-wide reference definitions', () => {
    const cases = [
      ['![A cat](../assets/cat%20one.png "Title")', '![A cat](../assets/cat%20one.png "Title")'],
      ['![A cat][cat]', '![A cat][cat]'],
      ['![cat][]', '![cat][]'],
      ['![cat]', '![cat]'],
    ] as const
    for (const [body, expected] of cases) {
      const definitions = body.includes('(') ? '' : '\n\n[cat]: ../assets/cat.png "Title"'
      const source = `<!-- holi:figure -->\n\n${body}\n\n<!-- holi:caption -->\n\nA **bold** and _italic_ [label](https://example.com/a).\n\n<!-- /holi:figure -->${definitions}`
      const instance = open(source)
      expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
      expect(instance.state.doc.firstChild?.firstChild?.type.name).toBe('image')
      expect(instance.state.doc.firstChild?.firstChild?.attrs.src).toContain('cat')
      const saved = instance.getMarkdown()
      expect(saved).toContain(expected)
      expect(saved).toContain('A **bold** and *italic* [label](https://example.com/a).')
      const reopened = open(saved)
      expect(reopened.state.doc.firstChild?.type.name, saved).toBe('documentFigure')
      expect(reopened.state.doc.firstChild?.lastChild?.textContent).toBe('A bold and italic label.')
      expect(reopened.getMarkdown().trimEnd()).toBe(saved.trimEnd())
      reopened.destroy()
      instance.destroy()
      editor = null
    }
  })

  it('adds captions to reference images without replacing reference syntax or definitions', () => {
    const source = '  ![Photo][photo]\n\n[photo]: ../assets/photo%20one.png "Photo title"'
    const instance = open(source)
    expect(instance.state.doc.firstChild?.type.name).toBe('image')
    expect(instance.state.doc.firstChild?.attrs.sourceMarkdown).toBe('  ![Photo][photo]')
    expect(addImageCaption(instance, 0)).toBe(true)
    instance.commands.insertContent('Photo caption')
    const saved = instance.getMarkdown()
    expect(saved).toContain('  ![Photo][photo]')
    expect(saved).toContain('[photo]: ../assets/photo%20one.png "Photo title"')
    const reopened = open(saved)
    expect(reopened.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(reopened.state.doc.firstChild?.firstChild?.attrs.src).toContain('photo%20one.png')
  })

  it('adds and removes captions for remote images without rebuilding their visible attrs', () => {
    const instance = open('![A cat](https://example.com/cat.png "remote title")')
    const image = instance.state.doc.firstChild!
    expect(image.type.name).toBe('image')
    const imagePos = 0
    expect(addImageCaption(instance, imagePos)).toBe(true)
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(instance.state.doc.firstChild?.firstChild?.attrs).toMatchObject({
      src: 'https://example.com/cat.png',
      alt: 'A cat',
      title: 'remote title',
    })
    expect(instance.getMarkdown()).toContain('![A cat](https://example.com/cat.png "remote title")')
    instance.commands.undo()
    expect(instance.state.doc.firstChild?.type.name).toBe('image')
    instance.commands.redo()
    expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(removeCodeCaption(instance, 0)).toBe(true)
    expect(instance.state.doc.firstChild?.type.name).toBe('image')
  })

  it('keeps an image and its caption together through duplicate, undo, redo, delete, and clipboard paste', () => {
    const source =
      '<!-- holi:figure -->\n\n![cat](../assets/cat.png)\n\n<!-- holi:caption -->\n\nA **cat**\n\n<!-- /holi:figure -->'
    const instance = open(source)
    const target = blockTargetAtPos(instance.state.doc, 0)!
    instance.view.dispatch(duplicateBlock(instance.state, target)!)
    expect(
      instance.state.doc.content.content.filter((node) => node.type.name === 'documentFigure'),
    ).toHaveLength(2)
    const images: string[] = []
    const captions: string[] = []
    instance.state.doc.descendants((node) => {
      if (node.type.name === 'image') images.push(node.type.name)
      if (node.type.name === 'documentCaption') captions.push(node.type.name)
    })
    expect(images).toHaveLength(2)
    expect(captions).toHaveLength(2)
    instance.commands.undo()
    expect(
      instance.state.doc.content.content.filter((node) => node.type.name === 'documentFigure'),
    ).toHaveLength(1)
    instance.commands.redo()
    expect(
      instance.state.doc.content.content.filter((node) => node.type.name === 'documentFigure'),
    ).toHaveLength(2)
    const slice = instance.state.doc.slice(0, instance.state.doc.firstChild!.nodeSize)
    const clipboard = instance.view.serializeForClipboard(slice)
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
    expect(pasted.state.doc.firstChild?.childCount).toBe(2)
    expect(pasted.getMarkdown()).toContain('A **cat**')
    expect(pasted.getMarkdown()).toContain('![cat](../assets/cat.png)')
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, 1)),
    )
    instance.view.dom.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }))
    expect(instance.state.selection).toBeInstanceOf(NodeSelection)
    expect((instance.state.selection as NodeSelection).node.type.name).toBe('documentFigure')
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, 1)),
    )
    expect((instance.state.selection as NodeSelection).node.type.name).toBe('image')
    expect(instance.commands.deleteSelection()).toBe(true)
    expect(
      instance.state.doc.content.content.filter((node) => node.type.name === 'documentFigure'),
    ).toHaveLength(1)
    const remainingCaptions: string[] = []
    instance.state.doc.descendants((node) => {
      if (node.type.name === 'documentCaption') remainingCaptions.push(node.textContent)
    })
    expect(remainingCaptions).toEqual(['A cat'])
    expect(removeCodeCaption(instance, 0)).toBe(true)
    expect(instance.state.doc.firstChild?.type.name).toBe('image')
  })

  it('leaves empty and malformed image captions as their original image source', () => {
    const empty = open('![empty](../assets/empty.png)')
    expect(addImageCaption(empty, 0)).toBe(true)
    expect(empty.getMarkdown()).toContain('![empty](../assets/empty.png)')
    expect(empty.getMarkdown()).not.toContain('holi:figure')

    const malformed =
      '<!-- holi:figure -->\n\n![missing][not-defined]\n\n<!-- holi:caption -->\n\ncaption\n\n<!-- /holi:figure -->\n\nAfter.'
    const preserved = open(malformed)
    expect(preserved.state.doc.firstChild?.type.name).not.toBe('documentFigure')
    expect(preserved.getMarkdown()).toContain('![missing][not-defined]')
    expect(preserved.getMarkdown()).toContain('<!-- holi:caption -->')
    preserved.commands.setTextSelection(preserved.state.doc.content.size - 2)
    preserved.commands.insertContent('!')
    expect(preserved.getMarkdown()).toContain('<!-- /holi:figure -->')
    expect(preserved.getMarkdown()).toContain('After!')
  })

  it('parses captioned images through markdown insertion, paste, and external reload', () => {
    const source =
      '<!-- holi:figure -->\n\n![ref][asset]\n\n<!-- holi:caption -->\n\nFigure caption\n\n<!-- /holi:figure -->\n\n[asset]: ../assets/photo.png'
    const inserted = open('')
    inserted.commands.insertContent(source, { contentType: 'markdown' })
    expect(inserted.state.doc.firstChild?.type.name).toBe('documentFigure')
    const pasted = open('')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? source : '') },
    })
    pasted.view.dom.dispatchEvent(event)
    expect(pasted.state.doc.firstChild?.type.name).toBe('documentFigure')
    const reloaded = open('old')
    expect(applyReload(reloaded, source)).toBe(true)
    expect(reloaded.state.doc.firstChild?.type.name).toBe('documentFigure')
    expect(reloaded.getMarkdown().trimEnd()).toBe(source.trimEnd())
  })

  it('rejects stale image source metadata from HTML clipboard when visible attrs differ', () => {
    const instance = open('')
    instance.commands.setContent(
      '<figure data-holi-code-figure="" data-source-body="![hidden](../assets/hidden.png)" data-holi-source-image="[&quot;../assets/hidden.png&quot;,&quot;hidden&quot;,null]"><img src="https://example.com/visible.png" alt="visible"><figcaption>Caption</figcaption></figure>',
    )
    expect(instance.getMarkdown()).toContain('https://example.com/visible.png')
    expect(instance.getMarkdown()).not.toContain('hidden.png')
  })

  it('parses indented source fences on open, insertion, and reload without changing their bytes', () => {
    for (const indent of [' ', '  ', '   ']) {
      const source = `<!-- holi:figure -->\n\n${indent}~~~typescript extra\n${indent}const value = 1\n${indent}~~~\n\n<!-- holi:caption -->\n\ncaption\n\n<!-- /holi:figure -->`
      const instance = open(source)
      expect(instance.state.doc.firstChild?.type.name).toBe('documentFigure')
      expect(instance.state.doc.firstChild?.firstChild?.textContent).toBe('const value = 1')
      expect(instance.getMarkdown()).toBe(source)
      expect(instance.getMarkdown()).not.toContain('holi-private-caption')

      const inserted = open('')
      inserted.commands.insertContent(source, { contentType: 'markdown' })
      expect(inserted.state.doc.firstChild?.type.name).toBe('documentFigure')

      const reloaded = open('ordinary')
      expect(applyReload(reloaded, source)).toBe(true)
      expect(reloaded.state.doc.firstChild?.type.name).toBe('documentFigure')
      expect(reloaded.getMarkdown()).toContain(
        `${indent}~~~typescript extra\n${indent}const value = 1\n${indent}~~~`,
      )
      expect(reloaded.getMarkdown()).not.toContain('holi-private-caption')
      instance.destroy()
      inserted.destroy()
      reloaded.destroy()
      editor = null
    }
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

  it('round-trips brackets and backslashes inside inline code across repeated saves', () => {
    let instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    const text = '[name] \\\\[nested\\\\] &#91;'
    const code = instance.schema.marks.code
    expect(code).toBeDefined()
    instance.view.dispatch(
      instance.state.tr
        .insertText(text, captionStart)
        .addMark(captionStart, captionStart + text.length, code!.create()),
    )
    for (let cycle = 0; cycle < 3; cycle++) {
      const markdown = instance.getMarkdown()
      expect(markdown).toContain('`[name] \\\\[nested\\\\] &#91;`')
      instance.destroy()
      editor = null
      instance = open(markdown)
      expect(instance.state.doc.firstChild?.lastChild?.textContent).toBe(text)
      expect(
        instance.state.doc.firstChild?.lastChild?.firstChild?.marks.map((mark) => mark.type.name),
      ).toContain('code')
    }
  })

  it('round-trips inline code with single and double backtick runs', () => {
    let instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    const text = 'single ` and double `` ticks'
    const code = instance.schema.marks.code!.create()
    instance.view.dispatch(
      instance.state.tr
        .insertText(text, captionStart)
        .addMark(captionStart, captionStart + text.length, code),
    )
    for (let cycle = 0; cycle < 3; cycle++) {
      const markdown = instance.getMarkdown()
      expect(readMarkdownCodeCaptions(markdown)).toHaveLength(1)
      instance.destroy()
      editor = null
      instance = open(markdown)
      const caption = instance.state.doc.firstChild!.lastChild!
      expect(caption.textContent).toBe(text)
      expect(caption.firstChild?.marks.map((mark) => mark.type.name)).toContain('code')
    }
  })

  it('keeps link destinations with brackets and adjacent supported formatting', () => {
    const instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    const text = 'label and bold'
    const linkMark = instance.schema.marks.link
    const boldMark = instance.schema.marks.bold
    expect(linkMark).toBeDefined()
    expect(boldMark).toBeDefined()
    const link = linkMark!.create({ href: 'https://example.com/[part]' })
    const bold = boldMark!.create()
    instance.view.dispatch(
      instance.state.tr
        .insertText(text, captionStart)
        .addMark(captionStart, captionStart + 5, link)
        .addMark(captionStart + 10, captionStart + text.length, bold),
    )
    let markdown = instance.getMarkdown()
    expect(markdown).toContain('[label](https://example.com/%5Bpart%5D)')
    expect(markdown).not.toContain('&#91;')
    expect(markdown).not.toContain('&#93;')
    expect(markdown).toContain('**bold**')
    for (let cycle = 0; cycle < 3; cycle++) {
      const reopened = open(markdown)
      expect(reopened.state.doc.firstChild?.lastChild?.textContent).toBe(text)
      const reopenedCaption = reopened.state.doc.firstChild?.lastChild
      const reopenedLink = reopenedCaption?.firstChild?.marks.find(
        (mark) => mark.type.name === 'link',
      )
      expect(reopenedLink?.attrs.href).toBe('https://example.com/%5Bpart%5D')
      markdown = reopened.getMarkdown()
      expect(markdown).toContain('[label](https://example.com/%5Bpart%5D)')
      expect(markdown).not.toMatch(/&#(?:91|93);/)
    }
  })

  it('round-trips nested linked and unlinked brackets without changing link coverage', () => {
    let instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    const text = 'outer [inner] and [linked [nested]]'
    const link = instance.schema.marks.link!.create({ href: 'https://example.com/path' })
    instance.view.dispatch(
      instance.state.tr
        .insertText(text, captionStart)
        .addMark(captionStart + 18, captionStart + text.length, link),
    )
    for (let cycle = 0; cycle < 3; cycle++) {
      const markdown = instance.getMarkdown()
      expect(readMarkdownCodeCaptions(markdown)).toHaveLength(1)
      instance.destroy()
      editor = null
      instance = open(markdown)
      const caption = instance.state.doc.firstChild!.lastChild!
      expect(caption.textContent).toBe(text)
      expect(caption.childCount).toBe(2)
      const linked = caption.child(1)
      expect(linked.text).toBe('[linked [nested]]')
      expect(linked.marks.map((mark) => mark.type.name)).toContain('link')
    }
  })

  it('does not replace bracket tokens inside link destinations', () => {
    const instance = open('```ts\nx\n```')
    expect(addCodeCaption(instance, 0)).toBe(true)
    const captionStart = 1 + instance.state.doc.firstChild!.firstChild!.nodeSize + 1
    const text = '[label]'
    const href = 'https://example.com/HOLICAPBRACKET0X'
    instance.view.dispatch(
      instance.state.tr
        .insertText(text, captionStart)
        .addMark(
          captionStart,
          captionStart + text.length,
          instance.schema.marks.link!.create({ href }),
        ),
    )
    const reopened = open(instance.getMarkdown())
    const caption = reopened.state.doc.firstChild!.lastChild!
    expect(caption.textContent).toBe(text)
    expect(caption.firstChild?.marks.find((mark) => mark.type.name === 'link')?.attrs.href).toBe(
      href,
    )
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
    const image = open('![image](../image.png)')
    image.setEditable(false)
    expect(addImageCaption(image, 0)).toBe(false)
    image.setEditable(true)
    expect(addImageCaption(image, 1000)).toBe(false)
    image.destroy()
    editor = instance
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
