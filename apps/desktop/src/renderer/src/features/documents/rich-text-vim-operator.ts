import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import {
  containerAt,
  graphemeBoundaries,
  logicalLineAt,
  logicalLineChange,
  logicalLineDeletion,
  logicalLines,
  normalCaret,
  safeRange,
  STRUCTURAL_CONTAINERS,
  textBlocks,
} from './rich-text-vim-range'
import type { VimRegister } from './rich-text-vim-register'

type VimOperator = 'd' | 'c' | 'y'
type VimOperatorTarget =
  | {
      kind: 'motion'
      origin: number
      motion: 'w' | 'b' | 'e' | 'h' | 'l' | 'j' | 'k' | '0' | '^' | '$'
      count: number
    }
  | { kind: 'doubled'; origin: number; count: number }
  | { kind: 'visual'; anchor: number; cursor: number; linewise: boolean }

export type VimOperatorRequest = { operator: VimOperator; target: VimOperatorTarget }
type SchemaIntent =
  | { kind: 'inline' }
  | { kind: 'logical-lines'; textblock: 'codeBlock' | 'hardBreak' }
  | { kind: 'textblocks'; container: { pos: number; type: string } | null }
  | { kind: 'list-items'; container: { pos: number; type: 'listItem' | 'taskItem' } }
type PrimitiveMutation =
  | { kind: 'delete'; range: { from: number; to: number }; replacement?: never }
  | { kind: 'replace'; range: { from: number; to: number }; replacement: Slice }
type Mutation = PrimitiveMutation | { kind: 'sequence'; edits: readonly PrimitiveMutation[] }

export type VimOperatorPlan =
  | { kind: 'noop' }
  | { kind: 'rejected'; feedback: string }
  | {
      kind: 'ready'
      sourceDoc: EditorState['doc']
      operator: VimOperator
      contentRange: { from: number; to: number }
      register: VimRegister
      mutation: Mutation | null
      caret: { position: number; bias: -1 | 1; mode: 'normal' | 'insert' }
      nativeSchema: SchemaIntent
    }

const rejected = (scope: 'motion' | 'selection' | 'line' = 'motion'): VimOperatorPlan => ({
  kind: 'rejected',
  feedback:
    scope === 'line'
      ? 'Vim line range does not fit in this list; no text was changed'
      : `Vim ${scope} crosses a list or table; no text was changed`,
})
const countOf = (count: number) => Math.min(999, Math.max(1, count))
const wordPattern = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*$/u

