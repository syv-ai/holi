import { Editor } from '@tiptap/react'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { afterEach, expect, it } from 'vitest'

import { createDocumentExtensions } from '../document-extensions'
import { displaySrc } from '../media-src'
import { addImageCaption, removeCodeCaption } from '../rich-text/document-figure'

const editors: Editor[] = []
function open(source: string, folder = 'notes') {
  const editor = new Editor({
    extensions: createDocumentExtensions({ folder, placeholder: '', onOpenLink: () => {} }),
    content: source,
    contentType: 'markdown',
  })
  editors.push(editor)
  return editor
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function figure(body: string, caption = 'A **bold** and *italic* [link](https://example.com).') {
  return `<!-- holi:figure -->\n\n${body}\n\n<!-- holi:caption -->\n\n${caption}\n\n<!-- /holi:figure -->`
}
function images(editor: Editor) {
  const result: Array<{ src: string; alt: string; title: string | null }> = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') {
      const { src, alt, title } = node.attrs
      result.push({ src, alt, title })
    }
  })
  return result
}
function paste(editor: Editor, html: string, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
    },
  })
  editor.view.dom.dispatchEvent(event)
}
function copy(editor: Editor, selection: 'image' | 'figure', cut = false) {
  editor.view.dispatch(
    editor.state.tr.setSelection(
      NodeSelection.create(editor.state.doc, selection === 'image' ? 1 : 0),
    ),
  )
  const values: Record<string, string> = {}
  const event = new Event(cut ? 'cut' : 'copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      clearData: () => Object.keys(values).forEach((key) => delete values[key]),
      setData: (type: string, value: string) => {
        values[type] = value
      },
    },
  })
  editor.view.dom.dispatchEvent(event)
  return values
}

it('binds same-alt images to parsed source positions after consumed figures, including duplicates', () => {
  const first = '![same](../first.png "first title")'
  const second = '![same](../second.png "second title")'
  const third = '![same](../third.png "third title")'
  const source = `${figure(first)}\n\n${second}\n\n${second}\n\n${third}\n\nAfter.`
  const editor = open(source)
  const expected = [
    { src: '../first.png', alt: 'same', title: 'first title' },
    { src: '../second.png', alt: 'same', title: 'second title' },
    { src: '../second.png', alt: 'same', title: 'second title' },
    { src: '../third.png', alt: 'same', title: 'third title' },
  ]
  expect(images(editor)).toEqual(expected)
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  editor.commands.insertContent(' Unrelated edit.')
  const saved = editor.getMarkdown()
  expect(saved).toContain(second)
  expect(images(open(saved))).toEqual(expected)
})

it.each([
  '<pre>\n![same](../wrong.png "wrong")\n</pre>',
  '<textarea>\n![same](../wrong.png "wrong")\n</textarea>',
  '```md\n![same](../wrong.png "wrong")\n```',
  '    ![same](../wrong.png "wrong")',
  '<!--\n![same](../wrong.png "wrong")\n-->',
])('does not consume protected image examples as provenance: %s', (protectedSource) => {
  const source = `${protectedSource}\n\n![same](../right.png "right")`
  const editor = open(source)
  expect(images(editor)).toEqual([{ src: '../right.png', alt: 'same', title: 'right' }])
  const saved = editor.getMarkdown()
  expect(saved).toContain('../wrong.png')
  expect(images(open(saved))).toEqual(images(editor))
})

it.each(['![A \\[cat\\]][photo]', '![A (cat)][photo]', '![photo][]', '![photo]'])(
  'preserves standalone reference syntax and full definitions: %s',
  (body) => {
    const source = `${figure('![same](../first.png)')}\n\n${body}\n\n[photo]:\n  ../assets/photo.png\n  "Title"\n\n\`\`\`md\n[photo]: ../wrong.png\n\`\`\``
    const editor = open(source)
    expect(images(editor)[1]?.src).toBe('../assets/photo.png')
    const position = editor.state.doc.firstChild!.nodeSize
    expect(addImageCaption(editor, position)).toBe(true)
    editor.commands.insertContent('Caption')
    const reopened = open(editor.getMarkdown())
    expect(removeCodeCaption(reopened, reopened.state.doc.firstChild!.nodeSize)).toBe(true)
    const saved = reopened.getMarkdown()
    expect(saved).toContain(body)
    expect(saved.match(/\[photo\]:\n/g)).toHaveLength(1)
    expect(saved).toContain('[photo]:\n  ../assets/photo.png\n  "Title"')
    expect(images(open(saved))[1]?.src).toBe('../assets/photo.png')
  },
)

it.each([
  ['', 'notes/deep', 'assets/photo.png', '../../assets/photo.png'],
  ['', '', 'assets/photo.png', 'assets/photo.png'],
  ['notes/deep', '', '../../assets/photo.png', 'assets/photo.png'],
  ['notes', 'notes/deep', '../assets/photo.png', '../../assets/photo.png'],
])('rebases native HTML with both clipboard formats from %s to %s', (from, to, src, expected) => {
  const editor = open(figure(`![Photo](${src} "Title")`), from)
  const clipboard = copy(editor, 'image')
  const target = open('', to)
  paste(target, clipboard['text/html']!, clipboard['text/plain']!)
  expect(images(target)).toEqual([{ src: expected, alt: 'Photo', title: 'Title' }])
  const saved = target.getMarkdown()
  expect(saved).not.toContain('holi-vault:')
  expect(images(open(saved, to))).toEqual(images(target))
})

