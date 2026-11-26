import { GFM, parser } from '@lezer/markdown'
import { decodeHTMLStrict } from 'entities/decode'

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

function destinationParts(raw: string): { pathname: string; suffix: string } {
  let pathname = ''
  let cursor = 0
  const tokens =
    /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])|&(?:#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});|[?#]/gi
  for (const token of raw.matchAll(tokens)) {
    pathname += raw.slice(cursor, token.index)
    const decoded = token[1] ?? decodeHTMLStrict(token[0])
    const separator = decoded.search(/[?#]/)
    if (separator >= 0)
      return { pathname: pathname + decoded.slice(0, separator), suffix: raw.slice(token.index) }
    pathname += decoded
    cursor = token.index + token[0].length
  }
  return { pathname: pathname + raw.slice(cursor), suffix: '' }
}

// Lezer does not honor escaped angle delimiters. Mask only candidate URL contents
// for parsing; edits still use original text and unchanged UTF-16 source offsets.
function parseableSource(text: string): string {
  let characters: string[] | undefined
  let scanned = 0
  for (const candidate of text.matchAll(/\]\([ \t\r\n]*</g)) {
    if (candidate.index < scanned) continue
    let index = candidate.index + candidate[0].length
    while (index < text.length && text[index] !== '>' && !/[\r\n]/.test(text[index]!)) {
      if (text[index] === '\\') {
        if (text[index + 1] === '<' || text[index + 1] === '>') {
          characters ??= text.split('')
          characters[index] = 'a'
          characters[index + 1] = 'a'
        }
        index += 2
      } else index++
    }
    scanned = index
  }
  return characters?.join('') ?? text
}

function validDestination(raw: string): boolean {
  const angle = raw.startsWith('<') && raw.endsWith('>')
  const value = angle ? raw.slice(1, -1) : raw
  let depth = 0
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (
      character === '\\' &&
      /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(value[index + 1] ?? '')
    ) {
      index++
      continue
    }
    if (character === '<' || character === '>' || /[\r\n]/.test(character)) return false
    if (!angle) {
      if (/\s/.test(character)) return false
      if (character === '(') depth++
      if (character === ')' && --depth < 0) return false
    }
  }
  return depth === 0
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
  markdownParser.parse(parseableSource(text.slice(bodyStart))).iterate({
    enter(node) {
      if (node.name !== 'Link' && node.name !== 'Image') return
      const url = node.node.getChild('URL')
      if (!url) return
      const from = bodyStart + url.from
      const to = bodyStart + url.to
      const raw = text.slice(from, to)
      if (!validDestination(raw)) return
      const angle = raw.startsWith('<') && raw.endsWith('>')
      const destination = angle ? raw.slice(1, -1) : raw
      const { pathname, suffix } = destinationParts(destination)
      if (!pathname || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(pathname)) return
      // Encoded separators are ambiguous across URL and filesystem path adapters.
      if (/%(?:2f|5c)/i.test(pathname)) return
      let decoded: string
      try {
        decoded = decodeURIComponent(pathname)
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
