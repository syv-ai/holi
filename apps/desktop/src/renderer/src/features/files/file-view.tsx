/**
 * A vault file that is not a note or an app, opened in a tab. A plugin that
 * claims the path with a view shows it (PDF, a community plugin's files);
 * otherwise `fileKind` decides: an image in an image view, an office document
 * in a placeholder, and anything else, css, yaml, json, `.gitignore` or `.env`,
 * as code, editable on arrival like a note.
 *
 * Code is the plain CodeMirror editor (`plainTextExtensions`) dressed as
 * ReUI's code block, its Shiki colours and its measures (`codeLook`), with
 * line numbers. It saves like a note: shortly after the last
 * keystroke, the file whole. A json or yaml file that does not parse is not
 * saved until it does (`syntaxValid`; the editor's own strip says why), so a
 * half-typed settings file never reaches the vault. Its header carries the
 * latest commit and History, the same as a document's (`FileHistoryButton`).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fileKind } from '@holi/shared'
import { EditorState } from '@codemirror/state'
import { findNext, findPrevious } from '@codemirror/search'
import { EditorView, highlightActiveLineGutter, lineNumbers } from '@codemirror/view'
import { useAtomValue, useSetAtom } from 'jotai'
import { FileTextIcon } from 'lucide-react'

import { ViewHeader, ViewHeaderTitle } from '@/composites/view-header'
import { Skeleton } from '@/components/ui/skeleton'
import { plainTextExtensions } from '@/editor/extensions'
import { syntaxValid } from '@/editor/languages'
import { trpc } from '@/lib/trpc'
import { vaultAssetUrl } from '@/lib/vault-asset'
import { sawText } from '@/state/doc-changes'
import { editorSelectionAtom } from '@/state/ui-report'
import { useViewMemory } from '@/state/view-memory'
import { claimsAtom } from '@/state/plugins'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

import { FileHistoryButton } from '../history/file-history-button'
import type { FindCount, FindRequest } from '../../composites/find-bar'
import { codeFind, codeFindCount } from './code-find'
import { CodeFindBar } from './code-find-bar'
import { codeLook } from './code-look'
import { EmptyState, ErrorState } from '@/composites/empty-state'
import { basename } from '@/lib/tree-paths'

function FileHeader({
  path,
  status,
  actions,
}: {
  path: string
  status?: string
  actions?: ReactNode
}) {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  return (
    <ViewHeader>
      <ViewHeaderTitle
        title={basename(path)}
        meta={
          folder === null && status === undefined ? undefined : (
            <>
              {folder !== null ? <span className="truncate">{folder}</span> : null}
              {folder !== null && status !== undefined ? (
                <span
                  aria-hidden="true"
                  className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
                />
              ) : null}
              {status !== undefined ? (
                <span aria-live="polite" className="shrink-0">
                  {status}
                </span>
              ) : null}
            </>
          )
        }
      />
      {actions}
    </ViewHeader>
  )
}

type SaveState = 'saved' | 'saving' | 'held' | 'error'

/** How long after the last keystroke a text file is written. */
const SAVE_DELAY_MS = 600

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  held: 'Not saved until it parses',
  error: 'Not saved',
}

type Load =
  { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; text: string }

function FileLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-6 sm:px-6" role="status" aria-label={label}>
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-2/5" />
    </div>
  )
}

function FileError({
  title,
  message,
  onRetry,
}: {
  title: string
  message: string
  onRetry: () => void
}) {
  return <ErrorState title={title} message={message} onRetry={onRetry} />
}

/**
 * The file in CodeMirror, saving as it is typed. `text` is the file as the
 * view last knew it; a change on disk arrives through it and replaces the
 * document unless local edits are still pending, which win. ⌘F opens the
 * find bar over the text (`code-find-bar.tsx`), seeded with the selection
 * when it is one line; ⌘G and ⇧⌘G step from the text too while it is open.
 */
