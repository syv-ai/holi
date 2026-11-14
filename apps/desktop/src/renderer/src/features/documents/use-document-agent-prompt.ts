/**
 * The agent's prompt on a page: Space on an empty line, the slash menu's Ask
 * AI and a vault app's command open it (`trigger`); sending it turns the line
 * into the marker the agent writes at. The prompt is the editor's to track
 * (`agentPromptKey`) and renders into the view's `promptBox` on that line.
 */
import { useEffect, useRef, useState } from 'react'
import { useEditorActivity } from '@/hooks/use-editor-activity'
import { useAtomValue } from 'jotai'
import type { Editor } from '@tiptap/react'

import { isRunLive } from '@/state/document-runs'
import { pluginSlashCommandsAtom } from '@/state/plugins'

import { agentPromptKey, agentPromptPos, onEmptyLineAt, setAgentPrompt } from './agent-trigger'
import type { useDocumentAgent } from './document-agent'
import { AGENT_MARKER } from './markdown'
import {
  enqueueRewrite,
  mapRewriteTargets,
  removeRewrite,
  reselectRewrite,
  updateRewrite,
} from './rewrite-queue'
import type { Mapping } from '@tiptap/pm/transform'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { RewriteQueue } from './rewrite-queue'
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
  freeze,
}: {
  editor: Editor | null
  path: string
  agent: ReturnType<typeof useDocumentAgent>
  handlers: React.RefObject<PromptHandlers>
  save: () => Promise<void>
  freeze: (value: boolean) => void
}) {
  const activity = useEditorActivity(editor)
  /** Whether the agent prompt is open. */
  const [promptOpen, setPromptOpen] = useState(false)
  /** What the ask prompt opens with: an app command's instruction. */
  const [promptInitial, setPromptInitial] = useState('')
  const [rewriteQueue, setRewriteQueue] = useState<RewriteQueue>([])
  const rewriteQueueRef = useRef(rewriteQueue)
  rewriteQueueRef.current = rewriteQueue
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [batchError, setBatchError] = useState<string | null>(null)
  const batchInFlight = useRef(false)
  const batchGeneration = useRef(0)
  const batchAwaitingRun = useRef(false)

  function releaseBatch(token: number) {
    if (batchGeneration.current !== token) return
    batchInFlight.current = false
    freeze(false)
    setBatchSubmitting(false)
  }

  useEffect(() => {
    if (!batchAwaitingRun.current || !agent.run || isRunLive(agent.run)) return
    batchAwaitingRun.current = false
    batchInFlight.current = false
    freeze(false)
    setBatchSubmitting(false)
  }, [agent.run, freeze])

  function updateQueue(update: (queue: RewriteQueue) => RewriteQueue) {
    const next = update(rewriteQueueRef.current)
    rewriteQueueRef.current = next
    setRewriteQueue(next)
  }

  function addToBatch(instruction: string, passage: string) {
    if (batchInFlight.current || !editor || !activity.focused) return
    const { from, to, $from, $to } = editor.state.selection
    if (
      from === to ||
      $from.parent !== $to.parent ||
      $from.start() !== $to.start() ||
      !$from.parent.isTextblock
    )
      return
    updateQueue((queue) =>
      enqueueRewrite(
        queue,
        {
          from,
          to,
          blockFrom: $from.before(),
          blockTo: $from.after(),
          passage,
          instruction,
          blockType: $from.parent.type.name,
        },
        crypto.randomUUID(),
      ),
    )
  }

  function reselection(id: string) {
    if (batchInFlight.current) return
    const item = rewriteQueueRef.current.find((request) => request.id === id)
    if (!item || !editor) return
    if (item.valid) {
      editor.commands.setTextSelection({ from: item.from, to: item.to })
      editor.commands.focus()
      return
    }
    const { from, to, $from, $to } = editor.state.selection
    if (
      from === to ||
      $from.parent !== $to.parent ||
      $from.start() !== $to.start() ||
      !$from.parent.isTextblock
    )
      return
    updateQueue((queue) =>
      reselectRewrite(queue, id, {
        from,
        to,
        blockFrom: $from.before(),
        blockTo: $from.after(),
        passage: editor.state.doc.textBetween(from, to, '\n'),
        blockType: $from.parent.type.name,
      }),
    )
  }

  async function submitBatch() {
    if (batchInFlight.current || !editor || !activity.focused) return
    const batch = rewriteQueueRef.current
    if (!batch.length || batch.some((item) => !item.valid)) return

    // Lock synchronously before save yields, so inputs, removals, reselections,
    // and duplicate submits cannot change the request being saved/launched.
    batchInFlight.current = true
    const submission = ++batchGeneration.current
    setBatchError(null)
    freeze(true)
    setBatchSubmitting(true)
    const isCurrentVisit = activity.capture()
    const savedRevision = editor.state.doc
    const getLocation = (item: RewriteQueue[number]) => {
      const blocks: string[] = []
      let targetIndex = -1
      savedRevision.descendants((node, pos) => {
        if (!node.isTextblock) return
        blocks.push(node.textContent)
        if (pos === item.blockFrom) targetIndex = blocks.length - 1
        return false
      })
      const current = blocks[targetIndex] ?? ''
      const occurrence = blocks.slice(0, targetIndex + 1).filter((text) => text === current).length
      return {
        ordinal: targetIndex + 1,
        occurrence,
        previous: blocks[targetIndex - 1] ?? '',
        current,
        next: blocks[targetIndex + 1] ?? '',
      }
    }
    const targets = batch.map((item) => ({ item, location: getLocation(item) }))
    const request = batch.map((item, index) => `${index + 1}. ${item.instruction}`).join('\n')
    const passages = targets
      .map(
        ({ item, location }, index) =>
          `<target index="${index + 1}" document="${path}" body-block="${location.ordinal}" ` +
          `identical-block-occurrence="${location.occurrence}">\n` +
          `Previous block: ${JSON.stringify(location.previous)}\n` +
          `Exact target: ${JSON.stringify(item.passage)}\n` +
          `Prefix in target block: ${JSON.stringify(savedRevision.textBetween(item.blockFrom + 1, item.from))}\n` +
          `Suffix in target block: ${JSON.stringify(savedRevision.textBetween(item.to, item.blockTo - 1))}\n` +
          `Current block: ${JSON.stringify(location.current)}\n` +
          `Next block: ${JSON.stringify(location.next)}\n</target>`,
      )
      .join('\n\n')
    try {
      await save()
      // A save can yield to disk reloads, editor changes, tab/vault switches,
      // or disposal. Never launch if the captured target revision is stale.
      if (
        editor.isDestroyed ||
        !isCurrentVisit() ||
        !editor.state.doc.eq(savedRevision) ||
        rewriteQueueRef.current !== batch ||
        batch.some((item) => !item.valid)
      ) {
        if (isCurrentVisit())
          setBatchError('The document changed before submission. Review the targets and try again.')
        return
      }
      batchAwaitingRun.current = true
      const started = await agent.start(
        'rewrite',
        `In the saved document ${path}, apply each numbered request only to its corresponding target. ` +
          'Locate it by document path, 1-based Markdown body text-block order, occurrence among identical blocks, ' +
          'neighboring blocks, and exact target text; ' +
          'if those do not identify exactly one block, do not edit it.\n' +
          request,
        passages,
        isCurrentVisit,
        `Rewrite batch (${batch.length})`,
      )
      if (
        started &&
        batchGeneration.current === submission &&
        isCurrentVisit() &&
        rewriteQueueRef.current === batch
      )
        updateQueue(() => [])
    } catch (error) {
      if (isCurrentVisit())
        setBatchError(
          error instanceof Error ? error.message : 'Could not submit the batch. Try again.',
        )
    } finally {
      if (batchGeneration.current === submission) batchAwaitingRun.current = false
      releaseBatch(submission)
    }
  }

  handlers.current.trigger = (pos, instruction) => {
    if (!activity.focused || !editor || !agent.available || isRunLive(agent.run)) return
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
    if (activity.focused) editor.commands.focus(pos ?? 'end')
  }

  async function sendPrompt(request: string) {
    if (!activity.focused || !editor) return
    const current = activity.capture()
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
    await agent.start('write', request, undefined, current)
  }

  /** A quick command or the person's own instruction, on a selected passage. */
  async function quickCommand(instruction: string, passage: string) {
    const current = activity.capture()
    await save()
    await agent.start('rewrite', instruction, passage, current)
  }

  async function createVaultApp() {
    const current = activity.capture()
    await save()
    await agent.start('vault-app', 'Creating a vault app', undefined, current)
  }

  return {
    promptOpen,
    promptInitial,
    closePrompt,
    sendPrompt,
    quickCommand,
    createVaultApp,
    rewriteQueue,
    addToBatch,
    submitBatch,
    batchSubmitting,
    batchError,
    mapTargets: (mapping: Mapping, doc: ProseMirrorNode, externalReload = false) =>
      updateQueue((queue) => mapRewriteTargets(queue, mapping, doc, externalReload)),
    removeFromBatch: (id: string) => {
      if (!batchInFlight.current) updateQueue((queue) => removeRewrite(queue, id))
    },
    editBatchItem: (id: string, instruction: string) => {
      if (!batchInFlight.current) updateQueue((queue) => updateRewrite(queue, id, { instruction }))
    },
    reselection,
  }
}
