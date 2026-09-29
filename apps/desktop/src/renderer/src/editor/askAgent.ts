/**
 * Select a passage, say what you want done with it, and the agent gets the note
 * and the exact lines you meant. The line numbers come from CodeMirror's range,
 * not from searching the source for the substring, which is wrong when the
 * passage appears twice.
 *
 * No new transport: the finished string and a target session go to a seam on
 * `EditorDeps`, which `EditorPane` routes through `sendToAgent`.
 */
import { EditorSelection, StateField, type EditorState, type Extension } from '@codemirror/state'
import { showTooltip, type EditorView, type Tooltip, type TooltipView } from '@codemirror/view'
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

/** The prompt for the primary selection, or null when it is empty. */
export function promptForSelection(state: EditorState, notePath: string): string | null {
  const range = state.selection.main
  if (range.empty) return null
  return selectionPrompt(
    notePath,
    state.doc.lineAt(range.from).number,
    state.doc.lineAt(range.to).number,
    state.sliceDoc(range.from, range.to),
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
function askAgentView(view: EditorView, quote: string, seam: AskAgentSeam): TooltipView {
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

  const popover = (): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'cm-ask-agent-popover'

    const field = document.createElement('textarea')
    field.rows = 1
    field.className = 'cm-ask-agent-field'

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
        dom.classList.remove('cm-ask-agent-open')
        dom.replaceChildren(trigger())
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

  const trigger = (): HTMLElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-ask-agent-trigger'
    button.textContent = 'Ask agent'
    button.onmousedown = (e) => {
      e.preventDefault()
      dom.replaceChildren(popover())
      // Added by the press, not at mount: this element is rebuilt on every
      // selection change, so a mount-time animation would replay during a drag.
      dom.classList.add('cm-ask-agent-open')
      // CodeMirror cannot see a DOM swap, so the wider popover would stay placed
      // for the button. An empty transaction makes it measure again.
      view.dispatch({})
    }
    return button
  }

  dom.appendChild(trigger())
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

function tooltipFor(state: EditorState, notePath: string, seam: AskAgentSeam): Tooltip[] {
  // A read-only file is one a reconcile is resolving (docs/features/vaults-sync.md):
  // do not hand it to a second conversation mid-merge. `state.readOnly`, not the
  // `editable` facet, which is about the caret rather than the file.
  if (state.readOnly) return []
  const prompt = promptForSelection(state, notePath)
  if (prompt === null) return []

  const range = state.selection.main
  return [
    {
      pos: range.from,
      end: range.to,
      above: true,
      create: (view) => askAgentView(view, prompt, seam),
    },
  ]
}

/**
 * Shows an "Ask agent" button over a non-empty selection. `notePath` is static
 * because `EditorPane` rebuilds the view per document.
 */
export function askAgentTooltip(notePath: string, seam: AskAgentSeam): Extension {
  const field = StateField.define<readonly Tooltip[]>({
    create: (state) => tooltipFor(state, notePath, seam),
    update(tooltips, tr) {
      // Not on other transactions: rebuilding would replace the button under
      // the pointer.
      if (!tr.docChanged && tr.selection === undefined) return tooltips
      return tooltipFor(tr.state, notePath, seam)
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  })
  return field
}
