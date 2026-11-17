import { Extension } from '@tiptap/react'
import { Fragment } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { closeHistory, undo, redo } from '@tiptap/pm/history'
import { requestHostHints } from '@/lib/host-hints'
import { clearExtraSelections } from './multi-cursor'
import { pasteVimRegister } from './rich-text-vim-register'
import {
  containerAt,
  graphemeBoundaries,
  graphemeParts as segments,
  logicalLineAt as lineAt,
  logicalLineChange,
  logicalLineDeletion,
  logicalLines,
  safeRange,
  STRUCTURAL_CONTAINERS,
  textBlocks as blocks,
} from './rich-text-vim-range'

export type RichTextVimMode = 'normal' | 'insert' | ''

type VimSettings = {
  enabled: boolean
  active: boolean
  editable: () => boolean
  onModeChange?: (mode: RichTextVimMode) => void
  onHints?: (view: EditorView) => void
  onFeedback?: (message: string) => void
  escapeOwned?: () => boolean
  onEscapeOwned?: () => void
}

type VimState = {
  enabled: boolean
  mode: RichTextVimMode
  prefix: boolean
  operator: 'd' | 'c' | 'y' | null
  count: number
  operatorCount: number
  visualAnchor: number | null
  visualCursor: number | null
  visualLinewise: boolean
  operatorAnchor: number | null
  insertHistoryTime: number | null
  register: {
    content: import('@tiptap/pm/model').Slice
    linewise: boolean
    linewiseTextblock?: 'codeBlock' | 'hardBreak'
    linewiseContainer?: 'listItem' | 'taskItem'
  } | null
}
const KEY = new PluginKey<VimState>('richTextVim')
const EMPTY: VimState = {
  enabled: false,
  mode: '',
  prefix: false,
  operator: null,
  count: 0,
  operatorCount: 1,
  visualAnchor: null,
  visualCursor: null,
  visualLinewise: false,
  operatorAnchor: null,
  insertHistoryTime: null,
  register: null,
}
const WORD = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*$/u

function resetTransient(state: VimState): VimState {
  return {
    ...state,
    prefix: false,
    operator: null,
    count: 0,
    operatorCount: 1,
    visualAnchor: null,
    visualCursor: null,
    visualLinewise: false,
    operatorAnchor: null,
  }
}

function setMode(view: EditorView, mode: RichTextVimMode, enabled?: boolean) {
  const current = KEY.getState(view.state) ?? EMPTY
  view.dispatch(
    view.state.tr
      .setMeta(KEY, {
        ...resetTransient(current),
        mode,
        enabled: enabled ?? current.enabled,
        insertHistoryTime: mode === 'insert' ? current.insertHistoryTime : null,
      })
      .setMeta('addToHistory', false),
  )
}

function closeHistoryBoundary(view: EditorView) {
  view.dispatch(closeHistory(view.state.tr))
}

function dispatchChange(view: EditorView, transaction: Transaction, position: number) {
  transaction.setMeta('vimChangeInsert', true)
  const safePosition = Math.min(position, transaction.doc.content.size)
  view.dispatch(
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(safePosition), 1)),
  )
  setMode(view, 'insert', true)
}

function clearTransient(view: EditorView) {
  const current = KEY.getState(view.state) ?? EMPTY
  const tr = view.state.tr.setMeta(KEY, resetTransient(current)).setMeta('addToHistory', false)
  if (current.visualAnchor !== null && !view.state.selection.empty)
    tr.setSelection(TextSelection.near(tr.doc.resolve(view.state.selection.head), 1))
  view.dispatch(tr)
}

function cappedCount(count: number) {
  return Math.min(999, Math.max(1, count))
}

function crossesContainerMotion(state: EditorState, origin: number, direction: -1 | 1, count = 1) {
  const source = lineAt(state, origin)
  if (!source) return false
  const all = blocks(state).flatMap((block) => logicalLines(block))
  const sourceIndex = all.findIndex((line) => line.from === source.from)
  const target = all[sourceIndex + direction * count]
  if (!target) return false
  const startContainer = containerAt(state, source.block.from, STRUCTURAL_CONTAINERS)
  const endContainer = containerAt(state, target.block.from, STRUCTURAL_CONTAINERS)
  return startContainer?.pos !== endContainer?.pos || startContainer?.type !== endContainer?.type
}

function visualRange(state: EditorState, anchor: number, head: number, linewise: boolean) {
  if (!linewise) {
    const low = Math.min(anchor, head)
    const high = Math.max(anchor, head)
    const line = lineAt(state, high)
    const end = line
      ? graphemeBoundaries(state, line.from, line.to).find((at) => at > high)
      : undefined
    return {
      anchor: head >= anchor ? anchor : (end ?? high),
      head: head >= anchor ? (end ?? high) : low,
      from: low,
      to: end ?? high,
      linewiseTextblock: undefined,
    }
  }
  const first = lineAt(state, Math.min(anchor, head))
  const last = lineAt(state, Math.max(anchor, head))
  if (!first || !last) return null
  if (first.block.from === last.block.from && logicalLines(first.block).length > 1) {
    const from = first.from
    const to = last.to
    return {
      anchor: head >= anchor ? from : to,
      head: head >= anchor ? to : from,
      from,
      to,
      linewiseTextblock:
        logicalLines(first.block).length > 1
          ? first.block.node.type.name === 'codeBlock'
            ? ('codeBlock' as const)
            : ('hardBreak' as const)
          : undefined,
    }
  }
  const partialLogicalEdge =
    (logicalLines(first.block).length > 1 && first.from !== first.block.from) ||
    (logicalLines(last.block).length > 1 && last.to !== last.block.to)
  if (partialLogicalEdge) return null
  const from = first.block.from - 1
  const to = last.block.to + 1
  return {
    anchor: head >= anchor ? first.from : last.to,
    head: head >= anchor ? last.to : first.from,
    from,
    to,
    linewiseTextblock: undefined,
  }
}

