import {
  nativeFieldEdit,
  nextGrapheme,
  previousGrapheme,
  setFieldSelection,
} from './native-field-edit'
import type { NativeField } from './native-field-edit'
import { requestHostHints } from './host-hints'

export type NativeFieldMode = 'insert' | 'normal' | 'visual'
export interface NativeFieldVimState {
  mode: NativeFieldMode
  count: string
  anchor: number | null
  operator: 'delete' | 'change' | 'yank' | null
  operatorCount: number
}

export function createNativeFieldVimState(): NativeFieldVimState {
  return { mode: 'insert', count: '', anchor: null, operator: null, operatorCount: 1 }
}

function lineStart(value: string, at: number): number {
  return value.lastIndexOf('\n', Math.max(0, at - 1)) + 1
}
function lineEnd(value: string, at: number): number {
  const end = value.indexOf('\n', at)
  return end < 0 ? value.length : end
}

function copy(text: string): void {
  if (!navigator.clipboard) return
  void Promise.resolve()
    .then(() => navigator.clipboard!.writeText(text))
    .catch((error: unknown) => console.error(error))
}

const commandGenerations = new WeakMap<NativeField, number>()
function paste(field: NativeField): void {
  if (!navigator.clipboard) return
  const generation = field.dataset.vimGeneration
  const command = (commandGenerations.get(field) ?? 0) + 1
  commandGenerations.set(field, command)
  const value = field.value
  const start = field.selectionStart
  const end = field.selectionEnd
  const direction = field.selectionDirection
  void Promise.resolve()
    .then(() => navigator.clipboard!.readText())
    .then((text) => {
      if (
        command !== commandGenerations.get(field) ||
        !field.isConnected ||
        document.activeElement !== field ||
        field.disabled ||
        field.readOnly ||
        field.value !== value ||
        field.selectionStart !== start ||
        field.selectionEnd !== end ||
        field.selectionDirection !== direction ||
        field.dataset.vimGeneration !== generation ||
        field.closest('[hidden], [inert], [aria-hidden="true"]')
      )
        return
      nativeFieldEdit(field, 'insertText', text)
    })
    .catch((error: unknown) => console.error(error))
}

function grapheme(value: string, at: number): string {
  return value.slice(at, nextGrapheme(value, at))
}
function isWord(value: string): boolean {
  return /^[\p{L}\p{N}_]+$/u.test(value)
}
function isSpace(value: string): boolean {
  return /^\s+$/u.test(value)
}

