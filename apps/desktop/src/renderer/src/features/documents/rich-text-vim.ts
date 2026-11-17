import { Extension } from '@tiptap/react'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { closeHistory, undo, redo } from '@tiptap/pm/history'
import { requestHostHints } from '@/lib/host-hints'
import { clearExtraSelections } from './multi-cursor'

export type RichTextVimMode = 'normal' | 'insert' | ''

type VimSettings = {
  enabled: boolean
  active: boolean
  editable: () => boolean
  onModeChange?: (mode: RichTextVimMode) => void
  onHints?: (view: EditorView) => void
  onFeedback?: (message: string) => void
  escapeOwned?: () => boolean
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
  register: { content: import('@tiptap/pm/model').Slice; linewise: boolean } | null
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
  register: null,
}
const WORD = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_]*$/u

function segments(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(
      ({ segment }) => segment,
    )
  }
  return Array.from(value)
}

function setMode(view: EditorView, mode: RichTextVimMode, enabled?: boolean) {
  const current = KEY.getState(view.state) ?? EMPTY
  view.dispatch(
    view.state.tr
      .setMeta(KEY, { ...current, mode, enabled: enabled ?? current.enabled, prefix: false })
      .setMeta('addToHistory', false),
  )
}

function blocks(state: EditorState) {
  const result: { from: number; to: number; node: typeof state.doc }[] = []
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) result.push({ from: pos + 1, to: pos + node.nodeSize - 1, node })
  })
  return result
}

function lineAt(state: EditorState, pos: number) {
  const block = blocks(state).find(({ from, to }) => pos >= from && pos <= to)
  if (!block) return null
  const breaks: number[] = []
  block.node.descendants((node, offset) => {
    if (node.type.name === 'hardBreak') breaks.push(block.from + offset)
    if (block.node.type.name === 'codeBlock' && node.isText) {
      for (let index = 0; index < (node.text ?? '').length; index++)
        if (node.text?.[index] === '\n') breaks.push(block.from + offset + index)
    }
  })
  const before = breaks.filter((at) => at < pos).at(-1)
  const after = breaks.find((at) => at >= pos)
  return {
    block,
    from: before === undefined ? block.from : before + 1,
    to: after === undefined ? block.to : after,
  }
}

function graphemeBoundaries(state: EditorState, from: number, to: number) {
  const positions = new Set<number>([from, to])
  let runText = ''
  let runStart = 0
  let runEnd = 0
  const flushText = () => {
    if (!runText) return
    let offset = 0
    for (const part of segments(runText)) {
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

function containerAt(state: EditorState, pos: number, names: string[]) {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)))
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (names.includes(node.type.name)) return { type: node.type.name, pos: $pos.before(depth) }
  }
  return null
}

function structurallyContained(state: EditorState, pos: number) {
  let contained = false
  state.doc.descendants((node, start) => {
    if (
      ['tableCell', 'tableHeader', 'listItem', 'taskItem'].includes(node.type.name) &&
      pos >= start &&
      pos <= start + node.nodeSize
    )
      contained = true
  })
  return contained
}

function safeRange(state: EditorState, from: number, to: number) {
  const names = ['tableCell', 'tableHeader', 'listItem', 'taskItem']
  const touched = blocks(state).filter((block) => block.from <= to && block.to >= from)
  const origin = containerAt(state, from, names)
  return touched.every((block) => {
    const nested = containerAt(state, block.from, names)
    return origin?.pos === nested?.pos && origin?.type === nested?.type
  })
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
    }
  }
  const first = lineAt(state, Math.min(anchor, head))
  const last = lineAt(state, Math.max(anchor, head))
  if (!first || !last) return null
  const from = first.block.from
  const to = last.block.to
  return { anchor: head >= anchor ? from : to, head: head >= anchor ? to : from, from, to }
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
  clearExtraSelections(view)
  const { state } = view
  if (!state.selection.empty) select(view, state.selection.from)
  const line = lineAt(view.state, view.state.selection.head)
  if (line && view.state.selection.empty && view.state.selection.head > line.from)
    horizontal(view, -1)
  setMode(view, 'normal')
}

