import { useAtomValue, useStore } from 'jotai'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { vimCodeEditingAtom } from '@/state/preferences'
import { hostHintKeyAtom } from '@/state/shortcuts'
import {
  createNativeFieldVimState,
  handleNativeFieldKey,
  type NativeFieldMode,
} from '@/lib/native-field-vim'
import { supportsNativeFieldSelection, type NativeField } from '@/lib/native-field-edit'

/** Controlled native field binding. State is local to the focused field and never changes its value. */
export function useVimField(identity?: string | number, controlledValue?: string) {
  const enabled = useAtomValue(vimCodeEditingAtom)
  const store = useStore()
  const state = useRef(createNativeFieldVimState())
  const [mode, setMode] = useState<NativeFieldMode>('insert')
  const [focused, setFocused] = useState(false)
  const fieldRef = useRef<NativeField | null>(null)
  const composing = useRef(false)
  const acceptedNativeValue = useRef<string | null>(null)
  const domValue = useRef<string | null>(null)
  const previous = useRef<{ identity?: string | number; value: string | null }>({
    identity,
    value: controlledValue ?? null,
  })
  const reset = useCallback(() => {
    state.current = createNativeFieldVimState()
    const field = fieldRef.current
    if (field) field.dataset.vimGeneration = String(Number(field.dataset.vimGeneration ?? 0) + 1)
    setMode('insert')
  }, [])
  const onKeyDown = useCallback(
    (event: KeyboardEvent<NativeField>) => {
      if (event.defaultPrevented) return
      if (
        !enabled ||
        event.currentTarget.disabled ||
        event.currentTarget.readOnly ||
        !supportsNativeFieldSelection(event.currentTarget)
      ) {
        if (event.currentTarget.disabled || event.currentTarget.readOnly) {
          setFocused(false)
          reset()
        }
        return
      }
      if (composing.current) return
      const handled = handleNativeFieldKey(event, state.current)
      if (handled) setMode(state.current.mode)
    },
    [enabled, reset],
  )
  const onBlur = useCallback(
    (_event: React.FocusEvent<NativeField>) => {
      setFocused(false)
      acceptedNativeValue.current = null
      reset()
    },
    [reset],
  )
  const onFocus = useCallback(
    (event: React.FocusEvent<NativeField>) => {
      const target = event.currentTarget
      if (target.disabled || target.readOnly || !supportsNativeFieldSelection(target)) {
        setFocused(false)
        reset()
        return
      }
      if (
        previous.current.identity !== identity ||
        (fieldRef.current && fieldRef.current !== target)
      )
        reset()
      previous.current = { identity, value: target.value }
      domValue.current = target.value
      fieldRef.current = target
      setFocused(true)
    },
    [identity, reset],
  )
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field || field !== document.activeElement) return
    if (domValue.current !== field.value) {
      if (acceptedNativeValue.current !== field.value) reset()
      domValue.current = field.value
      // Explicit value reconciliation runs after layout and still needs this native edit marker.
      if (controlledValue === undefined) acceptedNativeValue.current = null
    }
  })
  useEffect(() => {
    if (!enabled) reset()
  }, [enabled, reset])
  useEffect(() => {
    if (previous.current.identity !== identity) reset()
    if (controlledValue !== undefined && previous.current.value !== controlledValue) {
      const field = fieldRef.current
      const isNativeEdit =
        field !== null &&
        field === document.activeElement &&
        acceptedNativeValue.current === field.value
      if (!isNativeEdit) reset()
      acceptedNativeValue.current = null
    }
    previous.current = { identity, value: controlledValue ?? previous.current.value }
  }, [controlledValue, identity, reset])
  useEffect(() => {
    if (!enabled) return
    const onWindowKeyDown = (nativeEvent: globalThis.KeyboardEvent) => {
      const field = fieldRef.current
      if (!field || nativeEvent.target !== field || document.activeElement !== field) return
      if (composing.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        // Keep the IME's default action, not dialog dismissal or a field's submit handler.
        if (nativeEvent.key === 'Escape' || nativeEvent.key === 'Enter')
          nativeEvent.stopImmediatePropagation()
        return
      }
      if (nativeEvent.defaultPrevented) return
      const handleHostHint = store.get(hostHintKeyAtom)
      if (handleHostHint?.(nativeEvent)) {
        nativeEvent.preventDefault()
        nativeEvent.stopImmediatePropagation()
        return
      }
      const synthetic = {
        currentTarget: field,
        nativeEvent,
        key: nativeEvent.key,
        metaKey: nativeEvent.metaKey,
        ctrlKey: nativeEvent.ctrlKey,
        altKey: nativeEvent.altKey,
        preventDefault: () => nativeEvent.preventDefault(),
        stopPropagation: () => nativeEvent.stopImmediatePropagation(),
      } as unknown as KeyboardEvent<NativeField>
      onKeyDown(synthetic)
    }
    const onCompositionStart = (event: CompositionEvent) => {
      if (event.target === fieldRef.current) composing.current = true
    }
    const onCompositionEnd = (event: CompositionEvent) => {
      if (event.target === fieldRef.current) composing.current = false
    }
    const onInput = (event: Event) => {
      const field = fieldRef.current
      if (event.target === field && field && document.activeElement === field)
        acceptedNativeValue.current = field.value
    }
    window.addEventListener('keydown', onWindowKeyDown, true)
    window.addEventListener('compositionstart', onCompositionStart, true)
    window.addEventListener('compositionend', onCompositionEnd, true)
    window.addEventListener('input', onInput, true)
    return () => {
      window.removeEventListener('keydown', onWindowKeyDown, true)
      window.removeEventListener('compositionstart', onCompositionStart, true)
      window.removeEventListener('compositionend', onCompositionEnd, true)
      window.removeEventListener('input', onInput, true)
    }
  }, [enabled, onKeyDown, store])
  return {
    vimFieldProps: enabled ? { onKeyDown, onBlur, onFocus } : {},
    vimFieldMode: enabled && focused ? mode : null,
  }
}
