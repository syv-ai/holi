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
import { fencedBlocks, fileKind, parseWikiLinks, resolveImageRef } from '@holi/shared'
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

/** `![alt](target)` and `![alt](<target with spaces> "title")`. */
const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\s*\)/g

/** Ranges no image is read from: fenced blocks and inline code spans. */
function codeRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = fencedBlocks(markdown).map((b) => [b.from, b.to])
  for (const m of markdown.matchAll(/(`+)[^`\n]*?\1/g)) {
    ranges.push([m.index, m.index + m[0].length])
  }
  return ranges
}

function decode(target: string): string {
  try {
    return decodeURIComponent(target)
  } catch {
    return target
  }
}

/** Every image in `markdown`, in order: markdown images, and wiki-links to an
 *  image file (`[[a.png]]` or `![[a.png]]`, vault-relative like the editor). */
function findImages(markdown: string, notePath: string): Found[] {
  const code = codeRanges(markdown)
  const inCode = (at: number): boolean => code.some(([from, to]) => at >= from && at < to)
  const found: Found[] = []
  for (const m of markdown.matchAll(MARKDOWN_IMAGE)) {
    if (inCode(m.index)) continue
    const ref = resolveImageRef(notePath, decode(m[2] ?? m[3]!))
    found.push({ from: m.index, to: m.index + m[0].length, alt: m[1]!.trim(), target: ref })
  }
  for (const link of parseWikiLinks(markdown)) {
    if (fileKind(link.target) !== 'image' || inCode(link.start)) continue
    const from = markdown[link.start - 1] === '!' ? link.start - 1 : link.start
    if (found.some((f) => from < f.to && link.end > f.from)) continue
    found.push({
      from,
      to: link.end,
      alt: link.label ?? '',
      target: { kind: 'vault', path: link.target },
    })
  }
  return found.sort((a, b) => a.from - b.from)
}

/** The markdown that stands in for an image: the image itself, in Typst. */
export function imageMarkdown(bytes: Uint8Array, format: string, alt: string): string {
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
    try {
      out += imageMarkdown(await load(path), format, image.alt)
    } catch (err) {
      leftOut(`${path}: ${(err as Error).message}`)
    }
  }
  return { markdown: out + markdown.slice(at), warnings }
}
