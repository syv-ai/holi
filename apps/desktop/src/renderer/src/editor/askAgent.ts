/**
 * The selection's tooltip: Ask agent, and Comment, which opens a thread on the
 * passage in the comments panel (docs/features/note-comments.md).
 *
 * Select a passage, say what you want done with it, and the agent gets the note
 * and the exact lines you meant. The line numbers come from CodeMirror's range,
 * not from searching the source for the substring, which is wrong when the
 * passage appears twice.
 *
 * No new transport: the finished string and a target session go to a seam on
 * `EditorDeps`, which the editors route through the agent service
 * (`useAskAgentSeam`). With no agent there is no seam and no button.
 */
import {
  EditorSelection,
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import { searchPanelOpen } from '@codemirror/search'
import { showTooltip, type EditorView, type Tooltip, type TooltipView } from '@codemirror/view'
import type { LineRange } from '@holi/shared'
import { motionDurationMs, prefersReducedMotion } from '@/lib/motion'

/**
 * The seeded turn for a selection. `from`/`to` are 1-based inclusive line
 * numbers and `path` is the note's vault path.
 */
export function selectionPrompt(path: string, from: number, to: number, text: string): string {
  const where = from === to ? `line ${from}` : `lines ${from}-${to}`
  // Every line, including the blank ones: a quote with holes in it is a
  // different passage from the one that was selected.
  const quoted = text.split('\n').map((line) => `> ${line}`.trimEnd())
  return [`[From ${path}, ${where}]`, ...quoted].join('\n')
}

/**
 * The finished message: the instruction first, since that is what the agent
 * acts on, then the quote as context. An empty instruction sends the quote alone.
 */
export function askPrompt(instruction: string, quote: string): string {
  const said = instruction.trim()
  return said === '' ? quote : `${said}\n\n${quote}`
}

/** The primary selection's lines, 1-based and inclusive, or null when it is
 *  empty (a caret). A selection that ends at the very start of a later line
 *  (a triple-click, Mod-L, shift+down) holds nothing of that line, so it does
 *  not count. Also what the agent's per-turn focus line names
 *  (`state/ui-report.ts`). */
export function selectedLines(state: EditorState): LineRange | null {
  const range = state.selection.main
  if (range.empty) return null
  const startLine = state.doc.lineAt(range.from).number
  const end = state.doc.lineAt(range.to)
  const endLine = range.to === end.from && end.number > startLine ? end.number - 1 : end.number
  return { startLine, endLine }
}

/** The prompt for the primary selection, or null when it is empty. */
export function promptForSelection(state: EditorState, notePath: string): string | null {
  const lines = selectedLines(state)
  if (lines === null) return null
  const range = state.selection.main
  return selectionPrompt(
    notePath,
    lines.startLine,
    lines.endLine,
    state.sliceDoc(range.from, Math.min(range.to, state.doc.line(lines.endLine).to)),
  )
}

export interface AskTarget {
  id: string
  name: string
}

/** What the popover offers, read when it opens: sessions come and go. */
export interface AskTargets {
  /** Live sessions in tab order. The caller leaves out one blocked on its own
   *  question, where the text would sit unread. */
  sessions: AskTarget[]
  /** Selected when the popover opens: the session you are on, or `'new'` when
   *  that session cannot take an ask. */
  initial: string | 'new'
}

/** Sent, or refused with a reason the popover shows while keeping the text. */
export interface AskResult {
  ok: boolean
  message?: string
}

/** The editor's whole view of the agent: a list of names, and somewhere to send. */
export interface AskAgentSeam {
  targets: () => AskTargets
  onAsk: (prompt: string, target: string | 'new') => Promise<AskResult>
}

/** Open a comment thread on the selection: the panel takes it from here. */
export interface CommentSeam {
  comment: (from: number, to: number) => void
}

/** The note's comment seam, while it takes threads. A facet rather than an
 *  argument, so the note's claim can give or take it (`reconfigureClaimLayer`)
 *  without rebuilding the tooltip's field, which would close an open ask. */
export const commentSeamFacet = Facet.define<CommentSeam, CommentSeam | undefined>({
  combine: (values) => values[0],
})

/** A picker label, not a name: main derives the real one from the ask's first
 *  line at spawn. */
const NEW_SESSION = 'New session'

/**
 * How long the popover takes to leave. Read off `--motion-leave` so the timer
 * matches the stylesheet's animation; zero under reduced motion. Read at use,
 * since the OS setting can change while the app runs.
 */
const exitMs = (): number => (prefersReducedMotion() ? 0 : motionDurationMs('--motion-leave', 190))

/**
 * The tooltip's two states: a button, and the popover it opens into (a row of
 * target sessions, and a textarea with no send button).
 *
 * Both states live in one element that swaps its children, not a `StateField`:
 * nothing outside the tooltip acts on them. A selection change rebuilds the
 * tooltip and so closes the popover.
 *
 * The tooltip is outside the editor's content, so a plain click would move
 * focus and collapse the highlight: `preventDefault` on `mousedown` stops that.
 * The textarea may take focus because the selection lives in editor state.
 *
 * Sending collapses the selection on purpose: that is how the tooltip closes,
 * one mechanism rather than a second dismiss path. The collapse follows the fade.
 */
function askAgentView(
  view: EditorView,
  quote: string,
  seam: AskAgentSeam | undefined,
  comment: CommentSeam | undefined,
  instruction?: string,
): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-ask-agent'

  let leaving: ReturnType<typeof setTimeout> | null = null
  /** The tooltip has been destroyed; a send in flight has nowhere to land. */
  let gone = false

  const leave = () => {
    dom.classList.add('cm-ask-agent-leaving')
    leaving = setTimeout(() => {
      leaving = null
      view.dispatch({ selection: EditorSelection.cursor(view.state.selection.main.to) })
      view.focus()
    }, exitMs())
  }

  const popover = (seam: AskAgentSeam, text = ''): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'cm-ask-agent-popover'

    const field = document.createElement('textarea')
    field.rows = 1
    field.className = 'cm-ask-agent-field'
    field.value = text

    // Read as the popover opens. A default that has gone falls back to a new session.
    const { sessions, initial } = seam.targets()
    let target: string | 'new' =
      initial !== 'new' && sessions.some((s) => s.id === initial) ? initial : 'new'

    const row = document.createElement('div')
    row.className = 'cm-ask-agent-targets'
    row.setAttribute('role', 'radiogroup')
    row.setAttribute('aria-label', 'Which session to ask')
    const choices = [
      ...sessions.map((s) => ({ value: s.id, label: s.name })),
      {
        value: 'new' as const,
        label: NEW_SESSION,
      },
    ]
    const buttons = choices.map((choice) => {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'cm-ask-agent-target'
      option.textContent = choice.label
      option.setAttribute('role', 'radio')
      // As with the trigger; it also keeps the field focused while picking.
      option.onmousedown = (e) => {
        e.preventDefault()
        target = choice.value
        paint()
      }
      return option
    })
    const paint = () => {
      buttons.forEach((option, i) =>
        option.setAttribute('aria-checked', String(choices[i]!.value === target)),
      )
    }
    paint()
    row.append(...buttons)

    /** Why the last send did not go. Empty until something refuses. */
    const notice = document.createElement('div')
    notice.className = 'cm-ask-agent-notice'

    /** A send is an async round trip, so guard against a second one. */
    let sending = false

    const send = async (instruction: string) => {
      if (leaving !== null || sending) return // already on the way out, or already going
      sending = true
      notice.textContent = ''
      const res = await seam.onAsk(askPrompt(instruction, quote), target)
      sending = false
      /**
       * The popover may be gone by now (Escape, a new selection during spawn).
       * `leave()` would then arm a timer `destroy` can no longer clear, which
       * collapses whatever the user selected since and steals focus.
       */
      if (gone || !field.isConnected) return
      if (!res.ok) {
        // Keep the text; the user can pick another target and resend.
        notice.textContent = res.message ?? 'That could not be sent.'
        view.dispatch({}) // the bubble is taller; let CodeMirror place it again
        field.focus()
        return
      }
      leave()
    }

    /**
     * Grow with the content. `height: auto` first, or `scrollHeight` never
     * shrinks. A real height change is reported to CodeMirror, which positioned
     * the bubble, or it grows down over the passage.
     */
    const grow = () => {
      const before = dom.getBoundingClientRect().height
      // Measured unscrolled: a bar of its own narrows the box, rewraps the text
      // and changes the very height being measured.
      field.style.overflowY = 'hidden'
      field.style.height = 'auto'
      const content = field.scrollHeight
      const max = parseFloat(getComputedStyle(field).maxHeight)
      /**
       * Overflow decided here, not by `overflow-y: auto`. `index.css` styles
       * `::-webkit-scrollbar`, so Chromium drops overlay scrollbars; and
       * `scrollHeight` is rounded while a line box is not (22.4px), so `auto`
       * would show a permanent track over a fraction of a pixel.
       */
      const capped = Number.isFinite(max) && content > max
      field.style.height = `${capped ? max : content}px`
      field.style.overflowY = capped ? 'auto' : 'hidden'
      const after = dom.getBoundingClientRect().height
      if (after === before) return

      /**
       * Hold the bottom edge still. CodeMirror corrects the inline `top` only on
       * its next measure, a frame away, so the bubble would blink down and back
       * on every newline. Moving `top` by the growth now lands on the value it
       * is about to compute. Only when placed above; below, growing down is right.
       */
      if (dom.classList.contains('cm-tooltip-above')) {
        const top = parseFloat(dom.style.top)
        if (!Number.isNaN(top)) dom.style.top = `${top - (after - before)}px`
      }
      view.dispatch({})
    }
    field.oninput = grow
    field.placeholder = 'Ask the agent, ⌘↵ to send'
    field.setAttribute('aria-label', 'Instructions for the agent, Command Enter to send')
    field.onkeydown = (e) => {
      // ⌘/Ctrl + Enter, so a plain Enter is still a newline.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void send(field.value)
        return
      }
      // Back to the button; the selection stays.
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        // Opened by a command, perhaps with nothing selected: the selection
        // decides again, which is the button over one and nothing otherwise.
        if (instruction !== undefined) {
          view.dispatch({ selection: view.state.selection })
          view.focus()
          return
        }
        dom.classList.remove('cm-ask-agent-open')
        dom.replaceChildren(...triggers())
        view.dispatch({})
      }
    }
    // After it is in the tree: focus lands on a node with no layout yet, and
    // `scrollHeight` of a detached element is 0.
    queueMicrotask(() => {
      field.focus()
      grow()
    })
    wrap.append(row, field, notice)
    return wrap
  }

  const button = (label: string, press: () => void): HTMLElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cm-ask-agent-trigger'
    b.textContent = label
    b.onmousedown = (e) => {
      e.preventDefault()
      press()
    }
    return b
  }

  const triggers = (): HTMLElement[] => [
    ...(seam === undefined
      ? []
      : [
          button('Ask agent', () => {
            dom.replaceChildren(popover(seam))
            // Added by the press, not at mount: this element is rebuilt on every
            // selection change, so a mount-time animation would replay during a drag.
            dom.classList.add('cm-ask-agent-open')
            // CodeMirror cannot see a DOM swap, so the wider popover would stay placed
            // for the button. An empty transaction makes it measure again.
            view.dispatch({})
          }),
        ]),
    ...(comment === undefined
      ? []
      : [
          button('Comment', () => {
            const { from, to } = view.state.selection.main
            ;(view.state.facet(commentSeamFacet) ?? comment).comment(from, to)
          }),
        ]),
  ]

  // Opened by a command: the popover straight away, with its instruction in.
  if (instruction !== undefined && seam !== undefined) {
    dom.appendChild(popover(seam, instruction))
    dom.classList.add('cm-ask-agent-open')
  } else dom.append(...triggers())
  return {
    dom,
    // The tooltip can go before the fade finishes; the pending dispatch must not
    // land on a view that has moved on.
    destroy: () => {
      gone = true
      if (leaving !== null) clearTimeout(leaving)
      leaving = null
    },
  }
}

