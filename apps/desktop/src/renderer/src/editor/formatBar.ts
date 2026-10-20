/**
 * The format bubble's bar (after ReUI's `rich-text-format-bubble`,
 * `rich-text-bubble-bar`, `rich-text-controls`, `rich-text-highlight` and
 * `rich-text-link`; docs/features/editor.md): the block's type, the marks,
 * alignment, highlight and link, each as its key does it, over markdown.
 *
 * Plain DOM, like the rest of the bubble (`askAgent.ts`): it lives in a
 * CodeMirror tooltip, which CodeMirror places against the selection, and is
 * rebuilt whenever the selection moves. Its menus and popovers are panels
 * inside the bubble rather than Radix overlays, so a press never takes focus
 * from the text unless it must (the link field), and the selection the press
 * acts on stays painted.
 *
 * Keyboard: Alt+F10 from the text reaches the bar (the WAI-ARIA editor
 * convention), ← → Home End walk it, Enter or Space presses, ↓ opens a menu
 * and walks it, Escape closes a panel and then returns to the text.
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Ban,
  Bold,
  Check,
  ChevronDown,
  Code,
  createElement,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link,
  Link2Off,
  Strikethrough,
  Type,
  Underline,
  type IconNode,
} from 'lucide'
import { blockAt, turnInto, type TurnIntoKind } from './blocks'
import { linkAt, normalizeHref, removeLink, setLink, toggleInline } from './formatting'
import {
  activeMarks,
  alignOf,
  canAlign,
  HIGHLIGHT_COLORS,
  setAlign,
  setHighlight,
  toggleUnderline,
  type Align,
  type HighlightColor,
} from './marks'

/** A panel the bubble can open with, for ⌘K and the link bubble's Edit. */
export type BubblePanel = 'link' | null

const TOOLBAR_ITEM = '[data-toolbar-item]'

export function glyph(icon: IconNode, cls = 'cm-format-icon'): SVGElement {
  return createElement(icon, { class: cls, 'aria-hidden': 'true' })
}

/** The bar's own block types, as ReUI's block type menu has them. */
const BLOCK_TYPES: { kind: TurnIntoKind; label: string; icon: IconNode; keys: string }[] = [
  { kind: 'text', label: 'Text', icon: Type, keys: '⌘⌥0' },
  { kind: 'heading-1', label: 'Heading 1', icon: Heading1, keys: '⌘⌥1' },
  { kind: 'heading-2', label: 'Heading 2', icon: Heading2, keys: '⌘⌥2' },
  { kind: 'heading-3', label: 'Heading 3', icon: Heading3, keys: '⌘⌥3' },
]

const ALIGN_ROWS: { align: Align; label: string; icon: IconNode; keys: string }[] = [
  { align: 'left', label: 'Align left', icon: AlignLeft, keys: '⌘⇧L' },
  { align: 'center', label: 'Align center', icon: AlignCenter, keys: '⌘⇧E' },
  { align: 'right', label: 'Align right', icon: AlignRight, keys: '⌘⇧R' },
  { align: 'justify', label: 'Justify', icon: AlignJustify, keys: '⌘⇧J' },
]

/** Whether the selection starts in code, where marks mean nothing. */
export function inCode(view: EditorView): boolean {
  const pos = view.state.selection.main.from
  for (let n = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent!) {
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') return true
    if (n.parent === null) break
  }
  return false
}

interface ButtonSpec {
  label: string
  keys?: string
  content: Node | string
  pressed?: boolean
  disabled?: boolean
  className?: string
  onPress: (button: HTMLButtonElement) => void
}

/**
 * Builds the bar for the view's current selection. `trailing` is put after a
 * hairline at the end (Ask agent, when there is an agent).
 */
