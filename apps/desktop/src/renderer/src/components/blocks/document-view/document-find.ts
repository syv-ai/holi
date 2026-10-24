/**
 * Find in a document: `prosemirror-search` (the engine CodeMirror's search is
 * the sibling of) holds the query and highlights every match, the current
 * one being the match the selection is on. Positions are the document's
 * own, so a match inside a link, a mark or a list item maps exactly. The bar
 * that drives it is `document-find-bar.tsx`.
 */
import { Extension } from "@tiptap/react"
import type { EditorState } from "@tiptap/pm/state"
import {
  getMatchHighlights,
  getSearchState,
  search,
  SearchQuery,
} from "prosemirror-search"

export interface FindOptions {
  search: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
  replace: string
}

export function findQuery(options: FindOptions): SearchQuery {
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

/** How many matches there are, and which one (1-based) the selection is on. */
export function findCount(state: EditorState): {
  total: number
  current: number | null
} {
  const matches = getMatchHighlights(state)
    .find()
    .sort((a, b) => a.from - b.from)
  const { from, to } = state.selection
  const index = matches.findIndex(
    (match) => match.from === from && match.to === to
  )
  return { total: matches.length, current: index < 0 ? null : index + 1 }
}

/** The query in force, or null when there is none to search for. */
export function activeQuery(state: EditorState): SearchQuery | null {
  const query = getSearchState(state)?.query
  return query?.valid ? query : null
}

export const DocumentFind = Extension.create({
  name: "documentFind",

  addProseMirrorPlugins() {
    return [search()]
  },
})
