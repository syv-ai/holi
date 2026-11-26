import { GFM, parser } from '@lezer/markdown'

const markdownParser = parser.configure(GFM)

function resolvePath(directory: string[], path: string): string[] | null {
  const result = [...directory]
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!result.length) return null
      result.pop()
    } else result.push(part)
  }
  return result
}

/** Preserve relative inline destinations when a document or its target moves. */
export function rewriteMarkdownMoveLinks(
  text: string,
  documentPath: string,
  movedFrom: string,
  movedTo: string,
): string {
  const bom = text.startsWith('\uFEFF') ? 1 : 0
  const source = text.slice(bom)
  // Match the existing frontmatter fence grammar, retaining original source offsets.
  const fence = source.startsWith('---\n') || source.startsWith('---\r\n')
  const closing = fence ? /\n---[^\n]*(?:\n|$)/.exec(source) : null
  const bodyStart = fence ? (closing ? bom + closing.index + closing[0].length : text.length) : bom
  const oldDirectory = documentPath.split('/').slice(0, -1)
  const documentMoved = documentPath === movedFrom
  const newDirectory = documentMoved ? movedTo.split('/').slice(0, -1) : oldDirectory
  const edits: Array<{ from: number; to: number; value: string }> = []
  markdownParser.parse(text.slice(bodyStart)).iterate({
    enter(node) {
      if (node.name !== 'Link' && node.name !== 'Image') return
      const url = node.node.getChild('URL')
      if (!url) return
      const from = bodyStart + url.from
      const to = bodyStart + url.to
      const raw = text.slice(from, to)
      const angle = raw.startsWith('<') && raw.endsWith('>')
      const destination = angle ? raw.slice(1, -1) : raw
      if (!destination || /^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(destination)) return
      const cut = destination.search(/[?#]/)
      const pathname = cut < 0 ? destination : destination.slice(0, cut)
      const suffix = cut < 0 ? '' : destination.slice(cut)
      // Encoded separators and entities cannot safely identify a vault path here.
      if (/%(?:2f|5c)/i.test(pathname) || /&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(pathname)) return
      let decoded: string
      try {
        decoded = decodeURIComponent(
          pathname.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1'),
        )
      } catch {
        return
      }
      if (/[\x00-\x1f\x7f\\]/.test(decoded)) return
      const resolved = resolvePath(oldDirectory, decoded)
      if (!resolved) return
      const targetMoved = resolved.join('/') === movedFrom
      if (!documentMoved && !targetMoved) return
      const target = targetMoved ? movedTo.split('/') : resolved
      let common = 0
      while (
        common < newDirectory.length &&
        common < target.length &&
        newDirectory[common] === target[common]
      )
        common++
      const relative =
        [...Array(newDirectory.length - common).fill('..'), ...target.slice(common)].join('/') ||
        '.'
      const originalResolved = resolvePath(newDirectory, decoded)
      if (originalResolved?.join('/') === target.join('/')) return
      let encoded = relative
        .split('/')
        .map((part) =>
          encodeURIComponent(part).replace(
            /[!'()*]/g,
            (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
        )
        .join('/')
      if (pathname.endsWith('/') && !encoded.endsWith('/')) encoded += '/'
      edits.push({
        from: from + (angle ? 1 : 0),
        to: to - (angle ? 1 : 0),
        value: `${encoded}${suffix}`,
      })
    },
  })
  let result = text
  for (const edit of edits.sort((left, right) => right.from - left.from))
    result = result.slice(0, edit.from) + edit.value + result.slice(edit.to)
  return result
}
