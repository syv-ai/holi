/**
 * A document is markdown on disk and Tiptap in the editor. Only the body
 * passes through the editor: the frontmatter block is kept byte for byte and
 * put back on save, since the editor neither shows nor understands it.
 *
 * The body round-trips through Tiptap's own markdown rules (`@tiptap/markdown`
 * and each extension's parse and render), so a file's formatting is
 * normalised the first time it is edited here, never on open alone.
 */
import { Markdown } from '@tiptap/markdown'
import { marked } from 'marked'
import {
  isPortableInlineCaption,
  readMarkdownCaptionEnvelopes,
  readMarkdownCodeCaptions,
} from '@holi/shared'

/** The line that marks where an agent run was asked to write: an HTML
 *  comment, so it is invisible anywhere else the file is read. */
export const AGENT_MARKER = '<!-- holi:agent -->'

function markdownImageFromSource(
  body: string,
  source: string,
  manager: { parse: (source: string) => any },
) {
  try {
    const tokens = marked.lexer(body).filter((token) => token.type !== 'space')
    const paragraph = tokens.length === 1 && tokens[0]?.type === 'paragraph' ? tokens[0] : null
    if (
      paragraph?.type === 'paragraph' &&
      paragraph.tokens?.length === 1 &&
      paragraph.tokens[0]?.type === 'image'
    ) {
      const sourceTokens = marked.lexer(`${body}\n\n${source}`)
      const imageToken = sourceTokens
        .filter((token) => token.type === 'paragraph')
        .flatMap((token: any) => token.tokens ?? [])
        .find((token: any) => token.type === 'image' && token.raw.trim() === body.trim())
      if (imageToken?.href) {
        return {
          type: 'image',
          attrs: {
            src: imageToken.href,
            alt: imageToken.text,
            title: imageToken.title ?? null,
          },
        }
      }
      const document = manager.parse(`${body}\n\n${source}`)
      const first = document.content?.[0]
      const image =
        first?.type === 'image'
          ? first
          : first?.type === 'paragraph' && first.content?.length === 1
            ? first.content[0]
            : null
      if (image?.type === 'image') return image
    }
  } catch {
    // Reference syntax below also covers markdown parsers without reference support.
  }
  const match = /^ {0,3}!\[([^\]]*)\](?:\[([^\]]*)\])?$/.exec(body)
  if (!match) return null
  const alt = match[1]!.replace(/\\([\\[\]])/g, '$1')
  const reference = (match[2] || match[1]!).trim().replace(/\s+/g, ' ').toLowerCase()
  const definition = marked
    .lexer(source)
    .find((token: any) => token.type === 'def' && token.tag === reference)
  if (!definition || definition.type !== 'def') return null
  return {
    type: 'image',
    attrs: {
      src: definition.href,
      alt,
      title: definition.title ?? null,
    },
  }
}

function expandReferenceImages(source: string, manager: { parse: (source: string) => any }) {
  const replacements: Array<{ from: number; to: number; text: string }> = []
  let fence: { marker: string; length: number } | null = null
  let offset = 0
  for (const line of source.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length)
        fence = null
    } else if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length }
    } else if (/^ {0,3}!\[[^\n]*\](?:\[[^\n]*\])?\s*$/.test(line)) {
      const body = line.trim()
      const image = markdownImageFromSource(body, source, manager)
      if (image?.attrs?.src && !body.includes('(')) {
        const alt = String(image.attrs.alt ?? '').replace(/([\\\\[\\]])/g, '\\\\$1')
        const target = String(image.attrs.src).replace(/[\\\\()]/g, '\\\\$&')
        const title = image.attrs.title
          ? ` \"${String(image.attrs.title).replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\\"')}\"`
          : ''
        replacements.push({
          from: offset,
          to: offset + line.length,
          text: `![${alt}](${target}${title})`,
        })
      }
    }
    const afterLine = offset + line.length
    offset =
      afterLine +
      (source.startsWith('\r\n', afterLine) ? 2 : source.startsWith('\n', afterLine) ? 1 : 0)
  }
  let result = source
  for (const replacement of replacements.reverse())
    result = result.slice(0, replacement.from) + replacement.text + result.slice(replacement.to)
  return result
}

