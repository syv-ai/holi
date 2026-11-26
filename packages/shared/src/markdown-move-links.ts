import { GFM, parser } from '@lezer/markdown'

const markdownParser = parser.configure(GFM)

/** Rebase relative inline Markdown destinations while preserving all other source bytes. */
export function rewriteMarkdownMoveLinks(text: string, from: string, to: string): string {
  const bom = text.startsWith('\uFEFF')
  const source = bom ? text.slice(1) : text
  const normalized = source.replaceAll('\r\n', '\n')
  const tree = markdownParser.parse(normalized)
  const edits: Array<{ from: number; to: number; value: string }> = []
  tree.iterate({
    enter(node) {
      if (node.name !== 'Link') return
      const url = node.node.getChild('URL')
      if (!url) return
      const raw = normalized.slice(url.from, url.to)
      const angle = raw.startsWith('<') && raw.endsWith('>')
      const destination = angle ? raw.slice(1, -1) : raw
      if (
        !destination ||
        /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(destination) ||
        destination.startsWith('//')
      )
        return
      let decoded: string
      try {
        decoded = decodeURIComponent(destination.replaceAll('\\ ', ' '))
      } catch {
        return
      }
      if (decoded.includes('\\') || decoded.split(/[?#]/, 1)[0]!.split('/').includes('..')) return
      const hash = decoded.search(/[?#]/)
      const pathname = hash < 0 ? decoded : decoded.slice(0, hash)
      const suffix = hash < 0 ? '' : decoded.slice(hash)
      if (!pathname) return
      const parent = from.split('/').slice(0, -1)
      const resolved = [...parent]
      for (const part of pathname.split('/')) {
        if (part === '.' || !part) continue
        if (part === '..') {
          if (!resolved.length) return
          resolved.pop()
        } else resolved.push(part)
      }
      const target = resolved.join('/')
      const movedParent = to.split('/').slice(0, -1)
      const relative: string[] = []
      let common = 0
      while (
        common < movedParent.length &&
        common < resolved.length &&
        movedParent[common] === resolved[common]
      )
        common++
      relative.push(...Array(movedParent.length - common).fill('..'), ...resolved.slice(common))
      let replacement = relative.join('/') || '.'
      if (pathname.endsWith('/') && !replacement.endsWith('/')) replacement += '/'
      if (replacement === pathname) return
      replacement += suffix
      const encoded = replacement.replaceAll(' ', '%20')
      const value = angle ? `<${encoded}>` : encoded
      const start = url.from + (angle ? 1 : 0)
      const end = url.to - (angle ? 1 : 0)
      edits.push({ from: start, to: end, value })
      void target
    },
  })
  let result = normalized
  for (const edit of edits.sort((a, b) => b.from - a.from))
    result = result.slice(0, edit.from) + edit.value + result.slice(edit.to)
  // Parsing normalizes CRLF offsets; translate edits via original line endings instead.
  if (source.includes('\r\n')) {
    const lines = source.split('\r\n')
    const converted = result.split('\n')
    if (lines.length === converted.length) result = converted.join('\r\n')
  }
  return `${bom ? '\uFEFF' : ''}${result}`
}
