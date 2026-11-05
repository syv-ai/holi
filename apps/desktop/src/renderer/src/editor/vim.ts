import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'

type VimMode = 'normal' | 'insert' | 'visual'
type ModeChange = (mode: VimMode) => void

// Leave normal-mode f unused for the later host-hints feature. Insert mode is
// still handled by the Vim engine as ordinary text input.
Vim.unmap('f', 'normal')

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

        constructor(private readonly view: EditorView) {
          this.report()
        }

        update() {
          this.report()
        }

        destroy() {
          this.live = false
        }

        private report() {
          const mode = modeFor(this.view)
          if (mode === this.reported) return
          this.reported = mode
          queueMicrotask(() => {
            if (this.live) onModeChange(mode)
          })
        }
      },
    ),
  ]
}