function tooltipFor(
  state: EditorState,
  notePath: string,
  seam: AskAgentSeam | undefined,
): Tooltip[] {
  const comment = state.facet(commentSeamFacet)
  if (seam === undefined && comment === undefined) return []
  // A read-only file is one a reconcile is resolving (docs/features/vaults-sync.md):
  // do not hand it to a second conversation mid-merge. `state.readOnly`, not the
  // `editable` facet, which is about the caret rather than the file.
  if (state.readOnly) return []
  // Stepping through find's matches selects each one; that is not a selection
  // to ask about.
  if (searchPanelOpen(state)) return []
  const prompt = promptForSelection(state, notePath)
  if (prompt === null) return []

  const range = state.selection.main
  return [
    {
      pos: range.from,
      end: range.to,
      above: true,
      create: (view) => askAgentView(view, prompt, seam, comment),
    },
  ]
}

/**
 * Open the popover with `instruction` written in, over the selection, or at the
 * caret when nothing is selected: what a slash command's `{ agent }` does
 * (docs/features/editor.md). The person still picks the session and sends.
 */
export const openAskAgent = StateEffect.define<string>()

/** Whether this editor has the ask at all: it has none without an agent. */
export const hasAskAgent = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

/** The opened-by-a-command tooltip: the selection quoted, or the caret's line
 *  named when there is none. */
