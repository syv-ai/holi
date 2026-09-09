/**
 * Select a passage, say what you want done with it, and the agent opens already
 * knowing which note and which lines you meant (#5).
 *
 * **The line numbers are exact, and that is the point.** The affordance is
 * adopted from ailex's `handleChatAboutSelection`, which recovers them by
 * searching the markdown source for the selected substring — approximate by
 * construction, and wrong outright when the passage appears twice. CodeMirror
 * already holds the range, so the prompt quotes a location rather than guessing
 * at one.
 *
 * **No new transport.** The button hands a finished string to a seam on
 * `EditorDeps`, and `EditorPane` puts it in `agentSeedPromptAtom` — the wire the
 * reconcile handoff already uses. Nothing here knows there is an agent.
 */
import { EditorSelection, StateField, type EditorState, type Extension } from '@codemirror/state'
import { showTooltip, type EditorView, type Tooltip, type TooltipView } from '@codemirror/view'

/**
 * The seeded turn for a selection. `from`/`to` are 1-based inclusive line
 * numbers and `path` is the note's vault path — the same path grammar
 * wiki-links use, so the agent can open what it is being asked about.
 */
export function selectionPrompt(path: string, from: number, to: number, text: string): string {
  const where = from === to ? `line ${from}` : `lines ${from}-${to}`
  // Every line, including the blank ones: a quote with holes in it is a
  // different passage from the one that was selected.
  const quoted = text.split('\n').map((line) => `> ${line}`.trimEnd())
  return [`[From ${path}, ${where}]`, ...quoted].join('\n')
}

/**
 * The finished message: what you asked for, then the passage you asked about.
 *
 * The instruction goes FIRST because that is the sentence the agent is meant to
 * act on, and a quote reads as context for what precedes it. An empty
 * instruction is allowed and sends the quote alone — that is what the button did
 * before it grew a field, and "look at this" is a real thing to want to say.
 */
export function askPrompt(instruction: string, quote: string): string {
  const said = instruction.trim()
  return said === '' ? quote : `${said}\n\n${quote}`
}

/** The prompt for whatever the state's primary selection currently is, or null
 *  when there is nothing selected. Pure, so the tooltip below is the only part
 *  that needs a DOM. */
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

/**
 * How long the popover takes to leave. Set as a custom property on the element
 * so the stylesheet animates for exactly this long: the number lives once, here,
 * and the CSS reads it.
 */
const EXIT_MS = 220

/** Nothing to fade for someone who asked not to be moved, so nothing to wait for
 *  either. Read at use rather than cached: the OS setting can change while the
 *  app runs. */
const exitMs = (): number =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true ? 0 : EXIT_MS

/**
 * The tooltip's two states: a button, and the popover it opens into.
 *
 * **The popover is a textarea and nothing else.** No send button, no chrome: the
 * placeholder says how to send, which is the only instruction it needs, and a
 * second control beside a field you are already typing in is a thing to look at
 * rather than a thing to use.
 *
 * Both states live in one element that swaps its own children, rather than in a
 * `StateField`, because the state is genuinely local — nothing outside this
 * tooltip can act on whether the field is open. A selection change rebuilds the
 * tooltip and so closes the popover, which is the right answer anyway: you are
 * now asking about a different passage.
 *
 * **Nothing here may collapse the selection by accident.** The tooltip is outside
 * the editor's content, so a plain click on the button moves focus and takes the
 * highlight with it; `preventDefault` on `mousedown` is what stops that. The
 * textarea is the exception and must take focus, which is safe because the
 * selection lives in the editor's state and not in the DOM.
 *
 * **Sending collapses it on purpose**, which is the whole of how this closes.
 * The tooltip exists because the selection is not empty, so putting the caret at
 * the end of the passage removes it — one mechanism rather than a second
 * "dismiss" path that would have to agree with the first. The message goes out
 * before the animation, so nothing waits on it; the collapse follows the fade so
 * there is something to fade.
 */
