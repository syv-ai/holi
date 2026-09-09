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
import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { showTooltip, type Tooltip } from '@codemirror/view'

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
 * The tooltip's two states: a button, and the form it opens into.
 *
 * Both live in one element that swaps its own children, rather than in a
 * `StateField`, because the state is genuinely local — nothing outside this
 * tooltip can act on whether the field is open. A selection change rebuilds the
 * tooltip and so closes the form, which is the right answer anyway: you are now
 * asking about a different passage.
 *
 * **Nothing here may collapse the selection.** The tooltip is outside the
 * editor's content, so a plain click on the button moves focus and takes the
 * highlight with it; `preventDefault` on `mousedown` is what stops that. The
 * TEXTAREA is the exception and must take focus, which is safe because the
 * selection lives in the editor's state and not in the DOM: focusing elsewhere
 * dims the highlight without changing what is selected. The quote was built
 * before either happened regardless.
 */
function askAgentDom(quote: string, onAsk: (prompt: string) => void): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-ask-agent'

  const send = (instruction: string) => onAsk(askPrompt(instruction, quote))

  const form = (): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'cm-ask-agent-form'

    const field = document.createElement('textarea')
    field.rows = 2
    field.placeholder = 'What should the agent do with this?'
    field.setAttribute('aria-label', 'Instructions for the agent')
    // Enter sends, because this is a message rather than a document. Shift+Enter
    // is the newline, which is the convention every chat box uses and the one a
    // reader will try first.
    field.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        send(field.value)
        return
      }
      // Back to the button rather than out of the editor: Escape here means "not
      // this", not "stop selecting".
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dom.replaceChildren(trigger())
      }
    }

    const submit = document.createElement('button')
    submit.type = 'button'
    submit.className = 'cm-ask-agent-send'
    submit.textContent = 'Ask agent'
    submit.onmousedown = (e) => {
      e.preventDefault()
      send(field.value)
    }

    wrap.append(field, submit)
    // After it is in the tree, or focus lands on a node with no layout yet.
    queueMicrotask(() => field.focus())
    return wrap
  }

  const trigger = (): HTMLElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Ask agent'
    button.onmousedown = (e) => {
      e.preventDefault()
      dom.replaceChildren(form())
    }
    return button
  }

  dom.appendChild(trigger())
  return dom
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
      create: () => ({ dom: askAgentDom(prompt, onAsk) }),
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
