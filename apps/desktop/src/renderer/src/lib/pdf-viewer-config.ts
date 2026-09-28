/**
 * What the embedded PDF viewer (embedpdf) may do, as pure data (D103), so a
 * node test can pin it: disabled command categories, the palette in Holi's
 * tokens, the CSS put into its shadow root, the opening zoom, and keydown
 * spelling. No React, no DOM globals beyond the `KeyboardEvent` type.
 */
import { Lock, LockOpen, Sparkles, type IconNode } from 'lucide'
import { DRAWER_WIDTH } from './drawer'
import { ASK_AGENT_PDF, ASK_AGENT_THREAD } from './pdf-comments'
import { MAKE_EDITABLE, MAKE_READ_ONLY } from './pdf-read-only'

/**
 * Disabled by category, which removes the command AND its shortcut together.
 *
 * The first block would collide with Holi: ⌘O, ⌘P (the plugin would
 * `stopPropagation` before the palette saw it), ⌘W (closes Holi's tab) and
 * ⌘⇧S. The second is what a pane is not for: export, protect, fullscreen,
 * their menu, and annotation families outside highlight and mark-up.
 * Signatures are the one Insert item kept (D104) and sit on the top bar, so
 * the Insert tab (`mode-insert`) goes too.
 *
 * The names are the viewer's own, and a name that matches no category fails
 * silently.
 */
export const PDF_DISABLED_CATEGORIES: readonly string[] = [
  'document-open',
  'document-print',
  'document-close',
  'capture',
  'document-export',
  'document-protect',
  'document-capture',
  'document-fullscreen',
  'document-menu',
  'redaction',
  'stamp',
  'form',
  'security',
  'insert-rubber-stamp',
  'insert-image',
  'insert-attachment',
  'mode-insert',
]

/** A token slug from `THEME_TOKENS`; the node test checks every one is real. */
const v = (slug: string): string => `var(--${slug})`

/**
 * The viewer's palette, in Holi's tokens.
 *
 * The palette becomes `--ep-*` custom properties on the viewer's shadow root,
 * and custom properties inherit across the shadow boundary, so
 * `var(--background)` resolves to the vault's theme (D64). The same map serves
 * light and dark because the variables already flip with the mode.
 */
export function pdfViewerTheme(mode: 'light' | 'dark') {
  const colors = {
    background: {
      // The viewer's toolbars paint from `surface` (top bar, sidebars) and
      // `surfaceAlt` (the Annotate/Shapes bar). Holi's chrome is flat, so all
      // three are the pane, with no rule between them (`PDF_BORDERLESS_CSS`).
      app: v('background'),
      surface: v('background'),
      surfaceAlt: v('background'),
      elevated: v('popover'),
      input: v('input'),
    },
    foreground: {
      primary: v('foreground'),
      secondary: v('muted-foreground'),
      muted: v('muted-foreground'),
      disabled: v('muted-foreground'),
      onAccent: v('primary-foreground'),
    },
    border: {
      default: v('border'),
      subtle: v('divider'),
      strong: v('border'),
    },
    accent: {
      primary: v('primary'),
      primaryHover: v('primary'),
      primaryActive: v('primary'),
      primaryLight: v('selection'),
      primaryForeground: v('primary-foreground'),
    },
    interactive: {
      hover: v('accent'),
      active: v('accent'),
      selected: v('selection'),
      focus: v('ring'),
      focusRing: v('ring'),
    },
    state: {
      error: v('destructive'),
      errorLight: v('destructive'),
    },
    // Holi's tooltip is the popover surface, not an inverted chip
    // (`primitives/Tooltip.tsx`). The scrollbar's shape is `PDF_SCROLLBAR_CSS`.
    tooltip: {
      background: v('popover'),
      foreground: v('popover-foreground'),
    },
    scrollbar: {
      track: v('background'),
      thumb: v('scrollbar-thumb'),
      thumbHover: v('scrollbar-thumb-hover'),
    },
    // Not mapped, so the viewer's own defaults stand: `background.overlay` and
    // the warning, success and info states, which Holi has no token for.
  }
  return { preference: mode, light: colors, dark: colors }
}

