/**
 * Draws every open find bar, wherever its editor is.
 *
 * Mounted once, in the app shell, like `FrontmatterFieldsHost`: each editor's
 * search panel publishes an empty container to `editor/find.ts`, and this
 * renders the bar into it through `createPortal`, inside the app's one React
 * tree. The bar only drives CodeMirror's search; the query, the matches and
 * their highlighting stay CodeMirror's.
 */
import { useLayoutEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react'
import { findPortals, setFindReplace, subscribeFindPortals, type FindPortal } from '@/editor/find'
import { playOnce } from '@/lib/motion'
import { Button } from '@/primitives/Button'
import { IconButton } from '@/primitives/IconButton'
import { Input } from '@/primitives/Input'

/** Counting stops here; a note with more matches says "999+". */
const COUNT_CAP = 999

/** How many matches, and which one the selection is on (0 when none). */
function matchPosition(state: EditorState, query: SearchQuery): { index: number; total: number } {
  if (!query.valid) return { index: 0, total: 0 }
  const { from, to } = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let index = 0
  for (let r = cursor.next(); !r.done && total < COUNT_CAP + 1; r = cursor.next()) {
    total++
    if (r.value.from === from && r.value.to === to) index = total
  }
  return { index, total }
}

function countLabel(
  query: SearchQuery,
  { index, total }: { index: number; total: number },
): string {
  if (query.search === '') return ''
  if (total === 0) return 'No results'
  const of = total > COUNT_CAP ? `${COUNT_CAP}+` : String(total)
  return index === 0 ? of : `${index} of ${of}`
}

/** Select the first match at or after the caret, wrapping, as the query is typed. */
function selectNearest(view: EditorView, query: SearchQuery): void {
  if (!query.valid) return
  const from = view.state.selection.main.from
  let r = query.getCursor(view.state, from).next()
  if (r.done) r = query.getCursor(view.state).next()
  if (r.done) return
  view.dispatch({
    selection: { anchor: r.value.from, head: r.value.to },
    effects: EditorView.scrollIntoView(r.value.from, { y: 'center' }),
    userEvent: 'select.search',
  })
}

function FindBar({ portal }: { portal: FindPortal }): React.JSX.Element {
  const { view, replace } = portal
  const find = useRef<HTMLInputElement>(null)
  const query = getSearchQuery(view.state)
  const position = matchPosition(view.state, query)
  const readOnly = view.state.readOnly

  useLayoutEffect(() => {
    playOnce(portal.el, 'motion-in-fade')
    find.current?.focus()
    find.current?.select()
  }, [portal.el])

  const setQuery = (patch: { search?: string; replace?: string }): SearchQuery => {
    const next = new SearchQuery({
      search: query.search,
      replace: query.replace,
      caseSensitive: query.caseSensitive,
      literal: query.literal,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
      ...patch,
    })
    view.dispatch({ effects: setSearchQuery.of(next) })
    return next
  }

  // CodeMirror listens for keys on its content, not on a panel, so the find
  // keys (⌘G, F3, Escape, ⌘⌥F) are replayed in the scope `findKeymap` gives
  // them. Enter steps, as in CodeMirror's own panel.
  const onFindKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (runScopeHandlers(view, e.nativeEvent, 'search-panel')) {
      e.preventDefault()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) findPrevious(view)
      else findNext(view)
    }
  }

  const onReplaceKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (runScopeHandlers(view, e.nativeEvent, 'search-panel')) {
      e.preventDefault()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (e.metaKey || e.ctrlKey) replaceAll(view)
      else replaceNext(view)
    }
  }

  const label = countLabel(query, position)

  return createPortal(
    <div className="flex w-80 flex-col gap-1 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-popover">
      <div className="flex items-center gap-1">
        {!readOnly && (
          <IconButton
            icon={Replace}
            label="Replace"
            tooltip="Replace (⌘⌥F)"
            pressed={replace}
            onClick={() => setFindReplace(view, !replace)}
          />
        )}
        <Input
          ref={find}
          main-field="true"
          aria-label="Find"
          placeholder="Find"
          className="h-7 flex-1 px-2 md:text-xs"
          value={query.search}
          onChange={(e) => selectNearest(view, setQuery({ search: e.target.value }))}
          onKeyDown={onFindKey}
        />
        <span className="min-w-14 text-right text-xs tabular-nums text-muted-foreground">
          {label}
        </span>
        <IconButton
          icon={ChevronUp}
          label="Previous match"
          tooltip="Previous match (⇧↵)"
          onClick={() => findPrevious(view)}
        />
        <IconButton
          icon={ChevronDown}
          label="Next match"
          tooltip="Next match (↵)"
          onClick={() => findNext(view)}
        />
        <IconButton
          icon={X}
          label="Close"
          tooltip="Close (Esc)"
          onClick={() => closeSearchPanel(view)}
        />
      </div>
      {replace && !readOnly && (
        <div className="flex items-center gap-1 pl-7">
          <Input
            aria-label="Replace with"
            placeholder="Replace with"
            className="h-7 flex-1 px-2 md:text-xs"
            value={query.replace}
            onChange={(e) => setQuery({ replace: e.target.value })}
            onKeyDown={onReplaceKey}
          />
          <Button variant="ghost" size="xs" onClick={() => replaceNext(view)}>
            Replace
          </Button>
          <Button variant="ghost" size="xs" onClick={() => replaceAll(view)}>
            All
          </Button>
        </div>
      )}
    </div>,
    portal.el,
  )
}

export function FindBarHost(): React.JSX.Element {
  const portals = useSyncExternalStore(subscribeFindPortals, findPortals)
  return (
    <>
      {portals.map((portal) => (
        <FindBar key={portal.id} portal={portal} />
      ))}
    </>
  )
}
