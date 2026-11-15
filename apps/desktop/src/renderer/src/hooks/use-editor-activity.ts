import { createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/react'

/** Live ownership of a retained editor. A ticket expires on leave, even after return. */
export interface EditorActivity {
  readonly displayed: boolean
  readonly focused: boolean
  capture: () => () => boolean
  subscribe: (listener: () => void) => () => void
  snapshot: () => number
  update: (displayed: boolean, focused: boolean) => void
}

function createEditorActivity(): EditorActivity {
  let displayed = true
  let focused = true
  let generation = 0
  const listeners = new Set<() => void>()
  return {
    get displayed() {
      return displayed
    },
    get focused() {
      return displayed && focused
    },
    capture() {
      const ticket = generation
      return () => displayed && focused && ticket === generation
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: () => generation * 4 + (displayed ? 2 : 0) + (focused ? 1 : 0),
    update(nextDisplayed, nextFocused) {
      if (displayed === nextDisplayed && focused === nextFocused) return
      if ((displayed && !nextDisplayed) || (focused && !nextFocused)) generation++
      displayed = nextDisplayed
      focused = nextFocused
      for (const listener of listeners) listener()
    },
  }
}

const DEFAULT_ACTIVITY = createEditorActivity()
export const EditorActivityContext = createContext(DEFAULT_ACTIVITY)
const activities = new WeakMap<Editor, EditorActivity>()

/** Installed before node views are created; extensions retain this same interface. */
export function bindEditorActivity(editor: Editor, activity: EditorActivity): void {
  activities.set(editor, activity)
}

export function editorActivity(editor: Editor): EditorActivity {
  return activities.get(editor) ?? DEFAULT_ACTIVITY
}

export function useEditorActivity(editor?: Editor | null): EditorActivity {
  const inherited = useContext(EditorActivityContext)
  const activity = editor ? (activities.get(editor) ?? inherited) : inherited
  useSyncExternalStore(activity.subscribe, activity.snapshot, activity.snapshot)
  return activity
}

/** Open controls belong to one focus visit; returning never reopens a portal. */
export function useActivityOpen(
  open: boolean | undefined,
  defaultOpen = false,
  onChange?: (open: boolean) => void,
) {
  const activity = useEditorActivity()
  const [local, setLocal] = useState(defaultOpen)
  const [valid, setValid] = useState(() => activity.capture())
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (open) setValid(() => activity.capture())
  }
  useLayoutEffect(
    () =>
      activity.subscribe(() => {
        if (!activity.focused && (open ?? local)) {
          setLocal(false)
          onChange?.(false)
        }
      }),
    [activity, open, local, onChange],
  )
  return {
    valid,
    epoch: Math.floor(activity.snapshot() / 4),
    open: (open ?? local) && valid(),
    onOpenChange: (next: boolean) => {
      if (next && !activity.displayed) return
      if (next) setValid(() => activity.capture())
      setLocal(next)
      onChange?.(next)
    },
  }
}

export function useDocumentActivity(displayed: boolean, focused: boolean) {
  const [activity] = useState(createEditorActivity)
  useLayoutEffect(() => {
    activity.update(displayed, focused)
  }, [activity, displayed, focused])
  useLayoutEffect(() => () => activity.update(false, false), [activity])
  return activity
}

/** Portaled controls share their opening visit with their focus-scope cleanup. */
export const OverlayActivityContext = createContext<(() => boolean) | null>(null)
export function useOverlayAutoFocus(handler?: (event: Event) => void) {
  const activity = useEditorActivity()
  const valid = useContext(OverlayActivityContext)
  return (event: Event) => {
    if (!activity.focused || (valid !== null && !valid())) event.preventDefault()
    else handler?.(event)
  }
}
