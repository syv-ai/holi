/**
 * The caret's link (after ReUI's `rich-text-link` bubble): the address, which
 * the text alone never shows, and Edit and Remove. Only a vetted address goes
 * live (`normalizeHref`). Edit opens the selection bubble's link field on the
 * link's text.
 */
import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { showTooltip, type EditorView, type Tooltip } from '@codemirror/view'
import { ExternalLink, Link2Off, Pencil } from 'lucide'
import { openBubblePanel } from './askAgent'
import { glyph } from './formatBar'
import { linkAt, normalizeHref, removeLink } from './formatting'

/** The link under a bare caret, or null. */
export function caretLink(state: EditorState) {
  const sel = state.selection.main
  if (!sel.empty || state.readOnly) return null
  const link = linkAt(state, sel.head)
  // On the brackets' outside edges the caret is beside the link, not in it.
  if (link === null || sel.head === link.from || sel.head === link.to) return null
  return link
}

function button(label: string, content: Node[], onPress: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = `cm-format-btn${cls}`
  b.setAttribute('aria-label', label)
  b.dataset.tip = label
  b.append(...content)
  b.onmousedown = (e) => e.preventDefault()
  b.onclick = onPress
  return b
}

export function linkBubble(openUrl: (url: string) => void): Extension {
  return StateField.define<readonly Tooltip[]>({
    create: (state) => tooltips(state),
    update(value, tr) {
      return tr.docChanged || tr.selection !== undefined ? tooltips(tr.state) : value
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  })

  function tooltips(state: EditorState): Tooltip[] {
    const link = caretLink(state)
    if (link === null) return []
    return [
      {
        pos: link.from,
        above: false,
        create: (view: EditorView) => {
          const dom = document.createElement('div')
          dom.className = 'cm-link-bubble'
          dom.setAttribute('role', 'group')
          dom.setAttribute('aria-label', 'Link')
          const href = normalizeHref(link.url)
          if (href !== null) {
            const text = document.createElement('span')
            text.textContent = href.replace(/^https?:\/\//, '')
            const open = button(
              `Open ${href}`,
              [glyph(ExternalLink), text],
              () => openUrl(href),
              ' cm-link-bubble-href',
            )
            delete open.dataset.tip
            dom.append(open)
          }
          dom.append(
            button('Edit link', [glyph(Pencil)], () => {
              const now = linkAt(view.state, view.state.selection.main.head)
              if (now === null) return
              view.dispatch({
                selection: { anchor: now.textFrom, head: now.textTo },
                effects: openBubblePanel.of('link'),
              })
            }),
            button('Remove link', [glyph(Link2Off)], () => {
              const spec = removeLink(view.state)
              if (spec !== null) view.dispatch(spec)
              view.focus()
            }),
          )
          return { dom }
        },
      },
    ]
  }
}