function TextEditor({
  path,
  text,
  onSaved,
  onSaveState,
}: {
  path: string
  text: string
  onSaved: (text: string) => void
  onSaveState: (state: SaveState) => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lastText = useRef(text)
  const saveTimer = useRef<number | undefined>(undefined)
  const callbacks = useRef({ onSaved, onSaveState })
  callbacks.current = { onSaved, onSaveState }
  const [view, setView] = useState<EditorView | null>(null)
  /** The find bar, open while set; a new request refocuses it. */
  const [find, setFind] = useState<FindRequest | null>(null)
  const [count, setCount] = useState<FindCount>({ total: 0, current: null })
  const setEditorSelection = useSetAtom(editorSelectionAtom)
  const reportSelection = useRef(setEditorSelection)
  reportSelection.current = setEditorSelection
  const memory = useViewMemory()

  useEffect(() => {
    const host = hostRef.current
    if (host === null || remote === null) return
    // Where this file was left, when it was open before: the caret clamped
    // to the text as it is now.
    const spot = memory.get(remote, path)
    const length = lastText.current.length
    const clamp = (at: number) => Math.min(Math.max(at, 0), length)

    async function save(view: EditorView) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = undefined
      const next = view.state.doc.toString()
      if (next === lastText.current) return callbacks.current.onSaveState('saved')
      if (!syntaxValid(path, next)) return callbacks.current.onSaveState('held')
      callbacks.current.onSaveState('saving')
      try {
        await trpc.notes.write.mutate({ remote: remote!, path, text: next })
        lastText.current = next
        callbacks.current.onSaved(next)
        callbacks.current.onSaveState('saved')
      } catch {
        callbacks.current.onSaveState('error')
      }
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: lastText.current,
        selection:
          spot === undefined ? undefined : { anchor: clamp(spot.anchor), head: clamp(spot.head) },
        extensions: [
          // The code block's look: no soft wrap, as in the block.
          ...plainTextExtensions(path).filter((extension) => extension !== EditorView.lineWrapping),
          lineNumbers(),
          highlightActiveLineGutter(),
          ...codeLook(path),
          codeFind(),
          EditorView.updateListener.of((update) => {
            const next = codeFindCount(update.state)
            setCount((was) =>
              was.total === next.total && was.current === next.current ? was : next,
            )
            if (update.selectionSet) {
              const { anchor, head } = update.state.selection.main
              memory.note(remote, path, { anchor, head })
              // The lines selected, for the agent's per-turn context; a
              // caret clears what this file reported, never another's.
              const { from, to } = update.state.selection.main
              const doc = update.state.doc
              const start = doc.lineAt(from)
              const end = doc.lineAt(to)
              const endLine =
                to > from && to === end.from && end.number > start.number
                  ? end.number - 1
                  : end.number
              reportSelection.current((was) => {
                if (from === to) return was?.path === path ? null : was
                const same =
                  was?.path === path &&
                  was.lines.startLine === start.number &&
                  was.lines.endLine === endLine
                return same ? was : { path, lines: { startLine: start.number, endLine } }
              })
            }
            if (!update.docChanged) return
            window.clearTimeout(saveTimer.current)
            saveTimer.current = window.setTimeout(() => void save(update.view), SAVE_DELAY_MS)
          }),
        ],
      }),
    })
    viewRef.current = view
    setView(view)
    const scroller = view.scrollDOM
    if (spot !== undefined) {
      scroller.scrollTop = spot.scrollTop
      // Again once the editor has measured, should it not have yet.
      requestAnimationFrame(() => {
        scroller.scrollTop = spot.scrollTop
      })
    }
    const noteScroll = () => memory.note(remote, path, { scrollTop: scroller.scrollTop })
    scroller.addEventListener('scroll', noteScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', noteScroll)
      // Leaving the editor writes what is pending, and leaves what it showed
      // for its tab to be compared to (`doc-changes.ts`).
      sawText(remote, path, view.state.doc.toString())
      if (saveTimer.current !== undefined) void save(view)
      view.destroy()
      viewRef.current = null
      setView(null)
      setFind(null)
    }
  }, [remote, path, memory])

  // A change on disk comes back in, unless local edits are still pending.
  useEffect(() => {
    const view = viewRef.current
    if (view === null || text === lastText.current) return
    if (saveTimer.current !== undefined) return
    lastText.current = text
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    })
  }, [text])

  function openFind() {
    const current = viewRef.current
    if (current === null) return
    const { from, to } = current.state.selection.main
    const selected = current.state.sliceDoc(from, to)
    const text = from < to && !selected.includes('\n') ? selected : null
    setFind((was) => ({ token: (was?.token ?? 0) + 1, text }))
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = viewRef.current
    if (current === null || event.defaultPrevented) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && !event.altKey && !event.shiftKey && key === 'f') {
      event.preventDefault()
      openFind()
    } else if (find && mod && !event.altKey && key === 'g') {
      event.preventDefault()
      if (event.shiftKey) findPrevious(current)
      else findNext(current)
    } else if (find && event.key === 'Escape' && current.hasFocus) {
      event.preventDefault()
      setFind(null)
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" onKeyDown={handleKeyDown}>
      {view && find ? (
        <div className="absolute top-2 right-4 z-40">
          <CodeFindBar view={view} request={find} count={count} onClose={() => setFind(null)} />
        </div>
      ) : null}
      <div
        ref={hostRef}
        data-file-editor={path}
        className="min-h-0 flex-1 overflow-auto px-2 py-2 sm:px-4 [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
      />
    </div>
  )
}

