/**
 * A markdown document, open in ReUI's rich-text editor (`rich-text-editor-2`)
 * and saved back to the file as markdown (`markdown.ts`).
 *
 * The file stays the source of truth. Typing saves after a pause; a change on
 * disk (a pull, the agent) is read back in unless there are local edits not
 * yet saved, which win and are written over it.
 *
 * The agent is part of the page: Space on an empty line asks it to write
 * there, the format bubble's Ask AI rewrites a selection, and the menu's
 * Create vault app makes a vault app of the document beside it, and opens it
 * when it is done if the document is still in front. While a run edits
 * the document the page is locked (nothing in it can be pressed) and the
 * status pill at its foot says what it is doing and offers Stop.
 *
 * A note's comment threads sit in a panel beside the text, their passages
 * tinted in it (`document-comments.ts`): the format bubble's Comment, or
 * ⌘⌥M, starts one on the selection. A task's properties sit above the text or
 * in a panel beside it, as the person's `propertiesLayout` says; the header's
 * toggle flips it.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import {
  differsBeyondTidy,
  holiWebLink,
  isHoliLinkable,
  isResolved,
  parseTaskFile,
  SCRATCHPAD_PATH,
  TASKS_CLAIM,
} from '@holi/shared'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { findNext, findPrev } from 'prosemirror-search'
import { EditorContent, Extension, useEditor } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'

import { DeleteTableDialog } from '@/features/documents/rich-text/delete-table-dialog'
import { RichTextBlockActions } from '@/features/documents/rich-text/rich-text-block-actions'
import { RichTextBlockGutter } from '@/features/documents/rich-text/rich-text-block-gutter'
import { setRichTextBubble } from '@/features/documents/rich-text/rich-text-bubble-bar'
import { RICH_TEXT_PROSE } from '@/features/documents/rich-text/rich-text-content'
import { RichTextLinkBubble } from '@/features/documents/rich-text/rich-text-link'
import {
  RICH_TEXT_BASIC_SLASH_ITEMS,
  RichTextSlashCommand,
  type SlashAgentLabelSource,
  type RichTextSlashItem,
} from '@/features/documents/rich-text/rich-text-slash-menu'
import { useRichTextSelector } from '@/features/documents/rich-text/rich-text-state'
import {
  RICH_TEXT_TABLE_PROSE,
  RICH_TEXT_TABLE_SLASH_ITEM,
  RichTextTable,
  RichTextTableBubble,
} from '@/features/documents/rich-text/rich-text-table'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerBuffer } from '@/lib/buffer-registry'
import { cn } from '@/lib/cn'
import { TaskProperties, useHasTaskProperties } from '@/features/planning/task-properties'
import { useSettingsWrite } from '@/features/settings/use-vault-settings'
import { trpc } from '@/lib/trpc'
import { sawText } from '@/state/doc-changes'
import { canStartConversationAtom, startConversationAtom } from '@/state/agents-slots'
import { isRunLive, useAgentLabel } from '@/state/document-runs'
import { agentProviderSettingAtom } from '@/state/settings'
import { claimsAtom } from '@/state/plugins'
import { activeVaultSettingsAtom, useAppSetting } from '@/state/settings'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { closeTab, entryOf, focusedTab } from '@/state/shell-workspace'
import { tabKey, tabPath } from '@/state/tab-descriptor'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

import { AgentPrompt, AgentStatus } from './agent-prompt'
import { askAiSlashItem } from './ask-ai-slash'
import { applyReload } from './apply-reload'
import { locksDocument, useDocumentAgent } from './document-agent'
import { parentOf } from '@/lib/tree-paths'
import { CommentsPanel } from './comments-panel'
import { DocumentComments } from './document-comments'
import { createDocumentExtensions } from './document-extensions'
import { headingAtCaret } from './document-headings'
import { DocumentFindBar } from './document-find-bar'
import { resolveLink } from './resolve-link'
import { DocumentSkeleton } from './document-skeleton'
import { useDocumentAgentPrompt } from './use-document-agent-prompt'
import { useDocumentComments } from './use-document-comments'
import { useDocumentFind } from './use-document-find'
import { useDocumentPosition } from './use-document-position'
import { useSelectionReport } from './use-selection-report'
import { DocumentFormatBubble } from './document-format-bubble'
import { DocumentHeader, type SaveState } from './document-header'
import { documentTitle, joinDocument, splitDocument } from './markdown'
import { ErrorState } from '@/composites/empty-state'
import {
  bindEditorActivity,
  EditorActivityContext,
  useDocumentActivity,
  useEditorActivity,
} from '@/hooks/use-editor-activity'

function isTaskPath(path: string): boolean {
  return /(?:^|\/)task\.[^/]+\.md$/.test(path)
}

// How long typing has to pause before the file is written.
const SAVE_DELAY_MS = 600

// The block drop line, as the rich-text block draws it.
const DROP_LINE =
  '[&_.prosemirror-dropcursor-block]:text-primary [&_.prosemirror-dropcursor-block]:h-0.5! [&_.prosemirror-dropcursor-block]:rounded-full'

/**
 * When a task's properties may sit in a sidebar: only while the view is wide
 * enough to keep a readable text column beside it, a wider view when the
 * comments panel is open too. Below that the sidebar is hidden and the
 * inline properties show instead.
 */