function setVisualSelection(view: EditorView, anchor: number, head: number, linewise: boolean) {
  const range = visualRange(view.state, anchor, head, linewise)
  if (!range) return false
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, range.anchor, range.head))
      .setMeta('vimSelection', true)
      .setMeta('addToHistory', false),
  )
  return true
}

function select(view: EditorView, pos: number) {
  const safe = Math.max(0, Math.min(pos, view.state.doc.content.size))
  const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(safe), 1))
  view.dispatch(tr.setMeta('vimSelection', true).setMeta('addToHistory', false).scrollIntoView())
}

function horizontal(view: EditorView, direction: -1 | 1) {
  const { state } = view
  const line = lineAt(state, state.selection.head)
  if (!line) return
  const boundaries = graphemeBoundaries(state, line.from, line.to)
  const pos = state.selection.head
  const next =
    direction < 0
      ? [...boundaries].reverse().find((at) => at < pos)
      : boundaries.find((at) => at > pos && at < line.to)
  if (next !== undefined) select(view, next)
}

function vertical(view: EditorView, direction: -1 | 1) {
  const { state } = view
  const current = lineAt(state, state.selection.head)
  if (!current) return
  const withinBlock =
    direction < 0
      ? current.from > current.block.from
        ? lineAt(state, current.from - 1)
        : null
      : current.to < current.block.to
        ? lineAt(state, current.to + 1)
        : null
  let targetLine = withinBlock
  if (!targetLine) {
    const all = blocks(state)
    const index = all.findIndex((block) => block.from === current.block.from)
    const target = all[index + direction]
    if (!target) return
    targetLine = lineAt(state, direction < 0 ? target.to : target.from)
  }
  if (!targetLine) return
  const relative = state.selection.head - current.from
  const positions = graphemeBoundaries(state, targetLine.from, targetLine.to)
  const normalPositions = positions.length > 1 ? positions.slice(0, -1) : positions
  select(
    view,
    normalPositions.find((at) => at >= targetLine.from + relative) ??
      normalPositions.at(-1) ??
      targetLine.from,
  )
}

function wordPositions(state: EditorState) {
  const chars: { value: string; from: number; to: number }[] = []
  for (const block of blocks(state)) {
    const boundaries = graphemeBoundaries(state, block.from, block.to)
    for (let index = 0; index < boundaries.length - 1; index++) {
      const from = boundaries[index]!
      const to = boundaries[index + 1]!
      const value = state.doc.textBetween(from, to, '\u0000', '\u0000') || '\u0000'
      chars.push({ value, from, to })
    }
    chars.push({ value: ' ', from: block.to, to: block.to })
  }
  return chars
}

function wordMotion(view: EditorView, motion: 'w' | 'b' | 'e') {
  const chars = wordPositions(view.state)
  const pos = view.state.selection.head
  const word = (item: (typeof chars)[number]) => WORD.test(item.value)
  const current = chars.findIndex((item) => item.from <= pos && pos < item.to)
  const firstAtOrAfter = chars.findIndex((item) => item.from >= pos)
  let target: number | undefined
  if (motion === 'w') {
    const start = current >= 0 ? current + 1 : firstAtOrAfter < 0 ? chars.length : firstAtOrAfter
    for (let i = start; i < chars.length; i++) {
      if (word(chars[i]!) && (i === 0 || !word(chars[i - 1]!))) {
        target = chars[i]!.from
        break
      }
    }
  } else if (motion === 'b') {
    for (let i = chars.length - 1; i >= 0; i--) {
      if (chars[i]!.from >= pos) continue
      if (word(chars[i]!) && (i === 0 || !word(chars[i - 1]!))) {
        target = chars[i]!.from
        break
      }
    }
    if (target === undefined) target = chars.find((item) => item.from < pos)?.from
  } else {
    const atWordEnd =
      current >= 0 &&
      word(chars[current]!) &&
      (current + 1 === chars.length || !word(chars[current + 1]!))
    const start =
      current >= 0
        ? current + (atWordEnd ? 1 : 0)
        : firstAtOrAfter < 0
          ? chars.length
          : firstAtOrAfter
    for (let i = start; i < chars.length; i++) {
      if (!word(chars[i]!)) continue
      if (i + 1 === chars.length || !word(chars[i + 1]!)) {
        target = chars[i]!.from
        break
      }
    }
  }
  if (target !== undefined) select(view, target)
}

function lineMotion(view: EditorView, key: '0' | '^' | '$') {
  const line = lineAt(view.state, view.state.selection.head)
  if (!line) return
  const positions = graphemeBoundaries(view.state, line.from, line.to)
  const target =
    key === '0'
      ? line.from
      : key === '$'
        ? positions.length > 1
          ? positions.at(-2)!
          : positions.at(-1)!
        : (positions.find(
            (at) =>
              view.state.doc.textBetween(at, positions.find((next) => next > at) ?? at).trim() !==
              '',
          ) ?? line.to)
  select(view, target)
}

function deleteChar(view: EditorView) {
  if (!view.editable) return
  const { state } = view
  if (!state.selection.empty) {
    if (state.selection instanceof TextSelection) {
      view.dispatch(state.tr.deleteSelection())
      return
    }
    const selected = state.selection
    if ('node' in selected) {
      view.dispatch(state.tr.delete(selected.from, selected.to))
      return
    }
  }
  const line = lineAt(state, state.selection.head)
  if (!line || state.selection.head >= line.to) return
  const positions = graphemeBoundaries(state, line.from, line.to)
  const from = state.selection.head
  const to = positions.find((at) => at > from)
  if (to === undefined) return
  const index = positions.indexOf(from)
  const target = to === line.to && index > 0 ? positions[index - 1]! : from
  const transaction = state.tr.delete(from, to)
  transaction.setSelection(TextSelection.create(transaction.doc, target))
  view.dispatch(transaction)
}

