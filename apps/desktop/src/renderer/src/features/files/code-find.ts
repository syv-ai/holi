/**
 * Find in a code file: CodeMirror's own search (`@codemirror/search`) holds
 * the query and steps and replaces through it, while the bar is ours
 * (`composites/find-bar.tsx`), so its panel never opens. Its highlighter draws
 * only with that panel open, so the matches are drawn here instead, every
 * match a quiet tint and the one the selection is on a stronger one, in the
 * find tokens the document's find uses.
 */
import { getSearchQuery, search, SearchQuery, setSearchQuery } from '@codemirror/search'
import {
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

import type { FindCount, FindOptions } from '../../composites/find-bar'

/** As many matches as the count says exactly; past it, "1000+" would lie
 *  less than a slow keystroke. */
const COUNT_LIMIT = 1000

export function codeQuery(options: FindOptions): SearchQuery {
  return new SearchQuery({
    search: options.search,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    regexp: options.regexp,
    replace: options.replace,
    // A typed `\n` is two characters, not a line break.
    literal: true,
  })
}

/** The bar is open: only then are matches drawn. */
const setCodeFindOpen = StateEffect.define<boolean>()

const findOpen = StateField.define<boolean>({
  create: () => false,
  update(open, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCodeFindOpen)) open = effect.value
    }
    return open
  },
})

const match = Decoration.mark({ class: 'cm-searchMatch' })
const current = Decoration.mark({
  class: 'cm-searchMatch cm-searchMatch-selected',
})

function highlight(view: EditorView): DecorationSet {
  const query = getSearchQuery(view.state)
  if (!view.state.field(findOpen) || !query.valid) return Decoration.none
  const { from: selFrom, to: selTo } = view.state.selection.main
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const cursor = query.getCursor(view.state, from, to)
    for (let next = cursor.next(); !next.done; next = cursor.next()) {
      const hit = next.value
      builder.add(hit.from, hit.to, hit.from === selFrom && hit.to === selTo ? current : match)
    }
  }
  return builder.finish()
}

const highlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = highlight(view)
    }
    update(update: ViewUpdate) {
      this.decorations = highlight(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** What a code editor needs for its find bar. */
export function codeFind(): Extension {
  return [search(), findOpen, highlighter]
}

/** Put `options` in force (or clear it, with the bar closed). */
export function setCodeQuery(view: EditorView, options: FindOptions, open: boolean): void {
  view.dispatch({
    effects: [setSearchQuery.of(codeQuery(options)), setCodeFindOpen.of(open)],
  })
}

/** How many matches there are, and which one (1-based) the selection is on. */
export function codeFindCount(state: EditorState): FindCount {
  const query = getSearchQuery(state)
  if (!state.field(findOpen, false) || !query.valid) {
    return { total: 0, current: null }
  }
  const { from: selFrom, to: selTo } = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let at: number | null = null
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++
    if (next.value.from === selFrom && next.value.to === selTo) at = total
    if (total >= COUNT_LIMIT) break
  }
  return { total, current: at }
}
