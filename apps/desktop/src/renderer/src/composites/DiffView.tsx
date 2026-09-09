/**
 * A unified diff, rendered with `@codemirror/merge`'s `unifiedMergeView` in
 * **inline + compact** mode:
 *  - `allowInlineDiffs` — small in-line edits render inline (solid green/red) rather
 *    than as the default gradient-underlined separate lines.
 *  - `collapseUnchanged` — long unchanged runs fold away, so the change is the focus.
 *
 * `original` is the before-content; the doc is the after.
 *
 * **Two modes, and `onResolve` is the switch.** Without it this is what it has
 * always been: a read-only view of history, with `mergeControls: false` dropping
 * the accept/reject affordances because there is nothing to resolve about a
 * commit that already happened. With it, the chunks grow their controls and the
 * document becomes editable, which is what an agent turn needs — a hunk the
 * agent wrote is a hunk you may want back (D88).
 */
import { unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { editorTheme } from '@/editor/theme'

/**
 * `{ dark: true }` marks the editor dark so `@codemirror/merge`'s own `&dark`
 * rules apply — `editorTheme` is a `baseTheme` with no dark flag, so without this
 * the merge view falls back to its LIGHT variants (a white "N unchanged lines"
 * bar on our dark UI). The `.cm-collapsedLines` override then replaces that bar's
 * hardcoded gradient with a flat, subtle strip that reads on any background.
 */
const diffTheme = EditorView.theme(
  {
    '.cm-collapsedLines': {
      background: 'none',
      backgroundColor: '#0a0a0a', // neutral-950, the app's standard background
      color: '#888',
      border: 'none',
    },
    '.cm-collapsedLines:hover': { color: '#aaa' },
    // The package marks changed/deleted text with a 2px bottom gradient — it reads
    // as an underline. Replace it with a full solid background: green for
    // insertions, red for deletions, the way a diff normally shades text.
    '.cm-changedText': { background: 'rgba(34,197,94,0.28)' },
    '.cm-deletedChunk .cm-deletedText, .cm-deletedText': { background: 'rgba(239,68,68,0.30)' },
  },
  { dark: true },
)

export function DiffView({
  before,
  after,
  onResolve,
}: {
  before: string
  after: string
  /** Present: the chunks get accept/reject controls, the document is editable,
   *  and this fires with the whole document text after every resolution.
   *  Absent: read-only, exactly as the history panel has always had it. */
  onResolve?: (text: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  /**
   * Held in a ref and kept OUT of the effect below.
   *
   * The panel above re-renders on every state change and hands down a fresh
   * closure each time. In the dependency array that would destroy and rebuild
   * the whole merge view between accepting one chunk and looking at the next,
   * losing the resolutions so far. The ref lets the effect depend on the
   * documents, which are the only things that should rebuild it.
   */
  const resolve = useRef(onResolve)
  resolve.current = onResolve
  // Whether there is a resolver may change the extensions, so unlike its
  // identity it does belong in the dependencies.
  const resolvable = onResolve !== undefined

  useEffect(() => {
    if (host.current === null) return
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: after,
        extensions: [
          EditorState.readOnly.of(!resolvable),
          EditorView.editable.of(resolvable),
          EditorView.lineWrapping,
          editorTheme,
          diffTheme,
          // Every accept and reject is an edit to the document, so one listener
          // covers both without knowing which control was pressed — and covers a
          // hand edit too, which an editable merge view also allows.
          EditorView.updateListener.of((update) => {
            if (update.docChanged) resolve.current?.(update.state.doc.toString())
          }),
          unifiedMergeView({
            original: before,
            mergeControls: resolvable,
            allowInlineDiffs: true,
            gutter: true,
            collapseUnchanged: { margin: 2 },
          }),
        ],
      }),
    })
    return () => view.destroy()
  }, [before, after, resolvable])

  return <div ref={host} className="h-full overflow-auto text-[11px]" />
}
