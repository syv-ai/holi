export type MermaidLabel = { id: string; label: string; from: number; to: number }
export type MinimalTextChange = { from: number; to: number; insert: string }

/** Return one minimal replacement range that transforms oldText into newText. */
export function minimalTextChange(oldText: string, newText: string): MinimalTextChange {
  let prefix = 0
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix])
    prefix++
  let suffix = 0
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  )
    suffix++
  return {
    from: prefix,
    to: oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  }
}
export type MermaidLabelAnalysis =
  { supported: true; labels: MermaidLabel[] } | { supported: false; reason: string }

const unsupported = (): MermaidLabelAnalysis => ({
  supported: false,
  reason: 'This diagram uses syntax that cannot be safely edited as labels.',
})
const startId = (char: string | undefined) => !!char && /[A-Za-z_]/.test(char)
const idChar = (char: string | undefined) => !!char && /[A-Za-z0-9_-]/.test(char)
const directions = new Set(['TB', 'TD', 'BT', 'RL', 'LR'])
const shapeDelimiters = [
  ['[[', ']]'],
  ['((', '))'],
  ['([', '])'],
  ['[(', ')]'],
  ['{{', '}}'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
] as const
const namedEntities: Record<string, string> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: '\u00a0',
}

function decodeMermaidLabel(value: string): string {
  return value.replace(
    /(?:&(?:#([0-9]+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt|nbsp));|#(?:([0-9]+)|x([0-9a-f]+)|(amp|quot|apos|lt|gt|nbsp));)/gi,
    (entity, htmlDecimal, htmlHex, htmlName, decimal, hex, name: string | undefined) => {
      if (htmlDecimal || htmlHex || decimal || hex) {
        const digits = htmlDecimal ?? htmlHex ?? decimal ?? hex
        const code = Number.parseInt(digits, htmlHex || hex ? 16 : 10)
        return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : entity
      }
      return namedEntities[(htmlName ?? name)!.toLowerCase()] ?? entity
    },
  )
}

function encodeMermaidLabel(value: string): string {
  return value.replace(/[&"<>`]|#(?=(?:[0-9]+|x[0-9a-f]+|[a-z]+);)|\*\*|__/gi, (token) =>
    token === '&' ? '&amp;' : [...token].map((char) => `#${char.charCodeAt(0)};`).join(''),
  )
}

/** Analyse a deliberately bounded, round-trippable graph/flowchart source grammar. */
export function analyseMermaidLabels(source: string): MermaidLabelAnalysis {
  const labels: MermaidLabel[] = []
  const declared = new Set<string>()
  let i = 0
  const skipSpace = () => {
    while (source[i] === ' ' || source[i] === '\t' || source[i] === '\r') i++
  }
  const skipComment = () => {
    while (i < source.length && source[i] !== '\n') i++
  }
  const readWord = () => {
    if (!startId(source[i])) return null
    const from = i++
    while (idChar(source[i]) && !(source[i] === '-' && source[i + 1] === '-')) i++
    return source.slice(from, i)
  }
  const lineBreak = () => {
    if (source[i] === '\r' && source[i + 1] === '\n') i += 2
    else if (source[i] === '\n') i++
    else return false
    return true
  }

  // Comments may precede the one required header.
  while (i < source.length) {
    skipSpace()
    if (lineBreak()) continue
    if (source.slice(i, i + 2) === '%%' && !source.startsWith('%%{', i)) {
      skipComment()
      lineBreak()
      continue
    }
    break
  }
  const header = /^(?:graph|flowchart)[ \t]+(TB|TD|BT|RL|LR)(?=[ \t\r\n;]|$)/.exec(source.slice(i))
  if (!header || !directions.has(header[1]!)) return unsupported()
  i += header[0].length
  skipSpace()
  if (source[i] === ';') i++
  else if (
    i < source.length &&
    source[i] !== '\n' &&
    source[i] !== '\r' &&
    source.slice(i, i + 2) !== '%%'
  )
    return unsupported()
  else lineBreak()

  let statements = 0
  while (i < source.length) {
    skipSpace()
    if (i >= source.length) break
    if (source.slice(i, i + 3) === '%%{') return unsupported()
    if (source.slice(i, i + 2) === '%%') {
      skipComment()
      lineBreak()
      continue
    }
    if (source[i] === ';' || lineBreak()) continue
    let endpoints = 0
    while (true) {
      skipSpace()
      const id = readWord()
      if (!id) return unsupported()
      skipSpace()
      const shape = shapeDelimiters.find(([open]) => source.startsWith(open, i))
      if (shape) {
        if (declared.has(id)) return unsupported()
        const [open, close] = shape
        i += open.length
        skipSpace()
        const quoted = source[i] === '"'
        if (quoted) i++
        const from = i
        while (i < source.length && (quoted ? source[i] !== '"' : !source.startsWith(close, i))) {
          const c = source[i]!
          if (c === '\n' || c === '\r' || /[\u0000-\u001f\u007f]/.test(c) || c === '<' || c === '>')
            return unsupported()
          if (
            !quoted &&
            (c === '[' ||
              c === ']' ||
              c === '(' ||
              c === ')' ||
              c === '{' ||
              c === '}' ||
              c === '"' ||
              c === '\\')
          )
            return unsupported()
          i++
        }
        if (i >= source.length) return unsupported()
        const to = i
        const raw = source.slice(from, to)
        if (!raw.trim() || /\*\*|__|\[[^\]]+\]\(/.test(raw)) return unsupported()
        if (quoted) {
          i++
          skipSpace()
          if (!source.startsWith(close, i)) return unsupported()
        } else if (raw.trim() !== raw) return unsupported()
        i += close.length
        labels.push({ id, label: decodeMermaidLabel(raw), from, to })
        declared.add(id)
      }
      endpoints++
      skipSpace()
      if (source.slice(i, i + 3) !== '-->') break
      i += 3
      skipSpace()
      if (!startId(source[i])) return unsupported()
    }
    if (!endpoints) return unsupported()
    statements++
    skipSpace()
    if (source.slice(i, i + 2) === '%%') {
      skipComment()
      lineBreak()
      continue
    }
    if (source[i] === ';') {
      i++
      continue
    }
    if (i >= source.length || lineBreak()) continue
    return unsupported()
  }
  return statements ? { supported: true, labels } : unsupported()
}

export function patchMermaidLabel(
  source: string,
  id: string,
  label: string,
): { source: string } | { error: string } {
  if (!label.trim()) return { error: 'A label cannot be blank.' }
  if (/[\r\n\u0000-\u001f\u007f]/.test(label))
    return { error: 'Labels must be a single line without control characters.' }
  const result = analyseMermaidLabels(source)
  if (!result.supported) return { error: result.reason }
  const item = result.labels.find((entry) => entry.id === id)
  if (!item) return { error: 'This node does not have an editable label.' }
  if (item.label === label) return { source }
  const encoded = encodeMermaidLabel(label)
  const quoted = source[item.from - 1] === '"'
  const token =
    !quoted && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(encoded) ? `"${encoded}"` : encoded
  return { source: source.slice(0, item.from) + token + source.slice(item.to) }
}