function openLine(view: EditorView, above: boolean, editable: () => boolean) {
  if (!view.editable || !editable()) return
  const line = lineAt(view.state, view.state.selection.head)
  if (!line) return
  closeHistoryBoundary(view)
  const { state } = view
  const code = line.block.node.type.name === 'codeBlock'
  if (!code && line.from === line.block.from && line.to === line.block.to) {
    const target = above ? line.block.from : line.block.to
    select(view, target)
    view.dispatch(view.state.tr.split(view.state.selection.from))
    if (above) {
      const current = view.state.selection.from
      const previous = blocks(view.state)
        .filter((block) => block.from < current)
        .at(-1)
      if (previous) select(view, previous.from)
    }
    setMode(view, 'insert', true)
    return
  }
  const boundary = above ? line.from : line.to
  if (code) {
    view.dispatch(state.tr.insertText('\n', boundary))
    select(view, above ? boundary : boundary + 1)
  } else {
    const hardBreak = state.schema.nodes.hardBreak
    if (!hardBreak) return
    const separator = hardBreak.create()
    view.dispatch(state.tr.insert(boundary, separator))
    select(view, above ? boundary : boundary + separator.nodeSize)
  }
  setMode(view, 'insert', true)
}

function insertAt(view: EditorView, where: 'i' | 'a' | 'I' | 'A', editable: () => boolean) {
  if (!view.editable || !editable()) return
  closeHistoryBoundary(view)
  const { state } = view
  const line = lineAt(state, state.selection.head)
  if (where === 'i' || !line) {
    setMode(view, 'insert', true)
    return
  }
  if (where === 'a') {
    const positions = graphemeBoundaries(state, line.from, line.to)
    const after = positions.find((at) => at > state.selection.head)
    select(view, after ?? line.to)
  } else if (where === 'I') {
    const positions = graphemeBoundaries(state, line.from, line.to)
    const first = positions.find((at) => {
      const next = positions.find((candidate) => candidate > at) ?? at
      return state.doc.textBetween(at, next).trim() !== ''
    })
    select(view, first ?? line.to)
  } else select(view, line.to)
  setMode(view, 'insert', true)
}

function leaveInsert(view: EditorView) {
  closeHistoryBoundary(view)
  clearExtraSelections(view)
  const { state } = view
  if (!state.selection.empty) select(view, state.selection.from)
  const line = lineAt(view.state, view.state.selection.head)
  if (line && view.state.selection.empty && view.state.selection.head > line.from)
    horizontal(view, -1)
  setMode(view, 'normal')
}

type Motion = 'w' | 'b' | 'e' | 'h' | 'l' | 'j' | 'k' | '0' | '^' | '$'

function previewMotion(view: EditorView, start: number, motion: Motion, count: number) {
  let state = view.state
  const preview = {
    get state() {
      return state
    },
    dispatch(transaction: Transaction) {
      state = state.apply(transaction)
    },
  } as EditorView
  select(preview, start)
  for (let index = 0; index < count; index++) {
    const previous = state.selection.head
    if (motion === 'w' || motion === 'b' || motion === 'e') wordMotion(preview, motion)
    else if (motion === 'h' || motion === 'l') horizontal(preview, motion === 'h' ? -1 : 1)
    else if (motion === 'j' || motion === 'k') vertical(preview, motion === 'j' ? 1 : -1)
    else lineMotion(preview, motion)
    if (state.selection.head === previous) break
  }
  return state.selection.head
}

function operatorRange(start: number, destination: number) {
  return { from: Math.min(start, destination), to: Math.max(start, destination) }
}

