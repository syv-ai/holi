import type { EditorState } from '@tiptap/pm/state'

export const STRUCTURAL_CONTAINERS = ['tableCell', 'tableHeader', 'listItem', 'taskItem']

export function textBlocks(state: EditorState) {
  const result: { from: number; to: number; node: typeof state.doc }[] = []
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) result.push({ from: pos + 1, to: pos + node.nodeSize - 1, node })
  })
  return result
}

export function graphemeParts(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(
      ({ segment }) => segment,
    )
  }
  return Array.from(value)
}

export function graphemeBoundaries(state: EditorState, from: number, to: number) {
  const positions = new Set<number>([from, to])
  let runText = ''
  let runStart = 0
  let runEnd = 0
  const flushText = () => {
    if (!runText) return
    let offset = 0
    for (const part of graphemeParts(runText)) {
      offset += part.length
      positions.add(runStart + offset)
    }
    runText = ''
  }
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) {
      if (runText && pos !== runEnd) flushText()
      if (!runText) runStart = pos
      runText += node.text ?? ''
      runEnd = pos + node.nodeSize
    } else if (node.isInline && !node.isText) {
      flushText()
      positions.add(pos)
      positions.add(pos + node.nodeSize)
    }
  })
  flushText()
  return [...positions].filter((pos) => pos >= from && pos <= to).sort((a, b) => a - b)
}

export function logicalLines(block: ReturnType<typeof textBlocks>[number]) {
  const breaks: number[] = []
  block.node.descendants((node, offset) => {
    if (node.type.name === 'hardBreak') breaks.push(block.from + offset)
    if (block.node.type.name === 'codeBlock' && node.isText) {
      for (let index = 0; index < (node.text ?? '').length; index++)
        if (node.text?.[index] === '\n') breaks.push(block.from + offset + index)
    }
  })
  const lines: { block: typeof block; from: number; to: number }[] = []
  let from = block.from
  for (const at of breaks) {
    lines.push({ block, from, to: at })
    from = at + 1
  }
  lines.push({ block, from, to: block.to })
  return lines
}

export function logicalLineAt(state: EditorState, pos: number) {
  const block = textBlocks(state).find(({ from, to }) => pos >= from && pos <= to)
  return block
    ? (logicalLines(block).find((line) => pos >= line.from && pos <= line.to) ?? null)
    : null
}

export function logicalLineDeletion(
  lines: ReturnType<typeof logicalLines>,
  firstIndex: number,
  lastIndex: number,
  consumeFollowingSeparator = false,
) {
  const first = lines[firstIndex]
  const last = lines[lastIndex]
  if (!first || !last) return null
  const previous = lines[firstIndex - 1]
  const next = lines[lastIndex + 1]
  // First-line deletion consumes its following separator so the next line
  // joins in its place; change leaves it to preserve the empty insertion line.
  return {
    from: previous ? previous.to : first.from,
    to: next && !previous && consumeFollowingSeparator ? next.from : last.to,
    contentFrom: first.from,
    contentTo: last.to,
  }
}

/** Keep the replacement line on the preceding separator and retain the trailing separator. */
export function logicalLineChange(
  lines: ReturnType<typeof logicalLines>,
  firstIndex: number,
  lastIndex: number,
) {
  const first = lines[firstIndex]
  const last = lines[lastIndex]
  if (!first || !last) return null
  return { from: first.from, to: last.to }
}

export function containerAt(state: EditorState, pos: number, names = STRUCTURAL_CONTAINERS) {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)))
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (!STRUCTURAL_CONTAINERS.includes(node.type.name)) continue
    return names.includes(node.type.name) ? { type: node.type.name, pos: $pos.before(depth) } : null
  }
  return null
}

export function safeRange(state: EditorState, from: number, to: number) {
  const touched = textBlocks(state).filter((block) => block.from <= to && block.to >= from)
  const origin = containerAt(state, from)
  return touched.every((block) => {
    const nested = containerAt(state, block.from)
    return origin?.pos === nested?.pos && origin?.type === nested?.type
  })
}