/**
 * The page before it is painted, in Holi's tokens instead of white.
 *
 * embedpdf hard-codes an inline white background on every page wrapper, and
 * PDFium's bitmap arrives tens of milliseconds later: a white flash on a dark
 * theme. The bitmap carries its own white paper, so the wrapper is only a
 * placeholder. `!important` beats the inline style.
 */
export const PDF_PAGE_PLACEHOLDER_CSS = `[style*="background-color: rgb(255, 255, 255)"] { background-color: ${v('muted')} !important; }`

/**
 * The page scroller keeps room for its scrollbar from the start.
 *
 * Otherwise the scrollbar appearing narrows the viewport and the viewer
 * recomputes fit-width 150 ms later: a visible second zoom. The scroller is
 * the element painted `bg-bg-app` with an inline `overflow: auto`.
 */
export const PDF_VIEWPORT_CSS = `.bg-bg-app[style*="overflow: auto"] { scrollbar-gutter: stable; }`

/**
 * No lines between regions, the way Holi's own chrome has none.
 *
 * The viewer's rules (`border-border-*`) and 1px group dividers
 * (`bg-border-default`) go clear; dividers stay as space, and floating things
 * keep their shadow. Form controls (all on `bg-bg-input`) keep an outline
 * dimmed to `--divider`, except under `:focus`. Two-class selectors outrank
 * the utilities they override, so no `!important`.
 */
export const PDF_BORDERLESS_CSS = [
  ':is(.border-border-default, .border-border-subtle):not(.bg-bg-input) { border-color: transparent; }',
  ':is(.w-px, .h-px).bg-border-default { background-color: transparent; }',
  '.ring-border-default { --tw-ring-color: transparent; }',
  `.bg-bg-input.border-border-default:not(:focus) { border-color: ${v('divider')}; }`,
  // A toolbar button shows selected or hovered by background alone: no ring
  // (a `--tw-ring` box-shadow), no drop shadow, and a foreground icon rather
  // than accent on the accent selection. A mode tab has no background, so its
  // `text-accent` underline still marks it.
  'button:is(.ring-accent, .hover\\:ring-accent:hover) { --tw-ring-color: transparent; }',
  'button.ring-accent { box-shadow: none; }',
  `button.bg-interactive-selected.text-accent { color: ${v('foreground')}; }`,
  // The zoom group's div sits on the hover colour at rest. Only the div: on
  // buttons that class is their state.
  'div.bg-interactive-hover { background-color: transparent; }',
  '.outline-border-default { outline-color: transparent; }',
  // A sidebar lies flat on the pane like Holi's file tree. Nothing inside has
  // an edge except a form field's dimmed outline.
  `[data-sidebar-id], [data-sidebar-id] .bg-bg-surface { background-color: ${v('background')}; }`,
  '[data-sidebar-id] :not(input, textarea) { border-color: transparent !important; }',
  // Nor a ring or shadow, except a floating menu (`bg-bg-elevated`). The
  // selected comment is marked by colour.
  '[data-sidebar-id] :not(.bg-bg-elevated) { box-shadow: none !important; }',
  `[data-sidebar-id] .ring-interactive-focus-ring { background-color: ${v('accent')}; }`,
  `[data-sidebar-id] :is(input, textarea) { border-color: ${v('divider')} !important; }`,
  // A comment card leads with its author's name: hide the viewer's type-icon
  // and initials circles.
  '[data-sidebar-id="comment-panel"] .rounded-full:is(.bg-bg-surface-alt, .text-white) { display: none; }',
  // Align each page heading with the cards' text (1px edge + 1rem padding).
  '[data-sidebar-id="comment-panel"] .sticky.top-0:has(h3) { padding-inline-start: calc(0.25rem + 1px + 1rem); }',
].join('\n')

/**
 * Holi's scrollbar, inside the viewer.
 *
 * `index.css`'s scrollbar rule does not reach into a shadow root, so this
 * repeats Holi's shape against `:host *`, the viewer's own selector, and wins
 * by coming later.
 */
