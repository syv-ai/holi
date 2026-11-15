import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeFieldVimState, handleNativeFieldKey } from '@/lib/native-field-vim'

function key(
  field: HTMLInputElement,
  state: ReturnType<typeof createNativeFieldVimState>,
  value: string,
) {
  let consumed = false
  const event = {
    currentTarget: field,
    nativeEvent: { isComposing: false, keyCode: 0 },
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: () => undefined,
    stopPropagation: vi.fn(),
  }
  consumed = handleNativeFieldKey(event as never, state)
  return consumed
}

describe('native field Vim commands', () => {
  beforeEach(() => {
    document.execCommand = vi.fn(() => true)
  })

  it.each(['delete', 'change', 'yank'] as const)(
    'completes the %s operator with a word motion',
    (operator) => {
      const field = document.createElement('input')
      field.value = 'foo, bar baz'
      field.focus()
      field.setSelectionRange(0, 0)
      const state = createNativeFieldVimState()
      state.mode = 'normal'
      const selection = vi.spyOn(field, 'setSelectionRange')
      key(field, state, operator === 'delete' ? 'd' : operator === 'change' ? 'c' : 'y')
      key(field, state, 'w')
      if (operator === 'yank') expect(selection).toHaveBeenCalledWith(0, 0, 'forward')
      else expect(selection).toHaveBeenCalledWith(0, 5, 'forward')
      expect(state.operator).toBeNull()
    },
  )

  it('does not turn an incomplete operator into a line deletion on Enter or printable keys', () => {
    const field = document.createElement('input')
    field.value = 'keep this line'
    field.focus()
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    key(field, state, 'd')
    expect(key(field, state, 'q')).toBe(true)
    expect(field.value).toBe('keep this line')
    key(field, state, 'd')
    expect(key(field, state, 'Enter')).toBe(true)
    expect(field.value).toBe('keep this line')
  })

  it('does not paste into a field after focus changes during clipboard read', async () => {
    let resolveRead!: (value: string) => void
    const readText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    vi.stubGlobal('navigator', { clipboard: { readText } })
    const field = document.createElement('input')
    document.body.append(field)
    field.value = 'original'
    field.focus()
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    key(field, state, 'p')
    await Promise.resolve()
    field.blur()
    resolveRead('stale')
    await Promise.resolve()
    await Promise.resolve()
    expect(document.execCommand).not.toHaveBeenCalled()
    field.remove()
    vi.unstubAllGlobals()
  })

  it.each([
    ['3x', ['3', 'x'], 0, 3],
    ['2dd', ['2', 'd', 'd'], 0, 20],
    ['2cc', ['2', 'c', 'c'], 0, 20],
    ['2yy', ['2', 'y', 'y'], 0, 0],
  ])('applies count command %s', (_name, keys, from, to) => {
    const field = document.createElement('input')
    field.value = 'one two\nthree four\nend'
    field.focus()
    field.setSelectionRange(0, 0)
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    const selection = vi.spyOn(field, 'setSelectionRange')
    for (const command of keys) expect(key(field, state, command)).toBe(true)
    expect(selection).toHaveBeenCalledWith(from, to, 'forward')
    expect(state.operator).toBeNull()
  })

  it('cancels mismatched operators without editing and keeps visual f inert', () => {
    const field = document.createElement('input')
    field.value = 'keep me'
    field.focus()
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    key(field, state, 'd')
    expect(key(field, state, 'y')).toBe(true)
    expect(state.operator).toBeNull()
    expect(document.execCommand).not.toHaveBeenCalled()
    state.mode = 'visual'
    state.anchor = 0
    expect(key(field, state, 'f')).toBe(true)
    expect(state.mode).toBe('visual')
    expect(state.operator).toBeNull()
  })

  it('requests host hints only from idle normal mode', () => {
    const field = document.createElement('input')
    const request = vi.fn()
    window.addEventListener('holi:vim-host-hints', request)
    try {
      const state = createNativeFieldVimState()
      state.mode = 'normal'
      key(field, state, 'f')
      expect(request).toHaveBeenCalledOnce()
      expect((request.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ source: field })
      state.mode = 'visual'
      key(field, state, 'f')
      state.mode = 'normal'
      key(field, state, 'd')
      key(field, state, 'f')
      expect(state.operator).toBeNull()
      expect(request).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('holi:vim-host-hints', request)
    }
  })

  it('uses an inclusive grapheme endpoint for visual selections', () => {
    const field = document.createElement('input')
    field.value = '😀ab'
    field.focus()
    field.setSelectionRange(0, 0)
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    const selection = vi.spyOn(field, 'setSelectionRange')
    key(field, state, 'v')
    key(field, state, 'l')
    key(field, state, 'x')
    expect(selection).toHaveBeenCalledWith(0, 3, 'forward')
    expect(document.execCommand).toHaveBeenCalledWith('delete')
  })

  it('moves word motions over Unicode graphemes and punctuation', () => {
    const field = document.createElement('input')
    field.value = '😀 é!!! 𐐀x'
    field.focus()
    field.setSelectionRange(0, 0)
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    key(field, state, 'w')
    expect(field.selectionStart).toBe(9)
    key(field, state, 'w')
    expect(field.selectionStart).toBe(12)
    key(field, state, 'b')
    expect(field.selectionStart).toBe(9)
  })

  it.each(['value', 'selection'])('abandons stale paste after %s changes', async (change) => {
    let resolveRead!: (value: string) => void
    const readText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        }),
    )
    vi.stubGlobal('navigator', { clipboard: { readText } })
    const field = document.createElement('input')
    document.body.append(field)
    field.value = 'original'
    field.focus()
    field.setSelectionRange(0, 0)
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    key(field, state, 'p')
    await Promise.resolve()
    if (change === 'value') field.value = 'changed'
    else field.setSelectionRange(1, 1)
    resolveRead('stale')
    await Promise.resolve()
    await Promise.resolve()
    expect(document.execCommand).not.toHaveBeenCalled()
    field.remove()
    vi.unstubAllGlobals()
  })

  it('handles clipboard read rejection and multiplies operator and motion counts', async () => {
    const error = new Error('denied')
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn().mockRejectedValue(error) } })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const field = document.createElement('input')
    document.body.append(field)
    field.value = 'one two three four five six'
    field.focus()
    field.setSelectionRange(0, 0)
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    key(field, state, 'p')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).toHaveBeenCalledWith(error)
    expect(key(field, state, '2')).toBe(true)
    key(field, state, 'd')
    key(field, state, '3')
    key(field, state, 'w')
    expect(state.operator).toBeNull()
    field.remove()
    log.mockRestore()
    vi.unstubAllGlobals()
  })

  it('handles clipboard write rejection without claiming a yank succeeded', async () => {
    const error = new Error('write denied')
    const writeText = vi.fn().mockRejectedValue(error)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const field = document.createElement('input')
    field.value = 'copy me'
    field.focus()
    field.setSelectionRange(0, 0)
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    key(field, state, 'y')
    key(field, state, 'y')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writeText).toHaveBeenCalledWith('copy me')
    expect(log).toHaveBeenCalledWith(error)
    expect(state.operator).toBeNull()
    log.mockRestore()
    vi.unstubAllGlobals()
  })

  it('accepts both count placements and bounds a large count', () => {
    const field = document.createElement('input')
    field.value = 'one two three four'
    field.focus()
    field.setSelectionRange(0, 0)
    const state = createNativeFieldVimState()
    state.mode = 'normal'
    const selection = vi.spyOn(field, 'setSelectionRange')
    key(field, state, '2')
    key(field, state, 'd')
    expect(state.operator).toBe('delete')
    key(field, state, 'w')
    expect(selection.mock.calls).toContainEqual([0, 8, 'forward'])
    expect(field.selectionStart).toBe(0)
    const second = document.createElement('input')
    second.value = 'one two three four'
    second.focus()
    second.setSelectionRange(0, 0)
    const secondState = createNativeFieldVimState()
    secondState.mode = 'normal'
    const secondSelection = vi.spyOn(second, 'setSelectionRange')
    key(second, secondState, 'd')
    key(second, secondState, '2')
    key(second, secondState, 'w')
    expect(secondSelection).toHaveBeenCalledWith(0, 8, 'forward')
    key(field, state, '9')
    key(field, state, '9')
    key(field, state, '9')
    key(field, state, '9')
    expect(state.count.length).toBeLessThanOrEqual(4)
  })
})