function words(state: EditorState) {
  const chars: { value: string; from: number; to: number }[] = []
  for (const block of textBlocks(state)) {
    const boundaries = graphemeBoundaries(state, block.from, block.to)
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const from = boundaries[i]!
      const to = boundaries[i + 1]!
      chars.push({
        value: state.doc.textBetween(from, to, '\u0000', '\u0000') || '\u0000',
        from,
        to,
      })
    }
    chars.push({ value: ' ', from: block.to, to: block.to })
  }
  return chars
}
function wordDestination(state: EditorState, pos: number, motion: 'w' | 'b' | 'e') {
  const chars = words(state)
  const isWord = (index: number) => !!chars[index] && wordPattern.test(chars[index]!.value)
  const current = chars.findIndex((item) => item.from <= pos && pos < item.to)
  const firstAfter = chars.findIndex((item) => item.from >= pos)
  if (motion === 'w') {
    const start = current >= 0 ? current + 1 : firstAfter < 0 ? chars.length : firstAfter
    for (let i = start; i < chars.length; i++)
      if (isWord(i) && (i === 0 || !isWord(i - 1))) return chars[i]!.from
  } else if (motion === 'b') {
    for (let i = chars.length - 1; i >= 0; i--) {
      if (chars[i]!.from >= pos) continue
      if (isWord(i) && (i === 0 || !isWord(i - 1))) return chars[i]!.from
    }
    return chars.find((item) => item.from < pos)?.from ?? pos
  } else {
    const end = current >= 0 && isWord(current) && !isWord(current + 1)
    const start = current >= 0 ? current + Number(end) : firstAfter < 0 ? chars.length : firstAfter
    for (let i = start; i < chars.length; i++)
      if (isWord(i) && !isWord(i + 1)) return chars[i]!.from
  }
  return pos
}
function lineDestination(state: EditorState, pos: number, key: '0' | '^' | '$', count = 1) {
  const line = logicalLineAt(state, pos)
  if (!line) return pos
  const all = textBlocks(state).flatMap((block) => logicalLines(block))
  const container = containerAt(state, line.block.from, STRUCTURAL_CONTAINERS)
  const matching = all.filter((candidate) => {
    const other = containerAt(state, candidate.block.from, STRUCTURAL_CONTAINERS)
    return container ? container.pos === other?.pos && container.type === other.type : !other
  })
  const index = matching.findIndex((candidate) => candidate.from === line.from)
  const target =
    key === '$' ? (matching[Math.min(matching.length - 1, index + count - 1)] ?? line) : line
  const bounds = graphemeBoundaries(state, target.from, target.to)
  if (key === '0') return target.from
  if (key === '$') return bounds.length > 1 ? bounds.at(-2)! : target.from
  return (
    bounds.find((at) => state.doc.textBetween(at, bounds.find((next) => next > at) ?? at).trim()) ??
    target.to
  )
}
export function resolveVimMotion(
  state: EditorState,
  origin: number,
  motion: 'w' | 'b' | 'e' | 'h' | 'l' | 'j' | 'k' | '0' | '^' | '$',
  count: number,
) {
  let pos = origin
  if (motion === '$') return lineDestination(state, origin, '$', count)
  for (let i = 0; i < count; i++) {
    const line = logicalLineAt(state, pos)
    if (!line) break
    if (motion === 'w' || motion === 'b' || motion === 'e')
      pos = wordDestination(state, pos, motion)
    else if (motion === '0' || motion === '^') pos = lineDestination(state, pos, motion)
    else if (motion === 'h' || motion === 'l') {
      const bounds = graphemeBoundaries(state, line.from, line.to)
      pos =
        motion === 'h'
          ? ([...bounds].reverse().find((at) => at < pos) ?? pos)
          : (bounds.find((at) => at > pos && at < line.to) ?? pos)
    } else {
      const withinBlock =
        motion === 'j'
          ? line.to < line.block.to
            ? logicalLineAt(state, line.to + 1)
            : null
          : line.from > line.block.from
            ? logicalLineAt(state, line.from - 1)
            : null
      const all = textBlocks(state)
      const blockIndex = all.findIndex((block) => block.from === line.block.from)
      const target = all[blockIndex + (motion === 'j' ? 1 : -1)]
      const targetLine =
        withinBlock ??
        (target ? logicalLineAt(state, motion === 'j' ? target.from : target.to) : null)
      if (!targetLine) break
      const boundaries = graphemeBoundaries(state, targetLine.from, targetLine.to)
      const bounds = boundaries.length > 1 ? boundaries.slice(0, -1) : boundaries
      pos =
        bounds.find((at) => at >= targetLine.from + pos - line.from) ??
        bounds.at(-1) ??
        targetLine.from
    }
  }
  return pos
}
export function resolveVimVisualRange(
  state: EditorState,
  anchor: number,
  cursor: number,
  linewise: boolean,
) {
  if (!linewise) {
    const low = Math.min(anchor, cursor)
    const high = Math.max(anchor, cursor)
    const line = logicalLineAt(state, high)
    const end = line && graphemeBoundaries(state, line.from, line.to).find((at) => at > high)
    return {
      from: low,
      to: end ?? high,
      anchor: cursor >= anchor ? anchor : (end ?? high),
      head: cursor >= anchor ? (end ?? high) : low,
      linewiseTextblock: undefined as undefined | 'codeBlock' | 'hardBreak',
    }
  }
  const first = logicalLineAt(state, Math.min(anchor, cursor))
  const last = logicalLineAt(state, Math.max(anchor, cursor))
  if (!first || !last) return null
  if (first.block.from === last.block.from && logicalLines(first.block).length > 1)
    return {
      from: first.from,
      to: last.to,
      anchor: cursor >= anchor ? first.from : last.to,
      head: cursor >= anchor ? last.to : first.from,
      linewiseTextblock:
        first.block.node.type.name === 'codeBlock'
          ? ('codeBlock' as const)
          : ('hardBreak' as const),
    }
  if (
    (logicalLines(first.block).length > 1 && first.from !== first.block.from) ||
    (logicalLines(last.block).length > 1 && last.to !== last.block.to)
  )
    return null
  return {
    from: first.block.from - 1,
    to: last.block.to + 1,
    anchor: cursor >= anchor ? first.from : last.to,
    head: cursor >= anchor ? last.to : first.from,
    linewiseTextblock: undefined,
  }
}
function registerFor(
  state: EditorState,
  from: number,
  to: number,
  linewise: boolean,
  textblock?: 'codeBlock' | 'hardBreak',
  container?: 'listItem' | 'taskItem',
): VimRegister {
  return {
    content: state.doc.slice(from, to),
    schema: state.schema,
    linewise,
    linewiseTextblock: textblock,
    linewiseContainer: container,
  }
}
function mutationEdits(mutation: Mutation): readonly PrimitiveMutation[] {
  return mutation.kind === 'sequence' ? mutation.edits : [mutation]
}