function openedTooltip(
  state: EditorState,
  notePath: string,
  seam: AskAgentSeam,
  instruction: string,
): Tooltip[] {
  if (state.readOnly) return []
  const range = state.selection.main
  const quote =
    promptForSelection(state, notePath) ??
    `[From ${notePath}, line ${state.doc.lineAt(range.head).number}]`
  return [
    {
      pos: range.from,
      end: range.to,
      above: true,
      create: (view) => askAgentView(view, quote, seam, undefined, instruction),
    },
  ]
}

/**
 * Shows "Ask agent" and "Comment" over a non-empty selection, each while its
 * seam is there (the comment seam is `commentSeamFacet`). `notePath` is static
 * because `EditorPane` rebuilds the view per document.
 */
export function askAgentTooltip(notePath: string, seam: AskAgentSeam | undefined): Extension {
  const field = StateField.define<readonly Tooltip[]>({
    create: (state) => tooltipFor(state, notePath, seam),
    update(tooltips, tr) {
      if (seam !== undefined) {
        for (const effect of tr.effects) {
          if (effect.is(openAskAgent)) return openedTooltip(tr.state, notePath, seam, effect.value)
        }
      }
      // Not on other transactions: rebuilding would replace the button under
      // the pointer. A note that starts or stops taking threads changes the
      // buttons, so that rebuilds too, and so does find opening or closing.
      const commentable = (state: EditorState) => state.facet(commentSeamFacet) !== undefined
      const flipped =
        commentable(tr.startState) !== commentable(tr.state) ||
        searchPanelOpen(tr.startState) !== searchPanelOpen(tr.state)
      if (!tr.docChanged && tr.selection === undefined && !flipped) return tooltips
      return tooltipFor(tr.state, notePath, seam)
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  })
  return seam === undefined ? field : [field, hasAskAgent.of(true)]
}
