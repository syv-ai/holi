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
 * Turn into an Artifact makes a vault app of the document. While a run edits
 * the document the page is locked (nothing in it can be pressed) and the
 * status pill at its foot says what it is doing and offers Stop.
 *
 * A note's comment threads sit in a panel beside the text, their passages
 * tinted in it (`document-comments.ts`): the format bubble's Comment, or
 * ⌘⌥M, starts one on the selection.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { holiLink, isHoliLinkable, isResolved } from '@holi/shared'
import { useAtomValue } from 'jotai'
import { findNext, findPrev } from 'prosemirror-search'
import { EditorContent, useEditor } from '@tiptap/react'

import { DeleteTableDialog } from '@/features/documents/rich-text/delete-table-dialog'
import { RichTextBlockActions } from '@/features/documents/rich-text/rich-text-block-actions'
import { RichTextBlockGutter } from '@/features/documents/rich-text/rich-text-block-gutter'
import { setRichTextBubble } from '@/features/documents/rich-text/rich-text-bubble-bar'
import { RICH_TEXT_PROSE } from '@/features/documents/rich-text/rich-text-content'
import { RichTextLinkBubble } from '@/features/documents/rich-text/rich-text-link'
import {
  RICH_TEXT_BASIC_SLASH_ITEMS,
  RichTextSlashCommand,
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
import { cn } from '@/lib/cn'
import { TaskProperties } from '@/features/planning/task-properties'
import { trpc } from '@/lib/trpc'
import { sawText } from '@/state/doc-changes'
import { claimsAtom } from '@/state/plugins'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

import { AgentPrompt, AgentStatus } from './agent-prompt'
import { askAiSlashItem } from './ask-ai-slash'
import { artifactPathFor, isRunLive, locksDocument, useDocumentAgent } from './document-agent'
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
import { applyReload } from './apply-reload'
import { ErrorState } from '@/composites/empty-state'

// How long typing has to pause before the file is written.
const SAVE_DELAY_MS = 600

// The block drop line, as the rich-text block draws it.
const DROP_LINE =
  '[&_.prosemirror-dropcursor-block]:text-primary [&_.prosemirror-dropcursor-block]:h-0.5! [&_.prosemirror-dropcursor-block]:rounded-full'

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; head: string; body: string; text: string }
  | { kind: 'error'; message: string }