function mutationSequence(edits: readonly PrimitiveMutation[]): Mutation {
  const ordered = [...edits].sort((left, right) => right.range.from - left.range.from)
  return ordered.length === 1 ? ordered[0]! : { kind: 'sequence', edits: ordered }
}

function changedListItem(node: ProseMirrorNode, itemPosition: number, from: number, to: number) {
  const edits: PrimitiveMutation[] = []
  let position = itemPosition + 1
  let caret = itemPosition + 2
  node.forEach((child) => {
    const childPosition = position
    if (child.isTextblock && childPosition + 1 >= from && childPosition + 1 <= to) {
      if (edits.length === 0) caret = childPosition + 1
      edits.push({
        kind: 'replace',
        range: { from: childPosition, to: childPosition + child.nodeSize },
        replacement: new Slice(
          Fragment.from(child.type.create(child.attrs, null, child.marks)),
          0,
          0,
        ),
      })
    }
    position += child.nodeSize
  })
  if (edits.length === 0) return null
  return { edits, caret }
}

function allowedRange(
  state: EditorState,
  range: { from: number; to: number },
  intent: SchemaIntent,
) {
  if (intent.kind !== 'list-items') return safeRange(state, range.from, range.to)
  if (safeRange(state, range.from, range.to)) return true
  try {
    const $from = state.doc.resolve(range.from)
    const $to = state.doc.resolve(range.to)
    if ($from.parent !== $to.parent || $from.depth !== $to.depth) return false
    const start = $from.index()
    const end = $to.index()
    if (end <= start) return false
    for (let index = start; index < end; index++)
      if ($from.parent.child(index).type.name !== intent.container.type) return false
    return true
  } catch {
    return false
  }
}

