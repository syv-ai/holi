import { useAtomValue, useSetAtom } from 'jotai'
import { useMemo, useState } from 'react'
import { buildTree, type TreeNode } from '../lib/tree'
import { activeDocAtom, createNoteAtom, docsAtom } from '../state/vaults'
import { openDocAtom } from '../state/view'

export function FileTree() {
  const { docs, folders } = useAtomValue(docsAtom)
  const tree = useMemo(() => buildTree(docs, folders), [docs, folders])
  const createNote = useSetAtom(createNoteAtom)
  const [newPath, setNewPath] = useState('')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex gap-1 p-2"
        onSubmit={(e) => {
          e.preventDefault()
          const path = newPath.trim()
          if (path) {
            void createNote(path.endsWith('.md') ? path : `${path}.md`)
            setNewPath('')
          }
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
  const [open, setOpen] = useState(true)
  const pad = { paddingLeft: `${depth * 12 + 8}px` }

  if (node.kind === 'folder') {
    return (
      <div>
        <button
          className="block w-full truncate rounded px-1 py-0.5 text-left text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          style={pad}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '▾' : '▸'} {node.name}
        </button>
        {open && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} />)}
      </div>
    )
  }
  const isActive = activeDoc?.id === node.docId
  return (
    <button
      // The open note is marked here, not only in the header — the tree is where you look
      // to know where you are. Hover lands a step below the active row so the two read as
      // the same scale of emphasis rather than competing.
      className={`block w-full truncate rounded px-1 py-0.5 text-left transition-colors ${
        isActive
          ? 'bg-neutral-800 text-neutral-100'
          : 'text-neutral-300 hover:bg-neutral-800/60 hover:text-neutral-100'
      }`}
      style={pad}
      onClick={() => {
        const doc = docs.find((d) => d.id === node.docId)
        // openDoc, not setActiveDoc: from the board, setting the doc alone left the board
        // on screen and the click looked broken.
        if (doc) openDoc(doc)
      }}
    >
      {node.name}
    </button>
  )
}
