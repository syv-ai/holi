import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

type VimMode = 'normal' | 'insert' | 'visual'
type ModeChange = (mode: VimMode) => void

// Leave normal-mode f unused for the later host-hints feature. Insert mode is
// still handled by the Vim engine as ordinary text input.
Vim.map('f', '<Esc>', 'normal')

/** Private adapter for Vim keys and per-view mode reporting. */
function modeFor(view: EditorView): VimMode {
  const vimState = getCM(view)?.state.vim
  if (vimState?.insertMode) return 'insert'
  if (vimState?.visualMode) return 'visual'
  return 'normal'
}

export function vimCodeEditor(onModeChange: ModeChange): Extension[] {
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