function operatorRange(
  view: EditorView,
  start: number,
  motion: 'w' | 'b' | 'e' | 'h' | 'l' | 'j' | 'k' | '0' | '^' | '$',
  count: number,
) {
  const origin = view.state.selection.head
  select(view, start)
  for (let index = 0; index < count; index++) {
    if (motion === 'w' || motion === 'b' || motion === 'e') wordMotion(view, motion)
    else if (motion === 'h' || motion === 'l') horizontal(view, motion === 'h' ? -1 : 1)
    else if (motion === 'j' || motion === 'k') vertical(view, motion === 'j' ? 1 : -1)
    else if (motion === '0' || motion === '^' || motion === '$') lineMotion(view, motion)
  }
  const destination = view.state.selection.head
  return { from: Math.min(origin, destination), to: Math.max(origin, destination) }
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
      tr.setMeta(KEY, {
        ...current,
        prefix: false,
        operator: null,
        count: 0,
        operatorCount: 1,
        visualAnchor: null,
        visualCursor: null,
        visualLinewise: false,
        operatorAnchor: null,
      }).setMeta('addToHistory', false)
      view.dispatch(tr)
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
    select(view, current.visualCursor ?? current.visualAnchor)
    if (key === 'h' || key === 'l') horizontal(view, key === 'h' ? -1 : 1)
    else if (key === 'j' || key === 'k') vertical(view, key === 'j' ? 1 : -1)
    else if (key === 'w' || key === 'b' || key === 'e') wordMotion(view, key)
    else lineMotion(view, key)
    const anchor = Math.min(current.visualAnchor, view.state.doc.content.size)
    const head = view.state.selection.head
    view.dispatch(
      view.state.tr.setMeta(KEY, { ...current, visualCursor: head }).setMeta('addToHistory', false),
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
      const all = blocks(view.state)
      const line = lineAt(view.state, anchor)
      const index = all.findIndex((block) => block.from === line?.block.from)
      const target = all[Math.min(all.length - 1, index + current.count - 1)]
      if (target) visualHead = target.from
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
    if (key === operator) {
      const line = lineAt(view.state, view.state.selection.head)
      if (line) {
        const { block } = line
        const nested = containerAt(view.state, block.from, [
          'tableCell',
          'tableHeader',
          'listItem',
          'taskItem',
        ])
        const from = nested ? block.from : block.from - 1
        const to = nested ? block.to : block.to + 1
        const content = view.state.doc.slice(from, to)
        update({
          operator: null,
          count: 0,
          operatorCount: 1,
          register: { content, linewise: true },
        })
        if (operator !== 'y' && settings.editable()) {
          const tr = closeHistory(view.state.tr).delete(from, to)
          view.dispatch(
            tr.setSelection(
              TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size)), 1),
            ),
          )
          if (operator === 'c') setMode(view, 'insert', true)
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
      const operatorLine = lineAt(view.state, origin)
      if (
        (key === 'j' || key === 'k') &&
        operatorLine &&
        structurallyContained(view.state, operatorLine.block.from)
      ) {
        update({ operator: null, operatorAnchor: null, count: 0, operatorCount: 1 })
        settings.onFeedback?.('Vim motion crosses a list or table; no text was changed')
        event.preventDefault()
        return true
      }
      const range = operatorRange(
        view,
        origin,
        key,
        Math.max(1, current.operatorCount * (current.count || 1)),
      )
      const from = range.from
      const to = key === 'e' || key === 'l' || key === '$' ? range.to + 1 : range.to
      const safeTo = Math.min(view.state.doc.content.size, Math.max(from, to))
      const sourceBlock = lineAt(view.state, origin)?.block
      const destinationBlock = lineAt(view.state, range.to)?.block
      const structuralCrossing =
        (key === 'j' || key === 'k') &&
        sourceBlock !== undefined &&
        destinationBlock !== undefined &&
        containerAt(view.state, sourceBlock.from, [
          'tableCell',
          'tableHeader',
          'listItem',
          'taskItem',
        ])?.pos !==
          containerAt(view.state, destinationBlock.from, [
            'tableCell',
            'tableHeader',
            'listItem',
            'taskItem',
          ])?.pos
      const allowed = !structuralCrossing && safeRange(view.state, from, safeTo)
      if (!allowed) {
        update({ operator: null, operatorAnchor: null, count: 0, operatorCount: 1 })
        settings.onFeedback?.('Vim motion crosses a list or table; no text was changed')
        event.preventDefault()
        return true
      }
      const content = view.state.doc.slice(from, safeTo)
      update({
        operator: null,
        operatorAnchor: null,
        count: 0,
        operatorCount: 1,
        register: { content, linewise: false },
      })
      if (operator !== 'y' && settings.editable() && safeTo > from) {
        const tr = closeHistory(view.state.tr).delete(from, safeTo)
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(from), 1)))
        if (operator === 'c') setMode(view, 'insert', true)
      }
      event.preventDefault()
      return true
    }
    update({ operator: null, operatorAnchor: null, count: 0 })
  }
  if (current.visualAnchor !== null && (key === 'd' || key === 'c' || key === 'y')) {
    const range = visualRange(
      view.state,
      current.visualAnchor,
      view.state.selection.head,
      current.visualLinewise,
    )
    if (!range || (key !== 'y' && !safeRange(view.state, range.from, range.to))) {
      update({ visualAnchor: null, visualCursor: null, visualLinewise: false, count: 0 })
      settings.onFeedback?.('Vim selection crosses a list or table; no text was changed')
      event.preventDefault()
      return true
    }
    const content = view.state.doc.slice(range.from, range.to)
    update({
      visualAnchor: null,
      visualCursor: null,
      visualLinewise: false,
      register: { content, linewise: current.visualLinewise },
    })
    if (key !== 'y' && settings.editable() && range.to > range.from) {
      const tr = closeHistory(view.state.tr).delete(range.from, range.to)
      view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(range.from), 1)))
      if (key === 'c') setMode(view, 'insert', true)
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
    if (settings.editable()) {
      const line = lineAt(view.state, view.state.selection.head)
      const nested =
        line &&
        containerAt(view.state, line.block.from, [
          'tableCell',
          'tableHeader',
          'listItem',
          'taskItem',
        ])
      const at =
        current.register.linewise && line
          ? nested
            ? key === 'p'
              ? line.block.to
              : line.block.from
            : key === 'p'
              ? line.block.to + 1
              : line.block.from - 1
          : view.state.selection.head + (key === 'p' && !current.register.linewise ? 1 : 0)
      const pos = Math.max(0, Math.min(at, view.state.doc.content.size))
      const $pos = view.state.doc.resolve(pos)
      if ($pos.parent.canReplace($pos.index(), $pos.index(), current.register.content.content)) {
        const tr = view.state.tr.replace(pos, pos, current.register.content)
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos), 1)).scrollIntoView())
      } else
        settings.onFeedback?.('Vim register does not fit at this position; no text was changed')
    }
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
    for (let index = 0; index < Math.max(1, current.count); index++) {
      if (key === 'h' || key === 'l') horizontal(view, key === 'h' ? -1 : 1)
      else if (key === 'j' || key === 'k') vertical(view, key === 'j' ? 1 : -1)
      else if (key === 'w' || key === 'b' || key === 'e') wordMotion(view, key)
      else lineMotion(view, key)
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
    event.preventDefault()
    return true
  }
  if (key === 'x') {
    if (settings.editable()) deleteChar(view)
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
        state: {
          init: () => ({
            ...EMPTY,
            enabled: options.enabled,
            mode: options.enabled ? 'normal' : '',
          }),
          apply(transaction, value) {
            const meta = transaction.getMeta(KEY) as VimState | undefined
            if (meta) return meta
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
            const operator = mapPosition(value.operatorAnchor)
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
              const current = KEY.getState(view.state) ?? EMPTY
              if (current.prefix)
                view.dispatch(
                  view.state.tr
                    .setMeta(KEY, { ...current, prefix: false })
                    .setMeta('addToHistory', false),
                )
              return false
            },
            compositionstart(view) {
              const current = KEY.getState(view.state) ?? EMPTY
              if (current.prefix)
                view.dispatch(
                  view.state.tr
                    .setMeta(KEY, { ...current, prefix: false })
                    .setMeta('addToHistory', false),
                )
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
              if (options.escapeOwned?.() || view.dom.getAttribute('aria-haspopup') === 'listbox')
                return false
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
  view.dispatch(
    view.state.tr
      .setMeta(KEY, {
        enabled: shouldEnable,
        mode: shouldEnable ? (current.enabled ? current.mode : 'normal') : '',
        prefix: false,
        operator: null,
        count: 0,
        operatorCount: 1,
        visualAnchor: null,
        visualCursor: null,
        visualLinewise: false,
        operatorAnchor: null,
        register: current.register,
      })
      .setMeta('addToHistory', false),
  )
}
