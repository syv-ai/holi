/**
 * A unified diff via `@codemirror/merge`'s `unifiedMergeView`, inline
 * (`allowInlineDiffs`) and compact (`collapseUnchanged`). `original` is the
 * before-content; the doc is the after.
 *
 * Two modes, switched by `onResolve`. Without it: a read-only view of history,
 * no merge controls. With it: accept/reject controls and an editable document,
 * for reviewing an agent turn (D88).
 */
import { unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { colorModeAware } from '@/editor/color-mode'
import { editorTheme } from '@/editor/theme'

/**
 * The diff's palette, from the app's tokens rather than the mode, so almost
 * nothing branches on light/dark; `colorModeAware()` handles CodeMirror's core
 * chrome.
 *
 * Every selector is written `&.cm-merge-b …` deliberately: the package's rules
 * are `&dark.cm-merge-b .cm-changedText` and friends, three classes deep, and a
 * theme beats a `baseTheme` only at equal specificity. One class shallower and
 * the overrides silently do not apply.
 */
const diffTheme = EditorView.theme({
  // The "N unchanged lines" strip: a flat neutral wash, translucent because
  // the host panels set no background and an opaque colour would be a guess.
  '&.cm-merge-b .cm-collapsedLines': {
    background: 'none',
    backgroundColor: 'color-mix(in srgb, var(--muted-foreground) 12%, transparent)',
    color: 'var(--muted-foreground)',
    border: 'none',
  },
  '&.cm-merge-b .cm-collapsedLines:hover': { color: 'var(--foreground)' },
  // A solid background instead of the package's 2px gradient underline.
  '&.cm-merge-b .cm-changedText': {
    background: 'color-mix(in srgb, var(--diff-added) 28%, transparent)',
  },
  '&.cm-merge-b .cm-deletedText, &.cm-merge-b .cm-deletedChunk .cm-deletedText': {
    background: 'color-mix(in srgb, var(--diff-removed) 30%, transparent)',
  },
  // The whole-line wash under a change: same tokens as the text, far lower
  // alpha, so shaded text stays legible on it.
  '&.cm-merge-b .cm-changedLine, &.cm-merge-b .cm-inlineChangedLine': {
    backgroundColor: 'color-mix(in srgb, var(--diff-added) 10%, transparent)',
  },
  '&.cm-merge-b .cm-deletedChunk': {
    backgroundColor: 'color-mix(in srgb, var(--diff-removed) 10%, transparent)',
  },
  // The 3px change gutter.
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
  /** Present: accept/reject controls, an editable document, and this fires
   *  with the whole text after every resolution. Absent: read-only. */
  onResolve?: (text: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  /**
   * In a ref, kept out of the effect's dependencies: the parent hands down a
   * fresh closure every render, which would rebuild the merge view and lose the
   * resolutions so far.
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
          // Accept, reject and hand edits are all document edits: one listener.
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