function askAgentView(view: EditorView, quote: string, onAsk: (prompt: string) => void): TooltipView {
  const dom = document.createElement('div')
  dom.className = 'cm-ask-agent'
  dom.style.setProperty('--ask-exit', `${EXIT_MS}ms`)

  let leaving: ReturnType<typeof setTimeout> | null = null

  const send = (instruction: string) => {
    if (leaving !== null) return // already on the way out
    onAsk(askPrompt(instruction, quote))
    dom.classList.add('cm-ask-agent-leaving')
    leaving = setTimeout(() => {
      leaving = null
      // The passage stays selected until now, and letting go of it is what takes
      // this tooltip off the screen.
      view.dispatch({ selection: EditorSelection.cursor(view.state.selection.main.to) })
      view.focus()
    }, exitMs())
  }

  const popover = (): HTMLElement => {
    const field = document.createElement('textarea')
    field.rows = 1
    field.className = 'cm-ask-agent-field'

    /**
     * Grow with what is typed rather than scroll inside a fixed box.
     *
     * `height: auto` first, because `scrollHeight` of an element already sized to
     * its content reports that size and never shrinks again — a message you cut
     * back down would keep the height of its longest draft.
     *
     * A change in height changes the size of a bubble CodeMirror has positioned,
     * and it is anchored ABOVE the passage, so it has to be told or it grows down
     * over the text it is about. Only on a real change, so this is a few
     * transactions per message rather than one per keystroke.
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
       * The overflow is decided here rather than left to `overflow-y: auto`.
       *
       * `index.css` paints `::-webkit-scrollbar` for the whole app, which makes
       * Chromium give up OVERLAY scrollbars — so a scrollable box shows a
       * permanent track rather than one that fades. `scrollHeight` is a rounded
       * integer and a line box is not (14px at 1.6 is 22.4), so a height taken
       * straight from it can be a fraction of a pixel short, and `auto` then
       * shows that track forever over one pixel nobody can see. Saying when it
       * may scroll costs a line and cannot round wrong.
       */
      const capped = Number.isFinite(max) && content > max
      field.style.height = `${capped ? max : content}px`
      field.style.overflowY = capped ? 'auto' : 'hidden'
      const after = dom.getBoundingClientRect().height
      if (after === before) return

      /**
       * Hold the bottom edge still while it grows.
       *
       * CodeMirror places this tooltip with an inline `top` and only corrects it
       * on its NEXT measure, which is a frame away. So a taller bubble grows
       * downward over the passage it is about and then jumps back up — a blink
       * on every newline. Moving `top` by exactly the growth, here and now,
       * lands on the value CodeMirror is about to compute, so its measure
       * confirms the position rather than correcting it.
       *
       * Only when the bubble is ABOVE the passage. CodeMirror flips it below
       * when there is no room, marks which it chose, and growing downward is
       * right in that case.
       */
      if (dom.classList.contains('cm-tooltip-above')) {
        const top = parseFloat(dom.style.top)
        if (!Number.isNaN(top)) dom.style.top = `${top - (after - before)}px`
      }
      view.dispatch({})
    }
    field.oninput = grow
    // The only instruction the popover carries, and the reason it needs no
    // button. ⌘ is the app's own convention for a shortcut in copy (⌘J, ⌘T).
    field.placeholder = 'Ask the agent, ⌘↵ to send'
    field.setAttribute('aria-label', 'Instructions for the agent, Command Enter to send')
    field.onkeydown = (e) => {
      // ⌘/Ctrl + Enter, so a plain Enter is still a newline. A message about a
      // passage is often more than one line, and a bare Enter would send it half
      // written.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        send(field.value)
        return
      }
      // Back to the button rather than out of the editor: Escape here means "not
      // this", not "stop selecting".
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
    return field
  }

  const trigger = (): HTMLElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Ask agent'
    button.onmousedown = (e) => {
      e.preventDefault()
      dom.replaceChildren(popover())
      // The bubble animates in, not the field inside it. The bubble IS this
      // element, and it is rebuilt on every selection change — so a mount-time
      // animation would replay on every frame of a drag-select. A class added by
      // the press instead runs it exactly when the popover opens.
      dom.classList.add('cm-ask-agent-open')
      // The popover is much wider than the button it replaced, and CodeMirror
      // positions this tooltip itself. A bare DOM swap is invisible to it, so
      // the bubble would stay placed for the button and could hang off the edge
      // of the editor. An empty transaction is the cheapest thing that makes it
      // measure again, and it changes neither the document nor the selection, so
      // nothing else in the stack recomputes.
      view.dispatch({})
    }
    return button
  }

  dom.appendChild(trigger())
  return {
    dom,
    // The tooltip can go before the fade finishes — another selection, the note
    // closing — and the pending dispatch would then land on a view that has
    // moved on.
    destroy: () => {
      if (leaving !== null) clearTimeout(leaving)
      leaving = null
    },
  }
}

function tooltipFor(state: EditorState, notePath: string, onAsk: (prompt: string) => void): Tooltip[] {
  // A locked file is one a reconcile is resolving (`vaults-sync.md` FR-19).
  // Handing it to a second conversation mid-merge is the one case this must not
  // offer. `state.readOnly` and not the `editable` facet: only the former is a
  // state field, and `editable` is about the caret rather than about the file.
  if (state.readOnly) return []
  const prompt = promptForSelection(state, notePath)
  if (prompt === null) return []

  const range = state.selection.main
  return [
    {
      pos: range.from,
      end: range.to,
      above: true,
      create: (view) => askAgentView(view, prompt, onAsk),
    },
  ]
}

/**
 * Shows an "Ask agent" button over a non-empty selection.
 *
 * `notePath` is static per editor instance, which is true because `EditorPane`
 * rebuilds the view per document — the same reason `notePathFacet` can be static
 * in live preview.
 */
export function askAgentTooltip(notePath: string, onAsk: (prompt: string) => void): Extension {
  const field = StateField.define<readonly Tooltip[]>({
    create: (state) => tooltipFor(state, notePath, onAsk),
    update(tooltips, tr) {
      // Only a selection or a document change can alter it. A viewport scroll
      // cannot, and recomputing on one would rebuild the button under the
      // pointer while you were reaching for it.
      if (!tr.docChanged && tr.selection === undefined) return tooltips
      return tooltipFor(tr.state, notePath, onAsk)
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  })
  return field
}
