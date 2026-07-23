/**
 * The vault, as rows.
 *
 * Driven entirely by the pushed snapshot: main walks the directory, pushes the
 * whole vault, and this projects it. Nothing here refetches, and nothing here
 * holds a second copy — a note that arrives by pull, by the agent, or from
 * another window simply appears.
 *
 * **Rename** moves the file and rewrites inbound `[[links]]` in one pass (FR-11,
 * `renameNoteAtom`); **delete** first previews what links here (FR-12,
 * `backrefsFor`) so it can name what it will turn into tombstones. Both use an
 * inline/in-app surface rather than `window.prompt`/`confirm`: Electron's
 * Chromium does not support `prompt`, and the delete preview has a list to show
 * that a native confirm cannot.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import { buildTree, type TreeNode } from '../lib/tree'
import { backrefsFor, createNoteAtom, deleteNoteAtom, renameNoteAtom, snapshotAtom } from '../state/vaults'

export function FileTree({
  activePath,
  onOpen,
}: {
  activePath: string | null
  onOpen: (path: string) => void
}) {
  const snapshot = useAtomValue(snapshotAtom)
  const tree = useMemo(() => buildTree(snapshot.docs.map((d) => d.path)), [snapshot])
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
          // Surfaced, not voided: `notes.create` refuses a taken path with
          // CONFLICT rather than clobbering it, and swallowing that leaves a row
          // that never appears and nothing saying why.
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
          <TreeRow key={node.path} node={node} depth={0} activePath={activePath} onOpen={onOpen} />
        ))}
        {tree.length === 0 && <p className="px-2 text-xs text-neutral-500">no notes yet</p>}
      </div>
    </div>
  )
}

function TreeRow({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: TreeNode
  depth: number
  activePath: string | null
  onOpen: (path: string) => void
}) {
  const deleteNote = useSetAtom(deleteNoteAtom)
  const renameNote = useSetAtom(renameNoteAtom)
  const getBackrefs = useSetAtom(backrefsFor)
  const [open, setOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  // null = no dialog open; an array (possibly empty) = "confirm deleting, and
  // here is what links to it". FR-12: the warning is the list, not just a Y/N.
  const [confirming, setConfirming] = useState<{ path: string; count: number }[] | null>(null)
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.kind === 'folder') {
    return (
      <div>
        <div
          className="group flex items-center rounded text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          style={pad}
        >
          <button
            className="min-w-0 flex-1 truncate py-0.5 text-left"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? '▾' : '▸'} {node.name}
          </button>
        </div>
        {open &&
          node.children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
          ))}
      </div>
    )
  }

  const isActive = activePath === node.path

  const submitRename = () => {
    const raw = renameValue.trim()
    const to = raw.endsWith('.md') ? raw : `${raw}.md`
    setRenaming(false)
    if (!raw || to === node.path) return
    setError(null)
    void renameNote({ from: node.path, to }).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }

  if (renaming) {
    return (
      <form
        style={pad}
        className="flex py-0.5"
        onSubmit={(e) => {
          e.preventDefault()
          submitRename()
        }}
      >
        <input
          // rename-to-path IS move: a different folder prefix relocates the note.
          autoFocus
          data-rename-input={node.path}
          className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 text-sm"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
          onBlur={() => setRenaming(false)}
        />
      </form>
    )
  }

  return (
    <div
      // The open note is marked here, not only in the header — the tree is
      // where you look to know where you are. Hover sits a step below the
      // active row so the two read as one scale of emphasis, not a competition.
      className={`group flex items-center rounded transition-colors ${
        isActive
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100'
      }`}
      style={pad}
    >
      <button
        className="min-w-0 flex-1 truncate py-0.5 text-left"
        onClick={() => onOpen(node.path)}
      >
        {node.name}
      </button>
      <span
        role="button"
        title="rename"
        data-rename={node.path}
        className="hidden shrink-0 px-1 text-[10px] text-neutral-500 hover:text-neutral-200 group-hover:block"
        onClick={(e) => {
          e.stopPropagation()
          setRenameValue(node.path)
          setRenaming(true)
        }}
      >
        ✎
      </span>
      <span
        role="button"
        title="delete"
        data-delete={node.path}
        className="hidden shrink-0 px-1 pr-2 text-[10px] text-neutral-500 hover:text-red-400 group-hover:block"
        onClick={(e) => {
          e.stopPropagation()
          setError(null)
          // Look before you leap: name what links here so the delete is an
          // informed one (FR-12). Dangling refs survive as tombstones — no
          // cascade — but the user gets to see them first.
          void getBackrefs(node.path)
            .then((refs) => setConfirming(refs))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        }}
      >
        ✕
      </span>
      {error && <p className="px-2 text-[10px] text-red-400">{error}</p>}
      {confirming !== null && (
        <DeleteConfirm
          path={node.path}
          refs={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null)
            void deleteNote(node.path).catch((err: unknown) =>
              setError(err instanceof Error ? err.message : String(err)),
            )
          }}
        />
      )}
    </div>
  )
}

/**
 * The FR-12 delete preview: name every file that links here and how many times,
 * so deleting is a decision with the tombstones-to-be in view. An in-app dialog
 * rather than `window.confirm` — the warning is a list, and Electron's native
 * confirm cannot render one.
 */
function DeleteConfirm({
  path,
  refs,
  onCancel,
  onConfirm,
}: {
  path: string
  refs: { path: string; count: number }[]
  onCancel: () => void
  onConfirm: () => void
}) {
  const total = refs.reduce((n, r) => n + r.count, 0)
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        data-delete-dialog={path}
        className="w-80 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2">
          Delete <span className="font-mono text-neutral-100">{path}</span>?
        </p>
        {refs.length === 0 ? (
          <p className="mb-3 text-xs text-neutral-500">Nothing links to it.</p>
        ) : (
          <div className="mb-3">
            <p className="mb-1 text-xs text-neutral-400">
              {total} link{total === 1 ? '' : 's'} in {refs.length} file
              {refs.length === 1 ? '' : 's'} will be left dangling (they become tombstones — no
              cascade):
            </p>
            <ul className="max-h-40 overflow-y-auto text-xs">
              {refs.map((r) => (
                <li key={r.path} className="flex justify-between font-mono text-neutral-300">
                  <span className="truncate">{r.path}</span>
                  <span className="ml-2 shrink-0 text-neutral-500">×{r.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            data-delete-confirm={path}
            className="rounded bg-red-900/60 px-2 py-1 text-xs text-red-200 hover:bg-red-900"
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
