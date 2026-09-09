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
import { colorModeAware } from '@/editor/color-mode'
import { editorTheme } from '@/editor/theme'

/**
 * The diff's palette, taken off the app's tokens rather than off the mode.
 *
 * **This used to declare `{ dark: true }`**, which picked `@codemirror/merge`'s
 * own `&dark` arm and was right while Holi was dark-only. Light mode shipped
 * with D85 and the flag stayed, so a diff in a light vault came up wearing dark
 * chrome — most visibly a black `#0a0a0a` strip where the "N unchanged lines"
 * bar should be. The flag is gone; `colorModeAware()` tells the view which mode
 * it is actually in, the way the app's other three editor stacks already do.
 *
 * With the colours below stated as tokens, almost nothing in a diff branches on
 * the mode any more — which is the point. What remains is CodeMirror's core
 * chrome (the cursor, above all, since the resolvable mode is editable) and the
 * package's `.cm-inlineChangedLineGutter`, a mode-independent purple marking a
 * line that has an insertion and a deletion on it. Both are left alone.
 *
 * **Every selector is written `&.cm-merge-b …` deliberately.** `unifiedMergeView`
 * puts `cm-merge-b` on the editor, and so does the package's own theme: its
 * rules are `&dark.cm-merge-b .cm-changedText` and friends, three classes deep.
 * A theme beats a `baseTheme` only at EQUAL specificity (both mount through
 * `StyleModule`; the base one is `Prec.lowest`, so it lands earlier in the
 * sheet), and the overrides here used to be written one class shallower — so
 * the two that had a `&dark`-scoped counterpart, `.cm-changedText` and the
 * inline `.cm-deletedText`, never actually applied and the package's gradient
 * underline was what showed. Matching the package's shape fixes that too.
 */
const diffTheme = EditorView.theme({
  // The "N unchanged lines" strip. The package paints it with a hardcoded
  // gradient; this is a flat neutral wash instead, and TRANSLUCENT because the
  // panels that host a diff set no background of their own — an opaque colour
  // is a guess about a surface this component cannot see, which is precisely
  // how `#0a0a0a` got here.
  '&.cm-merge-b .cm-collapsedLines': {
    background: 'none',
    backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)',
    color: 'var(--muted-foreground)',
    border: 'none',
  },
  '&.cm-merge-b .cm-collapsedLines:hover': { color: 'var(--foreground)' },
  // The package marks changed/deleted text with a 2px bottom gradient — it reads
  // as an underline. Replace it with a full solid background: green for
  // insertions, red for deletions, the way a diff normally shades text.
  '&.cm-merge-b .cm-changedText': {
    background: 'color-mix(in srgb, var(--diff-added) 28%, transparent)',
  },
  '&.cm-merge-b .cm-deletedText, &.cm-merge-b .cm-deletedChunk .cm-deletedText': {
    background: 'color-mix(in srgb, var(--diff-removed) 30%, transparent)',
  },
  // The whole-line wash under a change. The package's is neither of these hues
  // — a deletion gets a muddy tan (`rgba(160,128,100,.08)`) — so a red word sat
  // on a brown line beside a red gutter. Same tokens, far lower alpha, since
  // this one is the backdrop the shaded text above has to stay legible on.
  '&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-inlineChangedLine': {
    backgroundColor: 'color-mix(in srgb, var(--diff-added) 10%, transparent)',
  },
  '&.cm-merge-b .cm-deletedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--diff-removed) 10%, transparent)',
  },
  // The 3px change gutter. The one thing left that `{ dark: true }` still
  // decided after the overrides above, so tokenising it is what makes dropping
  // the flag a clean swap rather than a trade.
  '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--diff-added)' },
  '&.cm-merge-b .cm-deletedLineGutter': { background: 'var(--diff-removed)' },
})

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
          colorModeAware(),
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
