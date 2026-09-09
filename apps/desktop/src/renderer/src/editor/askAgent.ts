/**
 * Select a passage, press one button, and the agent opens already knowing which
 * note and which lines you meant (#5).
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
      create: () => {
        const dom = document.createElement('div')
        dom.className = 'cm-ask-agent'
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = 'Ask Claude'
        // The tooltip is outside the content, so a plain click would move focus
        // and collapse the very selection it is about to send.
        button.onmousedown = (e) => {
          e.preventDefault()
          onAsk(prompt)
        }
        dom.appendChild(button)
        return { dom }
      },
    },
  ]
}

/**
 * Shows an "Ask Claude" button over a non-empty selection.
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
