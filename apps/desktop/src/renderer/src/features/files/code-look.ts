/**
 * The code editor dressed as ReUI's code block, so a file reads the same
 * whether it is being read or typed in.
 *
 * **Colours from the block's own highlighter.** `highlightCode` (Shiki, the
 * GitHub light and dark themes, the grammars the block knows, Vue and
 * Svelte among them) tokenizes the document a moment after typing pauses,
 * and each token becomes a mark carrying the block's two colour variables,
 * `--cb-c` and `--cb-cd`; the theme picks one by Holi's light or dark. While
 * a pass is out, the last colours map through the edits, so typing never
 * flashes to plain. A file past `HIGHLIGHT_LIMIT` stays plain, as in the
 * block.
 *
 * **The block's measures.** 13px mono on 24px lines, the numbers muted in
 * a gutter as wide as the block's, on the page's own ground.
 */
import { StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

import { highlightCode } from '@/components/reui/code-block/code-block-highlight'

import { codeLanguage } from '@/editor/languages'

/** Past this, the editor stays plain rather than tokenizing a lockfile. */
const HIGHLIGHT_LIMIT = 300_000
/** How long typing must pause before the colours are worked out again. */
const PASS_DELAY_MS = 120

const setColours = StateEffect.define<DecorationSet>()

const colours = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setColours)) return effect.value
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

const markCache = new Map<string, Decoration>()

function markFor(color?: string, colorDark?: string, fontStyle?: string) {
  const key = `${color ?? ''}|${colorDark ?? ''}|${fontStyle ?? ''}`
  let mark = markCache.get(key)
  if (mark === undefined) {
    const style = [
      color ? `--cb-c:${color}` : '',
      colorDark ? `--cb-cd:${colorDark}` : '',
      fontStyle === 'italic' ? 'font-style:italic' : '',
      fontStyle === 'bold' ? 'font-weight:600' : '',
      fontStyle === 'underline' ? 'text-decoration:underline' : '',
    ]
      .filter(Boolean)
      .join(';')
    mark = Decoration.mark({ class: 'cm-shiki', attributes: { style } })
    markCache.set(key, mark)
  }
  return mark
}

function shikiPlugin(language: string) {
  return ViewPlugin.fromClass(
    class {
      timer: number | undefined
      pass = 0

      constructor(readonly view: EditorView) {
        this.schedule(0)
      }

      update(update: ViewUpdate) {
        if (update.docChanged) this.schedule(PASS_DELAY_MS)
      }

      schedule(delay: number) {
        window.clearTimeout(this.timer)
        this.timer = window.setTimeout(() => void this.run(), delay)
      }

      async run() {
        const doc = this.view.state.doc
        if (doc.length > HIGHLIGHT_LIMIT) return
        const pass = ++this.pass
        const lines = await highlightCode(doc.toString(), {
          language,
          instanceKey: 'file-editor',
        }).catch(() => null)
        // A newer pass, or an edit since this one began, wins.
        if (lines === null || pass !== this.pass) return
        if (this.view.state.doc !== doc) return

        const ranges = []
        for (let index = 0; index < lines.length && index < doc.lines; index++) {
          const line = doc.line(index + 1)
          let at = line.from
          for (const token of lines[index]!.tokens) {
            const to = at + token.content.length
            if (to > line.to) break
            if (to > at && (token.color || token.colorDark || token.fontStyle)) {
              ranges.push(markFor(token.color, token.colorDark, token.fontStyle).range(at, to))
            }
            at = to
          }
        }
        this.view.dispatch({
          effects: setColours.of(Decoration.set(ranges, true)),
        })
      }

      destroy() {
        window.clearTimeout(this.timer)
        this.pass++
      }
    },
  )
}

const LOOK = EditorView.theme({
  '&': { fontSize: '0.8125rem' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.5rem',
  },
  '.cm-content': { paddingBlock: '0.75rem' },
  '.cm-line': { paddingInline: '0.75rem' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--muted-foreground)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '2.25rem',
    paddingInline: '0 0.625rem',
    textAlign: 'end',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  // Over the plain stack's own token colours, whichever span is outermost.
  '.cm-shiki, .cm-shiki span': { color: 'var(--cb-c, inherit)' },
  ":root[data-theme='dark'] & .cm-shiki, :root[data-theme='dark'] & .cm-shiki span": {
    color: 'var(--cb-cd, inherit)',
  },
})

/** The block's colours and measures for the file at `path`. */
export function codeLook(path: string): Extension[] {
  const language = codeLanguage(path)
  return [LOOK, ...(language ? [colours, shikiPlugin(language)] : [])]
}