it('still rejects root clipboard provenance that disagrees with visible src', () => {
  const target = open('')
  paste(
    target,
    '<figure data-holi-code-figure><img src="https://example.com/visible.png" data-holi-source-src="assets/hidden.png" data-holi-source-folder="" alt="Visible"><figcaption>Caption</figcaption></figure>',
    '',
  )
  expect(images(target)[0]?.src).toBe('https://example.com/visible.png')
  expect(target.getMarkdown()).not.toContain('hidden.png')
})

it.each(['image', 'figure'] as const)(
  'copies and cuts complete %s selections as self-contained portable Markdown',
  (selection) => {
    for (const cut of [false, true]) {
      const editor = open(`${figure('![Photo][photo]')}\n\n[photo]: ../assets/photo.png "Title"`)
      const clipboard = copy(editor, selection, cut)
      const text = clipboard['text/plain']!
      expect(text).toContain('![Photo](../assets/photo.png "Title")')
      expect(text).toContain('<!-- holi:figure -->')
      expect(text).toContain('<!-- holi:caption -->')
      expect(text).toContain('A **bold** and *italic* [link](https://example.com).')
      expect(text).not.toMatch(/holi-vault:|data-holi-|sourceBody|\[photo\]/)
      expect(clipboard['text/html']).toContain('figcaption')
      const target = open('')
      paste(target, '', text)
      expect(images(open(target.getMarkdown()))).toEqual([
        { src: '../assets/photo.png', alt: 'Photo', title: 'Title' },
      ])
      expect(target.state.doc.firstChild?.lastChild?.textContent).toBe('A bold and italic link.')
      if (cut) expect(editor.getMarkdown()).not.toContain('holi:figure')
    }
  },
)

it('serializes multiple figures with marks but keeps ordinary selection text unchanged', () => {
  const editor = open(
    `${figure('![first](../first.png)')}\n\n${figure('![second](../second.png)')}`,
  )
  const clipboard = editor.view.serializeForClipboard(
    editor.state.doc.slice(0, editor.state.doc.content.size),
  )
  expect(clipboard.text.match(/<!-- holi:figure -->/g)).toHaveLength(2)
  expect(images(open(clipboard.text))).toEqual(images(editor))
  const ordinary = open('Ordinary **bold** [link](https://example.com).')
  ordinary.view.dispatch(
    ordinary.state.tr.setSelection(
      TextSelection.create(ordinary.state.doc, 1, ordinary.state.doc.content.size - 1),
    ),
  )
  expect(ordinary.view.serializeForClipboard(ordinary.state.selection.content()).text).toBe(
    'Ordinary bold link.',
  )
})

it('materializes clipboard references before colliding destination definitions can resolve them', () => {
  const editor = open(`${figure('![Photo][photo]')}\n\n[photo]: ../assets/photo.png "Title"`)
  const clipboard = copy(editor, 'figure')
  const target = open('![Other][photo]\n\n[photo]: ../other.png')
  target.commands.setTextSelection(target.state.doc.content.size - 1)
  paste(target, clipboard['text/html']!, clipboard['text/plain']!)
  expect(images(target).map((image) => image.src)).toContain('../assets/photo.png')
})

it.each(['photo+one.png', 'photo&one.png', 'photo#one.png', 'photo?one.png', 'photo%20one.png'])(
  'keeps the actual displayed asset URL after HTML clipboard rebasing: %s',
  (name) => {
    const src = `../assets/${name}`
    const source = open(figure(`![Photo](${src})`))
    const clipboard = copy(source, 'figure')
    const target = open('', 'notes/deep')
    paste(target, clipboard['text/html']!, clipboard['text/plain']!)
    const before = displaySrc(images(source)[0]!.src, 'notes')
    const after = displaySrc(images(target)[0]!.src, 'notes/deep')
    expect(after).toBe(before)
    const reopened = open(target.getMarkdown(), 'notes/deep')
    expect(displaySrc(images(reopened)[0]!.src, 'notes/deep')).toBe(before)
  },
)

it.each(['bad%', 'bad%2', 'bad%GG', 'bad%C3%28'])(
  'falls back to visible src during actual pasteHTML with malformed provenance: %s',
  (source) => {
    const target = open('')
    const html = `<figure data-holi-code-figure><img src="https://example.com/visible.png" data-holi-source-src="${source}" data-holi-source-folder="notes" alt="Photo"><figcaption>Caption</figcaption></figure>`
    expect(() => target.view.pasteHTML(html, new Event('paste') as ClipboardEvent)).not.toThrow()
    expect(images(target)).toEqual([
      { src: 'https://example.com/visible.png', alt: 'Photo', title: null },
    ])
    expect(target.state.doc.firstChild?.lastChild?.textContent).toBe('Caption')
    expect(images(open(target.getMarkdown()))).toEqual(images(target))
  },
)

it.each([false, true])(
  'preserves nested opaque ranges and every trailing sibling, closed=%s',
  (closed) => {
    const opaque =
      '<!-- holi:figure -->\n\nOuter.\n\n' +
      figure('Unsupported inner body.', 'Inner caption') +
      '\n\nOuter tail.\n\n[ref]: ../assets/right.png' +
      (closed ? '\n\n<!-- /holi:figure -->' : '')
    const siblings =
      '\n\nAfter important prose.\n\n![Trailing][ref]\n\n' +
      figure('![Valid](../assets/valid.png)', 'Valid caption') +
      '\n\n[ref]: ../assets/wrong.png\n\nEnd.'
    const original = 'Before.\n\n' + opaque + siblings
    let source = original
    for (let cycle = 0; cycle < 3; cycle++) {
      const editor = open(source)
      source = editor.getMarkdown().trimEnd()
      expect(source).toBe(original)
      expect(source).not.toContain('holi-private')
      if (closed)
        expect(images(editor).map((image) => image.src)).toEqual([
          '../assets/right.png',
          '../assets/valid.png',
        ])
    }
  },
)
