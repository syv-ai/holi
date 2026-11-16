import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RichTextTable } from '@/features/documents/rich-text/rich-text-table'

import { createDocumentExtensions } from '../document-extensions'
import { joinDocument, splitDocument } from '../markdown'

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function roundTrip(markdown: string): string {
  editor = new Editor({
    extensions: [
      ...createDocumentExtensions({
        folder: 'notes',
        placeholder: '',
        onOpenLink: () => undefined,
      }),
      RichTextTable,
    ],
    content: markdown,
    contentType: 'markdown',
  })
  return editor.getMarkdown()
}

describe('splitDocument', () => {
  it('keeps the frontmatter verbatim and joins it back', () => {
    const text = '---\ntitle: Plan\ntags: [a, b]\n---\n\n# Plan\n\nBody\n'
    const { head, body } = splitDocument(text)
    expect(head).toBe('---\ntitle: Plan\ntags: [a, b]\n---\n\n')
    expect(body).toBe('# Plan\n\nBody\n')
    expect(joinDocument(head, body)).toBe(text)
  })

  it('treats a file without a fence as all body', () => {
    expect(splitDocument('# Hi\n')).toEqual({ head: '', body: '# Hi\n' })
  })
})

describe('markdown round trip', () => {
  const cases: [string, string][] = [
    ['headings and paragraphs', '# Title\n\n## Section\n\nA paragraph.'],
    ['inline marks', 'Some **bold**, *italic*, ~~struck~~ and `code`.'],
    ['links', 'A [link](https://holi.app) here.'],
    ['bullet list', '- one\n- two\n  - nested'],
    ['ordered list', '1. first\n2. second'],
    ['task list', '- [ ] open\n- [x] done'],
    ['blockquote', '> quoted'],
    ['code fence', '```ts\nconst a = 1\n```'],
    ['wiki link', 'See [[Project plan]] and [[notes/Ideas|ideas]].'],
    ['image', '![A chart](assets/chart.png)'],
    ['rule', 'Above\n\n---\n\nBelow'],
    ['highlight', 'Some ==marked== text.'],
    ['html block', '<details>\n<summary>More</summary>\nHidden\n</details>'],
    ['hard break', 'line one  \nline two'],
  ]
  for (const [name, markdown] of cases) {
    it(name, () => {
      expect(roundTrip(markdown).trim()).toBe(markdown)
    })
  }

  // The divider is padded to the column width: a one-time normalisation,
  // and still the same table.
  it('table', () => {
    expect(roundTrip('| Name | Role |\n| --- | --- |\n| Ada | Lead |').trim()).toBe(
      '| Name | Role |\n| ---- | ---- |\n| Ada  | Lead |',
    )
  })

  it('keeps reference definitions intact across CRLF and mixed newlines', () => {
    const source =
      '---\r\ntitle: Kept\r\n---\r\n\r\n![Alt][chart]\r\n\r\n<!-- holi:figure -->\n![Fig](images/a.png)\n<!-- /holi:figure -->\r\n\r\n[chart]: images/chart.png \"chart title\"\r\n'
    const { head, body } = splitDocument(source)
    expect(head).toBe('---\ntitle: Kept\n---\n\n')
    const saved = roundTrip(body)
    expect(saved).toContain('[chart]: images/chart.png \"chart title\"')
    expect(saved).toContain('<!-- holi:figure -->')
    expect(saved).toContain('images/a.png')
  })

  it('does not duplicate definitions retained inside malformed envelopes on repeated saves', () => {
    let saved =
      '![Other][ref]\n\n<!-- holi:figure -->\n\n![Photo](../photo.png)\n\n[ref]: ../other.png "Title"\n\nAfter.'
    for (let cycle = 0; cycle < 3; cycle++) saved = roundTrip(saved)
    expect(saved.match(/\[ref\]:/g)).toHaveLength(1)
    expect(roundTrip(saved)).toBe(saved)
  })
})