function preserveReferenceDefinitions(parsed: any, source: string) {
  let offset = 0
  for (const token of marked.lexer(source)) {
    if (token.type === 'def') {
      const end = offset + token.raw.length
      const definition = source.slice(offset, end).replace(/\r?\n$/, '')
      parsed.content ??= []
      parsed.content.push({ type: 'htmlBlock', attrs: { html: definition } })
    }
    offset += token.raw.length
  }
  return parsed
}

function protectedMarkdownRanges(source: string) {
  const ranges: Array<{ from: number; to: number }> = []
  let offset = 0
  for (const token of marked.lexer(source)) {
    if (
      token.type === 'code' ||
      (token.type === 'html' && !/^<!--\s*\/?holi:(?:figure|caption)\s*-->$/.test(token.raw.trim()))
    )
      ranges.push({ from: offset, to: offset + token.raw.length })
    offset += token.raw.length
  }
  return ranges
}

function hasStandaloneImageSource(source: string) {
  let fence: { marker: string; length: number } | null = null
  for (const line of source.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (match?.[1]?.[0] === fence.marker && match[1].length >= fence.length) fence = null
    } else if (match) {
      fence = { marker: match[1]![0]!, length: match[1]!.length }
    } else if (/^ {0,3}!\[[^\n]*\](?:\([^\n]*\)|\[[^\n]*\]|[ \t*]*)$/.test(line)) {
      return true
    }
  }
  return false
}

function annotateStandaloneImageSources(
  parsed: any,
  source: string,
  manager: { parse: (source: string) => any },
) {
  let fence: { marker: string; length: number } | null = null
  const candidates: Array<{ body: string; image: any }> = []
  for (const line of source.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length)
        fence = null
      continue
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length }
      continue
    }
    if (!/^ {0,3}!\[[^\n]*\](?:\([^\n]*\)|\[[^\n]*\]|[ \t*]*)$/.test(line)) continue
    try {
      const image = markdownImageFromSource(line, source, manager)
      if (image) candidates.push({ body: line, image })
    } catch {
      // An unsupported image form remains an ordinary markdown block.
    }
  }
  const available = [...candidates]
  parsed.content = (parsed.content ?? []).map((node: any) => {
    const image =
      node.type === 'image'
        ? node
        : node.type === 'paragraph' &&
            node.content?.length === 1 &&
            node.content[0]?.type === 'image'
          ? node.content[0]
          : null
    if (!image) return node
    const index = available.findIndex(
      (candidate) => (candidate.image.attrs?.alt ?? null) === (image.attrs?.alt ?? null),
    )
    if (index < 0) return node
    const [candidate] = available.splice(index, 1)
    const sourceMarkdownImageAttrs = JSON.stringify([
      candidate!.image.attrs?.src ?? '',
      candidate!.image.attrs?.alt ?? null,
      candidate!.image.attrs?.title ?? null,
    ])
    return {
      ...node,
      ...(node.type === 'image'
        ? {
            attrs: {
              ...node.attrs,
              src: candidate!.image.attrs?.src,
              alt: candidate!.image.attrs?.alt,
              title: candidate!.image.attrs?.title,
              sourceMarkdown: candidate!.body,
              sourceMarkdownImageAttrs,
            },
          }
        : {
            content: [
              {
                ...node.content[0],
                attrs: {
                  ...image.attrs,
                  src: candidate!.image.attrs?.src,
                  alt: candidate!.image.attrs?.alt,
                  title: candidate!.image.attrs?.title,
                  sourceMarkdown: candidate!.body,
                  sourceMarkdownImageAttrs,
                },
              },
            ],
          }),
    }
  })
  return preserveReferenceDefinitions(parsed, source)
}

