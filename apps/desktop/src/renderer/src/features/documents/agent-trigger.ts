/**
 * The document's own keys, and where the agent prompt sits. Space on an
 * empty top-level line opens the prompt there instead of typing a space
 * (Notion's gesture); anywhere else it is a space. ⌘B is always the
 * editor's: bold where bold applies, and never the shell's sidebar toggle,
 * which yields to a key the editor claimed.
 *
 * The prompt takes the empty line's place in the page: a widget before it,
 * with the line itself hidden, so what follows moves down rather than being
 * covered. The view renders the prompt into `container`.
 */
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { Extension, type Editor } from "@tiptap/react"

export interface AgentTriggerOptions {
  /** Open the prompt on the empty line at `pos`. */
  onTrigger: (pos: number) => void
  /** Where the view renders the prompt; placed in the page by a widget. */
  container: HTMLElement | null
}

/** The open prompt's line, as a position inside it, kept mapped through
 *  edits; null while closed. */
export const agentPromptKey = new PluginKey<number | null>("agentPrompt")

/** Whether the caret sits alone on an empty paragraph at the top level. */
export function onEmptyLine(editor: Editor): boolean {
  const { selection } = editor.state
  if (!selection.empty) return false
  const { $from } = selection
  return (
    $from.depth === 1 &&
    $from.parent.type.name === "paragraph" &&
    $from.parent.content.size === 0
  )
}

/** Open the prompt on the line at `pos`, or close it with null. */
export function setAgentPrompt(editor: Editor, pos: number | null): void {
  editor.view.dispatch(editor.state.tr.setMeta(agentPromptKey, { pos }))
}

export function agentPromptPos(state: EditorState): number | null {
  return agentPromptKey.getState(state) ?? null
}

export const AgentTrigger = Extension.create<AgentTriggerOptions>({
  name: "agentTrigger",

  addOptions() {
    return { onTrigger: () => undefined, container: null }
  },

  addKeyboardShortcuts() {
    return {
      Space: ({ editor }) => {
        if (!editor.isEditable || !onEmptyLine(editor)) return false
        this.options.onTrigger(editor.state.selection.from)
        return true
      },
      "Mod-b": ({ editor }) => {
        editor.commands.toggleBold()
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    const container = this.options.container
    return [
      new Plugin<number | null>({
        key: agentPromptKey,
        state: {
          init: () => null,
          apply(tr, pos) {
            const meta = tr.getMeta(agentPromptKey) as
              | { pos: number | null }
              | undefined
            if (meta !== undefined) return meta.pos
            return pos === null ? null : tr.mapping.map(pos)
          },
        },
        props: {
          decorations(state) {
            const pos = agentPromptKey.getState(state)
            if (pos == null || container === null) return null
            const $pos = state.doc.resolve(pos)
            if ($pos.depth < 1) return null
            const before = $pos.before(1)
            const after = $pos.after(1)
            return DecorationSet.create(state.doc, [
              Decoration.widget(before, container, {
                side: -1,
                key: "agent-prompt",
                ignoreSelection: true,
                // Typing in the prompt is the prompt's, not the editor's.
                stopEvent: () => true,
              }),
              Decoration.node(before, after, { class: "hidden" }),
            ])
          },
        },
      }),
    ]
  },
})