const SIDEBAR_FITS = {
  alone: { sidebar: 'hidden @4xl/document:flex', inline: '@4xl/document:hidden' },
  besideComments: { sidebar: 'hidden @7xl/document:flex', inline: '@7xl/document:hidden' },
} as const

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; head: string; body: string; text: string }
  | { kind: 'error'; message: string }

export function DocumentView({
  path,
  onOpen,
  onMoved,
  visible = true,
  focused = visible,
}: {
  path: string
  /** Open a vault path in a tab: a linked note, or a finished artifact. */
  onOpen: (path: string) => void
  /** The document moved (a task given another project): follow it. */
  onMoved?: (from: string, to: string) => void
  /** Whether the shell displays this retained view. */
  visible?: boolean
  /** Whether it owns keyboard focus and may publish active UI state. */
  focused?: boolean
}) {
  const activity = useDocumentActivity(visible, visible && focused)
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const docs = snapshot.docs
  const mtime =
    docs.find((doc) => doc.path === path)?.updatedAt ??
    (path === SCRATCHPAD_PATH
      ? snapshot.files.find((file) => file.path === SCRATCHPAD_PATH)?.updatedAt
      : undefined) ??
    JSON.stringify(snapshot.claimed[TASKS_CLAIM]?.items.find((item) => item.path === path) ?? null)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (remote === null) return
    let live = true
    setLoad({ kind: 'loading' })
    trpc.notes.read
      .query({ remote, path })
      .then((text) => {
        if (!live) return
        const { head, body } = splitDocument(text)
        setLoad({ kind: 'ready', head, body, text })
      })
      .catch((err: unknown) => {
        if (live)
          setLoad({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          })
      })
    return () => {
      live = false
    }
  }, [remote, path, attempt])

  if (load.kind === 'loading') return <DocumentSkeleton />
  if (load.kind === 'error' || remote === null)
    return (
      <ErrorState
        title={`Couldn’t open ${documentTitle(path)}`}
        message={load.kind === 'error' ? load.message : 'No vault is open.'}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )

  return (
    <EditorActivityContext value={activity}>
      <DocumentEditor
        key={`${remote}:${path}`}
        path={path}
        remote={remote}
        initial={load}
        mtime={mtime}
        docs={docs}
        onOpen={onOpen}
        onMoved={onMoved}
        visible={visible}
        focused={visible && focused}
      />
    </EditorActivityContext>
  )
}