function unhandledCaptionRanges(
  source: string,
  supported: Array<{ from: number; to: number }>,
  protectedRanges: Array<{ from: number; to: number }>,
) {
  const lines = source.split(/\r?\n/)
  const ranges: Array<{ from: number; to: number }> = []
  const open: number[] = []
  let offset = 0
  let fence: { marker: string; length: number } | null = null
  for (const line of lines) {
    const protectedLine = protectedRanges.some((range) => offset >= range.from && offset < range.to)
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (protectedLine) {
      // Marked owns code and raw HTML blocks; caption markers there are data.
    } else if (fence) {
      if (fenceMatch?.[1]?.[0] === fence.marker && fenceMatch[1].length >= fence.length)
        fence = null
    } else if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length }
    } else if (line.trim() === '<!-- holi:figure -->') {
      open.push(offset)
    } else if (line.trim() === '<!-- /holi:figure -->' && open.length) {
      ranges.push({ from: open.pop()!, to: offset + line.length })
    }
    const afterLine = offset + line.length
    offset =
      afterLine +
      (source.startsWith('\r\n', afterLine) ? 2 : source.startsWith('\n', afterLine) ? 1 : 0)
  }
  for (const from of open) ranges.push({ from, to: source.length })
  return ranges.filter(
    (range) => !supported.some((frame) => frame.from >= range.from && frame.from < range.to),
  )
}