export function DocumentView({
  path,
  onOpen,
  onMoved,
}: {
  path: string
  /** Open a vault path in a tab: a linked note, or a finished artifact. */
  onOpen: (path: string) => void
  /** The document moved (a task given another project): follow it. */
  onMoved?: (from: string, to: string) => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const docs = useAtomValue(snapshotAtom).docs
  const mtime = docs.find((doc) => doc.path === path)?.updatedAt
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
    <DocumentEditor
      key={path}
      path={path}
      remote={remote}
      initial={load}
      mtime={mtime}
      docs={docs}
      onOpen={onOpen}
      onMoved={onMoved}
    />
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
}: {
  path: string
  remote: string
  initial: { head: string; body: string; text: string }
  mtime: string | undefined
  docs: readonly { path: string }[]
  onOpen: (path: string) => void
  onMoved?: (from: string, to: string) => void
}) {
  const agent = useDocumentAgent(path)
  const locked = locksDocument(agent.run)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [linkOpen, setLinkOpen] = useState(false)
  const [deleteTableOpen, setDeleteTableOpen] = useState(false)
  const [fullWidth, setFullWidth] = useState(false)
  const [smallText, setSmallText] = useState(false)
  const [promptBox] = useState(() => {
    const box = document.createElement('div')
    box.contentEditable = 'false'
    box.className = 'my-1'
    return box
  })
  const pageRef = useRef<HTMLDivElement>(null)
  /** The page's scroller, whose place a tab switch keeps. */
  const scrollerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const head = useRef(initial.head)
  /** The file as last read or written: what a change on disk is compared to. */
  const lastText = useRef(initial.text)
  const saveTimer = useRef<number | undefined>(undefined)

  // Callbacks the extensions hold, read through refs so the extensions are
  // made once per document.
  const handlers = useRef({
    openLink: (_target: string) => undefined as void,
    trigger: (_pos: number, _instruction?: string) => undefined as void,
    pressThread: (_id: string) => undefined as void,
    pluginItems: (): readonly RichTextSlashItem[] => [],
  })
  handlers.current.openLink = (target) => {
    const found = resolveLink(target, path, docs)
    if (found) onOpen(found)
  }

  const extensions = useMemo(
    () => [
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
          askAiSlashItem((pos) => handlers.current.trigger(pos)),
        ],
        more: () => handlers.current.pluginItems(),
      }),
    ],
    [path, promptBox],
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
        setSaveState('saving')
        window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS)
      },
    },
    [extensions],
  )

  const editable = useRichTextSelector(editor, (current) => current?.isEditable ?? true)

  const { promptOpen, promptInitial, closePrompt, sendPrompt, quickCommand, turnIntoArtifact } =
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

  useSelectionReport(editor, path, head)

  /** What the first claim on this path draws above it: a link's card. */
  const Banner = useAtomValue(claimsAtom).find(
    (claim) => claim.banner !== undefined && claim.match(path),
  )?.banner
  useDocumentPosition({ editor, remote, path, scrollerRef, markdown })

  const holiLinks = isHoliLinkable(path)
    ? {
        file: () => holiLink({ remote, path }),
        heading: () => {
          if (!editor) return null
          const heading = headingAtCaret(editor, markdown())
          return heading === null ? null : holiLink({ remote, path, heading })
        },
      }
    : null

  handlers.current.pressThread = comments.pressThread

  /** The document as it would be saved. */
  function markdown(): string {
    return editor ? joinDocument(head.current, editor.getMarkdown()) : lastText.current
  }

  async function save(): Promise<void> {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    if (!editor || editor.isDestroyed) return
    const text = markdown()
    if (text === lastText.current) {
      setSaveState('saved')
      return
    }
    try {
      await trpc.notes.write.mutate({ remote, path, text })
      lastText.current = text
      setSaveState('saved')
      placeRef.current()
    } catch {
      setSaveState('error')
    }
  }

  // Leaving the document writes what is pending, and leaves what it showed
  // for its tab to be compared to (`doc-changes.ts`).
  useEffect(
    () => () => {
      const pending = saveTimer.current !== undefined
      const live = editor !== null && !editor.isDestroyed
      sawText(remote, path, pending && live ? markdown() : lastText.current)
      if (pending) void save()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor],
  )

  // A change on disk comes back in, unless local edits are still pending.
  useEffect(() => {
    if (!editor || mtime === undefined) return
    let live = true
    void trpc.notes.read
      .query({ remote, path })
      .then((text) => {
        if (!live || editor.isDestroyed || text === lastText.current) return
        if (saveTimer.current !== undefined && !locked) return
        const next = splitDocument(text)
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
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Only a new mtime means the file may have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtime, editor])

  // A run that edits the document locks it; done, the lock lifts.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!locked)
  }, [editor, locked])

  // A finished edit clears its pill on its own; an artifact waits to be
  // opened or dismissed.
  useEffect(() => {
    const run = agent.run
    if (!run || run.status !== 'done' || run.kind === 'artifact') return
    const timer = window.setTimeout(agent.dismiss, 1500)
    return () => window.clearTimeout(timer)
  }, [agent.run, agent.dismiss])

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

  const { find, setFind, apple, isFindKey, openFind } = useDocumentFind(editor, viewRef)

  function handleViewKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!editor || event.defaultPrevented) return
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

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={viewRef}
        className="text-foreground relative flex h-full min-h-0 w-full flex-col"
        onKeyDown={handleViewKeyDown}
      >
        {/* Locked while a run edits the document: nothing in it answers. */}
        <div inert={locked} className="flex min-h-0 flex-1 flex-col">
          {/* On the page's own ground, a hairline under it; the text scrolls
              beneath the line, not under the header. */}
          <DocumentHeader
            editor={editor}
            path={path}
            title={documentTitle(path)}
            saveState={saveState}
            locked={locked}
            markdown={markdown}
            fullWidth={fullWidth}
            smallText={smallText}
            onFullWidthChange={setFullWidth}
            onSmallTextChange={setSmallText}
            onTurnIntoArtifact={canAsk ? () => void turnIntoArtifact() : null}
            holiLinks={holiLinks}
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
          <div className="flex min-h-0 flex-1">
            <div
              ref={scrollerRef}
              className="relative min-h-0 min-w-0 flex-1 overflow-y-auto"
              onMouseDown={pressPage}
            >
              {/* The find bar floats at the page's top right, over the text,
                and stays there as it scrolls. */}
              {editor && find ? (
                <div className="sticky top-2 z-40 flex h-0 items-start justify-end px-4">
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
              {/* A task's fields, on the body's column; nothing for a note. */}
              <TaskProperties
                path={path}
                beforeWrite={save}
                onMoved={onMoved}
                className={cn(
                  'mx-auto w-full px-4 pt-8 sm:px-16 sm:pt-12',
                  fullWidth ? 'max-w-none' : 'max-w-3xl',
                )}
              />
              <div ref={pageRef} className={cn('relative min-h-full', DROP_LINE)}>
                {editor ? (
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
                      RICH_TEXT_TABLE_PROSE,
                      'mx-auto w-full px-4 py-8 sm:px-16 sm:py-12',
                      fullWidth ? 'max-w-none' : 'max-w-3xl',
                      smallText && 'text-sm/6',
                      locked && 'opacity-60',
                    )}
                  />
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
                        canAsk ? (verb, passage) => void quickCommand(verb, passage) : null
                      }
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

        {agent.run ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
            <div className="pointer-events-auto">
              <AgentStatus
                run={agent.run}
                onStop={() => void agent.stop()}
                onDismiss={agent.dismiss}
                onOpenArtifact={() => {
                  agent.dismiss()
                  onOpen(artifactPathFor(path))
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
