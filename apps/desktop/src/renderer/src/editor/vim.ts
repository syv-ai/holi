import { useLayoutEffect, useRef, useState, type KeyboardEventHandler } from 'react'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { Compartment, Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { requestHostHints } from '@/lib/host-hints'

type VimMode = 'normal' | 'insert' | 'visual'
type ModeChange = (mode: VimMode | '') => void

// Host hints own normal f; insert mode remains ordinary text input. The
// capture adapter below routes it before the Vim engine's character-find.
Vim.map('f', '<Esc>', 'normal')

function modeFor(view: EditorView): VimMode {
  const vimState = getCM(view)?.state.vim
  if (vimState?.insertMode) return 'insert'
  if (vimState?.visualMode) return 'visual'
  return 'normal'
}

function vimExtensions(onModeChange: ModeChange): Extension[] {
  return [
    Prec.highest(vim()),
    ViewPlugin.fromClass(
      class {
        private live = true
        private reported: VimMode | undefined
        private pendingReport = 0
        private readonly cm: ReturnType<typeof getCM>
        private readonly handleModeChange = (event: { mode: string }) => {
          this.report(
            event.mode === 'insert' ? 'insert' : event.mode === 'visual' ? 'visual' : 'normal',
          )
        }

        constructor(private readonly view: EditorView) {
          this.cm = getCM(view)
          this.report(modeFor(view))
          this.cm?.on('vim-mode-change', this.handleModeChange)
        }

        update() {
          this.report(modeFor(this.view))
        }

        destroy() {
          this.live = false
          this.pendingReport++
          this.cm?.off('vim-mode-change', this.handleModeChange)
        }

        private report(mode: VimMode) {
          if (mode === this.reported) return
          this.reported = mode
          const pendingReport = ++this.pendingReport
          queueMicrotask(() => {
            if (this.live && pendingReport === this.pendingReport) onModeChange(mode)
          })
        }
      },
    ),
  ]
}

/** Owns Vim's compartment, mode lifecycle and keyboard routing for one editor. */
export function useVimEditor(
  view: EditorView | null,
  enabled: boolean,
  active: boolean,
  onModeChange: ModeChange,
  onKeyDown: KeyboardEventHandler<HTMLDivElement>,
) {
  const callbacks = useRef({ onModeChange, onKeyDown })
  callbacks.current = { onModeChange, onKeyDown }
  const [editor] = useState(() => {
    const compartment = new Compartment()
    return { compartment, extension: compartment.of([]) }
  })

  useLayoutEffect(() => {
    if (view === null) return
    view.dispatch({
      effects: editor.compartment.reconfigure(
        enabled ? vimExtensions((mode) => callbacks.current.onModeChange(mode)) : [],
      ),
    })
    callbacks.current.onModeChange(enabled ? modeFor(view) : '')
  }, [view, enabled, editor])

  const routeKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.defaultPrevented) return
    if (
      enabled &&
      view !== null &&
      event.target instanceof Node &&
      view.contentDOM.contains(event.target) &&
      event.key === 'f' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.repeat &&
      !event.nativeEvent.isComposing &&
      modeFor(view) === 'normal'
    ) {
      event.preventDefault()
      event.stopPropagation()
      requestHostHints(view.dom)
      return
    }
    callbacks.current.onKeyDown(event)
  }

  return {
    extension: editor.extension,
    onKeyDownCapture: active && enabled ? routeKeyDown : undefined,
    onKeyDown: active && !enabled ? routeKeyDown : undefined,
  }
}