/** The extension the editor needs to read and write markdown. */
function withDocumentFigures(manager: { parse: (source: string) => any }, source: string) {
  const protectedRanges = protectedMarkdownRanges(source)
  const codeFrames = readMarkdownCodeCaptions(source).filter(
    (frame) =>
      frame.language.toLowerCase() !== 'mermaid' &&
      !protectedRanges.some(
        (range) => frame.envelope.from >= range.from && frame.envelope.from < range.to,
      ),
  )
  const codeRanges = new Set(codeFrames.map((frame) => frame.envelope.from))
  const imageFrames = readMarkdownCaptionEnvelopes(source).flatMap((frame) => {
    if (
      protectedRanges.some(
        (range) => frame.envelope.from >= range.from && frame.envelope.from < range.to,
      )
    )
      return []
    if (codeRanges.has(frame.envelope.from)) return []
    const body = source.slice(frame.body.from, frame.body.to)
    const caption = source.slice(frame.caption.from, frame.caption.to)
    if (!isPortableInlineCaption(caption)) return []
    try {
      // Parse in document context so shortcut, collapsed, and full reference
      // images can resolve definitions anywhere in the document.
      const image = markdownImageFromSource(body, source, manager)
      if (!image || typeof image.attrs?.src !== 'string' || !image.attrs.src) return []
      image.attrs = {
        ...image.attrs,
        sourceMarkdown: body,
        sourceMarkdownImageAttrs: JSON.stringify([
          image.attrs.src ?? '',
          image.attrs.alt ?? null,
          image.attrs.title ?? null,
        ]),
      }
      return [{ ...frame, image }]
    } catch {
      return []
    }
  })
  const frames = [...codeFrames, ...imageFrames].sort(
    (left, right) => left.envelope.from - right.envelope.from,
  )
  const opaqueRanges = unhandledCaptionRanges(
    source,
    frames.map((frame) => frame.envelope),
    protectedRanges,
  )
  if (!frames.length && !opaqueRanges.length)
    return annotateStandaloneImageSources(
      manager.parse(expandReferenceImages(source, manager)),
      source,
      manager,
    )

  const items = [
    ...frames.map((frame, frameIndex) => ({
      from: frame.envelope.from,
      to: frame.envelope.to,
      frameIndex,
      raw: null as string | null,
    })),
    ...opaqueRanges.map((range) => ({
      ...range,
      frameIndex: null as number | null,
      raw: source.slice(range.from, range.to),
    })),
  ].sort((left, right) => left.from - right.from)
  const placeholders = items.map((_, index) => {
    let token = `<!-- holi-private-caption-${index} -->`
    let suffix = 0
    while (source.includes(token)) token = `<!-- holi-private-caption-${index}-${++suffix} -->`
    return token
  })
  let substituted = source
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    substituted = substituted.slice(0, item.from) + placeholders[index] + substituted.slice(item.to)
  }
  const parsed = manager.parse(expandReferenceImages(substituted, manager))
  const figures = frames.map((frame) => {
    try {
      const imageFrame = imageFrames.find(
        (candidate) => candidate.envelope.from === frame.envelope.from,
      )
      if (imageFrame) {
        const captionMarkdown = source.slice(frame.caption.from, frame.caption.to)
        const captionDocument = manager.parse(captionMarkdown)
        const caption = captionDocument.content?.find((node: any) => node.type === 'paragraph')
        if (!caption) return null
        return {
          type: 'documentFigure',
          attrs: {
            sourceBody: source.slice(frame.body.from, frame.body.to),
            sourceImageAttrs: JSON.stringify([
              imageFrame.image.attrs.src ?? '',
              imageFrame.image.attrs.alt ?? null,
              imageFrame.image.attrs.title ?? null,
            ]),
          },
          content: [imageFrame.image, { type: 'documentCaption', content: caption.content }],
        }
      }
      const fence = source.slice(frame.body.from, frame.body.to)
      const openingIndent = /^( {0,3})(?:`{3,}|~{3,})/.exec(fence)?.[1]?.length ?? 0
      const parserFence =
        openingIndent === 0
          ? fence
          : fence
              .split('\n')
              .map((line) => line.replace(new RegExp(`^ {0,${openingIndent}}`), ''))
              .join('\n')
      const codeDocument = manager.parse(parserFence)
      const code = codeDocument.content?.find((node: any) => node.type === 'codeBlock')
      const captionMarkdown = source.slice(frame.caption.from, frame.caption.to)
      const captionDocument = manager.parse(captionMarkdown)
      const caption = captionDocument.content?.find((node: any) => node.type === 'paragraph')
      if (!code || !caption) return null
      const text = code.content?.map((part: any) => part.text ?? '').join('') ?? ''
      code.attrs = {
        ...code.attrs,
        sourceFence: fence,
        sourceFenceText: text,
        sourceFenceLanguage: String(code.attrs?.language ?? ''),
      }
      return {
        type: 'documentFigure',
        content: [code, { type: 'documentCaption', content: caption.content }],
      }
    } catch {
      return null
    }
  })
  const byPlaceholder = new Map(
    placeholders.map((placeholder, index) => [placeholder, items[index]!]),
  )
  parsed.content = (parsed.content ?? []).flatMap((node: any) => {
    if (node.type !== 'htmlBlock') return [node]
    const html = String(node.attrs?.html ?? '').trim()
    const item = byPlaceholder.get(html)
    if (item) {
      if (item.frameIndex !== null) {
        const figure = figures[item.frameIndex]
        if (figure) return [figure]
        return [{ ...node, attrs: { ...node.attrs, html: source.slice(item.from, item.to) } }]
      }
      return [{ ...node, attrs: { ...node.attrs, html: item.raw } }]
    }
    let restored = String(node.attrs?.html ?? '')
    for (const [placeholder, range] of byPlaceholder)
      if (restored.includes(placeholder))
        restored = restored.replaceAll(placeholder, source.slice(range.from, range.to))
    return [{ ...node, attrs: { ...node.attrs, html: restored } }]
  })
  return annotateStandaloneImageSources(parsed, source, manager)
}

export const DocumentMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    const initial = this.editor.options.content
    this.parent?.(event)
    const manager = this.editor.markdown
    if (!manager || typeof initial !== 'string') return
    const parse = manager.parse.bind(manager)
    manager.parse = (source: string) => withDocumentFigures({ parse }, source)
    if (
      this.editor.options.contentType === 'markdown' &&
      (readMarkdownCaptionEnvelopes(initial).length || hasStandaloneImageSource(initial))
    ) {
      this.editor.options.content = withDocumentFigures({ parse }, initial)
      this.editor.options.contentType = 'json'
    }
  },
}).configure({
  indentation: { style: 'space', size: 2 },
  markedOptions: { gfm: true },
})

/** A file split where its body starts: `head` is the frontmatter fence and
 *  everything up to the body, verbatim; empty when there is none. */
export function splitDocument(text: string): { head: string; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { head: '', body: normalized }
  const close = normalized.indexOf('\n---', 3)
  if (close === -1) return { head: '', body: normalized }
  const lineEnd = normalized.indexOf('\n', close + 4)
  if (lineEnd === -1) return { head: `${normalized}\n`, body: '' }
  // Blank lines between the fence and the body stay with the head.
  let start = lineEnd + 1
  while (normalized[start] === '\n') start++
  return { head: normalized.slice(0, start), body: normalized.slice(start) }
}

/** The file again: the head as it was, the editor's body, one trailing
 *  newline. */
export function joinDocument(head: string, body: string): string {
  const trimmed = body.replace(/\s+$/, '')
  return trimmed === '' ? head : `${head}${trimmed}\n`
}

/** The name a document shows: its file name without the extension. */
export function documentTitle(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