export const PDF_SCROLLBAR_CSS = [
  ':host *::-webkit-scrollbar { width: 10px; height: 10px; }',
  ':host *::-webkit-scrollbar-track { background: transparent; }',
  ':host *::-webkit-scrollbar-thumb { background: transparent; border-radius: 9999px; border: 3px solid transparent; background-clip: content-box; transition: background-color var(--motion-respond) var(--ease-settle); }',
  `:host *:hover::-webkit-scrollbar-thumb { background: ${v('scrollbar-thumb')}; background-clip: content-box; }`,
].join('\n')

/**
 * The Create Signature dialog (D104).
 *
 * The panel is Holi's dialog surface, `--popover`. The Draw, Type and Upload
 * areas are paper, because a signature is black ink and was invisible on a
 * dark pad: white in dark mode, `--muted` in light. White is the one literal,
 * as the paper, not chrome.
 *
 * A drag over the Upload zone shows as `--selection`; one class more than the
 * paper rule, because `:is()` takes its most specific argument.
 */
const SIGNATURE_HEADER = '[data-sidebar-id="signature-panel"] .border-b.p-3:has(> h2)'
export const PDF_SIGNATURE_DIALOG_CSS = [
  `.bg-bg-overlay > .bg-bg-surface { background-color: ${v('popover')}; }`,
  `.bg-bg-overlay :is(canvas.border-border-default, .border-dashed.border-border-default, .border-border-default:has(> input[type="text"])) { background-color: light-dark(${v('muted')}, white); }`,
  `.bg-bg-overlay .border-dashed.border-border-default.border-accent { background-color: ${v('selection')}; }`,
  // The header is one row: the title, and Create New Signature restyled as a
  // plus icon button (two gradient bars). It is still the viewer's button, so
  // its action, focus and accessible name (text at font-size 0) are intact.
  `${SIGNATURE_HEADER} { display: flex; align-items: center; justify-content: space-between; gap: 8px; }`,
  `${SIGNATURE_HEADER} > button { flex: none; width: 32px; height: 32px; margin: 0; padding: 0; border-radius: 6px; font-size: 0; background-color: transparent; background-image: linear-gradient(${v('foreground')}, ${v('foreground')}), linear-gradient(${v('foreground')}, ${v('foreground')}); background-size: 12px 1.5px, 1.5px 12px; background-position: center; background-repeat: no-repeat; }`,
  `${SIGNATURE_HEADER} > button:hover { background-color: ${v('accent')}; }`,
  // `PDF_SIGNATURE_NOTE`: Tailwind does not reach into the shadow root.
  `.holi-signature-note { margin: 0; padding: 12px 16px; font-size: 12px; line-height: 1.5; color: ${v('muted-foreground')}; }`,
].join('\n')

/**
 * The viewer's fonts, none of them fetched.
 *
 * Left alone the viewer fetches Google Fonts on every PDF. The UI uses Holi's
 * font, and the four signature script faces are bundled (`@fontsource/*`,
 * imported by `PdfDocument`) under the family names the viewer lists.
 */
export const PDF_FONTS = {
  ui: { family: 'var(--font-sans)', stylesheetUrl: null },
  signature: { stylesheetUrl: null },
}

/**
 * The bundled script faces, by the family names the viewer lists. Loaded when
 * the signature panel opens: nothing else asks for them before the Type tab's
 * canvas draws, so a quickly typed signature could be saved in a fallback face.
 */
export const PDF_SIGNATURE_FONT_FAMILIES: readonly string[] = [
  'Caveat',
  'Dancing Script',
  'Great Vibes',
  'Pacifico',
]

/** A toolbar item as the viewer's UI schema spells one, as far as this file reads it. */
export interface PdfToolbarItem {
  type: string
  id: string
  commandId?: string
  items?: PdfToolbarItem[]
  [key: string]: unknown
}

/**
 * Holi's command for the viewer's comment tool, so the top bar can label it
 * "Add comment": the viewer's label ("Comment") is fixed and clashes with the
 * comments panel button beside it.
 */
export const ADD_COMMENT = 'holi:add-comment'

/** Whether the viewer's comment tool is the active one in a document, read
 *  from the viewer's store the way its own command reads it. */