function DocumentEditor({
  path,
  remote,
  initial,
  mtime,
  docs,
  onOpen,
  onMoved,
  visible,
  focused,
}: {
  path: string
  remote: string
  initial: { head: string; body: string; text: string }
  mtime: string | undefined
  docs: readonly { path: string }[]
  onOpen: (path: string) => void
  onMoved?: (from: string, to: string) => void
  visible: boolean
  focused: boolean
}) {
  const activity = useEditorActivity()
  const agent = useDocumentAgent(path, focused)
  const agentLabel = useAgentLabel(useAtomValue(agentProviderSettingAtom)) ?? 'AI'
  const agentLabelRef = useRef(agentLabel)
  agentLabelRef.current = agentLabel
  const labelListeners = useRef(new Set<() => void>())
  const labelSource = useMemo<SlashAgentLabelSource>(
    () => ({
      get: () => agentLabelRef.current,
      subscribe: (listener) => {
        labelListeners.current.add(listener)
        return () => labelListeners.current.delete(listener)
      },
    }),
    [],
  )
  useEffect(() => {
    for (const listener of labelListeners.current) listener()
  }, [agentLabel])
  const store = useStore()
  const locked = locksDocument(agent.run)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [donePending, setDonePending] = useState(false)
  const [doneError, setDoneError] = useState<string | null>(null)
  const doneInFlight = useRef(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [deleteTableOpen, setDeleteTableOpen] = useState(false)
  const [fullWidth, setFullWidth] = useState(false)
  const [smallText, setSmallText] = useState(false)
  const tableStyle = useAppSetting('tableStyle')
  const propertiesLayout = useAppSetting('propertiesLayout')
  const hasProperties = useHasTaskProperties(path)
  const settingsRead = useAtomValue(activeVaultSettingsAtom) !== null
  const writeSetting = useSettingsWrite()
  const [promptBox] = useState(() => {
    const box = document.createElement('div')
    box.contentEditable = 'false'
    box.className = 'my-1'
    return box
  })
  useEffect(() => {
    promptBox.hidden = !focused
  }, [promptBox, focused])
  const pageRef = useRef<HTMLDivElement>(null)
  /** The page's scroller, whose place a tab switch keeps. */
  const scrollerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const [compactView, setCompactView] = useState(false)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const measure = () => setCompactView(view.getBoundingClientRect().width < 640)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view)
    return () => observer.disconnect()
  }, [])
  const head = useRef(initial.head)
  /** The file as last read or written: what a change on disk is compared to. */
  const lastText = useRef(initial.text)
  const saveTimer = useRef<number | undefined>(undefined)
  const dirty = useRef(false)
  /** Writes are serialized so each one compares against the prior completed write. */
  const writing = useRef<Promise<void>>(Promise.resolve())
  const reloadPending = useRef<Promise<void>>(Promise.resolve())
  const reloadFailed = useRef(false)
  const frozen = useRef(false)
  const doneFreeze = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  // Callbacks the extensions hold, read through refs so the extensions are
  // made once per document.
  const handlers = useRef({
    openLink: (_target: string) => undefined as void,
    trigger: (_pos: number, _instruction?: string) => undefined as void,
    pressThread: (_id: string) => undefined as void,
    pluginItems: (): readonly RichTextSlashItem[] => [],
  })
  handlers.current.openLink = (target) => {
    if (!activity.displayed) return
    const found = resolveLink(target, path, docs)
    if (found) onOpen(found)
  }

  const extensions = useMemo(
    () => [
      Extension.create({
        name: 'saveFreeze',
        onBeforeCreate() {
          bindEditorActivity(this.editor, activity)
        },
        addProseMirrorPlugins: () => [
          new Plugin({
            filterTransaction: (transaction) =>
              (!frozen.current && !doneFreeze.current) ||
              !transaction.docChanged ||
              transaction.getMeta('preventUpdate') === true,
          }),
        ],
      }),
      ...createDocumentExtensions({
        folder: parentOf(path),
        placeholder: 'Type / for commands, or Space to ask AI',
        onOpenLink: (target) => handlers.current.openLink(target),
        onAgentTrigger: (pos) => handlers.current.trigger(pos),
        promptContainer: promptBox,
      }),
      RichTextTable,
      DocumentComments.configure({
        onPress: (id) => handlers.current.pressThread(id),
      }),
      RichTextBlockActions,
      RichTextSlashCommand.configure({
        items: [
          ...RICH_TEXT_BASIC_SLASH_ITEMS,
          RICH_TEXT_TABLE_SLASH_ITEM,
          askAiSlashItem((pos) => handlers.current.trigger(pos), agentLabelRef.current),
        ],
        more: () => handlers.current.pluginItems(),
        labelSource,
      }),
    ],
    [path, promptBox, labelSource, activity],
  )

  const editor = useEditor(
    {
      extensions,
      content: initial.body,
      contentType: 'markdown',
      immediatelyRender: false,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': `${documentTitle(path)} document`,
          'aria-multiline': 'true',
        },
      },
      onUpdate: ({ transaction }) => {
        if (!transaction.docChanged || transaction.getMeta('preventUpdate')) return
        dirty.current = true
        setSaveState('saving')
        window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(
          () => void save().catch(() => undefined),
          SAVE_DELAY_MS,
        )
      },
    },
    [extensions],
  )

  const editable = useRichTextSelector(editor, (current) => current?.isEditable ?? true)

  const { promptOpen, promptInitial, closePrompt, sendPrompt, quickCommand, createVaultApp } =
    useDocumentAgentPrompt({ editor, path, agent, handlers, save })

  const comments = useDocumentComments({ editor, path, docs, head, save })
  const {
    threadsLoad,
    threads,
    commentable,
    commentsOpen,
    setCommentsOpen,
    draft,
    setDraft,
    activeThread,
    setActiveThread,
    placed,
    hasSelection,
    placeRef,
    showThread,
    commentOnSelection,
    commentWrite,
    addThread,
    replyThread,
    resolveThread,
    refreshThreads,
  } = comments

  useSelectionReport(editor, path, head, focused)

  const claims = useAtomValue(claimsAtom)
  /** The latest claims, for `save` and the reload, which outlive the render that made them. */
  const claimsRef = useRef(claims)
  claimsRef.current = claims
  /** What the first claim on this path draws above it: a link's card. */
  const Banner = claims.find((claim) => claim.banner !== undefined && claim.match(path))?.banner
  useDocumentPosition({ editor, remote, path, scrollerRef, markdown, active: focused })

  const holiLinks = isHoliLinkable(path)
    ? {
        file: () => holiWebLink({ remote, path }),
        heading: () => {
          if (
            !editor ||
            editor.state.selection.$from.depth !== 1 ||
            editor.state.selection.$from.parent.type.name !== 'heading'
          )
            return null
          const heading = headingAtCaret(editor, markdown())
          return heading === null ? null : holiWebLink({ remote, path, heading })
        },
      }
    : null

  handlers.current.pressThread = comments.pressThread

  /** The document as it would be saved. */
  function markdown(): string {
    return editor ? joinDocument(head.current, editor.getMarkdown()) : lastText.current
  }

  function save(): Promise<void> {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    // Capture the body while the editor is alive, but take frontmatter after
    // pending disk reads: task properties may have changed independently.
    const capturedDirty = dirty.current
    const body = editor ? editor.getMarkdown() : splitDocument(lastText.current).body
    const done = writing.current
      .then(async () => {
        if (reloadFailed.current) {
          const failed = reloadPending.current
          const text = await trpc.notes.read.query({ remote, path })
          if (reloadPending.current === failed) {
            head.current = splitDocument(text).head
            reloadFailed.current = false
            reloadPending.current = Promise.resolve()
          }
        }
        let pending: Promise<void>
        do {
          pending = reloadPending.current
          await pending
        } while (pending !== reloadPending.current)
        // A clean snapshot has no local work to restore over a newer disk body.
        if (capturedDirty) await write(joinDocument(head.current, body), true)
      })
      .catch((error: unknown) => {
        setSaveState('error')
        throw error
      })
    writing.current = done.catch(() => undefined)
    return done
  }

  async function write(text: string, captured = false): Promise<void> {
    // Differing only by what the commit tidies away is nothing to save:
    // writing it would just be tidied again.
    if (
      (!dirty.current && !captured) ||
      !differsBeyondTidy(lastText.current, text, path, claimsRef.current)
    ) {
      dirty.current =
        mounted.current && editor !== null && !editor.isDestroyed
          ? differsBeyondTidy(lastText.current, markdown(), path, claimsRef.current)
          : false
      setSaveState(dirty.current ? 'saving' : 'saved')
      return
    }
    setSaveState('saving')
    try {
      await trpc.notes.write.mutate({ remote, path, text })
      lastText.current = text
      dirty.current =
        mounted.current && editor !== null && !editor.isDestroyed
          ? differsBeyondTidy(text, markdown(), path, claimsRef.current)
          : dirty.current && !captured
      setSaveState(dirty.current ? 'saving' : 'saved')
      if (mounted.current) placeRef.current()
    } catch (error) {
      setSaveState('error')
      throw error
    }
  }

  /** The latest `save`, for the flush, which outlives the render that made it. */
  const saveRef = useRef(save)
  saveRef.current = save

  // A rename, move, delete, branch switch, vault switch or quit writes what
  // is pending first, to the path it was typed at; after that the unmount
  // below has nothing left to write.
  useEffect(
    () =>
      registerBuffer(
        () => saveRef.current(),
        undefined,
        (value) => {
          frozen.current = value
          editor?.setEditable(
            !value && visibleRef.current && !doneFreeze.current && !lockedRef.current,
          )
        },
      ),
    [editor],
  )

  // Leaving the document writes what is pending, and leaves what it showed
  // for its tab to be compared to (`doc-changes.ts`).
  useEffect(() => {
    if (visible) return
    const pending = dirty.current
    const live = editor !== null && !editor.isDestroyed
    sawText(remote, path, pending && live ? markdown() : lastText.current)
    if (pending) void save().catch(() => undefined)
    // Saving is an existing leave-view behavior; a retained editor remains
    // mounted, so visibility replaces its former unmount transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // A close or vault disposal still unmounts the editor and needs the same
  // final save that ordinary tabs used to get from unmounting on every leave.
  useEffect(
    () => () => {
      const pending = dirty.current
      const live = editor !== null && !editor.isDestroyed
      sawText(remote, path, pending && live ? markdown() : lastText.current)
      if (pending) void save().catch(() => undefined)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  )

  // A change on disk comes back in, unless local edits are still pending.
  useEffect(() => {
    if (!editor || mtime === undefined) return
    let live = true
    const reload: Promise<void> = trpc.notes.read.query({ remote, path }).then((text) => {
      if (!live || editor.isDestroyed) {
        // A queued save outlives the editor too. Its captured body still needs
        // the latest metadata; a superseded read must never supply it.
        if (reloadPending.current === reload) head.current = splitDocument(text).head
        return
      }
      if (text === lastText.current) return
      // The commit's tidy (`normalize-md`) rewrote what was saved: nothing
      // new, so the buffer stays, and with it a space just typed under the
      // caret. The next save compares against the tidied file.
      if (!differsBeyondTidy(lastText.current, text, path, claimsRef.current)) {
        lastText.current = text
        return
      }
      const next = splitDocument(text)
      if (dirty.current && !locked) {
        head.current = next.head
        lastText.current = text
        return
      }
      try {
        const changed = applyReload(editor, next.body)
        head.current = next.head
        lastText.current = text
        if (changed) placeRef.current()
        setSaveState('saved')
      } catch {
        // Keep the last-known file snapshot unchanged so a later disk update
        // can retry; dispatch failures must not be mistaken for a successful reload.
        setSaveState('error')
      }
    })
    reloadPending.current = reload
    reloadFailed.current = false
    void reload.catch(() => {
      if (reloadPending.current === reload) reloadFailed.current = true
    })
    return () => {
      live = false
    }
    // Only a new mtime means the file may have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtime, editor])

  // A run that edits the document locks it; done, the lock lifts.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!locked && visible && !frozen.current && !doneFreeze.current)
  }, [editor, locked, visible])

  // A finished edit clears its pill on its own. A finished vault app opens
  // when the document is still the tab in front and was never left while it
  // ran; otherwise it waits on the pill's Open.
  useEffect(() => {
    const run = agent.run
    if (!focused || !activity.focused || !run || run.status !== 'done') return
    if (run.kind === 'vault-app') {
      // A partial copy stays on the pill until the person has seen what was left out.
      if (run.away || run.opened || run.appPath === undefined || run.message !== undefined) return
      if (tabPath(focusedTab(store.get(shellWorkspaceAtom))) !== path) return
      agent.markOpened()
      onOpen(run.appPath)
      return
    }
    const timer = window.setTimeout(agent.dismiss, 1500)
    return () => window.clearTimeout(timer)
    // `onOpen` is the shell's, new each render; the run is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.run, agent.dismiss, path, store, focused, activity])

  /**
   * The whole page takes a press. Below the last line it starts a new one
   * (reusing an empty last line); beside the text it puts the caret on the
   * nearest line. Presses on the text itself are the editor's.
   */
  function pressPage(event: React.MouseEvent<HTMLDivElement>) {
    if (!editor || !editor.isEditable || event.button !== 0) return
    // Only the bare page: the scroller, the page box, or the inset around the
    // text. Bubbles, the gutter and the prompt sit in the page too.
    const target = event.target
    if (
      target !== event.currentTarget &&
      target !== pageRef.current &&
      target !== editor.view.dom.parentElement
    )
      return
    event.preventDefault()
    const text = editor.view.dom.getBoundingClientRect()
    if (event.clientY > text.bottom) {
      const { doc, schema } = editor.state
      const last = doc.lastChild
      const emptyLast = last?.type.name === 'paragraph' && last.content.size === 0
      if (!emptyLast) {
        editor
          .chain()
          .insertContentAt(doc.content.size, { type: schema.nodes.paragraph!.name })
          .run()
      }
      editor.commands.focus('end')
      return
    }
    const x = Math.min(Math.max(event.clientX, text.left + 1), text.right - 1)
    const at = editor.view.posAtCoords({ left: x, top: event.clientY })
    editor.commands.focus(at?.pos ?? 'end')
  }

  function openLinkEditor() {
    if (!editor?.isEditable || !editor.can().toggleBold()) return
    if (editor.isActive('link')) editor.chain().extendMarkRange('link').run()
    setRichTextBubble(editor, 'documentFormatBubble', 'show')
    setLinkOpen(true)
  }

  const { find, setFind, apple, isFindKey, openFind } = useDocumentFind(editor, viewRef, focused)

  async function finishTask() {
    if (doneInFlight.current || lockedRef.current || frozen.current || !editor?.isEditable) return
    const remoteAtStart = store.get(activeRemoteAtom)
    const workspaceAtStart = store.get(shellWorkspaceAtom)
    const key = tabKey({ kind: 'doc', path })
    if (remoteAtStart !== remote || entryOf(workspaceAtStart, key) === null || !isTaskPath(path))
      return

    const currentVisit = activity.capture()
    doneInFlight.current = true
    doneFreeze.current = true
    editor.setEditable(false)
    setDonePending(true)
    setDoneError(null)
    try {
      await saveRef.current()
      // A clean buffer may not write at all. Check the serialized header only
      // after the queued save so validation sees the latest task text.
      parseTaskFile(markdown(), path)
      // A vault switch or any workspace change while the write was pending
      // makes the original close stale. Never act on the newly active workspace.
      if (
        !currentVisit() ||
        store.get(activeRemoteAtom) !== remoteAtStart ||
        store.get(shellWorkspaceAtom) !== workspaceAtStart ||
        frozen.current ||
        entryOf(store.get(shellWorkspaceAtom), key) === null
      )
        return
      store.set(shellWorkspaceAtom, (workspace) =>
        workspace === workspaceAtStart && entryOf(workspace, key) !== null
          ? closeTab(workspace, key)
          : workspace,
      )
    } catch (error) {
      setDoneError(error instanceof Error ? error.message : String(error))
    } finally {
      doneInFlight.current = false
      if (!editor.isDestroyed) {
        doneFreeze.current = false
        editor.setEditable(!lockedRef.current && activity.displayed && !frozen.current)
      }
      setDonePending(false)
    }
  }

  function handleViewKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!focusedRef.current || !editor || event.defaultPrevented) return
    const mod = apple ? event.metaKey : event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && event.altKey && !event.shiftKey && event.code === 'KeyM') {
      // ⌘⌥M, as in other editors: comment on the selection.
      event.preventDefault()
      void commentOnSelection()
    } else if (isFindKey(event)) {
      event.preventDefault()
      openFind()
    } else if (find && mod && !event.altKey && key === 'g') {
      event.preventDefault()
      ;(event.shiftKey ? findPrev : findNext)(editor.state, editor.view.dispatch)
    } else if (find && event.key === 'Escape' && editor.view.hasFocus()) {
      event.preventDefault()
      setFind(null)
    }
  }

  const canAsk = agent.available && !isRunLive(agent.run)
  const canStartChat = useAtomValue(canStartConversationAtom)
  const startConversation = useSetAtom(startConversationAtom)

  /** A new agent session beside the document, the passage in its input as
   *  context, for the person to ask about it. */
  async function startChat(passage: string) {
    const res = await startConversation({
      text: '',
      context: [{ kind: 'passage', path, text: passage }],
      beside: true,
    })
    if (!res.ok) toast.error(`Couldn't start the chat. ${res.message}`)
  }

  const sidebarFits = commentable && commentsOpen ? SIDEBAR_FITS.besideComments : SIDEBAR_FITS.alone

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={viewRef}
        className="text-foreground @container/document relative flex h-full min-h-0 w-full flex-col"
        inert={!visible}
        onKeyDown={handleViewKeyDown}
      >
        {/* Locked while a run edits the document: nothing in it answers. */}
        <div inert={locked} className="flex min-h-0 flex-1 flex-col">
          {/* On the page's own ground, a hairline under it; the text scrolls
              beneath the line, not under the header. */}
          <DocumentHeader
            editor={editor}
            visible={visible && focused}
            path={path}
            title={documentTitle(path)}
            saveState={saveState}
            locked={locked}
            taskDone={
              isTaskPath(path)
                ? { pending: donePending, error: doneError, onDone: finishTask }
                : undefined
            }
            compact={compactView}
            markdown={markdown}
            fullWidth={fullWidth}
            smallText={smallText}
            onFullWidthChange={setFullWidth}
            onSmallTextChange={setSmallText}
            onCreateVaultApp={canAsk && agent.appable ? () => void createVaultApp() : null}
            holiLink={holiLinks?.file ?? null}
            headingLink={holiLinks?.heading ?? null}
            properties={
              hasProperties
                ? {
                    // Nothing to flip until the settings are read.
                    disabled: !settingsRead,
                    sidebar: propertiesLayout === 'sidebar',
                    onSidebarChange: (sidebar) =>
                      void writeSetting('propertiesLayout', sidebar ? 'sidebar' : 'inline'),
                  }
                : null
            }
            comments={
              commentable
                ? {
                    count: threads?.filter((t) => !isResolved(t)).length ?? 0,
                    open: commentsOpen,
                    onOpenChange: setCommentsOpen,
                  }
                : null
            }
          />
          <div inert={donePending} className="flex min-h-0 flex-1">
            <div
              ref={scrollerRef}
              className="relative min-h-0 min-w-0 flex-1 overflow-y-auto"
              onMouseDown={pressPage}
            >
              {/* The find bar floats at the page's top right, over the text,
                and stays there as it scrolls. */}
              {editor && find ? (
                <div
                  hidden={!focused}
                  className={cn(
                    'sticky top-2 z-40 flex h-0 items-start justify-end px-4',
                    !focused && 'hidden',
                  )}
                >
                  <DocumentFindBar editor={editor} request={find} onClose={() => setFind(null)} />
                </div>
              ) : null}
              {/* A plugin's card for the file it claims, a link's page. */}
              {Banner !== undefined ? (
                <div
                  className={cn(
                    'mx-auto w-full px-4 pt-8 sm:px-16 sm:pt-12',
                    fullWidth ? 'max-w-none' : 'max-w-3xl',
                  )}
                >
                  <Banner path={path} />
                </div>
              ) : null}
              {/* A task's properties, on the body's column; nothing for a note.
                  In a sidebar only when the view has room for it beside the
                  text (and the comments, when they are open): narrower, they
                  stay here whatever the setting says. */}
              <TaskProperties
                path={path}
                layout="inline"
                beforeWrite={save}
                onMoved={onMoved}
                className={cn(
                  'mx-auto w-full px-4 pt-8 sm:px-16 sm:pt-12',
                  fullWidth ? 'max-w-none' : 'max-w-3xl',
                  propertiesLayout === 'sidebar' && sidebarFits.inline,
                )}
              />
              <div ref={pageRef} className={cn('relative min-h-full', DROP_LINE)}>
                {editor ? (
                  <div data-table-style={tableStyle} className={RICH_TEXT_TABLE_PROSE}>
                    <EditorContent
                      editor={editor}
                      onKeyDown={(event) => {
                        const mod = event.metaKey || event.ctrlKey
                        if (mod && !event.altKey && event.key.toLowerCase() === 'k') {
                          event.preventDefault()
                          openLinkEditor()
                        }
                      }}
                      className={cn(
                        RICH_TEXT_PROSE,
                        'mx-auto w-full px-4 py-8 sm:px-16 sm:py-12',
                        fullWidth ? 'max-w-none' : 'max-w-3xl',
                        smallText && 'text-sm/6',
                        locked && 'opacity-60',
                      )}
                    />
                  </div>
                ) : (
                  <DocumentSkeleton />
                )}
                {editor ? (
                  <>
                    <DocumentFormatBubble
                      editor={editor}
                      linkOpen={linkOpen}
                      onLinkOpenChange={setLinkOpen}
                      onQuickCommand={
                        canAsk
                          ? (instruction, passage) => void quickCommand(instruction, passage)
                          : null
                      }
                      onStartChat={canStartChat ? (passage) => void startChat(passage) : null}
                      onComment={commentable ? () => void commentOnSelection() : null}
                    />
                    <RichTextLinkBubble editor={editor} onEdit={openLinkEditor} />
                    <RichTextTableBubble
                      editor={editor}
                      onDeleteTable={() => setDeleteTableOpen(true)}
                    />
                    <RichTextBlockGutter
                      editor={editor}
                      editable={editable}
                      scrollerRef={pageRef}
                      onDeleteTable={() => setDeleteTableOpen(true)}
                      headingLink={holiLinks?.heading ?? null}
                    />
                  </>
                ) : null}
                {promptOpen
                  ? createPortal(
                      <AgentPrompt
                        initial={promptInitial}
                        onSubmit={(request) => void sendPrompt(request)}
                        onCancel={closePrompt}
                      />,
                      promptBox,
                    )
                  : null}
              </div>
            </div>
            {propertiesLayout === 'sidebar' ? (
              <TaskProperties
                path={path}
                layout="sidebar"
                beforeWrite={save}
                onMoved={onMoved}
                className={sidebarFits.sidebar}
              />
            ) : null}
            {commentable && commentsOpen ? (
              <CommentsPanel
                load={threadsLoad}
                placed={placed}
                active={activeThread}
                draft={draft}
                onSelect={showThread}
                onDraftSubmit={(body) =>
                  commentWrite('The comment could not be saved', async () => {
                    if (draft === null) return
                    const id = await addThread({ path, anchor: draft, body })
                    setDraft(null)
                    if (id) setActiveThread(id)
                  })
                }
                onDraftCancel={() => setDraft(null)}
                onReply={(thread, body) =>
                  commentWrite('The reply could not be saved', () =>
                    replyThread({ path, thread, body }),
                  )
                }
                onResolve={(thread, resolved) =>
                  commentWrite(
                    resolved
                      ? 'The thread could not be resolved'
                      : 'The thread could not be reopened',
                    () => resolveThread({ path, thread, resolved }),
                  ).catch(() => undefined)
                }
                onRetry={() => void refreshThreads(path)}
                onClose={() => {
                  setCommentsOpen(false)
                  setDraft(null)
                  setActiveThread(null)
                }}
                onCommentSelection={hasSelection ? () => void commentOnSelection() : null}
              />
            ) : null}
          </div>
        </div>

        {agent.run &&
        !(
          agent.run.kind === 'vault-app' &&
          agent.run.status === 'done' &&
          agent.run.opened &&
          agent.run.message === undefined
        ) ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
            <div className="pointer-events-auto">
              <AgentStatus
                run={agent.run}
                onStop={() => void agent.stop()}
                onDismiss={agent.dismiss}
                onOpenApp={() => {
                  const app = agent.run?.appPath
                  agent.markOpened()
                  if (app !== undefined) onOpen(app)
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
      <DeleteTableDialog editor={editor} open={deleteTableOpen} onOpenChange={setDeleteTableOpen} />
    </TooltipProvider>
  )
}
