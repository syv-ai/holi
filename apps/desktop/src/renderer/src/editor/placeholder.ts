/**
 * The hint on the caret's empty line (after ReUI's page editor, whose empty
 * line reads "Type / for commands" and whose empty heading names its level).
 * Shown only while the editor has focus, on the one line the caret is on, so a
 * page is never covered in grey text. When Space would ask the agent there
 * (`askSpace.ts`), the hint says so too.
 */
import { syntaxTree } from '@codemirror/language'
import { Facet, type EditorState } from '@codemirror/state'
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import { spaceAskAllowed } from './askSpace'
import { frontmatterRegion } from './frontmatter-region'

/** Whether Space on an empty line asks the agent here: the setting and an
 *  agent both. Read when the hint is drawn. */
export const spaceAskHintFacet = Facet.define<() => boolean, () => boolean>({
  combine: (values) => values[0] ?? (() => false),
})

export const COMMANDS_HINT = 'Type / for commands'
export const SPACE_HINT = 'Press Space to ask the agent, or type / for commands'

/** What the caret's line would say, or null. Pure, for the tests. */
export function placeholderFor(
  state: EditorState,
  spaceAsks: boolean,
): { pos: number; text: string } | null {
  const sel = state.selection.main
  if (!sel.empty || state.readOnly) return null
  const line = state.doc.lineAt(sel.head)
  if (sel.head !== line.to) return null
  if (line.from < (frontmatterRegion(state.doc.toString())?.to ?? 0)) return null
  const heading = /^(#{1,6})\s$/.exec(line.text)
  if (heading !== null) return { pos: line.to, text: `Heading ${heading[1]!.length}` }
  // An empty item: its marker and nothing after.
  if (/^\s*(?:[-*+]|\d+[.)]|[A-Za-z][.)])\s(?:\[[ xX]?\]\s)?$/.test(line.text)) {
    return { pos: line.to, text: COMMANDS_HINT }
  }
  if (line.text !== '') return null
  for (let n = syntaxTree(state).resolveInner(line.from, 1); ; n = n.parent!) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'Table') return null
    if (n.parent === null) break
  }
  return { pos: line.to, text: spaceAsks && spaceAskAllowed(state) ? SPACE_HINT : COMMANDS_HINT }
}

class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  override eq(other: HintWidget): boolean {
    return other.text === this.text
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-line-hint'
    el.setAttribute('aria-hidden', 'true')
    el.textContent = this.text
    return el
  }
  override ignoreEvent(): boolean {
    return false
  }
}

export const linePlaceholder = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.selectionSet || u.focusChanged) this.decorations = this.build(u.view)
    }
    build(view: EditorView): DecorationSet {
      if (!view.hasFocus) return Decoration.none
      const hint = placeholderFor(view.state, view.state.facet(spaceAskHintFacet)())
      if (hint === null) return Decoration.none
      return Decoration.set([
        Decoration.widget({ widget: new HintWidget(hint.text), side: 1 }).range(hint.pos),
      ])
    }
  },
  { decorations: (v) => v.decorations },
)