export function commentToolActive(state: unknown, documentId: string): boolean {
  const documents = (
    state as {
      plugins?: { annotation?: { documents?: Record<string, { activeToolId?: string | null }> } }
    }
  ).plugins?.annotation?.documents
  return documents?.[documentId]?.activeToolId === 'textComment'
}

/** Holi's buttons on the viewer's top bar, in order. Only one of the two
 *  read-only buttons is ever visible: each command says when it applies. */
const HOLI_BUTTONS: readonly PdfToolbarItem[] = [
  {
    type: 'command-button',
    id: 'signature-button',
    commandId: 'insert:add-signature',
    variant: 'icon',
  },
  {
    type: 'command-button',
    id: 'add-comment-button',
    commandId: ADD_COMMENT,
    variant: 'icon',
  },
  {
    type: 'command-button',
    id: 'make-read-only-button',
    commandId: MAKE_READ_ONLY,
    variant: 'icon',
  },
  {
    type: 'command-button',
    id: 'make-editable-button',
    commandId: MAKE_EDITABLE,
    variant: 'icon',
  },
]

/** Ask agent (D106), after the viewer's comments button because it asks about
 *  what that panel lists. Two commands, one visible at a time, because a
 *  command's label is fixed and the label says what is asked about: the
 *  selected comment, or the PDF itself. */
const ASK_BUTTONS: readonly PdfToolbarItem[] = [
  {
    type: 'command-button',
    id: 'ask-agent-thread-button',
    commandId: ASK_AGENT_THREAD,
    variant: 'icon',
  },
  {
    type: 'command-button',
    id: 'ask-agent-pdf-button',
    commandId: ASK_AGENT_PDF,
    variant: 'icon',
  },
]

/** The viewer's own button for the comments panel, in the right-hand group. */
const COMMENTS_BUTTON = 'comment-button'

/**
 * The main toolbar's items with Holi's buttons first in the right-hand group,
 * and Ask agent right after the comments button (or last). `ui.mergeSchema`
 * replaces the item list wholesale, so this returns the whole list; it is
 * idempotent.
 */
export function withHoliButtons(items: readonly PdfToolbarItem[]): PdfToolbarItem[] {
  return items.map((item) => {
    if (item.id !== 'right-group' || item.items === undefined) return item
    const present = new Set(item.items.map((child) => child.id))
    const missing = HOLI_BUTTONS.filter((button) => !present.has(button.id))
    const asks = ASK_BUTTONS.filter((button) => !present.has(button.id))
    if (missing.length === 0 && asks.length === 0) return item
    const children = [...missing, ...item.items]
    const comments = children.findIndex((child) => child.id === COMMENTS_BUTTON)
    const at = comments === -1 ? children.length : comments + 1
    return { ...item, items: [...children.slice(0, at), ...asks, ...children.slice(at)] }
  })
}

/** The viewer's own items that Holi's top bar now carries, by item id. */
const MOVED_TOOLS: ReadonlySet<string> = new Set(['add-comment'])

/**
 * A toolbar's items without the ones moved to the top bar, at any depth: the
 * comment tool leaves the Annotate bar, where it would be the same button a
 * second time. Fed to `ui.mergeSchema`, so it returns the whole list.
 */
export function withoutMovedTools(items: readonly PdfToolbarItem[]): PdfToolbarItem[] {
  return items.flatMap((item) => {
    if (MOVED_TOOLS.has(item.id)) return []
    if (item.items === undefined) return [item]
    const kept = withoutMovedTools(item.items)
    return [kept.length === item.items.length ? item : { ...item, items: kept }]
  })
}

/**
 * Holi's buttons keep their places as they come and go.
 *
 * A hidden command leaves an empty wrapper that is still a flex item with
 * gaps, so the read-only toggle (two items, one hidden) stepped sideways when
 * it flipped. The viewer's own spacers are empty on purpose, so the rule names
 * only Holi's items.
 */
export const PDF_TOOLBAR_CSS = `:is(${[...HOLI_BUTTONS, ...ASK_BUTTONS].map((b) => `[data-epdf-i="${b.id}"]`).join(', ')}):empty { display: none; }`

