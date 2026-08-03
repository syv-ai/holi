/**
 * Hover preview for wiki-links (notes-editor PRD FR-6). A `hoverTooltip` that finds
 * the `[[path]]` under the cursor (rendered chip or raw text — both are the same
 * token to `parseWikiLinks`) and shows a card: a task's status orb + title + due
 * from the task store, or a note's title + first lines read fresh, or a
 * "doesn't exist yet" line for a missing target.
 *
 * Note content is read on each hover rather than cached — a hover fires once per
 * settle, and reading fresh matches the app's no-index ethos (a stale peek would be
 * a small lie). Task data is already in the snapshot, so those need no read.
 */
import type { EditorState, Extension } from '@codemirror/state'
import { hoverTooltip, type Tooltip } from '@codemirror/view'
import { fileKind, parseWikiLinks } from '@holi/shared'
import { docExistsFacet, taskByPathFacet } from './livePreview'
import { noteTitleFromPath, previewFromMarkdown } from './notePreview'

/** Reads a note's text by vault-relative path; resolves null when it is not there. */
export type ReadNote = (path: string) => Promise<string | null>

function lineEl(text: string, className: string): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

function card(children: HTMLElement[]): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-wiki-preview'
  for (const c of children) el.appendChild(c)
  return el
}

async function buildPreview(
  state: EditorState,
  target: string,
  readNote: ReadNote,
): Promise<HTMLElement | null> {
  // A task: title + orb + due, straight from the store — no read.
  const task = state.facet(taskByPathFacet)(target)
  if (task) {
    const title = document.createElement('div')
    title.className = 'cm-wiki-preview-title'
    const orb = document.createElement('span')
    orb.className = `cm-task-orb cm-task-orb-${task.status}`
    title.appendChild(orb)
    title.appendChild(document.createTextNode(task.title))
    const meta = task.due ? `${task.status} · due ${task.due}` : task.status
    return card([title, lineEl(meta, 'cm-wiki-preview-meta')])
  }
  // A note we do not have is a missing target — never read to find that out.
  if (!state.facet(docExistsFacet)(target)) {
    return card([lineEl("This note doesn't exist yet.", 'cm-wiki-preview-meta')])
  }
  const text = await readNote(target)
  if (text === null) {
    return card([lineEl("This note doesn't exist yet.", 'cm-wiki-preview-meta')])
  }
  const { title, lines } = previewFromMarkdown(text)
  const head = lineEl(title ?? noteTitleFromPath(target), 'cm-wiki-preview-title')
  return card([head, ...lines.map((l) => lineEl(l, 'cm-wiki-preview-line'))])
}

export function wikiHoverPreview(readNote: ReadNote): Extension {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos)
      const rel = pos - line.from
      // A wiki-link body never spans lines, so the hovered line is the whole search.
      const link = parseWikiLinks(line.text).find((l) => rel >= l.start && rel <= l.end)
      // An image embed renders as the image, not a chip — nothing to preview.
      if (!link || fileKind(link.target) === 'image') return null
      const from = line.from + link.start
      const to = line.from + link.end
      const { target } = link
      return (async (): Promise<Tooltip | null> => {
        const dom = await buildPreview(view.state, target, readNote)
        return dom ? { pos: from, end: to, above: true, create: () => ({ dom }) } : null
      })()
    },
    { hoverTime: 300 },
  )
}
