import { useLayoutEffect, useRef, useState, type KeyboardEventHandler } from 'react'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { Compartment, Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

type VimMode = 'normal' | 'insert' | 'visual'
type ModeChange = (mode: VimMode | '') => void

// Leave normal-mode f unused for the later host-hints feature. Insert mode is
// still handled by the Vim engine as ordinary text input.
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
    if (!event.defaultPrevented) callbacks.current.onKeyDown(event)
  }

  return {
    extension: editor.extension,
    onKeyDownCapture: enabled ? routeKeyDown : undefined,
    onKeyDown: enabled ? undefined : routeKeyDown,
  }
}