/** Every sidebar the viewer's schema declares, left and right. */
const PDF_SIDEBAR_IDS = [
  'sidebar-panel',
  'annotation-panel',
  'rubber-stamp-panel',
  'signature-panel',
  'search-panel',
  'widget-edit-panel',
  'comment-panel',
  'redaction-panel',
] as const

/**
 * The sidebars' widths, as a `ui.mergeSchema` partial: the viewer's schema
 * gives every sidebar a `width` (250px by default) and merges a partial into
 * each one field by field. Every one opens at `DRAWER_WIDTH`. Unlike a
 * `DrawerShell` they do not resize: a handle would mean writing into the
 * library's DOM against its own layout.
 */
export const PDF_SIDEBAR_WIDTHS: Readonly<Record<string, { width: string }>> = Object.fromEntries(
  PDF_SIDEBAR_IDS.map((id) => [id, { width: `${DRAWER_WIDTH.default}px` }]),
)

/** The class on the stand-in that plays a closing sidebar's slide out
 *  (`features/files/pdf-sidebar-leave.ts`). */
export const PDF_SIDEBAR_LEAVING = 'holi-sidebar-leaving'

/** The width for a sidebar the list above does not name, should the viewer
 *  add one: the drawer width too, so the slide is never the wrong distance. */
const VIEWER_SIDEBAR_WIDTH = `${DRAWER_WIDTH.default}px`

/**
 * A sidebar's header and edge, drawn as a `DrawerShell`'s are: a 44px row with
 * the title at 12px medium, a rule under it and a line on the inner edge, both
 * `--drawer-edge`, which is clear unless a vault theme draws it. Two shapes of
 * header, a padded row holding the `h2` (search, signatures, redaction) and
 * the same with the `h2` in a flex row (comments). The edge rules carry
 * `!important` and one class more to outrank the borderless rule's.
 */
const PDF_SIDEBAR_HEADER = ':is(.border-b.p-3, .border-b.p-4):has(> h2, > .flex > h2)'
export const PDF_SIDEBAR_FORM_CSS = [
  `[data-sidebar-id] ${PDF_SIDEBAR_HEADER} { display: flex; align-items: center; min-height: 44px; padding-block: 0; padding-inline: 12px; border-bottom-color: ${v('drawer-edge')} !important; }`,
  `[data-sidebar-id] ${PDF_SIDEBAR_HEADER} > .flex { flex: 1; min-width: 0; }`,
  `[data-sidebar-id] ${PDF_SIDEBAR_HEADER} h2 { margin: 0; font-size: 12px; line-height: 16px; font-weight: 500; color: ${v('foreground')}; }`,
  `[data-sidebar-id].border-r.border-r { border-right-color: ${v('drawer-edge')} !important; }`,
  `[data-sidebar-id].border-l.border-l { border-left-color: ${v('drawer-edge')} !important; }`,
].join('\n')

/**
 * A sidebar slides its whole width in from the edge it docks on, and back out
 * (D98). Left docks draw `border-r`, right docks `border-l`; the narrow-pane
 * bottom sheet has neither and keeps its own motion. The slide is a negative
 * margin, so the panel keeps its width while the `flex-1` pages move with it.
 * The width is an inline style, unreadable from CSS, so it is written here.
 *
 * `--motion-slide`/`--ease-slide` are the same both ways so a slide reads as
 * one motion. The viewer unmounts a closing panel in the same render, so the
 * leave is played by a stand-in (`PDF_SIDEBAR_LEAVING`). Keyframe names do not
 * reach into a shadow root, so they are declared here.
 */
