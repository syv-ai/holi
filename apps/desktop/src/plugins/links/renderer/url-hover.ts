/**
 * The editor's hover over a web address, in any note: a markdown link
 * (`[text](https://…)` or `<https://…>`), a bare `https://…`, or a wiki-link
 * to a saved link file. It shows the page's card (`PreviewCard`).
 *
 * The address is read off the syntax tree, not the drawn link, so a bare
 * address that live preview leaves as text has a card too, and one inside
 * code never does (code has no `URL` node).
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { hoverTooltip, type Tooltip } from '@codemirror/view'
import { parseWikiLinks } from '@holi/shared'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { linkChipFacet } from '@/plugin-api'
import { isWebUrl } from '../shared/preview'
import { PreviewCard } from './PreviewCard'

interface Found {
  from: number
  to: number
  url: string
  /** What the vault calls it: a saved link's name. */
  title?: string
}

/** The web address of the markdown link under `pos`, if there is one. */
function markdownUrlAt(state: EditorState, pos: number): Found | null {
  for (let node = syntaxTree(state).resolveInner(pos, 1); ;) {
    // An image's address is the image, which the editor draws.
    if (node.name === 'Image') return null
    if (node.name === 'URL') {
      if (node.parent?.name === 'Image') return null
      const url = state.sliceDoc(node.from, node.to)
      // A bare one is its own node; one in a link belongs to the whole link.
      const owner =
        node.parent?.name === 'Link' || node.parent?.name === 'Autolink' ? node.parent : node
      return isWebUrl(url) ? { from: owner.from, to: owner.to, url } : null
    }
    if (node.name === 'Link' || node.name === 'Autolink') {
      const child = node.getChild('URL')
      const url = child === null ? '' : state.sliceDoc(child.from, child.to)
      return isWebUrl(url) ? { from: node.from, to: node.to, url } : null
    }
    if (node.parent === null) return null
    node = node.parent
  }
}

/** The saved link a wiki-link under `pos` points at, if it is one. */
function savedLinkAt(state: EditorState, pos: number): Found | null {
  const line = state.doc.lineAt(pos)
  const rel = pos - line.from
  const link = parseWikiLinks(line.text).find((l) => rel >= l.start && rel <= l.end)
  if (link === undefined) return null
  const chip = state.facet(linkChipFacet)(link.target)
  if (chip?.url === undefined) return null
  return {
    from: line.from + link.start,
    to: line.from + link.end,
    url: chip.url,
    title: chip.title,
  }
}

function card(found: Found): Tooltip {
  return {
    pos: found.from,
    end: found.to,
    above: true,
    create: () => {
      const dom = document.createElement('div')
      // The popover's surface: CodeMirror's hover shell is transparent.
      dom.className =
        'overflow-hidden rounded-2xl bg-popover text-popover-foreground shadow-popover'
      const root = createRoot(dom)
      root.render(
        createElement(PreviewCard, {
          url: found.url,
          floating: true,
          ...(found.title === undefined ? {} : { title: found.title }),
        }),
      )
      // Unmounted after CodeMirror's own update, never inside a render.
      return { dom, destroy: () => queueMicrotask(() => root.unmount()) }
    },
  }
}

export const urlHover: Extension = hoverTooltip(
  (view, pos) => {
    const found = savedLinkAt(view.state, pos) ?? markdownUrlAt(view.state, pos)
    return found === null ? null : card(found)
  },
  { hoverTime: 300 },
)
