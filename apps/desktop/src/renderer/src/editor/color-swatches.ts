/**
 * A colour square beside every hex value, in any file.
 *
 * The ordinary code-editor affordance: you write `#8b5cf6`, the editor shows
 * you what that is and lets you pick a new one. Not specific to themes, not
 * specific to a schema — a hex is a hex wherever it appears, which is the whole
 * reason it reads as an editor feature rather than a Holi one.
 *
 * **Built on `MatchDecorator`, which is CodeMirror's own.** The two published
 * colour-picker extensions (`@replit/codemirror-css-color-picker`,
 * `@uiw/codemirror-extensions-color`) both find colours by walking the syntax
 * tree for `ColorLiteral`/`CallExpression`/`ValueName` — nodes that exist only
 * in the CSS grammar. In a YAML or markdown document they produce nothing, so
 * neither covers `.holi/settings/theme.yaml`, which is the file this is for.
 * `MatchDecorator` is the core primitive for "keep decorations on text matching
 * a regex" and it owns the incremental bookkeeping, which is the part worth not
 * writing twice.
 *
 * **The square is painted with the matched text verbatim.** Same rule as
 * `ColorSwatch` and `css-color.ts`: the browser already knows what `#8b5cf6` is,
 * and converting it ourselves to tell it so would be reimplementing colour
 * spaces.
 */
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * A CSS hex colour.
 *
 * **Three, four, six or eight digits — not "three to eight".** `#12345` is not
 * a colour, and a loose `{3,8}` would paint a swatch beside a git SHA fragment
 * or an issue reference and offer to edit it.
 *
 * The leading `#` is also YAML's comment marker, which sounds like a problem
 * and is not: a comment is `#` followed by a space, so `# background:` cannot
 * match, while a quoted `"#8b5cf6"` can.
 */
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g

class HexSwatch extends WidgetType {
  constructor(readonly hex: string) {
    super()
  }

  override eq(other: HexSwatch): boolean {
    return other.hex === this.hex
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-hex-swatch'
    wrap.style.background = this.hex

    // `<input type="color">` stretched invisibly over the square rather than
    // hidden: a hidden input cannot be clicked open, and driving one through a
    // ref means a synthetic click browsers disagree about. Same technique, and
    // the same reasoning, as the `ColorSwatch` primitive.
    const input = document.createElement('input')
    input.type = 'color'
    // It speaks `#rrggbb` only, so a 3-, 4- or 8-digit value has to be widened
    // for the starting position. What gets WRITTEN is whatever is picked.
    input.value = toSixDigit(this.hex)
    input.setAttribute('aria-label', `colour ${this.hex}`)
    input.addEventListener('input', () => {
      // Found at edit time, not captured at build time: the document may have
      // changed since this widget was made, and a stale offset would recolour
      // the wrong thing.
      const at = view.posAtDOM(wrap)
      const line = view.state.doc.lineAt(at)
      const offset = at - line.from
      for (const m of line.text.matchAll(HEX)) {
        if (m.index + m[0].length !== offset) continue
        view.dispatch({
          changes: {
            from: line.from + m.index,
            to: line.from + m.index + m[0].length,
            insert: input.value,
          },
        })
        return
      }
    })
    wrap.appendChild(input)
    return wrap
  }

  /** The picker is the point, so the widget keeps its own clicks. */
  override ignoreEvent(): boolean {
    return false
  }
}

/** `#abc` → `#aabbcc`, `#aabbccdd` → `#aabbcc`. Only ever for the native
 *  input's starting position, never for what is written back. */
function toSixDigit(hex: string): string {
  const body = hex.slice(1)
  if (body.length === 3 || body.length === 4) {
    return `#${[...body.slice(0, 3)].map((c) => c + c).join('')}`
  }
  return `#${body.slice(0, 6)}`
}

const matcher = new MatchDecorator({
  regexp: HEX,
  // **`decorate`, not `decoration`.** The `decoration` shorthand adds whatever
  // it is given over the match's whole range (`add(from, from + len, deco)`),
  // and a widget has to be a POINT. It still drew, which is the trap — only the
  // position was not the one the click handler then looked for, so the swatch
  // was correct and picking a colour did nothing at all.
  //
  // `side: 1` puts the square after the value, where it does not push the text
  // out of alignment with the lines above it.
  decorate: (add, _from, to, match) => {
    add(to, to, Decoration.widget({ widget: new HexSwatch(match[0]), side: 1 }))
  },
})

const theme = EditorView.baseTheme({
  '.cm-hex-swatch': {
    position: 'relative',
    display: 'inline-block',
    width: '0.8em',
    height: '0.8em',
    marginLeft: '0.35em',
    verticalAlign: '-0.05em',
    borderRadius: '3px',
    border: '1px solid var(--border)',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  '.cm-hex-swatch input': {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    padding: '0',
    border: 'none',
    opacity: '0',
    cursor: 'pointer',
  },
})

/** A swatch beside every hex colour in the document. */
export const hexColorSwatches: Extension = [
  theme,
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate): void {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (v) => v.decorations },
  ),
]