export const PDF_SIDEBAR_MOTION_CSS = [
  `[data-sidebar-id] { --holi-sidebar-width: ${VIEWER_SIDEBAR_WIDTH}; }`,
  ...Object.entries(PDF_SIDEBAR_WIDTHS).map(
    ([id, { width }]) => `[data-sidebar-id="${id}"] { --holi-sidebar-width: ${width}; }`,
  ),
  '@keyframes holi-sidebar-in-left { from { margin-inline-start: calc(-1 * var(--holi-sidebar-width)); } }',
  '@keyframes holi-sidebar-in-right { from { margin-inline-end: calc(-1 * var(--holi-sidebar-width)); } }',
  '@keyframes holi-sidebar-out-left { to { margin-inline-start: calc(-1 * var(--holi-sidebar-width)); } }',
  '@keyframes holi-sidebar-out-right { to { margin-inline-end: calc(-1 * var(--holi-sidebar-width)); } }',
  '[data-sidebar-id].border-r { animation: holi-sidebar-in-left var(--motion-slide) var(--ease-slide); }',
  '[data-sidebar-id].border-l { animation: holi-sidebar-in-right var(--motion-slide) var(--ease-slide); }',
  `[data-sidebar-id].border-r.${PDF_SIDEBAR_LEAVING} { animation: holi-sidebar-out-left var(--motion-slide) var(--ease-slide) forwards; }`,
  `[data-sidebar-id].border-l.${PDF_SIDEBAR_LEAVING} { animation: holi-sidebar-out-right var(--motion-slide) var(--ease-slide) forwards; }`,
].join('\n')

/**
 * Holi's comment field (`features/files/PdfCommentField.tsx`) in the viewer's
 * comment row, in place of the viewer's one-line input.
 *
 * The textarea is portalled in after the viewer's input and send button, so
 * it is ordered first and the row uses a gap. The viewer's input stays
 * focusable but out of sight: selecting a comment focuses it, and Holi's field
 * takes that focus over. The field grows to about eight lines, then scrolls.
 */
const COMMENT_ROW = '[data-sidebar-id="comment-panel"] div:has(> .holi-comment-field)'
export const PDF_COMMENT_FIELD_CSS = [
  `${COMMENT_ROW} { gap: 8px; }`,
  `${COMMENT_ROW} > * { margin: 0; }`,
  `${COMMENT_ROW} > input[type="text"] { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }`,
  `textarea.holi-comment-field { order: -1; flex: 1; min-width: 0; min-height: 36px; max-height: 176px; field-sizing: content; resize: none; box-sizing: border-box; padding: 7px 12px; border: 1px solid ${v('divider')}; border-radius: 8px; background-color: ${v('input')}; color: ${v('foreground')}; font: inherit; font-size: 14px; line-height: 20px; outline: none; box-shadow: none; }`,
  `textarea.holi-comment-field::placeholder { color: ${v('muted-foreground')}; }`,
].join('\n')

/**
 * A comment as the viewer's one-line field can hold it: a line break is a
 * space, where the field would otherwise drop it and join the words.
 */
export function singleLine(text: string): string {
  return text.replace(/\r?\n/g, ' ')
}

/** Everything Holi puts into the viewer's shadow root, as one stylesheet. */
export const PDF_SHADOW_CSS = [
  PDF_PAGE_PLACEHOLDER_CSS,
  PDF_VIEWPORT_CSS,
  PDF_BORDERLESS_CSS,
  PDF_SCROLLBAR_CSS,
  PDF_SIGNATURE_DIALOG_CSS,
  PDF_TOOLBAR_CSS,
  PDF_SIDEBAR_MOTION_CSS,
  PDF_SIDEBAR_FORM_CSS,
  PDF_COMMENT_FIELD_CSS,
].join('\n')

/**
 * Holi's own icons for the viewer's toolbar, as SVG path data (the viewer's
 * icon registry takes paths only). Read from vanilla `lucide`, the set the
 * rest of Holi draws from, so a `rect` or `circle` in the geometry is spelled
 * here as the path that draws the same outline.
 */