function TextFileView({ path }: { path: string }) {
  const remote = useAtomValue(activeRemoteAtom)
  const mtime = useAtomValue(snapshotAtom).files.find((file) => file.path === path)?.updatedAt
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')

  useEffect(() => {
    if (remote === null) return
    let live = true
    setLoad({ kind: 'loading' })
    trpc.notes.read
      .query({ remote, path })
      .then((text) => live && setLoad({ kind: 'ready', text }))
      .catch(
        (err: unknown) =>
          live &&
          setLoad({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          }),
      )
    return () => {
      live = false
    }
  }, [remote, path, attempt])

  // A change on disk (a pull, the agent) is read back in; the editor decides
  // whether its pending edits keep it out.
  const ready = load.kind === 'ready'
  useEffect(() => {
    if (!ready || remote === null || mtime === undefined) return
    let live = true
    trpc.notes.read
      .query({ remote, path })
      .then(
        (text) =>
          live &&
          setLoad((current) =>
            current.kind === 'ready' && current.text === text ? current : { kind: 'ready', text },
          ),
      )
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Read again when the file's time moves, not when the load lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtime, remote, path])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileHeader
        path={path}
        status={ready ? SAVE_LABEL[saveState] : undefined}
        actions={<FileHistoryButton path={path} />}
      />
      {load.kind === 'error' ? (
        <FileError
          title="This file could not be opened"
          message={load.message}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : load.kind === 'loading' ? (
        <FileLoading label="Loading file" />
      ) : (
        <TextEditor
          path={path}
          text={load.text}
          onSaved={(text) => setLoad({ kind: 'ready', text })}
          onSaveState={setSaveState}
        />
      )}
    </div>
  )
}

function ImageFileView({ path }: { path: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileHeader path={path} />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <img
          src={vaultAssetUrl(path)}
          alt={basename(path)}
          className="max-h-full max-w-full rounded-md object-contain outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        />
      </div>
    </div>
  )
}

/** A rich format nothing here renders, an office document or a PDF with its
 *  plugin off. It stays in the vault and syncs; there is deliberately no
 *  "open elsewhere", so the file is not edited outside the vault's history. */
function UnviewableFile({ path }: { path: string }) {
  const kind = fileKind(path)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileHeader path={path} />
      <EmptyState
        icon={FileTextIcon}
        title={basename(path)}
        description={
          kind === 'pdf'
            ? 'Turn on the PDF plugin in Settings to read PDFs here.'
            : "Holi can't show this kind of document yet. It stays in the vault and syncs."
        }
      />
    </div>
  )
}

export function FileView({ path }: { path: string }) {
  const claims = useAtomValue(claimsAtom)
  const Claimed = claims.find((claim) => claim.view !== undefined && claim.match(path))?.view
  if (Claimed !== undefined) return <Claimed path={path} />

  const kind = fileKind(path)
  if (kind === 'image') return <ImageFileView key={path} path={path} />
  if (kind === 'doc' || kind === 'pdf') return <UnviewableFile path={path} />
  return <TextFileView key={path} path={path} />
}