export function formatBar(
  view: EditorView,
  options: { initialPanel?: BubblePanel; trailing?: HTMLElement } = {},
): HTMLElement {
  const state = view.state
  const root = document.createElement('div')
  root.className = 'cm-format-bar'
  root.setAttribute('role', 'toolbar')
  root.setAttribute('aria-label', 'Format')
  root.setAttribute('aria-keyshortcuts', 'Alt+F10')

  let open: { panel: HTMLElement; trigger: HTMLElement } | null = null

  const closePanel = (refocus: 'trigger' | 'text' | 'none' = 'none') => {
    if (open === null) return
    const { panel, trigger } = open
    open = null
    panel.remove()
    trigger.setAttribute('aria-expanded', 'false')
    if (refocus === 'trigger') trigger.focus()
    if (refocus === 'text') view.focus()
  }

  /** Runs an edit, then hands the caret back to the text. */
  const act = (spec: Parameters<EditorView['dispatch']>[0] | null) => {
    closePanel()
    if (spec !== null) view.dispatch(spec)
    view.focus()
  }

  const button = (spec: ButtonSpec): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `cm-format-btn${spec.className ? ` ${spec.className}` : ''}`
    b.setAttribute('data-toolbar-item', '')
    b.setAttribute('aria-label', spec.label)
    b.dataset.tip = spec.keys ? `${spec.label}  ${spec.keys}` : spec.label
    if (spec.pressed !== undefined) b.setAttribute('aria-pressed', String(spec.pressed))
    if (spec.disabled === true) b.setAttribute('aria-disabled', 'true')
    b.append(spec.content)
    // A press keeps the text focused and the selection painted.
    b.onmousedown = (e) => e.preventDefault()
    b.onclick = () => {
      if (spec.disabled === true) return
      spec.onPress(b)
    }
    return b
  }

  const rule = () => {
    const r = document.createElement('span')
    r.className = 'cm-format-rule'
    r.setAttribute('aria-hidden', 'true')
    return r
  }

  /** Opens `build`'s panel under `trigger`, or closes it when it is the one open. */
  const toggle = (trigger: HTMLElement, build: () => HTMLElement, focusFirst: boolean) => {
    if (open?.trigger === trigger) return closePanel()
    closePanel()
    const panel = build()
    panel.style.left = `${trigger.offsetLeft}px`
    root.append(panel)
    trigger.setAttribute('aria-expanded', 'true')
    open = { panel, trigger }
    if (focusFirst) panel.querySelector<HTMLElement>('[data-panel-item]')?.focus()
  }

  /** A menu of radio rows, as ReUI's dropdown menus. */
  const menu = (
    label: string,
    rows: { label: string; icon: IconNode; keys: string; checked: boolean; run: () => void }[],
  ): HTMLElement => {
    const panel = document.createElement('div')
    panel.className = 'cm-format-panel cm-format-menu'
    panel.setAttribute('role', 'menu')
    panel.setAttribute('aria-label', label)
    const heading = document.createElement('div')
    heading.className = 'cm-format-menu-label'
    heading.textContent = label
    panel.append(heading)
    for (const row of rows) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cm-format-row'
      b.setAttribute('role', 'menuitemradio')
      b.setAttribute('aria-checked', String(row.checked))
      b.setAttribute('data-panel-item', '')
      b.tabIndex = -1
      const text = document.createElement('span')
      text.className = 'cm-format-row-label'
      text.textContent = row.label
      const keys = document.createElement('span')
      keys.className = 'cm-format-kbd'
      keys.textContent = row.keys
      b.append(glyph(row.icon), text, keys)
      if (row.checked) b.append(glyph(Check, 'cm-format-icon cm-format-check'))
      b.onmousedown = (e) => e.preventDefault()
      b.onclick = row.run
      panel.append(b)
    }
    panel.onkeydown = (e) => {
      const items = [...panel.querySelectorAll<HTMLElement>('[data-panel-item]')]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next =
        e.key === 'ArrowDown'
          ? (i + 1) % items.length
          : e.key === 'ArrowUp'
            ? (i - 1 + items.length) % items.length
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? items.length - 1
                : null
      if (next === null) return
      e.preventDefault()
      e.stopPropagation()
      items[next]?.focus()
    }
    return panel
  }

  const code = inCode(view)
  const marks = activeMarks(state)
  const block = blockAt(state, state.selection.main.from)

  if (!code) {
    // The block's type: a labelled trigger as wide as its longest label, so the
    // bar holds still as the type changes.
    const kind = block?.kind ?? 'text'
    const current = BLOCK_TYPES.find((t) => t.kind === kind) ?? BLOCK_TYPES[0]!
    const typeLabel = document.createElement('span')
    typeLabel.className = 'cm-format-select-label'
    typeLabel.textContent = current.label
    const typeContent = document.createDocumentFragment()
    typeContent.append(typeLabel, glyph(ChevronDown, 'cm-format-icon cm-format-chevron'))
    const typeTrigger = button({
      label: `Block type, ${current.label}`,
      content: typeContent,
      className: 'cm-format-select',
      disabled: block === null || block.kind === 'table' || block.kind === 'divider',
      onPress: (b) =>
        toggle(
          b,
          () =>
            menu(
              'Turn into',
              BLOCK_TYPES.map((t) => ({
                label: t.label,
                icon: t.icon,
                keys: t.keys,
                checked: t.kind === kind,
                run: () => {
                  const now = blockAt(view.state, view.state.selection.main.from)
                  act(now === null || t.kind === kind ? null : turnInto(view.state, now, t.kind))
                },
              })),
            ),
          b.matches(':focus-visible'),
        ),
    })
    typeTrigger.setAttribute('aria-haspopup', 'menu')
    root.append(typeTrigger, rule())

    const group = (label: string) => {
      const g = document.createElement('div')
      g.className = 'cm-format-group'
      g.setAttribute('role', 'group')
      g.setAttribute('aria-label', label)
      root.append(g)
      return g
    }
    const wrap = (marker: string) => () => act(toggleInline(view.state, marker))
    group('Text style').append(
      button({
        label: 'Bold',
        keys: '⌘B',
        content: glyph(Bold),
        pressed: marks.bold,
        onPress: wrap('**'),
      }),
      button({
        label: 'Italic',
        keys: '⌘I',
        content: glyph(Italic),
        pressed: marks.italic,
        onPress: wrap('*'),
      }),
      button({
        label: 'Underline',
        keys: '⌘U',
        content: glyph(Underline),
        pressed: marks.underline,
        onPress: () => act(toggleUnderline(view.state)),
      }),
      button({
        label: 'Strikethrough',
        keys: '⌘⇧S',
        content: glyph(Strikethrough),
        pressed: marks.strike,
        onPress: wrap('~~'),
      }),
      button({
        label: 'Inline code',
        keys: '⌘E',
        content: glyph(Code),
        pressed: marks.code,
        onPress: wrap('`'),
      }),
    )
    root.append(rule())

    // Alignment: the current one's glyph and a chevron.
    const aligned = block !== null && canAlign(block) ? alignOf(state, block) : 'left'
    const alignRow = ALIGN_ROWS.find((r) => r.align === aligned)!
    const alignContent = document.createDocumentFragment()
    alignContent.append(
      glyph(alignRow.icon),
      glyph(ChevronDown, 'cm-format-icon cm-format-chevron'),
    )
    const alignTrigger = button({
      label: `Alignment, ${alignRow.label}`,
      content: alignContent,
      className: 'cm-format-align',
      disabled: block === null || !canAlign(block),
      onPress: (b) =>
        toggle(
          b,
          () =>
            menu(
              'Alignment',
              ALIGN_ROWS.map((r) => ({
                label: r.label,
                icon: r.icon,
                keys: r.keys,
                checked: r.align === aligned,
                run: () => {
                  const now = blockAt(view.state, view.state.selection.main.from)
                  act(now === null ? null : setAlign(view.state, now, r.align))
                },
              })),
            ),
          b.matches(':focus-visible'),
        ),
    })
    alignTrigger.setAttribute('aria-haspopup', 'menu')
    alignTrigger.dataset.tip = 'Alignment'
    root.append(alignTrigger, rule())

    const annotate = group('Annotate')
    const highlight = button({
      label: 'Highlight',
      keys: '⌘⇧H',
      content: glyph(Highlighter),
      pressed: marks.highlight !== null,
      onPress: (b) => toggle(b, () => swatches(marks.highlight), b.matches(':focus-visible')),
    })
    highlight.setAttribute('aria-haspopup', 'dialog')
    const link = button({
      label: 'Link',
      keys: '⌘K',
      content: glyph(Link),
      pressed: marks.link,
      onPress: (b) => toggle(b, linkPanel, true),
    })
    link.setAttribute('aria-haspopup', 'dialog')
    link.classList.add('cm-format-link')
    annotate.append(highlight, link)

    /** The five colours and Remove, as ReUI's highlight popover. */
    function swatches(current: HighlightColor | null): HTMLElement {
      const panel = document.createElement('div')
      panel.className = 'cm-format-panel cm-format-swatches'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', 'Highlight color')
      for (const color of HIGHLIGHT_COLORS) {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'cm-format-swatch'
        b.setAttribute('data-panel-item', '')
        b.setAttribute('aria-label', `${color.label} highlight`)
        b.setAttribute('aria-pressed', String(current === color.id))
        const dot = document.createElement('span')
        dot.className = `cm-format-dot cm-highlight-${color.id}`
        if (current === color.id) dot.append(glyph(Check))
        b.append(dot)
        b.onmousedown = (e) => e.preventDefault()
        b.onclick = () => act(setHighlight(view.state, color.id))
        panel.append(b)
      }
      panel.append(rule())
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'cm-format-btn'
      remove.setAttribute('data-panel-item', '')
      remove.setAttribute('aria-label', 'Remove highlight')
      if (current === null) remove.setAttribute('aria-disabled', 'true')
      remove.append(glyph(Ban))
      remove.onmousedown = (e) => e.preventDefault()
      remove.onclick = () => current !== null && act(setHighlight(view.state, null))
      panel.append(remove)
      panel.onkeydown = (e) => {
        const items = [...panel.querySelectorAll<HTMLElement>('[data-panel-item]')]
        const i = items.indexOf(document.activeElement as HTMLElement)
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
        e.preventDefault()
        e.stopPropagation()
        items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]?.focus()
      }
      return panel
    }

    /** The address field, as ReUI's link popover: apply, remove, and a reason
     *  when the address is not one. */
    function linkPanel(): HTMLElement {
      const sel = view.state.selection.main
      const current = linkAt(view.state, sel.from, sel.to)
      const panel = document.createElement('div')
      panel.className = 'cm-format-panel cm-format-linkpanel'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', 'Link')
      const field = document.createElement('div')
      field.className = 'cm-format-input'
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'cm-format-input-field'
      input.placeholder = 'Paste or type a link'
      input.setAttribute('aria-label', 'Link address')
      input.setAttribute('data-panel-item', '')
      input.value = current?.url ?? ''
      const error = document.createElement('div')
      error.className = 'cm-format-error'
      error.id = `cm-link-error-${Math.random().toString(36).slice(2)}`
      const apply = document.createElement('button')
      apply.type = 'button'
      apply.className = 'cm-format-btn cm-format-apply'
      apply.setAttribute('aria-label', 'Apply link')
      apply.append(glyph(Check))
      const paint = () => {
        if (input.value.trim() === '') apply.setAttribute('aria-disabled', 'true')
        else apply.removeAttribute('aria-disabled')
      }
      paint()
      const submit = () => {
        const draft = input.value.trim()
        // Enter on an empty field is a no-op, not an error.
        if (draft === '') return
        const href = normalizeHref(draft)
        if (href === null) {
          error.textContent = 'Enter a web address, like example.com'
          input.setAttribute('aria-invalid', 'true')
          input.setAttribute('aria-describedby', error.id)
          field.classList.add('cm-format-input-invalid')
          view.dispatch({}) // the bubble is taller; let CodeMirror place it again
          return
        }
        act(setLink(view.state, href, draft))
      }
      input.oninput = () => {
        paint()
        error.textContent = ''
        input.removeAttribute('aria-invalid')
        field.classList.remove('cm-format-input-invalid')
      }
      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closePanel('text')
        }
      }
      apply.onmousedown = (e) => e.preventDefault()
      apply.onclick = submit
      field.append(glyph(Link), input, apply)
      if (current !== null) {
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'cm-format-btn'
        remove.setAttribute('aria-label', 'Remove link')
        remove.append(glyph(Link2Off))
        remove.onmousedown = (e) => e.preventDefault()
        remove.onclick = () => act(removeLink(view.state))
        field.append(remove)
      }
      panel.append(field, error)
      return panel
    }

    if (options.initialPanel === 'link') {
      // Once CodeMirror has put the bubble in the page: the field takes focus,
      // and a detached input cannot.
      let tries = 0
      const openLink = () => {
        if (root.isConnected) toggle(link, linkPanel, true)
        else if (tries++ < 5) requestAnimationFrame(openLink)
      }
      queueMicrotask(openLink)
    }
  }

  if (options.trailing !== undefined) {
    if (root.childElementCount > 0) root.append(rule())
    options.trailing.setAttribute('data-toolbar-item', '')
    root.append(options.trailing)
  }

  // One tab stop for the bar; arrows move inside it.
  const items = () =>
    [...root.querySelectorAll<HTMLElement>(TOOLBAR_ITEM)].filter(
      (el) => el.getAttribute('aria-disabled') !== 'true' && !el.closest('.cm-format-panel'),
    )
  for (const [i, el] of items().entries()) el.tabIndex = i === 0 ? 0 : -1
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (open !== null) closePanel('trigger')
      else view.focus()
      return
    }
    if (e.target instanceof HTMLElement && e.target.closest('.cm-format-panel')) return
    if (
      e.key === 'ArrowDown' &&
      e.target instanceof HTMLElement &&
      e.target.hasAttribute('aria-haspopup')
    ) {
      e.preventDefault()
      if (open?.trigger !== e.target) e.target.click()
      open?.panel.querySelector<HTMLElement>('[data-panel-item]')?.focus()
      return
    }
    const all = items()
    const i = all.indexOf(e.target as HTMLElement)
    if (i === -1) return
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % all.length
        : e.key === 'ArrowLeft'
          ? (i - 1 + all.length) % all.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? all.length - 1
              : null
    if (next === null) return
    e.preventDefault()
    for (const el of all) el.tabIndex = -1
    all[next]!.tabIndex = 0
    all[next]!.focus()
  })
  return root
}

/** Alt+F10: from the text to the bar's first control, when a bar is up. */
export function focusFormatBar(view: EditorView): boolean {
  const first = view.dom.querySelector<HTMLElement>(
    '.cm-format-bar [data-toolbar-item][tabindex="0"]',
  )
  if (first === null) return false
  first.focus()
  return true
}
