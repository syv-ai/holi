/**
 * The agent's prompt on a page: Space on an empty line, the slash menu's Ask
 * AI and a vault app's command open it (`trigger`); sending it turns the line
 * into the marker the agent writes at. The prompt is the editor's to track
 * (`agentPromptKey`) and renders into the view's `promptBox` on that line.
 */
import { useState } from 'react'
import { useAtomValue } from 'jotai'
import type { Editor } from '@tiptap/react'

import { pluginSlashCommandsAtom } from '@/state/plugins'

import { agentPromptKey, agentPromptPos, onEmptyLineAt, setAgentPrompt } from './agent-trigger'
import { isRunLive, type useDocumentAgent } from './document-agent'
import { AGENT_MARKER } from './markdown'
import { pluginSlashItem } from './plugin-slash'
import type { RichTextSlashItem } from './rich-text/rich-text-slash-menu'

/** The callbacks the editor's extensions hold, read through a ref. */
export interface PromptHandlers {
  trigger: (pos: number, instruction?: string) => void
  pluginItems: () => readonly RichTextSlashItem[]
}

export function useDocumentAgentPrompt({
  editor,
  path,
  agent,
  handlers,
  save,
}: {
  editor: Editor | null
  path: string
  agent: ReturnType<typeof useDocumentAgent>
  handlers: React.RefObject<PromptHandlers>
  save: () => Promise<void>
}) {
  /** Whether the agent prompt is open. */
  const [promptOpen, setPromptOpen] = useState(false)
  /** What the ask prompt opens with: an app command's instruction. */
  const [promptInitial, setPromptInitial] = useState('')

  handlers.current.trigger = (pos, instruction) => {
    if (!editor || !agent.available || isRunLive(agent.run)) return
    setPromptInitial(instruction ?? '')
    setAgentPrompt(editor, pos)
    setPromptOpen(true)
  }

  // The running plugins' slash commands (a vault app's), offered where
  // their plugin says they may run on this note.
  const pluginCommands = useAtomValue(pluginSlashCommandsAtom)
  handlers.current.pluginItems = () =>
    pluginCommands
      .filter((command) => command.offeredIn?.(path) ?? true)
      .map((command) =>
        pluginSlashItem(command, path, (pos, instruction) =>
          handlers.current.trigger(pos, instruction),
        ),
      )

  function closePrompt() {
    if (!editor) return
    const pos = agentPromptPos(editor.state)
    setAgentPrompt(editor, null)
    setPromptOpen(false)
    editor.commands.focus(pos ?? 'end')
  }

  async function sendPrompt(request: string) {
    if (!editor) return
    // The prompt's line becomes the marker the agent writes at.
    const { state } = editor
    const pos = agentPromptPos(state)
    const tr = state.tr.setMeta(agentPromptKey, { pos: null })
    const marker = state.schema.nodes.htmlBlock?.create({ html: AGENT_MARKER })
    if (pos !== null && marker && onEmptyLineAt(state.doc, pos)) {
      const $pos = state.doc.resolve(pos)
      tr.replaceWith($pos.before(), $pos.after(), marker)
    }
    editor.view.dispatch(tr)
    setPromptOpen(false)
    await save()
    await agent.start('write', request)
  }

  /** A quick command or the person's own instruction, on a selected passage. */
  async function quickCommand(instruction: string, passage: string) {
    await save()
    await agent.start('rewrite', instruction, passage)
  }

  async function createVaultApp() {
    await save()
    await agent.start('vault-app', 'Creating a vault app')
  }

  return { promptOpen, promptInitial, closePrompt, sendPrompt, quickCommand, createVaultApp }
}