function handleNormal(
  view: EditorView,
  event: KeyboardEvent,
  settings: VimSettings,
  current: VimState,
) {
  const key = event.key
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey
  if (key === 'Escape' && plain) {
    if (current.prefix || current.operator || current.count || current.visualAnchor !== null) {
      const tr = view.state.tr
      if (current.visualAnchor !== null)
        tr.setSelection(TextSelection.near(tr.doc.resolve(view.state.selection.head), 1))
      tr.setMeta(KEY, resetTransient(current)).setMeta('addToHistory', false)
      view.dispatch(tr)
      event.preventDefault()
      return true
    }
    if (settings.escapeOwned?.()) {
      settings.onEscapeOwned?.()
      event.preventDefault()
      return true
    }
    return false
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    key.toLowerCase() === 'r'
  ) {
    event.preventDefault()
    event.stopPropagation()
    if (settings.editable()) redo(view.state, view.dispatch)
    return true
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    key.toLowerCase() === 'z'
  )
    return false
  if (!plain) return false
  clearExtraSelections(view)
  const update = (patch: Partial<VimState>) =>
    view.dispatch(
      view.state.tr.setMeta(KEY, { ...current, ...patch }).setMeta('addToHistory', false),
    )
  if (current.visualAnchor !== null && /^[0-9]$/.test(key) && (current.count > 0 || key !== '0')) {
    update({ count: Math.min(999, current.count * 10 + Number(key)) })
    event.preventDefault()
    return true
  }
  if (
    current.visualAnchor !== null &&
    (key === 'h' ||
      key === 'j' ||
      key === 'k' ||
      key === 'l' ||
      key === 'w' ||
      key === 'b' ||
      key === 'e' ||
      key === '0' ||
      key === '^' ||
      key === '$')
  ) {
    const visualOrigin = current.visualCursor ?? current.visualAnchor
    const count = cappedCount(current.count)
    if (
      (key === 'j' || key === 'k') &&
      crossesContainerMotion(view.state, visualOrigin, key === 'j' ? 1 : -1, count)
    ) {
      clearTransient(view)
      settings.onFeedback?.('Vim selection crosses a list or table; no text was changed')
      event.preventDefault()
      return true
    }
    const visualDestination = previewMotion(view, visualOrigin, key as Motion, count)
    const visualRangePreview = visualRange(
      view.state,
      current.visualAnchor,
      visualDestination,
      current.visualLinewise,
    )
    if (
      !visualRangePreview ||
      !safeRange(view.state, visualRangePreview.from, visualRangePreview.to)
    ) {
      clearTransient(view)
      settings.onFeedback?.('Vim selection crosses a list or table; no text was changed')
      event.preventDefault()
      return true
    }
    select(view, visualOrigin)
    let previous = visualOrigin
    for (let index = 0; index < count; index++) {
      if (key === 'h' || key === 'l') horizontal(view, key === 'h' ? -1 : 1)
      else if (key === 'j' || key === 'k') vertical(view, key === 'j' ? 1 : -1)
      else if (key === 'w' || key === 'b' || key === 'e') wordMotion(view, key)
      else lineMotion(view, key)
      const destination = view.state.selection.head
      if (destination === previous) break
      previous = destination
    }
    const anchor = Math.min(current.visualAnchor, view.state.doc.content.size)
    const head = view.state.selection.head
    view.dispatch(
      view.state.tr
        .setMeta(KEY, { ...current, visualCursor: head, count: 0 })
        .setMeta('addToHistory', false),
    )
    setVisualSelection(view, anchor, head, current.visualLinewise)
    event.preventDefault()
    return true
  }
  if (current.prefix && key === 'g') {
    select(view, 0)
    setMode(view, 'normal')
    event.preventDefault()
    return true
  }
  if (current.prefix)
    view.dispatch(
      view.state.tr.setMeta(KEY, { ...current, prefix: false }).setMeta('addToHistory', false),
    )
  if (key === 'Tab' || key === 'Enter' || key === 'Backspace' || key === 'Delete') {
    event.preventDefault()
    return true
  }
  if (key === 'v' || key === 'V') {
    const anchor = view.state.selection.head
    let visualHead = anchor
    if (key === 'V' && current.count > 1) {
      const all = blocks(view.state).flatMap((block) => logicalLines(block))
      const line = lineAt(view.state, anchor)
      const index = all.findIndex((candidate) => candidate.from === line?.from)
      const target = all[Math.min(all.length - 1, index + current.count - 1)]
      if (target) visualHead = target.from
      const range = visualRange(view.state, anchor, visualHead, true)
      if (!range || !safeRange(view.state, range.from, range.to)) {
        update({ ...resetTransient(current) })
        settings.onFeedback?.('Vim selection crosses a list or table; no text was changed')
        event.preventDefault()
        return true
      }
    }
    update({
      visualAnchor: anchor,
      visualCursor: visualHead,
      visualLinewise: key === 'V',
      operator: null,
      operatorAnchor: null,
      count: 0,
    })
    setVisualSelection(view, anchor, visualHead, key === 'V')
    event.preventDefault()
    return true
  }
  if (current.operator) {
    const operator = current.operator
    if (key !== operator && /^[0-9]$/.test(key) && (current.count > 0 || key !== '0')) {
      update({ count: Math.min(999, current.count * 10 + Number(key)) })
      event.preventDefault()
      return true
    }
    if (key === operator) {
      const line = lineAt(view.state, view.state.selection.head)
      if (line) {
        const { block } = line
        const item = containerAt(view.state, block.from, ['listItem', 'taskItem'])
        if (item) {
          const $item = view.state.doc.resolve(item.pos)
          const index = $item.index()
          const count = cappedCount(current.operatorCount * (current.count || 1))
          const siblings = Array.from({ length: count }, (_, offset) =>
            $item.parent.maybeChild(index + offset),
          )
          const items = siblings.filter((candidate) => candidate?.type.name === item.type)
          if (items.length === count) {
            const to = item.pos + items.reduce((size, node) => size + node!.nodeSize, 0)
            const content = view.state.doc.slice(item.pos, to)
            update({
              operator: null,
              count: 0,
              operatorCount: 1,
              register: {
                content,
                linewise: true,
                linewiseContainer: item.type as 'listItem' | 'taskItem',
              },
            })
            if (operator !== 'y' && settings.editable()) {
              const tr = closeHistory(view.state.tr)
              if (operator === 'c') {
                const first = items[0]!
                const children = first.content.content.slice()
                const firstTextblockIndex = children.findIndex((child) => child.isTextblock)
                if (firstTextblockIndex >= 0) {
                  const textblock = children[firstTextblockIndex]!
                  children[firstTextblockIndex] = textblock.type.create(
                    textblock.attrs,
                    null,
                    textblock.marks,
                  )
                }
                const replacement = first.copy(Fragment.fromArray(children))
                tr.replaceWith(item.pos, to, replacement)
              } else tr.delete(item.pos, to)
              if (operator === 'c') dispatchChange(view, tr, item.pos)
              else {
                view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(item.pos), 1)))
                closeHistoryBoundary(view)
              }
            }
            event.preventDefault()
            return true
          }
          update({ operator: null, count: 0, operatorCount: 1 })
          settings.onFeedback?.('Vim line range does not fit in this list; no text was changed')
          event.preventDefault()
          return true
        }
        const logical = logicalLines(block)
        const logicalIndex = logical.findIndex((candidate) => candidate.from === line.from)
        if (logical.length > 1 && logicalIndex >= 0) {
          const lastIndex = Math.min(
            logical.length - 1,
            logicalIndex + cappedCount(current.operatorCount * (current.count || 1)) - 1,
          )
          const deletion = logicalLineDeletion(logical, logicalIndex, lastIndex, operator === 'd')!
          const change = logicalLineChange(logical, logicalIndex, lastIndex)!
          const from = operator === 'c' ? change.from : deletion.from
          const to = operator === 'c' ? change.to : deletion.to
          const content = view.state.doc.slice(deletion.contentFrom, deletion.contentTo)
          let isHardBreakLine = false
          if (block.node.type.name !== 'codeBlock')
            block.node.descendants((node) => {
              if (node.type.name === 'hardBreak') isHardBreakLine = true
            })
          update({
            operator: null,
            count: 0,
            operatorCount: 1,
            register: {
              content,
              linewise: true,
              linewiseTextblock:
                block.node.type.name === 'codeBlock'
                  ? 'codeBlock'
                  : isHardBreakLine
                    ? 'hardBreak'
                    : undefined,
            },
          })
          if (operator !== 'y' && settings.editable()) {
            const tr = closeHistory(view.state.tr)
            if (from === block.from && to === block.to) {
              tr.replaceWith(
                block.from - 1,
                block.to + 1,
                block.node.type.create(block.node.attrs, null, block.node.marks),
              )
            } else tr.delete(from, to)
            if (operator === 'c') dispatchChange(view, tr, from)
            else {
              view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(from), 1)))
              closeHistoryBoundary(view)
            }
          }
          event.preventDefault()
          return true
        }
        const nested = containerAt(view.state, block.from, STRUCTURAL_CONTAINERS)
        const all = blocks(view.state)
        const blockIndex = all.findIndex((candidate) => candidate.from === block.from)
        const lineCount = cappedCount(current.operatorCount * (current.count || 1))
        const lastBlock = all[Math.min(all.length - 1, blockIndex + lineCount - 1)] ?? block
        const from = nested ? block.from : block.from - 1
        const to = nested ? lastBlock.to : lastBlock.to + 1
        if (!safeRange(view.state, from, to)) {
          update({ operator: null, count: 0, operatorCount: 1 })
          settings.onFeedback?.('Vim motion crosses a list or table; no text was changed')
          event.preventDefault()
          return true
        }
        const content =
          operator === 'y' && (nested?.type === 'tableCell' || nested?.type === 'tableHeader')
            ? view.state.doc.slice(block.from - 1, lastBlock.to + 1)
            : view.state.doc.slice(from, to)
        let hasHardBreak = false
        block.node.descendants((node) => {
          if (node.type.name === 'hardBreak') hasHardBreak = true
        })
        update({
          operator: null,
          count: 0,
          operatorCount: 1,
          register: {
            content,
            linewise: true,
            linewiseTextblock:
              block.node.type.name === 'codeBlock'
                ? 'codeBlock'
                : hasHardBreak
                  ? 'hardBreak'
                  : undefined,
          },
        })
        if (operator !== 'y' && settings.editable()) {
          const tr = closeHistory(view.state.tr)
          if (operator === 'c' && line.from === block.from && line.to === block.to) {
            const empty = block.node.type.create(block.node.attrs, null, block.node.marks)
            tr.replaceWith(block.from - 1, lastBlock.to + 1, empty)
          } else tr.delete(from, to)
          if (operator === 'c') dispatchChange(view, tr, from)
          else {
            view.dispatch(
              tr.setSelection(
                TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), 1),
              ),
            )
            closeHistoryBoundary(view)
          }
        }
      }
      event.preventDefault()
      return true
    }
    if (
      key === 'w' ||
      key === 'b' ||
      key === 'e' ||
      key === 'h' ||
      key === 'l' ||
      key === 'j' ||
      key === 'k' ||
      key === '0' ||
      key === '^' ||
      key === '$'
    ) {
      const origin = current.operatorAnchor ?? view.state.selection.head
      const operatorMotionCount = cappedCount(current.operatorCount * (current.count || 1))
      if (
        (key === 'j' || key === 'k') &&
        crossesContainerMotion(view.state, origin, key === 'j' ? 1 : -1, operatorMotionCount)
      ) {
        update({ operator: null, operatorAnchor: null, count: 0, operatorCount: 1 })
        settings.onFeedback?.('Vim motion crosses a list or table; no text was changed')
        event.preventDefault()
        return true
      }
      const destination = previewMotion(view, origin, key, operatorMotionCount)
      const range = operatorRange(origin, destination)
      const sourceLine = lineAt(view.state, origin)
      const destinationLine = lineAt(view.state, destination)
      const linewiseMotion =
        (key === 'j' || key === 'k') && destination !== origin && !!sourceLine && !!destinationLine
      const from = linewiseMotion
        ? Math.min(sourceLine.block.from, destinationLine.block.from) - 1
        : range.from
      const line = sourceLine
      const destinationBoundaries = destinationLine
        ? graphemeBoundaries(view.state, destinationLine.from, destinationLine.to)
        : []
      const afterDestination = destinationBoundaries.find((at) => at > destination)
      let to = key === 'e' || key === '$' ? (afterDestination ?? range.to) : range.to
      let safeFrom = from
      if (key === 'w' && line) {
        const chars = wordPositions(view.state)
        const words: { from: number; to: number }[] = []
        for (let index = 0; index < chars.length; index++) {
          if (!WORD.test(chars[index]!.value)) continue
          if (index === 0 || !WORD.test(chars[index - 1]!.value))
            words.push({ from: chars[index]!.from, to: chars[index]!.to })
          else words.at(-1)!.to = chars[index]!.to
        }
        const originIndex = words.findIndex((item) => item.from <= origin && origin < item.to)
        if (originIndex >= 0) {
          const target = words[originIndex + operatorMotionCount]
          to = target?.from ?? words.at(-1)?.to ?? line.to
        } else if (destination === origin) to = line.to
      }
      if (operator === 'c' && key === 'w') {
        const chars = wordPositions(view.state)
        const startIndex = chars.findIndex((item) => item.from <= origin && origin < item.to)
        if (startIndex >= 0 && WORD.test(chars[startIndex]!.value)) {
          let index = startIndex
          let words = 1
          while (index + 1 < chars.length && words < operatorMotionCount) {
            index++
            if (WORD.test(chars[index]!.value) && !WORD.test(chars[index - 1]!.value)) words++
          }
          while (index + 1 < chars.length && WORD.test(chars[index + 1]!.value)) index++
          to = chars[index]!.to
        }
      }
      if (key === 'e' && destination === origin && afterDestination !== undefined)
        to = afterDestination
      if (key === 'b' && destination === origin) safeFrom = Math.min(origin, range.to)
      const safeTo = linewiseMotion
        ? Math.min(
            view.state.doc.content.size,
            Math.max(sourceLine!.block.to, destinationLine!.block.to) + 1,
          )
        : Math.min(view.state.doc.content.size, Math.max(safeFrom, to))
      const rangeFrom = linewiseMotion ? Math.max(0, from) : safeFrom
      const sourceBlock = sourceLine?.block
      const destinationBlock = destinationLine?.block
      const structuralCrossing =
        (key === 'j' || key === 'k') &&
        sourceBlock !== undefined &&
        destinationBlock !== undefined &&
        containerAt(view.state, sourceBlock.from, STRUCTURAL_CONTAINERS)?.pos !==
          containerAt(view.state, destinationBlock.from, STRUCTURAL_CONTAINERS)?.pos
      const allowed = !structuralCrossing && safeRange(view.state, range.from, range.to)
      if (!allowed) {
        update({ operator: null, operatorAnchor: null, count: 0, operatorCount: 1 })
        settings.onFeedback?.('Vim motion crosses a list or table; no text was changed')
        event.preventDefault()
        return true
      }
      const inlineLinewise =
        linewiseMotion &&
        sourceLine?.block.from === destinationLine?.block.from &&
        logicalLines(sourceLine.block).length > 1
      const inlineLines = inlineLinewise ? logicalLines(sourceLine.block) : []
      const firstInlineIndex = inlineLinewise
        ? inlineLines.findIndex((item) => item.from === sourceLine.from)
        : -1
      const lastInlineIndex = inlineLinewise
        ? inlineLines.findIndex((item) => item.from === destinationLine.from)
        : -1
      const inlineFirst = inlineLines[Math.min(firstInlineIndex, lastInlineIndex)]
      const inlineLast = inlineLines[Math.max(firstInlineIndex, lastInlineIndex)]
      const content =
        inlineLinewise && inlineFirst && inlineLast
          ? view.state.doc.slice(inlineFirst.from, inlineLast.to)
          : view.state.doc.slice(rangeFrom, safeTo)
      const inlineLineType = inlineLinewise
        ? sourceLine.block.node.type.name === 'codeBlock'
          ? 'codeBlock'
          : 'hardBreak'
        : undefined
      if (operator === 'y') select(view, origin)
      update({
        operator: null,
        operatorAnchor: null,
        count: 0,
        operatorCount: 1,
        register: { content, linewise: linewiseMotion, linewiseTextblock: inlineLineType },
      })
      if (operator !== 'y' && settings.editable() && safeTo > rangeFrom) {
        if (inlineLinewise && inlineFirst && inlineLast) {
          const nextLine = inlineLines[Math.max(firstInlineIndex, lastInlineIndex) + 1]
          const previousLine = inlineLines[Math.min(firstInlineIndex, lastInlineIndex) - 1]
          const deleteFrom = previousLine && !nextLine ? previousLine.to : inlineFirst.from
          const deleteTo = nextLine ? nextLine.from : inlineLast.to
          const tr = closeHistory(view.state.tr)
          if (deleteFrom === sourceLine.block.from && deleteTo === sourceLine.block.to) {
            tr.replaceWith(
              sourceLine.block.from - 1,
              sourceLine.block.to + 1,
              sourceLine.block.node.type.create(
                sourceLine.block.node.attrs,
                null,
                sourceLine.block.node.marks,
              ),
            )
          } else tr.delete(deleteFrom, deleteTo)
          if (operator === 'c') dispatchChange(view, tr, deleteFrom)
          else view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(deleteFrom), 1)))
        } else {
          const tr = closeHistory(view.state.tr).delete(rangeFrom, safeTo)
          if (operator === 'c') dispatchChange(view, tr, rangeFrom)
          else view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(rangeFrom), 1)))
        }
        if (operator !== 'c') closeHistoryBoundary(view)
      }
      event.preventDefault()
      return true
    }
    update({ ...resetTransient(current) })
  }
  if (current.visualAnchor !== null && (key === 'd' || key === 'c' || key === 'y')) {
    const range = current.visualLinewise
      ? visualRange(view.state, current.visualAnchor, view.state.selection.head, true)
      : {
          from: view.state.selection.from,
          to: view.state.selection.to,
          anchor: view.state.selection.anchor,
          head: view.state.selection.head,
          linewiseTextblock: undefined,
        }
    const visualStart = lineAt(
      view.state,
      Math.min(current.visualAnchor, view.state.selection.head),
    )
    const visualEnd = lineAt(view.state, Math.max(current.visualAnchor, view.state.selection.head))
    const visualStartItem =
      current.visualLinewise && visualStart
        ? containerAt(view.state, visualStart.block.from, ['listItem', 'taskItem'])
        : null
    const visualEndItem =
      current.visualLinewise && visualEnd
        ? containerAt(view.state, visualEnd.block.from, ['listItem', 'taskItem'])
        : null
    const sameListItem =
      visualStartItem !== null &&
      visualEndItem !== null &&
      visualStartItem.pos === visualEndItem.pos &&
      visualStartItem.type === visualEndItem.type
    if (!range || (!sameListItem && !safeRange(view.state, range.from, range.to))) {
      update({ visualAnchor: null, visualCursor: null, visualLinewise: false, count: 0 })
      settings.onFeedback?.('Vim selection crosses a list or table; no text was changed')
      event.preventDefault()
      return true
    }
    const content = view.state.doc.slice(range.from, range.to)
    const firstVisualLine = current.visualLinewise
      ? lineAt(view.state, Math.min(current.visualAnchor, view.state.selection.head))
      : null
    const lastVisualLine = current.visualLinewise
      ? lineAt(view.state, Math.max(current.visualAnchor, view.state.selection.head))
      : null
    const visualContainer =
      current.visualLinewise && firstVisualLine
        ? containerAt(view.state, firstVisualLine.block.from, ['listItem', 'taskItem'])
        : null
    const visualContainerNode = visualContainer ? view.state.doc.nodeAt(visualContainer.pos) : null
    const registerContent =
      visualContainer &&
      visualContainerNode &&
      visualContainer.type ===
        containerAt(view.state, lastVisualLine?.block.from ?? firstVisualLine?.block.from ?? 0, [
          'listItem',
          'taskItem',
        ])?.type
        ? view.state.doc.slice(
            visualContainer.pos,
            visualContainer.pos + visualContainerNode.nodeSize,
          )
        : content
    const inlineVisual =
      range.linewiseTextblock &&
      firstVisualLine &&
      lastVisualLine &&
      firstVisualLine.block.from === lastVisualLine.block.from
        ? {
            type: range.linewiseTextblock,
            block: firstVisualLine.block,
            lines: logicalLines(firstVisualLine.block),
            first: firstVisualLine,
            last: lastVisualLine,
          }
        : null
    update({
      visualAnchor: null,
      visualCursor: null,
      visualLinewise: false,
      register: {
        content: registerContent,
        linewise: current.visualLinewise,
        linewiseTextblock: inlineVisual?.type,
        linewiseContainer: visualContainer?.type as 'listItem' | 'taskItem' | undefined,
      },
    })
    if (key === 'y') {
      select(view, Math.min(current.visualAnchor, view.state.doc.content.size))
    } else if (settings.editable() && range.to > range.from) {
      const tr = closeHistory(view.state.tr)
      let deleteFrom = range.from
      if (visualContainer && visualContainerNode) {
        const item = visualContainerNode
        const children = item.content.content.slice()
        const textblockIndex = children.findIndex((child) => child.isTextblock)
        if (key === 'c' && textblockIndex >= 0) {
          const textblock = children[textblockIndex]!
          children[textblockIndex] = textblock.type.create(textblock.attrs, null, textblock.marks)
          tr.replaceWith(
            visualContainer.pos,
            visualContainer.pos + item.nodeSize,
            item.copy(Fragment.fromArray(children)),
          )
        } else tr.delete(visualContainer.pos, visualContainer.pos + item.nodeSize)
      } else if (inlineVisual) {
        const low = Math.min(
          inlineVisual.lines.findIndex((item) => item.from === inlineVisual.first.from),
          inlineVisual.lines.findIndex((item) => item.from === inlineVisual.last.from),
        )
        const high = Math.max(
          inlineVisual.lines.findIndex((item) => item.from === inlineVisual.first.from),
          inlineVisual.lines.findIndex((item) => item.from === inlineVisual.last.from),
        )
        const previousLine = inlineVisual.lines[low - 1]
        const nextLine = inlineVisual.lines[high + 1]
        deleteFrom = previousLine && !nextLine ? previousLine.to : inlineVisual.lines[low]!.from
        const deleteTo =
          key === 'c'
            ? inlineVisual.lines[high]!.to
            : nextLine
              ? nextLine.from
              : inlineVisual.lines[high]!.to
        if (deleteFrom === inlineVisual.block.from && deleteTo === inlineVisual.block.to) {
          tr.replaceWith(
            inlineVisual.block.from - 1,
            inlineVisual.block.to + 1,
            inlineVisual.block.node.type.create(
              inlineVisual.block.node.attrs,
              null,
              inlineVisual.block.node.marks,
            ),
          )
        } else tr.delete(deleteFrom, deleteTo)
      } else tr.delete(deleteFrom, range.to)
      if (key === 'c') dispatchChange(view, tr, deleteFrom)
      else {
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(deleteFrom), 1)))
        closeHistoryBoundary(view)
      }
    }
    event.preventDefault()
    return true
  }
  if (key === 'd' || key === 'c' || key === 'y') {
    update({
      operator: key,
      operatorAnchor: view.state.selection.head,
      operatorCount: Math.max(1, current.count),
      count: 0,
    })
    event.preventDefault()
    return true
  }
  if ((key === 'p' || key === 'P') && current.register) {
    pasteVimRegister(
      view,
      key,
      current.register,
      current.count,
      settings.editable,
      settings.onFeedback,
      () => update({ count: 0 }),
      () => closeHistoryBoundary(view),
    )
    event.preventDefault()
    return true
  }
  if (/^[0-9]$/.test(key) && (current.count > 0 || key !== '0')) {
    update({ count: Math.min(999, current.count * 10 + Number(key)) })
    event.preventDefault()
    return true
  }
  if (key === 'g') {
    view.dispatch(
      view.state.tr.setMeta(KEY, { ...current, prefix: true }).setMeta('addToHistory', false),
    )
    event.preventDefault()
    return true
  }
  if (key === 'f') {
    if (current.count) update({ count: 0 })
    event.preventDefault()
    event.stopPropagation()
    if (!event.repeat) (settings.onHints ?? ((target) => requestHostHints(target.dom)))(view)
    return true
  }
  if (key === 'i' || key === 'a' || key === 'I' || key === 'A') {
    insertAt(view, key, settings.editable)
    event.preventDefault()
    return true
  }
  if (key === 'o' || key === 'O') {
    openLine(view, key === 'O', settings.editable)
    event.preventDefault()
    return true
  }
  if (
    key === 'h' ||
    key === 'l' ||
    key === 'j' ||
    key === 'k' ||
    key === 'w' ||
    key === 'b' ||
    key === 'e' ||
    key === '^' ||
    key === '$'
  ) {
    let previous = view.state.selection.head
    for (let index = 0; index < cappedCount(current.count); index++) {
      if (key === 'h' || key === 'l') horizontal(view, key === 'h' ? -1 : 1)
      else if (key === 'j' || key === 'k') vertical(view, key === 'j' ? 1 : -1)
      else if (key === 'w' || key === 'b' || key === 'e') wordMotion(view, key)
      else lineMotion(view, key)
      const destination = view.state.selection.head
      if (destination === previous) break
      previous = destination
    }
    if (current.count) update({ count: 0 })
    event.preventDefault()
    return true
  }
  if (key === '0') {
    lineMotion(view, key)
    if (current.count) update({ count: 0 })
    event.preventDefault()
    return true
  }
  if (key === 'G') {
    const last = blocks(view.state).at(-1)
    const line = last ? lineAt(view.state, last.to) : null
    const positions = line ? graphemeBoundaries(view.state, line.from, line.to) : []
    select(view, positions.length > 1 ? positions.at(-2)! : (positions.at(-1) ?? 0))
    if (current.count) update({ count: 0 })
    event.preventDefault()
    return true
  }
  if (key === 'x') {
    if (settings.editable()) deleteChar(view)
    if (current.count) update({ count: 0 })
    event.preventDefault()
    return true
  }
  if (key === 'u') {
    event.preventDefault()
    event.stopPropagation()
    if (settings.editable()) undo(view.state, view.dispatch)
    return true
  }
  if ((segments(key).length === 1 && key !== 'Dead') || key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  return false
}

