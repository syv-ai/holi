/**
 * The vault, as rows.
 *
 * Driven entirely by the pushed snapshot: main walks the directory, pushes the
 * whole vault, and this projects it. Nothing here refetches, and nothing here
 * holds a second copy — a note that arrives by pull, by the agent, or from
 * another window simply appears.
 *
 * **Rename is deliberately absent**, as is the backref preview that used to run
 * before a delete. `notes.rename` is not in the router: a rename must move the
 * file *and* rewrite every inbound `[[wiki-link]]` in one pass (FR-11), and
 * shipping the move half alone would silently break every link pointing at it.
 * Backrefs are a grep now (FR-12), and the grep is not written. Both come back
 * together, with the procedure that makes them honest.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import { buildTree, type TreeNode } from '../lib/tree'
import { createNoteAtom, deleteNoteAtom, snapshotAtom } from '../state/vaults'

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
  const [open, setOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
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
        title="delete"
        className="ml-auto hidden shrink-0 px-1 pr-2 text-[10px] text-neutral-500 hover:text-red-400 group-hover:block"
        onClick={(e) => {
          e.stopPropagation()
          // No backref warning yet, and FR-12 wants one. Until the grep exists,
          // the confirm names the file and nothing else rather than implying a
          // check that did not happen.
          if (window.confirm(`Delete ${node.path}?`)) {
            void deleteNote(node.path).catch((err: unknown) =>
              setError(err instanceof Error ? err.message : String(err)),
            )
          }
        }}
      >
        ✕
      </span>
      {error && <p className="px-2 text-[10px] text-red-400">{error}</p>}
    </div>
  )
}
