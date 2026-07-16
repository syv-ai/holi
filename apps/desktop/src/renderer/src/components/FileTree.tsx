import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import { buildTree, renameTarget, type TreeNode } from '../lib/tree'
import {
  activeDocAtom,
  createNoteAtom,
  deleteNoteAtom,
  docsAtom,
  loadBackrefsAtom,
  renameFolderAtom,
  renameNoteAtom,
} from '../state/vaults'
import { openDocAtom } from '../state/view'

export function FileTree() {
  const { docs, folders } = useAtomValue(docsAtom)
  const tree = useMemo(() => buildTree(docs, folders), [docs, folders])
  const createNote = useSetAtom(createNoteAtom)
  const [newPath, setNewPath] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex gap-1 p-2"
        onSubmit={(e) => {
          e.preventDefault()
          const path = newPath.trim()
          if (!path) return
          setError(null)
          // Surfaced, not voided: `notes.create` rejects a taken path with CONFLICT, and
          // this used to swallow it — the row simply never appeared and nothing said why.
          void createNote(path.endsWith('.md') ? path : `${path}.md`)
            .then(() => setNewPath(''))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs"
          placeholder="new note path…"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
        />
        <button className="rounded bg-neutral-800 px-2 text-xs hover:bg-neutral-700">+</button>
      </form>
      {error && <p className="px-2 pb-1 text-xs text-red-400">{error}</p>}
      <div className="holi-scroll min-h-0 flex-1 overflow-y-auto px-1 pb-2 text-sm">
        {tree.map((node) => (
          <TreeRow key={node.path} node={node} depth={0} />
        ))}
        {tree.length === 0 && <p className="px-2 text-xs text-neutral-500">no notes yet</p>}
      </div>
    </div>
  )
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const openDoc = useSetAtom(openDocAtom)
  const activeDoc = useAtomValue(activeDocAtom)
  const { docs } = useAtomValue(docsAtom)
  const renameNote = useSetAtom(renameNoteAtom)
  const renameFolder = useSetAtom(renameFolderAtom)
  const deleteNote = useSetAtom(deleteNoteAtom)
  const loadBackrefs = useSetAtom(loadBackrefsAtom)
  const [open, setOpen] = useState(true)
  /** Non-null while renaming: the draft path. Inline, matching the create form above —
   * there is no modal primitive in this codebase and no context menu anywhere. */
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pad = { paddingLeft: `${depth * 12 + 8}px` }
  const target = renameTarget(node)

  const guard = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const submitRename = guard(async () => {
    const next = draft?.trim()
    if (!next || !target || next === node.path) return setDraft(null)
    // Rename IS move: a different folder prefix relocates it, and the server creates the
    // destination folders. The server rewrites every [[link]] either way.
    if (target.kind === 'note') await renameNote(target.docId, next.endsWith('.md') ? next : `${next}.md`)
    else await renameFolder(target.folderId, next)
    setDraft(null)
  })

  const onDelete = guard(async () => {
    if (node.kind !== 'doc') return
    // FR-12: what links here, BEFORE you decide. `notes.backrefs` has been built and
    // uncalled all along. D27 means no cascade — those links will dangle on purpose.
    const refs = await loadBackrefs(node.path)
    const links = refs.length
      ? `\n\n${refs.length === 1 ? '1 note links' : `${refs.length} notes link`} here and will be left ` +
        `pointing at nothing:\n` +
        refs.map((r) => `  • ${r.path}${r.occurrences > 1 ? ` (${r.occurrences}×)` : ''}`).join('\n')
      : ''
    if (window.confirm(`Delete ${node.path}?${links}`)) await deleteNote(node.docId)
  })

  if (draft !== null) {
    return (
      <form
        style={pad}
        className="px-1 py-0.5"
        onSubmit={(e) => {
          e.preventDefault()
          void submitRename()
        }}
      >
        <input
          autoFocus
          disabled={busy}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
          onBlur={() => setDraft(null)}
        />
        {error && <p className="pt-0.5 text-[10px] text-red-400">{error}</p>}
      </form>
    )
  }

  /** Hover-revealed, because there is no context-menu primitive in this renderer. */
  const actions = (
    <span className="ml-auto hidden shrink-0 gap-1 pr-1 group-hover:flex">
      {target && (
        <span
          role="button"
          title="rename"
          className="rounded px-1 text-[10px] text-neutral-500 hover:text-neutral-200"
          onClick={(e) => {
            e.stopPropagation()
            setDraft(node.path)
          }}
        >
          ✎
        </span>
      )}
      {node.kind === 'doc' && (
        <span
          role="button"
          title="delete"
          className="rounded px-1 text-[10px] text-neutral-500 hover:text-red-400"
          onClick={(e) => {
            e.stopPropagation()
            void onDelete()
          }}
        >
          ✕
        </span>
      )}
    </span>
  )

  if (node.kind === 'folder') {
    return (
      <div>
        <div
          className="group flex items-center rounded text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          style={pad}
        >
          <button className="min-w-0 flex-1 truncate py-0.5 text-left" onClick={() => setOpen((o) => !o)}>
            {open ? '▾' : '▸'} {node.name}
          </button>
          {actions}
        </div>
        {error && <p className="px-2 text-[10px] text-red-400">{error}</p>}
        {open && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }

  const isActive = activeDoc?.id === node.docId
  return (
    <div
      // The open note is marked here, not only in the header — the tree is where you look
      // to know where you are. Hover lands a step below the active row so the two read as
      // the same scale of emphasis rather than competing.
      className={`group flex items-center rounded transition-colors ${
        isActive
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100'
      }`}
      style={pad}
    >
      <button
        className="min-w-0 flex-1 truncate py-0.5 text-left"
        onClick={() => {
          const doc = docs.find((d) => d.id === node.docId)
          // openDoc, not setActiveDoc: from the board, setting the doc alone left the board
          // on screen and the click looked broken.
          if (doc) openDoc(doc)
        }}
      >
        {node.name}
      </button>
      {actions}
      {error && <p className="px-2 text-[10px] text-red-400">{error}</p>}
    </div>
  )
}