/** Normal/insert Vim routing over the editor's actual ProseMirror state. */
export const RichTextVim = Extension.create<VimSettings>({
  name: 'richTextVim',
  priority: 1100,
  addOptions() {
    return { enabled: false, active: true, editable: () => true }
  },
  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin<VimState>({
        key: KEY,
        filterTransaction(transaction, state) {
          const vim = KEY.getState(state)
          if (
            vim?.mode === 'insert' &&
            vim.insertHistoryTime !== null &&
            transaction.docChanged &&
            !transaction.getMeta('vimChangeInsert')
          )
            transaction.setTime(vim.insertHistoryTime + 1)
          return true
        },
        state: {
          init: () => ({
            ...EMPTY,
            enabled: options.enabled,
            mode: options.enabled ? 'normal' : '',
          }),
          apply(transaction, value) {
            const meta = transaction.getMeta(KEY) as VimState | undefined
            if (meta) return meta
            if (transaction.getMeta('vimChangeInsert'))
              return { ...value, insertHistoryTime: transaction.time }
            if (
              transaction.selectionSet &&
              !transaction.getMeta('vimSelection') &&
              (value.visualAnchor !== null || value.operator !== null)
            ) {
              return {
                ...value,
                visualAnchor: null,
                visualCursor: null,
                visualLinewise: false,
                operator: null,
                operatorAnchor: null,
                prefix: false,
                count: 0,
                operatorCount: 1,
              }
            }
            if (!transaction.docChanged) return value
            const mapPosition = (position: number | null) => {
              if (position === null) return { position: null, invalid: false }
              const mapped = transaction.mapping.mapResult(position, -1)
              return {
                position: mapped.pos,
                invalid: mapped.deleted || mapped.pos > transaction.doc.content.size,
              }
            }
            const visual = mapPosition(value.visualAnchor)
            const cursor = mapPosition(value.visualCursor)
            const operator =
              value.operatorAnchor === null
                ? { position: null, invalid: false }
                : (() => {
                    const mapped = transaction.mapping.mapResult(value.operatorAnchor, 1)
                    return {
                      position: mapped.pos,
                      invalid: mapped.deleted || mapped.pos > transaction.doc.content.size,
                    }
                  })()
            if (visual.invalid || cursor.invalid || operator.invalid) {
              return {
                ...value,
                visualAnchor: null,
                visualCursor: null,
                visualLinewise: false,
                operator: null,
                operatorAnchor: null,
                prefix: false,
                count: 0,
                operatorCount: 1,
              }
            }
            try {
              if (visual.position !== null) transaction.doc.resolve(visual.position)
              if (cursor.position !== null) transaction.doc.resolve(cursor.position)
              if (operator.position !== null) transaction.doc.resolve(operator.position)
              return {
                ...value,
                visualAnchor: visual.position,
                visualCursor: cursor.position,
                operatorAnchor: operator.position,
              }
            } catch {
              return {
                ...value,
                visualAnchor: null,
                visualCursor: null,
                visualLinewise: false,
                operator: null,
                operatorAnchor: null,
                prefix: false,
                count: 0,
                operatorCount: 1,
              }
            }
          },
        },
        view(view) {
          const update = () => {
            const mode = KEY.getState(view.state)?.mode ?? ''
            if (mode) view.dom.dataset.vimMode = mode
            else delete view.dom.dataset.vimMode
            options.onModeChange?.(mode)
          }
          update()
          return {
            update,
            destroy: () => {
              delete view.dom.dataset.vimMode
              options.onModeChange?.('')
            },
          }
        },
        props: {
          handleDOMEvents: {
            blur(view) {
              clearTransient(view)
              return false
            },
            compositionstart(view) {
              clearTransient(view)
              return false
            },
            compositionend(view) {
              clearTransient(view)
              return false
            },
          },
          handleKeyDown(view, event) {
            const state = KEY.getState(view.state) ?? EMPTY
            if (
              !state.enabled ||
              !options.active ||
              !(event.target instanceof Node) ||
              !view.dom.contains(event.target)
            )
              return false
            if (
              event.target instanceof Element &&
              event.target.closest('input,textarea,select,[contenteditable="false"]')
            )
              return false
            if (event.isComposing || event.key === 'Process') return false
            if (state.mode === 'insert') {
              if (
                event.key !== 'Escape' ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                event.shiftKey
              )
                return false
              if (options.escapeOwned?.()) {
                options.onEscapeOwned?.()
                event.preventDefault()
                return true
              }
              if (view.dom.getAttribute('aria-haspopup') === 'listbox') return false
              leaveInsert(view)
              event.preventDefault()
              return true
            }
            if (state.mode !== 'normal') return false
            const handled = handleNormal(view, event, options, state)
            if (!handled) return false
            return true
          },
        },
      }),
    ]
  },
})

export function configureRichTextVim(
  view: EditorView,
  enabled: boolean,
  active: boolean,
  editable: () => boolean,
) {
  const current = KEY.getState(view.state) ?? EMPTY
  const shouldEnable = enabled && active && editable()
  const tr = view.state.tr
    .setMeta(KEY, {
      ...resetTransient(current),
      enabled: shouldEnable,
      mode: shouldEnable ? (current.enabled ? current.mode : 'normal') : '',
      insertHistoryTime:
        shouldEnable && current.mode === 'insert' ? current.insertHistoryTime : null,
      register: current.register,
    })
    .setMeta('addToHistory', false)
  if (current.visualAnchor !== null && !view.state.selection.empty)
    tr.setSelection(TextSelection.near(tr.doc.resolve(view.state.selection.head), 1))
  view.dispatch(tr)
}
