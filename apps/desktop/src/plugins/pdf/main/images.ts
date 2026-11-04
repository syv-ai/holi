/**
 * A note's images, put into its Typst copy as bytes.
 *
 * cmarker evaluates a markdown image inside its own package, so a path,
 * relative or absolute, resolves against cmarker and never the note's folder.
 * Each local image therefore goes in the way a mermaid diagram does: a
 * `<!--raw-typst … -->` comment holding the image's bytes. No image path
 * reaches Typst, and every template that renders through cmarker shows the
 * image unchanged.
 *
 * Reading is a function handed in (`render.ts` keeps it inside the vault), so
 * this module only finds the images and says what stands in for each.
 */
import { fileKind, parseWikiLinks, resolveImageRef } from '@holi/shared'
import { GFM, parser } from '@lezer/markdown'
import { commentSafeString } from './mermaid'

/** An image's bytes, by vault path. Throws with the reason it cannot. */
export type LoadImage = (vaultPath: string) => Promise<Uint8Array>

/** The formats Typst's `image` reads, by file extension. */
const FORMATS: Record<string, string> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  svg: 'svg',
}

/** One image in the note: where it is, what it says, where it points. */
interface Found {
  from: number
  to: number
  alt: string
  /** A vault path, or an `http(s)` address. */
  target: { kind: 'vault'; path: string } | { kind: 'external'; url: string }
}

/** CommonMark with GitHub's extensions, as the editor reads a note. */
const markdownParser = parser.configure(GFM)

/** Nodes whose text is never an image: code, and HTML (comments included). */
const VERBATIM = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'CommentBlock',
  'Comment',
  'HTMLBlock',
  'HTMLTag',
])

