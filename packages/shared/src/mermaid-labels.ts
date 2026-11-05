export type MermaidLabel = { id: string; label: string; from: number; to: number }
export type MermaidLabelAnalysis =
  { supported: true; labels: MermaidLabel[] } | { supported: false; reason: string }
const startId = (c: string | undefined) => !!c && /[A-Za-z_]/.test(c)
const idChar = (c: string | undefined) => !!c && /[A-Za-z0-9_-]/.test(c)
const unsupported = (): MermaidLabelAnalysis => ({
  supported: false,
  reason: 'This diagram uses syntax that cannot be safely edited as labels.',
})

/** Analyse only the bounded, round-trippable graph/flowchart grammar. */
export function analyseMermaidLabels(source: string): MermaidLabelAnalysis {
  const labels: MermaidLabel[] = []
  const declared = new Set<string>()
  let i = 0
  const spaces = () => {
    while (i < source.length && /[ \t\r]/.test(source[i]!)) i++
  }
  const word = () => {
    if (!startId(source[i])) return null
    const from = i++
    while (idChar(source[i])) i++
    return source.slice(from, i)
  }
  spaces()
  const diagram = word()
  if (diagram !== 'graph' && diagram !== 'flowchart') return unsupported()
  spaces()
  if (!['TB', 'TD', 'BT', 'RL', 'LR'].includes(source.slice(i, i + 2))) return unsupported()
  i += 2
  let statements = 0
  while (i < source.length) {
    spaces()
    if (source[i] === '\n' || source[i] === ';') {
      i++
      continue
    }
    if (i >= source.length) break
    if (source.slice(i, i + 2) === '%%') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (source[i] === '%') return unsupported()
    let endpointCount = 0
    while (true) {
      spaces()
      const id = word()
      if (!id) return unsupported()
      spaces()
      if (source[i] === '[') {
        if (declared.has(id)) return unsupported()
        i++
        spaces()
        const quoted = source[i] === '"'
        if (quoted) i++
        const from = i
        while (i < source.length && (quoted ? source[i] !== '"' : source[i] !== ']')) {
          if (
            source[i] === '\n' ||
            source[i] === '\r' ||
            source[i] === '\\' ||
            (!quoted && (source[i] === '[' || source[i] === '"'))
          )
            return unsupported()
          i++
        }
        if (i >= source.length || (quoted && source[i] !== '"')) return unsupported()
        const to = i
        const raw = source.slice(from, to)
        if (!quoted && (!raw.trim() || raw.trim() !== raw || /<|>/.test(raw))) return unsupported()
        const label = decodeMermaidLabel(raw)
        if (!quoted) {
          /* plain labels end at the closing bracket */
        } else {
          i++
          spaces()
          if (source[i] !== ']') return unsupported()
        }
        i++
        labels.push({ id, label, from, to })
        declared.add(id)
      }
      endpointCount++
      spaces()
      if (source.slice(i, i + 3) !== '-->') break
      i += 3
      spaces()
      if (!startId(source[i])) return unsupported()
    }
    if (!endpointCount) return unsupported()
    statements++
    spaces()
    if (
      i < source.length &&
      source[i] !== '\n' &&
      source[i] !== ';' &&
      source.slice(i, i + 2) !== '%%'
    )
      return unsupported()
  }
  return statements ? { supported: true, labels } : unsupported()
}
function decodeMermaidLabel(value: string): string {
  return value.replace(
    /#(amp|quot|lt|gt|35);/g,
    (_m, key: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', 35: '#' })[key]!,
  )
}
export function encodeMermaidLabel(value: string): string {
  return value.replace(
    /[&#"<>]/g,
    (char) => ({ '&': '#amp;', '#': '#35;', '"': '#quot;', '<': '#lt;', '>': '#gt;' })[char]!,
  )
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
  return { source: source.slice(0, item.from) + encodeMermaidLabel(label) + source.slice(item.to) }
}