function result(
  state: EditorState,
  operator: VimOperator,
  contentRange: { from: number; to: number },
  register: VimRegister,
  mutation: Mutation | null,
  caretPosition: number,
  nativeSchema: SchemaIntent,
): VimOperatorPlan {
  if (
    contentRange.from < 0 ||
    contentRange.to < contentRange.from ||
    contentRange.to > state.doc.content.size
  )
    return rejected()
  if (operator === 'd' && !mutation && contentRange.from === contentRange.to)
    return { kind: 'noop' }
  if (
    !allowedRange(state, contentRange, nativeSchema) ||
    (mutation &&
      mutationEdits(mutation).some((edit) => !allowedRange(state, edit.range, nativeSchema)))
  )
    return rejected()
  try {
    const tr = state.tr
    for (const edit of mutation ? mutationEdits(mutation) : []) {
      if (edit.kind === 'delete') tr.delete(edit.range.from, edit.range.to)
      else tr.replaceWith(edit.range.from, edit.range.to, edit.replacement.content)
    }
    tr.doc.check()
    // Changes name a position inside their replacement; deletes name surviving source content.
    const mapped = operator === 'c' ? caretPosition : tr.mapping.map(caretPosition, 1)
    const bounded = Math.max(0, Math.min(mapped, tr.doc.content.size))
    const position =
      operator === 'c'
        ? TextSelection.near(tr.doc.resolve(bounded), 1).head
        : normalCaret(EditorState.create({ doc: tr.doc }), bounded)
    return {
      kind: 'ready',
      sourceDoc: state.doc,
      operator,
      contentRange,
      register,
      mutation,
      caret: { position, bias: 1, mode: operator === 'c' ? 'insert' : 'normal' },
      nativeSchema,
    }
  } catch {
    return rejected()
  }
}

