import { Extension } from '@tiptap/react'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { closeHistory, undo, redo } from '@tiptap/pm/history'
import { requestHostHints } from '@/lib/host-hints'
import { clearExtraSelections } from './multi-cursor'
import { pasteVimRegister } from './rich-text-vim-register'
import type { VimRegister } from './rich-text-vim-register'
import { planVimOperator, resolveVimMotion, resolveVimVisualRange } from './rich-text-vim-operator'
import type { VimOperatorRequest } from './rich-text-vim-operator'
import {
  containerAt,
  graphemeBoundaries,
  graphemeParts as segments,
  logicalLineAt as lineAt,
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
  register: VimRegister | null
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

function setVisualSelection(view: EditorView, anchor: number, head: number, linewise: boolean) {
  const range = resolveVimVisualRange(view.state, anchor, head, linewise)
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

function lineMotion(view: EditorView, key: '0' | '^' | '$', count = 1) {
  const line = lineAt(view.state, view.state.selection.head)
  if (!line) return
  let targetLine = line
  if (key === '$' && count > 1) {
    const all = blocks(view.state).flatMap((block) => logicalLines(block))
    const container = containerAt(view.state, line.block.from, STRUCTURAL_CONTAINERS)
    const candidates = all.filter((candidate) => {
      const candidateContainer = containerAt(
        view.state,
        candidate.block.from,
        STRUCTURAL_CONTAINERS,
      )
      return container
        ? candidateContainer?.pos === container.pos && candidateContainer.type === container.type
        : !candidateContainer
    })
    const index = candidates.findIndex(
      (candidate) => candidate.block.from === line.block.from && candidate.from === line.from,
    )
    targetLine = candidates[Math.min(candidates.length - 1, index + count - 1)] ?? line
  }
  const positions = graphemeBoundaries(view.state, targetLine.from, targetLine.to)
  const target =
    key === '0'
      ? targetLine.from
      : key === '$'
        ? positions.length > 1
          ? positions.at(-2)!
          : positions.at(-1)!
        : (positions.find(
            (at) =>
              view.state.doc.textBetween(at, positions.find((next) => next > at) ?? at).trim() !==
              '',
          ) ?? targetLine.to)
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

function executeVimOperator(
  view: EditorView,
  settings: VimSettings,
  current: VimState,
  request: VimOperatorRequest,
) {
  const plan = planVimOperator(view.state, request)
  const clearPlan = () => {
    const latest = KEY.getState(view.state) ?? current
    const tr = view.state.tr.setMeta(KEY, resetTransient(latest)).setMeta('addToHistory', false)
    if (latest.visualAnchor !== null && !view.state.selection.empty)
      tr.setSelection(TextSelection.near(tr.doc.resolve(view.state.selection.head), 1))
    view.dispatch(tr)
  }
  if (plan.kind === 'noop') {
    clearPlan()
    return
  }
  if (plan.kind === 'rejected') {
    clearPlan()
    settings.onFeedback?.(plan.feedback)
    return
  }
  const { operator } = plan
  if (plan.sourceDoc !== view.state.doc || (operator !== 'y' && !settings.editable())) {
    clearPlan()
    return
  }
  const latest = KEY.getState(view.state) ?? current
  if (operator === 'y' || !plan.mutation) {
    if (operator === 'c') closeHistoryBoundary(view)
    const tr = view.state.tr.setSelection(
      TextSelection.near(view.state.doc.resolve(plan.caret.position), plan.caret.bias),
    )
    view.dispatch(
      tr
        .setMeta(KEY, {
          ...resetTransient(latest),
          register: plan.register,
          mode: operator === 'c' ? 'insert' : latest.mode,
          insertHistoryTime: operator === 'c' ? latest.insertHistoryTime : null,
        })
        .setMeta('addToHistory', false),
    )
    return
  }
  let tr = view.state.tr
  const { range } = plan.mutation
  if (plan.mutation.kind === 'delete') tr.delete(range.from, range.to)
  else tr.replaceWith(range.from, range.to, plan.mutation.replacement.content)
  try {
    tr.doc.check()
    tr.setSelection(TextSelection.near(tr.doc.resolve(plan.caret.position), plan.caret.bias))
    if (operator === 'c') {
      closeHistoryBoundary(view)
      tr.setMeta('vimChangeInsert', true)
    } else tr = closeHistory(tr)
    view.dispatch(tr)
    const after = KEY.getState(view.state) ?? latest
    view.dispatch(
      view.state.tr
        .setMeta(KEY, {
          ...resetTransient(after),
          register: plan.register,
          mode: operator === 'c' ? 'insert' : 'normal',
          insertHistoryTime: operator === 'c' ? after.insertHistoryTime : null,
        })
        .setMeta('addToHistory', false),
    )
    if (operator !== 'c') closeHistoryBoundary(view)
  } catch {
    clearPlan()
    settings.onFeedback?.('Vim range does not fit here; no text was changed')
  }
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
    const visualDestination = resolveVimMotion(view.state, visualOrigin, key as Motion, count)
    const visualRangePreview = resolveVimVisualRange(
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
    view.dispatch(
      view.state.tr
        .setMeta(KEY, { ...current, visualCursor: visualDestination, count: 0 })
        .setMeta('addToHistory', false),
    )
    setVisualSelection(view, current.visualAnchor, visualDestination, current.visualLinewise)
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
      const range = resolveVimVisualRange(view.state, anchor, visualHead, true)
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
    const origin = current.operatorAnchor ?? view.state.selection.head
    const count = cappedCount(current.operatorCount * (current.count || 1))
    if (key === operator)
      executeVimOperator(view, settings, current, {
        operator,
        target: { kind: 'doubled', origin, count },
      })
    else if (['w', 'b', 'e', 'h', 'l', 'j', 'k', '0', '^', '$'].includes(key))
      executeVimOperator(view, settings, current, {
        operator,
        target: { kind: 'motion', origin, motion: key as Motion, count },
      })
    else update({ ...resetTransient(current) })
    event.preventDefault()
    return true
  }
  if (current.visualAnchor !== null && (key === 'd' || key === 'c' || key === 'y')) {
    executeVimOperator(view, settings, current, {
      operator: key,
      target: {
        kind: 'visual',
        anchor: current.visualAnchor,
        cursor: current.visualCursor ?? current.visualAnchor,
        linewise: current.visualLinewise,
      },
    })
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
    if (key === '$') lineMotion(view, key, cappedCount(current.count))
    for (let index = 0; key !== '$' && index < cappedCount(current.count); index++) {
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
              (value.visualAnchor !== null ||
                value.operator !== null ||
                value.prefix ||
                value.count > 0 ||
                value.operatorCount > 1)
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