function iconPaths(node: IconNode): string[] {
  return node.map(([tag, attrs]) => {
    const n = (key: string) => Number(attrs[key] ?? 0)
    if (tag === 'path') return String(attrs.d)
    if (tag === 'circle') {
      const [cx, cy, r] = [n('cx'), n('cy'), n('r')]
      return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`
    }
    if (tag === 'rect') {
      const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')]
      const r = Math.min(n('rx'), w / 2, h / 2)
      const arc = (dx: number, dy: number) => (r === 0 ? '' : `a${r} ${r} 0 0 1 ${dx} ${dy}`)
      return (
        `M${x + r} ${y}h${w - 2 * r}${arc(r, r)}v${h - 2 * r}${arc(-r, r)}` +
        `h${2 * r - w}${arc(-r, -r)}v${2 * r - h}${arc(r, -r)}z`
      )
    }
    throw new Error(`PDF icon: no path for <${tag}>`)
  })
}
const lucideIcon = (node: IconNode) => ({
  paths: iconPaths(node).map((d) => ({ d, stroke: 'currentColor' })),
  // A number, as the registry takes it: the `--icon-stroke` value.
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})
export const PDF_ICONS = {
  'holi-lock': lucideIcon(Lock),
  'holi-lock-open': lucideIcon(LockOpen),
  // The agent's mark elsewhere in Holi (the palette, mail).
  'holi-sparkles': lucideIcon(Sparkles),
}

/**
 * What placing a signature shares, said where it is placed from: the foot of
 * the Signatures panel, for as long as the panel is open (D104). A signature
 * on a page is an image inside the PDF, the PDF is committed and synced, and
 * anyone with the file can extract that image, from any earlier commit too.
 */
export const PDF_SIGNATURE_NOTE =
  'A signature you place is saved into this PDF, which is committed to the vault. Anyone with access to the vault can copy it, and removing it later leaves it in the history.'

/**
 * The viewer's red, `#E44234`: its default for underline, strikeout,
 * squiggly, insert and replace text, the pen, every shape and free text.
 * The highlighters are yellow and a comment's note blue, and stay so.
 */
const VIEWER_RED = '#e44234'

/** A drawing tool as the viewer's annotation plugin lists one, as far as this reads it. */
export interface PdfTool {
  id: string
  defaults: Record<string, unknown>
}

/**
 * The tool defaults that make the viewer's red the theme's colour instead:
 * for each tool with a default in that red, a patch for `setToolDefaults`
 * setting those keys (and only those) to `color`. A mark's colour is written
 * into the PDF, so `color` is a hex, not a token.
 */
export function themedToolDefaults(
  tools: readonly PdfTool[],
  color: string,
): { toolId: string; patch: Record<string, string> }[] {
  return tools.flatMap(({ id, defaults }) => {
    const keys = Object.keys(defaults).filter(
      (key) => typeof defaults[key] === 'string' && defaults[key].toLowerCase() === VIEWER_RED,
    )
    return keys.length === 0
      ? []
      : [{ toolId: id, patch: Object.fromEntries(keys.map((key) => [key, color])) }]
  })
}

/**
 * A computed colour (`rgb(0, 105, 168)`) as the `#0069a8` a PDF stores, or
 * null when it is not an opaque `rgb()`/`rgba()`: a theme may write its
 * colours as `oklch()`, which the browser computes as itself.
 */
export function hexOfRgb(css: string): string | null {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(css.trim())
  if (match === null || (match[4] !== undefined && Number(match[4]) !== 1)) return null
  return `#${match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('')}`
}

/** The widest a PDF opens: 150%, where 100% is one CSS pixel per PDF point. */
export const PDF_OPENING_ZOOM_MAX = 1.5

/**
 * A PDF opens at 150%, or at fit-width when the page would overflow the pane
 * at 150%. The viewer has no such mode, so it opens at fit-width and this caps
 * the first zoom only, so a later Fit Width still fits. `null` is "leave it".
 */
export function openingZoomCap(level: string | number, zoom: number): number | null {
  return level === 'fit-width' && zoom > PDF_OPENING_ZOOM_MAX ? PDF_OPENING_ZOOM_MAX : null
}

/**
 * A keydown spelled the way the viewer's shortcut table spells one:
 * `ctrl`/`shift`/`alt`/`meta` plus the lower-cased key, sorted, joined with
 * `+`; a bare modifier is nothing. Mirrors the plugin so `PdfViewer` can ask
 * `getCommandByShortcut` whether a key pressed OUTSIDE the viewer would have
 * been claimed by it, and stop it first.
 */
export function shortcutOf(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey) parts.push('ctrl')
  if (event.shiftKey) parts.push('shift')
  if (event.altKey) parts.push('alt')
  if (event.metaKey) parts.push('meta')
  let key = event.key.toLowerCase()
  if (key === ' ') key = 'space'
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return null
  return [...parts, key].sort().join('+')
}