/** Handle one keydown; false leaves the browser and host shortcuts untouched. */
export function handleNativeFieldKey(
  event: React.KeyboardEvent<NativeField>,
  state: NativeFieldVimState,
): boolean {
  const field = event.currentTarget
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  const key = event.key
  commandGenerations.set(field, (commandGenerations.get(field) ?? 0) + 1)
  if (state.mode === 'insert') {
    if (key !== 'Escape') return false
    event.preventDefault()
    event.stopPropagation()
    state.mode = 'normal'
    state.count = ''
    state.anchor = null
    state.operator = null
    const at = previousGrapheme(field.value, field.selectionStart ?? 0)
    setFieldSelection(field, at)
    return true
  }
  if (key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    state.mode = 'normal'
    state.anchor = null
    state.count = ''
    state.operator = null
    return true
  }
  if (/^[1-9]$/.test(key) || (/^0$/.test(key) && state.count)) {
    state.count = (state.count + key).slice(0, 4)
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  const count = Math.min(
    1000,
    Math.max(1, Number(state.count) || 1) * (state.operator === null ? 1 : state.operatorCount),
  )
  state.count = ''
  if (state.operator === null && (key === 'd' || key === 'c' || key === 'y')) {
    const operator = key === 'd' ? 'delete' : key === 'c' ? 'change' : 'yank'
    if (state.mode === 'visual') {
      event.preventDefault()
      event.stopPropagation()
      const cursor =
        field.selectionDirection === 'backward'
          ? (field.selectionStart ?? 0)
          : previousGrapheme(field.value, field.selectionEnd ?? 0)
      const from = Math.min(state.anchor ?? cursor, cursor)
      const to = nextGrapheme(field.value, Math.max(state.anchor ?? cursor, cursor))
      if (operator === 'yank') copy(field.value.slice(from, to))
      else {
        setFieldSelection(field, from, to)
        nativeFieldEdit(field, 'delete')
        if (operator === 'change') state.mode = 'insert'
      }
      if (operator !== 'change') state.mode = 'normal'
      state.anchor = null
      return true
    }
    state.operator = operator
    state.operatorCount = count
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  if (key === 'f') {
    event.preventDefault()
    event.stopPropagation()
    if (state.mode === 'normal' && state.operator === null && count === 1) requestHostHints(field)
    state.count = ''
    state.operator = null
    return true
  }
  if (key === 'i' || key === 'a' || key === 'I' || key === 'A') {
    event.preventDefault()
    event.stopPropagation()
    const value = field.value
    let at = field.selectionStart ?? 0
    if (key === 'a' && at < value.length) at = nextGrapheme(value, at)
    if (key === 'I') at = lineStart(value, at)
    if (key === 'A') at = lineEnd(value, at)
    setFieldSelection(field, at)
    state.mode = 'insert'
    state.anchor = null
    state.operator = null
    return true
  }
  if (key === 'v') {
    event.preventDefault()
    event.stopPropagation()
    state.mode = 'visual'
    state.anchor = field.selectionStart ?? 0
    setFieldSelection(field, state.anchor, nextGrapheme(field.value, state.anchor))
    return true
  }
  if (key === 'Enter') {
    event.preventDefault()
    event.stopPropagation()
    state.operator = null
    state.count = ''
    return true
  }
  const value = field.value
  let at = field.selectionStart ?? 0
  const end = field.selectionEnd ?? at
  if (state.mode === 'visual' && state.anchor !== null)
    at =
      field.selectionDirection === 'backward'
        ? (field.selectionStart ?? at)
        : previousGrapheme(value, end)
  let target = at
  if (key === 'h') for (let i = 0; i < count; i++) target = previousGrapheme(value, target)
  else if (key === 'l') for (let i = 0; i < count; i++) target = nextGrapheme(value, target)
  else if (key === '0' || key === 'Home') target = lineStart(value, at)
  else if (key === '$' || key === 'End') target = lineEnd(value, at)
  else if (key === 'w') {
    target = at
    for (let i = 0; i < count; i++) {
      if (target < value.length && isWord(grapheme(value, target))) {
        while (target < value.length && isWord(grapheme(value, target)))
          target = nextGrapheme(value, target)
      }
      while (target < value.length && !isWord(grapheme(value, target)))
        target = nextGrapheme(value, target)
    }
  } else if (key === 'b') {
    target = at
    for (let i = 0; i < count; i++) {
      target = previousGrapheme(value, target)
      while (target > 0 && isSpace(grapheme(value, target)))
        target = previousGrapheme(value, target)
      const word = isWord(grapheme(value, target))
      while (
        target > 0 &&
        isWord(grapheme(value, target)) === word &&
        !isSpace(grapheme(value, target))
      )
        target = previousGrapheme(value, target)
      if (
        target < value.length &&
        (!isWord(grapheme(value, target)) || isSpace(grapheme(value, target)))
      )
        target = nextGrapheme(value, target)
    }
  } else if (key === 'j' || key === 'k') {
    const start = lineStart(value, at)
    const column = [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.slice(start, at)),
    ].length
    let rowStart = start
    for (let i = 0; i < count; i++) {
      const next = key === 'j' ? lineEnd(value, rowStart) + 1 : rowStart - 1
      if (next < 0 || next > value.length) break
      rowStart = key === 'j' ? next : lineStart(value, next)
    }
    const rowEnd = lineEnd(value, rowStart)
    target = rowStart
    for (let i = 0; i < column && target < rowEnd; i++) target = nextGrapheme(value, target)
  } else if (
    state.operator !== null &&
    key === (state.operator === 'delete' ? 'd' : state.operator === 'change' ? 'c' : 'y')
  ) {
    event.preventDefault()
    event.stopPropagation()
    const from = lineStart(value, at)
    let to = from
    for (let i = 0; i < count; i++) {
      const endOfLine = lineEnd(value, to)
      to = Math.min(value.length, endOfLine + (endOfLine < value.length ? 1 : 0))
    }
    const operator = state.operator
    if (operator === 'yank') copy(value.slice(from, to))
    else {
      setFieldSelection(field, from, to)
      nativeFieldEdit(field, 'delete')
      if (operator === 'change') state.mode = 'insert'
    }
    setFieldSelection(field, from)
    state.operator = null
    if (operator !== 'change') state.mode = 'normal'
    return true
  } else if (key === 'x' || key === 'p' || key === 'u') {
    event.preventDefault()
    event.stopPropagation()
    if (key === 'u') {
      document.execCommand('undo')
      return true
    }
    if (key === 'p') {
      paste(field)
      return true
    }
    let from = at,
      to = end
    if (state.mode !== 'visual' && from === to) {
      if (key === 'x') for (let i = 0; i < count; i++) to = nextGrapheme(value, to)
      else to = lineEnd(value, at)
    }
    if (state.mode === 'visual') {
      from = Math.min(state.anchor ?? at, at)
      to = nextGrapheme(value, Math.max(state.anchor ?? at, at))
    }
    if (to > from) {
      setFieldSelection(field, from, to)
      nativeFieldEdit(field, 'delete')
      state.mode = 'normal'
    }
    state.anchor = null
    return true
  } else {
    state.count = ''
    if (state.operator !== null) state.operator = null
    if (key.length === 1 || key === 'Backspace' || key === 'Delete' || key.startsWith('Arrow')) {
      event.preventDefault()
      event.stopPropagation()
      return true
    }
    return false
  }
  event.preventDefault()
  event.stopPropagation()
  if (state.operator !== null) {
    let from = Math.min(at, target)
    let to = Math.max(at, target)
    if (to > from) {
      if (state.operator === 'yank') {
        copy(value.slice(from, to))
      } else {
        setFieldSelection(field, from, to)
        nativeFieldEdit(field, 'delete')
        if (state.operator === 'change') state.mode = 'insert'
      }
      setFieldSelection(field, from)
    }
    const operator = state.operator
    state.operator = null
    if (operator !== 'change') state.mode = 'normal'
    return true
  }
  if (state.mode === 'visual' && state.anchor !== null) {
    const from = Math.min(state.anchor, target)
    const to = nextGrapheme(value, Math.max(state.anchor, target))
    setFieldSelection(field, from, to, target < state.anchor ? 'backward' : 'forward')
  } else {
    setFieldSelection(field, target)
  }
  return true
}