export function planVimOperator(state: EditorState, request: VimOperatorRequest): VimOperatorPlan {
  const { operator, target } = request
  const removal = operator !== 'y'
  if (target.kind === 'doubled') {
    const line = logicalLineAt(state, target.origin)
    if (!line) return { kind: 'noop' }
    const block = line.block
    const item = containerAt(state, block.from, ['listItem', 'taskItem'])
    if (item) {
      const node = state.doc.nodeAt(item.pos)
      const count = countOf(target.count)
      const $item = state.doc.resolve(item.pos)
      const index = $item.index()
      const siblings = Array.from({ length: count }, (_, offset) =>
        $item.parent.maybeChild(index + offset),
      )
      if (siblings.some((candidate) => !candidate || candidate.type.name !== item.type))
        return rejected('line')
      const nodes = siblings as NonNullable<(typeof siblings)[number]>[]
      const end = item.pos + nodes.reduce((sum, sibling) => sum + sibling.nodeSize, 0)
      const register = registerFor(
        state,
        item.pos,
        end,
        true,
        undefined,
        item.type as 'listItem' | 'taskItem',
      )
      let mutation: Mutation | null = null
      let caret = item.pos
      if (removal) {
        if (operator === 'c' && node) {
          const changed = changedListItem(node, item.pos, block.from, block.from)
          if (!changed) return rejected('line')
          const edits = [...changed.edits]
          if (nodes.length > 1)
            edits.push({ kind: 'delete', range: { from: item.pos + node.nodeSize, to: end } })
          mutation = mutationSequence(edits)
          caret = changed.caret
        } else mutation = { kind: 'delete', range: { from: item.pos, to: end } }
      }
      return result(
        state,
        operator,
        { from: item.pos, to: end },
        register,
        mutation,
        operator === 'y' ? target.origin : caret,
        {
          kind: 'list-items',
          container: { pos: item.pos, type: item.type as 'listItem' | 'taskItem' },
        },
      )
    }
    const logical = logicalLines(block)
    const idx = logical.findIndex((candidate) => candidate.from === line.from)
    if (logical.length > 1 && idx >= 0) {
      const following = textBlocks(state).find((candidate) => candidate.from > block.to)
      const trailingParagraph =
        following?.node.type.name === 'paragraph' &&
        following.node.content.size === 0 &&
        following.to + 1 === state.doc.content.size &&
        state.doc.resolve(following.from).depth === 1
      if (idx + countOf(target.count) > logical.length && following && !trailingParagraph)
        return rejected()
      const last = Math.min(logical.length - 1, idx + countOf(target.count) - 1)
      const deletion = logicalLineDeletion(logical, idx, last, operator === 'd')!
      const change = logicalLineChange(logical, idx, last)!
      const range = operator === 'c' ? change : deletion
      const type = block.node.type.name === 'codeBlock' ? 'codeBlock' : 'hardBreak'
      const register = registerFor(state, deletion.contentFrom, deletion.contentTo, true, type)
      let mutation: Mutation | null = null
      if (removal)
        mutation =
          range.from === block.from && range.to === block.to
            ? {
                kind: 'replace',
                range: { from: block.from - 1, to: block.to + 1 },
                replacement: new Slice(
                  Fragment.from(block.node.type.create(block.node.attrs, null, block.node.marks)),
                  0,
                  0,
                ),
              }
            : { kind: 'delete', range: { from: range.from, to: range.to } }
      return result(
        state,
        operator,
        { from: deletion.contentFrom, to: deletion.contentTo },
        register,
        mutation,
        operator === 'y' ? target.origin : operator === 'd' ? deletion.caret : range.from,
        { kind: 'logical-lines', textblock: type },
      )
    }
    const globalLines = textBlocks(state).flatMap((candidate) => logicalLines(candidate))
    const index = globalLines.findIndex((candidate) => candidate.from === line.from)
    if (index < 0) return rejected()
    const lastLine =
      globalLines[Math.min(globalLines.length - 1, index + countOf(target.count) - 1)]!
    const lastBlock = lastLine.block
    const lastBlockLines = logicalLines(lastBlock)
    const lastLineIndex = lastBlockLines.findIndex((candidate) => candidate.from === lastLine.from)
    // A doubled operator may consume complete logical lines, but may not leave a
    // partially selected multiline textblock at the far end of its range.
    if (lastBlockLines.length > 1 && lastLineIndex !== lastBlockLines.length - 1) return rejected()
    const from = block.from - 1
    const to = lastBlock.to + 1
    const container = containerAt(state, block.from, STRUCTURAL_CONTAINERS)
    if (!safeRange(state, from, to)) return rejected()
    const cell = container?.type === 'tableCell' || container?.type === 'tableHeader'
    const cellNode = cell ? state.doc.nodeAt(container.pos) : null
    const register = registerFor(
      state,
      from,
      to,
      true,
      block.from === lastBlock.from &&
        block.node.type.name === 'codeBlock' &&
        lastBlock.node.type.name === 'codeBlock'
        ? 'codeBlock'
        : undefined,
    )
    const mutation: Mutation | null = !removal
      ? null
      : cell && (operator === 'c' || (cellNode?.childCount ?? 0) <= countOf(target.count))
        ? {
            kind: 'replace',
            range: { from: block.from - 1, to: lastBlock.to + 1 },
            replacement: new Slice(
              Fragment.from(block.node.type.create(block.node.attrs, null, block.node.marks)),
              0,
              0,
            ),
          }
        : operator === 'c'
          ? {
              kind: 'replace',
              range: { from: block.from - 1, to: lastBlock.to + 1 },
              replacement: new Slice(
                Fragment.from(block.node.type.create(block.node.attrs, null, block.node.marks)),
                0,
                0,
              ),
            }
          : { kind: 'delete', range: { from, to } }
    return result(
      state,
      operator,
      { from, to },
      register,
      mutation,
      operator === 'y' ? target.origin : from,
      {
        kind: 'textblocks',
        container,
      },
    )
  }
  if (target.kind === 'motion') {
    const origin = target.origin
    const count = countOf(target.count)
    const line = logicalLineAt(state, origin)
    if (!line) return { kind: 'noop' }
    let destination = resolveVimMotion(state, origin, target.motion, count)
    if (target.motion === 'j' || target.motion === 'k') {
      let cursor = origin
      for (let index = 0; index < count; index++) {
        const next = resolveVimMotion(state, cursor, target.motion, 1)
        if (next === cursor) {
          if (count > 1) return rejected()
          break
        }
        cursor = next
      }
      destination = cursor
    }
    let from = Math.min(origin, destination)
    let to = Math.max(origin, destination)
    let linewise = false
    let textblock: 'codeBlock' | 'hardBreak' | undefined
    let mutation: Mutation | null = null
    if (target.motion === 'l') {
      const bounds = graphemeBoundaries(state, line.from, line.to)
      const index = Math.max(
        0,
        bounds.findIndex((at) => at >= origin),
      )
      destination = bounds[Math.min(bounds.length - 1, index + count)] ?? destination
      from = Math.min(origin, destination)
      to = Math.max(origin, destination)
    }
    if (target.motion === 'w') {
      const chars = words(state)
      const wordSegments: { from: number; to: number }[] = []
      for (let i = 0; i < chars.length; i++) {
        if (!wordPattern.test(chars[i]!.value)) continue
        if (!wordPattern.test(chars[i - 1]?.value ?? ''))
          wordSegments.push({ from: chars[i]!.from, to: chars[i]!.to })
        else wordSegments.at(-1)!.to = chars[i]!.to
      }
      const index = wordSegments.findIndex((item) => item.from <= origin && origin < item.to)
      to =
        index >= 0
          ? (wordSegments[index + count]?.from ?? wordSegments.at(-1)?.to ?? line.to)
          : destination === origin
            ? line.to
            : to
    }
    if (operator === 'c' && target.motion === 'w') {
      const chars = words(state)
      const start = chars.findIndex((item) => item.from <= origin && origin < item.to)
      if (start >= 0 && wordPattern.test(chars[start]!.value)) {
        let i = start
        let countWords = 1
        while (i + 1 < chars.length && countWords < count) {
          i++
          if (wordPattern.test(chars[i]!.value) && !wordPattern.test(chars[i - 1]!.value))
            countWords++
        }
        while (i + 1 < chars.length && wordPattern.test(chars[i + 1]!.value)) i++
        to = chars[i]!.to
      }
    }
    if (target.motion === 'e' && destination === origin)
      to = graphemeBoundaries(state, line.from, line.to).find((at) => at > destination) ?? to
    if (target.motion === 'b' && destination === origin) from = Math.min(origin, to)
    const destinationLine = logicalLineAt(state, destination)
    if (
      (target.motion === 'j' || target.motion === 'k') &&
      destinationLine &&
      destinationLine.block.from !== line.block.from
    ) {
      const sourceLines = logicalLines(line.block)
      const targetLines = logicalLines(destinationLine.block)
      const movingDown = destinationLine.block.from > line.block.from
      const sourceIndex = sourceLines.findIndex((candidate) => candidate.from === line.from)
      const destinationIndex = targetLines.findIndex(
        (candidate) => candidate.from === destinationLine.from,
      )
      if (
        (sourceLines.length > 1 && sourceIndex !== (movingDown ? 0 : sourceLines.length - 1)) ||
        (targetLines.length > 1 && destinationIndex !== (movingDown ? targetLines.length - 1 : 0))
      )
        return rejected()
      linewise = true
      const low = line.block.from < destinationLine.block.from ? line.block : destinationLine.block
      const high = line.block.from < destinationLine.block.from ? destinationLine.block : line.block
      from = low.from - 1
      to = high.to + 1
      if (!safeRange(state, from, to)) return rejected()
      const fragment = state.doc.slice(from, to)
      const mutationRange = { from, to }
      const container = containerAt(state, low.from, STRUCTURAL_CONTAINERS)
      const cell = container?.type === 'tableCell' || container?.type === 'tableHeader'
      const cellNode = cell ? state.doc.nodeAt(container.pos) : null
      const selectedBlocks = textBlocks(state).filter(
        (block) => block.from >= low.from && block.to <= high.to,
      ).length
      if (operator === 'c' || (removal && cell && (cellNode?.childCount ?? 0) <= selectedBlocks)) {
        const replacement = new Slice(
          Fragment.from(low.node.type.create(low.node.attrs, null, low.node.marks)),
          0,
          0,
        )
        mutation = { kind: 'replace', range: mutationRange, replacement }
      } else if (removal) mutation = { kind: 'delete', range: mutationRange }
      return result(
        state,
        operator,
        { from, to },
        { content: fragment, schema: state.schema, linewise, linewiseTextblock: undefined },
        mutation,
        operator === 'y' ? origin : from,
        { kind: 'textblocks', container: containerAt(state, low.from) },
      )
    }
    if (target.motion === '$') {
      const targetLine = logicalLineAt(state, destination)
      if (targetLine) to = targetLine.to
    }
    if (target.motion === 'e')
      to =
        graphemeBoundaries(
          state,
          destinationLine?.from ?? line.from,
          destinationLine?.to ?? line.to,
        ).find((at) => at > destination) ?? to
    if (!safeRange(state, from, to)) return rejected()
    const inlineLines = logicalLines(line.block)
    const inlineIndex = inlineLines.findIndex((candidate) => candidate.from === line.from)
    const lastIndex =
      destinationLine && destinationLine.block.from === line.block.from
        ? inlineLines.findIndex((candidate) => candidate.from === destinationLine.from)
        : -1
    if (
      (target.motion === 'j' || target.motion === 'k') &&
      inlineLines.length > 1 &&
      lastIndex >= 0
    ) {
      const low = Math.min(inlineIndex, lastIndex)
      const high = Math.max(inlineIndex, lastIndex)
      const deletion = logicalLineDeletion(inlineLines, low, high, operator === 'd')!
      const change = logicalLineChange(inlineLines, low, high)!
      const chosen = operator === 'c' ? change : deletion
      from = chosen.from
      to = chosen.to
      linewise = true
      textblock = line.block.node.type.name === 'codeBlock' ? 'codeBlock' : 'hardBreak'
      const content = registerFor(state, deletion.contentFrom, deletion.contentTo, true, textblock)
      if (!safeRange(state, from, to)) return rejected()
      if (removal) {
        if (from === line.block.from && to === line.block.to)
          mutation = {
            kind: 'replace',
            range: { from: line.block.from - 1, to: line.block.to + 1 },
            replacement: new Slice(
              Fragment.from(
                line.block.node.type.create(line.block.node.attrs, null, line.block.node.marks),
              ),
              0,
              0,
            ),
          }
        else mutation = { kind: 'delete', range: { from, to } }
      }
      return result(
        state,
        operator,
        { from: deletion.contentFrom, to: deletion.contentTo },
        content,
        mutation,
        operator === 'y' ? origin : operator === 'd' ? deletion.caret : from,
        { kind: 'logical-lines', textblock },
      )
    }
    const register = registerFor(state, from, to, false)
    if (removal && to > from) mutation = { kind: 'delete', range: { from, to } }
    return result(
      state,
      operator,
      { from, to },
      register,
      mutation,
      operator === 'y' ? origin : from,
      { kind: 'inline' },
    )
  }
  if (target.kind !== 'visual') return { kind: 'noop' }
  const range = resolveVimVisualRange(state, target.anchor, target.cursor, target.linewise)
  if (!range || !safeRange(state, range.from, range.to)) return rejected('selection')
  let registerRange = { from: range.from, to: range.to }
  let itemInfo: { pos: number; type: 'listItem' | 'taskItem' } | undefined
  if (target.linewise) {
    const firstLine = logicalLineAt(state, Math.min(target.anchor, target.cursor))
    const lastLine = logicalLineAt(state, Math.max(target.anchor, target.cursor))
    const firstItem =
      firstLine && containerAt(state, firstLine.block.from, ['listItem', 'taskItem'])
    const lastItem = lastLine && containerAt(state, lastLine.block.from, ['listItem', 'taskItem'])
    if (
      firstItem &&
      lastItem &&
      firstItem.pos === lastItem.pos &&
      firstItem.type === lastItem.type
    ) {
      const node = state.doc.nodeAt(firstItem.pos)
      if (node) {
        registerRange = { from: firstItem.pos, to: firstItem.pos + node.nodeSize }
        itemInfo = { pos: firstItem.pos, type: firstItem.type as 'listItem' | 'taskItem' }
      }
    }
  }
  const register = registerFor(
    state,
    registerRange.from,
    registerRange.to,
    target.linewise,
    range.linewiseTextblock,
    itemInfo?.type,
  )
  let mutation: Mutation | null = null
  let caret = range.from
  if (removal && (range.to > range.from || target.linewise)) {
    if (itemInfo) {
      const node = state.doc.nodeAt(itemInfo.pos)!
      if (operator === 'c') {
        const first = logicalLineAt(state, Math.min(target.anchor, target.cursor))!
        const last = logicalLineAt(state, Math.max(target.anchor, target.cursor))!
        const changed = changedListItem(node, itemInfo.pos, first.block.from, last.block.from)
        if (!changed) return rejected('selection')
        mutation = mutationSequence(changed.edits)
        caret = changed.caret
      } else {
        mutation = { kind: 'delete', range: registerRange }
        caret = itemInfo.pos
      }
    } else if (range.linewiseTextblock && target.linewise) {
      const first = logicalLineAt(state, Math.min(target.anchor, target.cursor))!
      const last = logicalLineAt(state, Math.max(target.anchor, target.cursor))!
      const lines = logicalLines(first.block)
      const low = lines.findIndex((item) => item.from === first.from)
      const high = lines.findIndex((item) => item.from === last.from)
      const deletion = logicalLineDeletion(
        lines,
        Math.min(low, high),
        Math.max(low, high),
        operator === 'd',
      )!
      const chosen =
        operator === 'c'
          ? logicalLineChange(lines, Math.min(low, high), Math.max(low, high))!
          : deletion
      caret = operator === 'd' ? deletion.caret : chosen.from
      mutation =
        chosen.from === first.block.from && chosen.to === first.block.to
          ? {
              kind: 'replace',
              range: { from: first.block.from - 1, to: first.block.to + 1 },
              replacement: new Slice(
                Fragment.from(
                  first.block.node.type.create(
                    first.block.node.attrs,
                    null,
                    first.block.node.marks,
                  ),
                ),
                0,
                0,
              ),
            }
          : { kind: 'delete', range: { from: chosen.from, to: chosen.to } }
    } else if (target.linewise) {
      const first = logicalLineAt(state, Math.min(target.anchor, target.cursor))!
      const last = logicalLineAt(state, Math.max(target.anchor, target.cursor))!
      const low = first.block.from <= last.block.from ? first.block : last.block
      const high = first.block.from <= last.block.from ? last.block : first.block
      const container = containerAt(state, low.from, STRUCTURAL_CONTAINERS)
      const isCell = container?.type === 'tableCell' || container?.type === 'tableHeader'
      const cellNode = isCell ? state.doc.nodeAt(container.pos) : null
      const selectedBlocks = textBlocks(state).filter(
        (block) => block.from >= low.from && block.to <= high.to,
      ).length
      if (operator === 'c' || (isCell && (cellNode?.childCount ?? 0) <= selectedBlocks)) {
        caret = low.from - 1
        mutation = {
          kind: 'replace',
          range: { from: low.from - 1, to: high.to + 1 },
          replacement: new Slice(
            Fragment.from(low.node.type.create(low.node.attrs, null, low.node.marks)),
            0,
            0,
          ),
        }
      } else mutation = { kind: 'delete', range: { from: range.from, to: range.to } }
    } else mutation = { kind: 'delete', range: { from: range.from, to: range.to } }
  }
  return result(
    state,
    operator,
    registerRange,
    register,
    mutation,
    caret,
    itemInfo
      ? { kind: 'list-items', container: itemInfo }
      : range.linewiseTextblock
        ? { kind: 'logical-lines', textblock: range.linewiseTextblock }
        : { kind: 'textblocks', container: containerAt(state, range.from) },
  )
}