/** A reference label as CommonMark matches it: case and runs of space ignored. */
const labelKey = (label: string): string =>
  label
    .replace(/^\[|\]$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

function decode(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** A link destination as written: without its `<…>`, percent-decoded. */
const destination = (url: string): string => decode(url.replace(/^<(.*)>$/, '$1'))

/** Every image in `markdown`, in order: markdown images (inline and by
 *  reference), and wiki-links to an image file (`[[a.png]]` or `![[a.png]]`,
 *  vault-relative like the editor). Never one inside code or HTML. */
function findImages(markdown: string, notePath: string): Found[] {
  const tree = markdownParser.parse(markdown)
  const verbatim: [number, number][] = []
  const definitions = new Map<string, string>()
  const images: { from: number; to: number; alt: string; url?: string; label?: string }[] = []
  tree.iterate({
    enter: (node) => {
      if (VERBATIM.has(node.name)) {
        verbatim.push([node.from, node.to])
        return false
      }
      if (node.name === 'LinkReference') {
        const label = node.node.getChild('LinkLabel')
        const url = node.node.getChild('URL')
        if (label !== null && url !== null) {
          const key = labelKey(markdown.slice(label.from, label.to))
          // The first definition of a label wins.
          if (!definitions.has(key)) definitions.set(key, markdown.slice(url.from, url.to))
        }
        return false
      }
      if (node.name !== 'Image') return
      // The alt ends at the last `]` before the destination or the label:
      // brackets inside the alt are marks of their own.
      let altEnd = node.to
      let url: string | undefined
      let label: string | undefined
      for (let c = node.node.firstChild; c !== null; c = c.nextSibling) {
        const text = markdown.slice(c.from, c.to)
        if (c.name === 'LinkMark' && text === ']' && url === undefined && label === undefined)
          altEnd = c.from
        else if (c.name === 'URL') url = text
        else if (c.name === 'LinkLabel') label = text
      }
      const alt = markdown.slice(node.from + 2, altEnd).trim()
      images.push({
        from: node.from,
        to: node.to,
        alt,
        ...(url === undefined ? {} : { url }),
        ...(label === undefined ? {} : { label }),
      })
      return false
    },
  })

  const found: Found[] = []
  for (const image of images) {
    // `![a][r]`, `![a][]` and `![a]` look their address up by label; an
    // undefined label is not an image, and stays text.
    const url =
      image.url ??
      definitions.get(
        labelKey(image.label === undefined || image.label === '[]' ? image.alt : image.label),
      )
    if (url === undefined) continue
    found.push({
      from: image.from,
      to: image.to,
      alt: image.alt,
      target: resolveImageRef(notePath, destination(url)),
    })
  }
  const inVerbatim = (at: number): boolean => verbatim.some(([from, to]) => at >= from && at < to)
  for (const link of parseWikiLinks(markdown)) {
    if (fileKind(link.target) !== 'image' || inVerbatim(link.start)) continue
    const from = markdown[link.start - 1] === '!' ? link.start - 1 : link.start
    if (found.some((f) => from < f.to && link.end > f.from)) continue
    found.push({
      from,
      to: link.end,
      alt: link.label ?? link.target,
      target: { kind: 'vault', path: link.target },
    })
  }
  return found.sort((a, b) => a.from - b.from)
}

/** Why `bytes` will not draw as `format`, or null when it will. Typst fails
 *  the whole PDF on an image it cannot decode, so a file whose bytes are not
 *  what its name says is caught here, as is an SVG that points at another
 *  file: Typst would look for that file inside cmarker's package. */
function unusable(bytes: Uint8Array, format: string): string | null {
  const starts = (sig: number[], at = 0): boolean => sig.every((b, i) => bytes[at + i] === b)
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))
  const ok: Record<string, () => boolean> = {
    png: () => starts([0x89, 0x50, 0x4e, 0x47]),
    jpg: () => starts([0xff, 0xd8, 0xff]),
    gif: () => starts(ascii('GIF8')),
    webp: () => starts(ascii('RIFF')) && starts(ascii('WEBP'), 8),
    svg: () => /<svg[\s>]/.test(new TextDecoder().decode(bytes)),
  }
  if (!ok[format]!()) return `is not a ${format === 'jpg' ? 'jpeg' : format} file`
  if (format === 'svg') {
    const svg = new TextDecoder().decode(bytes)
    for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*["']\s*([^"'\s]*)/g)) {
      if (!/^(#|data:)/i.test(m[1]!)) return 'is an SVG that links to another file'
    }
  }
  return null
}

/** The markdown that stands in for an image: the image itself, in Typst. */
function imageMarkdown(bytes: Uint8Array, format: string, alt: string): string {
  const altArg = alt === '' ? '' : `, alt: ${commentSafeString(alt)}`
  return `<!--raw-typst #image(bytes((${bytes.join(',')})), format: "${format}"${altArg})-->`
}

/**
 * `markdown` with every image it can show put in as bytes. An image that
 * cannot be shown (a web address, a missing file, a format Typst does not
 * read) leaves its alt text in its place, and says so in `warnings`: one image
 * never fails the whole PDF. `notePath` is the note's vault path, which a
 * relative image resolves against.
 */
export async function inlineImages(
  markdown: string,
  notePath: string,
  load: LoadImage,
): Promise<{ markdown: string; warnings: string[] }> {
  const images = findImages(markdown, notePath)
  if (images.length === 0) return { markdown, warnings: [] }

  const warnings: string[] = []
  let out = ''
  let at = 0
  for (const image of images) {
    out += markdown.slice(at, image.from)
    at = image.to
    const line = markdown.slice(0, image.from).split('\n').length
    const leftOut = (why: string): void => {
      warnings.push(`The image on line ${line} is left out: ${why}`)
      out += image.alt
    }
    if (image.target.kind === 'external') {
      leftOut(`${image.target.url} is a web address, and a PDF only takes images from the vault`)
      continue
    }
    const path = image.target.path
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const format = FORMATS[ext]
    if (format === undefined) {
      leftOut(`${path} is not an image Typst can read (png, jpg, gif, webp or svg)`)
      continue
    }
    let bytes: Uint8Array
    try {
      bytes = await load(path)
    } catch (err) {
      leftOut(`${path}: ${(err as Error).message}`)
      continue
    }
    const why = unusable(bytes, format)
    if (why === null) out += imageMarkdown(bytes, format, image.alt)
    else leftOut(`${path} ${why}`)
  }
  return { markdown: out + markdown.slice(at), warnings }
}
