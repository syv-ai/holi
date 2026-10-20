/**
 * Space on an empty line asks the agent (docs/features/editor.md), the way
 * Notion's AI opens on Space. Not in ReUI: Holi's own, beside Ask agent in the
 * selection bubble, and on the same surface.
 *
 * On a focused empty line of prose (not in a list item, a fence, a table or
 * the frontmatter), Space opens a field anchored at the line instead of typing
 * a space. Enter sends what was written to a new agent session with the note's
 * path and the line as context (`[From <path>, line N]`), the way a selection
 * ask quotes its lines; Shift+Enter is a newline. Escape closes it and types
 * the space after all, so nothing typed is lost. Off with the
 * `spaceAsksAgent` setting, with no agent, and on read-only files.
 */
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import {
  keymap,
  showTooltip,
  type EditorView,
  type Tooltip,
  type TooltipView,
} from '@codemirror/view'
import { askPrompt, type AskAgentSeam } from './askAgent'
import { frontmatterRegion } from './frontmatter-region'

/** Containers whose empty lines keep their Space: a list item's blank line is
 *  a loose list's gap, and code and tables are not prose. */
const NOT_HERE = new Set([
  'ListItem',
  'FencedCode',
  'CodeBlock',
  'Table',
  'HTMLBlock',
  'CommentBlock',
])

/**
 * Whether Space at the caret would open the ask: one caret, on a line with
 * nothing on it, in the body, outside a list item, a fence or a table, on a
 * file that can be written.
 */
export function spaceAskAllowed(state: EditorState): boolean {
  if (state.readOnly) return false
  if (state.selection.ranges.length !== 1) return false
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  if (line.text.trim() !== '') return false
  if (line.from < (frontmatterRegion(state.doc.toString())?.to ?? 0)) return false
  for (let n = syntaxTree(state).resolveInner(line.from, 1); ; n = n.parent!) {
    if (NOT_HERE.has(n.name)) return false
    if (n.parent === null) break
  }
  // A blank line inside a fence, or between two items of a loose list, can
  // resolve to the document: look at what its neighbours sit in too.
  for (const pos of [line.from - 1, line.to + 1]) {
    if (pos < 0 || pos > state.doc.length) continue
    for (let n = syntaxTree(state).resolveInner(pos, pos < line.from ? -1 : 1); ; n = n.parent!) {
      const around = n.from < line.from && n.to > line.to
      if (around && (NOT_HERE.has(n.name) || /List$/.test(n.name))) return false
      if (n.parent === null) break
    }
  }
  return true
}

/** The context a Space ask carries: where in which note it was asked. */
export function spaceAskContext(path: string, line: number): string {
  return `[From ${path}, line ${line}]`
}

/** The message a Space ask sends: the instruction, then where it was asked. */
export function spaceAskPrompt(path: string, line: number, instruction: string): string {
  return askPrompt(instruction, spaceAskContext(path, line))
}

/** Opens the ask at a line's start, or closes it with null. */
const setSpaceAsk = StateEffect.define<number | null>()

function askView(view: EditorView, path: string, seam: AskAgentSeam, at: number): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-ask-agent cm-ask-agent-open cm-space-ask'
  const field = document.createElement('textarea')
  field.rows = 1
  field.className = 'cm-ask-agent-field'
  field.placeholder = 'Ask the agent anything, ↵ to send'
  field.setAttribute('aria-label', 'Ask the agent, Enter to send, Escape to type a space')
  const notice = document.createElement('div')
  notice.className = 'cm-ask-agent-notice'
  dom.append(field, notice)

  let sending = false
  let gone = false
  const close = (typeSpace: boolean) => {
    const pos = view.state.selection.main.head
    view.dispatch({
      effects: setSpaceAsk.of(null),
      ...(typeSpace
        ? { changes: { from: pos, insert: ' ' }, selection: EditorSelection.cursor(pos + 1) }
        : {}),
    })
    view.focus()
  }
  const send = async () => {
    const instruction = field.value.trim()
    if (instruction === '' || sending) return
    sending = true
    notice.textContent = ''
    const line = view.state.doc.lineAt(Math.min(at, view.state.doc.length)).number
    const res = await seam.onAsk(spaceAskPrompt(path, line, instruction), 'new')
    sending = false
    if (gone) return
    if (!res.ok) {
      notice.textContent = res.message ?? 'That could not be sent.'
      view.dispatch({})
      field.focus()
      return
    }
    close(false)
  }
  const grow = () => {
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
    view.dispatch({})
  }
  field.oninput = grow
  field.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    }
  }
  queueMicrotask(() => field.focus())
  // Over the empty line itself, centred on it, the field's text where the
  // line's would start: the ask takes the line's place rather than covering
  // the one below. Read at each placing, since the field grows.
  const line = view.lineBlockAt(Math.min(at, view.state.doc.length))
  return {
    dom,
    get offset() {
      return { x: -10, y: -Math.round((line.height + dom.offsetHeight) / 2) }
    },
    destroy: () => {
      gone = true
    },
  }
}

/**
 * The Space key and the field it opens. `enabled` is read at the keypress, so
 * turning the setting off needs no rebuild.
 */
export function spaceAsk(
  path: string,
  seam: AskAgentSeam | undefined,
  enabled: () => boolean,
): Extension {
  if (seam === undefined) return []
  const field = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setSpaceAsk)) return e.value
      if (value === null) return null
      // Typing elsewhere or moving away lets it go.
      if (tr.docChanged || tr.selection !== undefined) return null
      return value
    },
    provide: (f) =>
      showTooltip.compute([f], (state): Tooltip | null => {
        const at = state.field(f)
        if (at === null) return null
        return { pos: at, above: false, create: (view) => askView(view, path, seam, at) }
      }),
  })
  return [
    field,
    Prec.high(
      keymap.of([
        {
          key: 'Space',
          run: (view) => {
            if (!enabled() || !spaceAskAllowed(view.state)) return false
            const line = view.state.doc.lineAt(view.state.selection.main.head)
            view.dispatch({ effects: setSpaceAsk.of(line.from) })
            return true
          },
        },
      ]),
    ),
  ]
}
