/**
 * What the embedded PDF viewer may do, as data (D103).
 *
 * embedpdf's ready-made viewer ships a toolbar and a commands plugin that binds
 * shortcuts on `document`. What about it is Holi's to decide lives here as
 * pure values so a node test can hold them still: which command categories are
 * switched off, how its palette is fed from Holi's theme tokens, the CSS put
 * into its shadow root, the zoom a document opens at, and how a keydown is
 * spelled the way its shortcut table spells one.
 *
 * No React, no DOM globals beyond the `KeyboardEvent` type: `features/files/`
 * consumes this, `test/pdf-viewer-config.test.ts` pins it.
 */
import { MAKE_EDITABLE, MAKE_READ_ONLY } from './pdf-read-only'

/**
 * Disabled by category, which removes the command AND its shortcut together.
 *
 * The first block is what would collide: `document-open` is ⌘O and a file
 * picker; `document-print` is ⌘P, which the plugin would `stopPropagation` on
 * before Holi's palette saw it; `document-close` is ⌘W, which is a menu
 * accelerator and closes Holi's tab, not the viewer's document; `capture` is
 * ⌘⇧S. The second block is what a pane is not for: exporting, protecting,
 * fullscreen, the hamburger menu they hang from, and the annotation families
 * outside "highlight and mark up": redaction, stamps, forms, and the Insert
 * tab's rubber stamp, image and attachment. Signatures are the one Insert item
 * kept (D104), and they sit on the top bar (`withHoliButtons`), so the
 * Insert tab itself (`mode-insert`) goes as well: it would only repeat them.
 *
 * The names are the viewer's own, read from its commands and UI schema, and a
 * name that matches nothing fails silently: this list once said `signature`,
 * which is not a category, and the whole Insert tab leaked in through it.
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
 * Its UI is Preact inside a shadow root, but the palette is a token map written
 * as `--ep-*` custom properties on that root, and a custom property inherits
 * across the shadow boundary — so a value of `var(--background)` is accepted
 * verbatim and resolves to whatever the vault's theme (D64) put on the document
 * root. The same map serves light and dark because the variables already flip
 * with the mode; only `preference` carries the mode itself.
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
 * embedpdf's page renderer hard-codes `backgroundColor: "#fff"` inline on every
 * page wrapper, with no config for it, and PDFium's bitmap arrives some tens of
 * milliseconds later. On a dark PDF that gap is a white flash. The bitmap is
 * rendered onto opaque white paper of its own (the engine fills it before
 * drawing), so the wrapper is only ever a placeholder and a white PDF still
 * looks white. Put into the viewer's shadow root, where `!important` beats
 * the inline style; the selector is the library's own white, so it catches
 * every place it paints one and nothing else.
 */
export const PDF_PAGE_PLACEHOLDER_CSS = `[style*="background-color: rgb(255, 255, 255)"] { background-color: ${v('muted')} !important; }`

/**
 * The page scroller keeps room for its scrollbar from the start.
 *
 * The scrollbar appears only once the pages lay out taller than the pane, and
 * takes its width from the viewport. The viewer recomputes fit-width on that
 * resize, 150 ms later, which on a narrow pane was a visible second zoom
 * during the arrival fade (93.9% to 92.5%). A stable gutter means the width
 * the first fit-width sees is the width it keeps. The scroller is the
 * viewport, painted `bg-bg-app` with an inline `overflow: auto`.
 */
export const PDF_VIEWPORT_CSS = `.bg-bg-app[style*="overflow: auto"] { scrollbar-gutter: stable; }`

/**
 * No lines between regions, the way Holi's own chrome has none.
 *
 * The viewer draws a rule under each toolbar, beside each sidebar, between
 * sections of its panels and menus, and around floating things like the page
 * pill, all as `border-border-default` or `-subtle`; the dividers between
 * toolbar groups are 1px boxes painted `bg-border-default`. Those go clear.
 * Dividers stay as space, so the toolbar keeps its rhythm, and a menu or the
 * page pill is separated from the page by the shadow it already has, which is
 * how Holi's own menus and tooltips are drawn. Form controls keep their
 * outline, dimmed to `--divider`: every one sits on `bg-bg-input`, and an input
 * with no edge is hard to find. The dimming stands aside under `:focus`, so a
 * focused field still brightens to its accent. The selectors' two classes
 * outrank the single-class utilities they override, so no `!important`.
 */
export const PDF_BORDERLESS_CSS = [
  ':is(.border-border-default, .border-border-subtle):not(.bg-bg-input) { border-color: transparent; }',
  ':is(.w-px, .h-px).bg-border-default { background-color: transparent; }',
  '.ring-border-default { --tw-ring-color: transparent; }',
  `.bg-bg-input.border-border-default:not(:focus) { border-color: ${v('divider')}; }`,
  // A toolbar button is selected (the pointer, pan) or hovered by its
  // background alone: the 1px ring both drew is a Tailwind `--tw-ring`, a
  // box-shadow keyed on this colour, and the mode select's edge an outline.
  // The selected one also had a drop shadow of its own, and drew its icon in
  // the accent, blue on the blue selection: its icon is the foreground, like
  // every other button's. A mode tab is `text-accent` with no background, so
  // its underline and text still mark it.
  'button:is(.ring-accent, .hover\\:ring-accent:hover) { --tw-ring-color: transparent; }',
  'button.ring-accent { box-shadow: none; }',
  `button.bg-interactive-selected.text-accent { color: ${v('foreground')}; }`,
  // The zoom group (level select, zoom out, zoom in) sat on the hover colour
  // at rest, so it read as a grey block on the toolbar. It stands on the
  // toolbar's own colour; its buttons still take the hover fill. The only
  // other static uses of the class are buttons (a menu's highlighted row, the
  // comment Cancel), where the fill is the state, so the rule names the div.
  'div.bg-interactive-hover { background-color: transparent; }',
  '.outline-border-default { outline-color: transparent; }',
  // A sidebar (thumbnails, search, comments) is set apart from the pane by
  // colour: `--card`, a step up from `--background`, where the viewer drew a
  // border on `surface`. Nothing inside it has an edge either, a selected
  // search hit included, except a form field's dimmed outline.
  `[data-sidebar-id], [data-sidebar-id] .bg-bg-surface { background-color: ${v('card')}; }`,
  '[data-sidebar-id] :not(input, textarea) { border-color: transparent !important; }',
  // Nor a ring or a shadow: the selected comment drew a 2px focus-ring blue
  // ring, the comment and edit fields a ring on focus, the cards a shadow. A
  // menu floating over the panel (`bg-bg-elevated`) keeps its shadow, which is
  // what lifts it off the panel. The selected comment is marked by colour,
  // and a field keeps its dimmed edge whether focused or not.
  '[data-sidebar-id] :not(.bg-bg-elevated) { box-shadow: none !important; }',
  `[data-sidebar-id] .ring-interactive-focus-ring { background-color: ${v('accent')}; }`,
  `[data-sidebar-id] :is(input, textarea) { border-color: ${v('divider')} !important; }`,
].join('\n')

/**
 * Holi's scrollbar, inside the viewer.
 *
 * `index.css` styles every scrollbar in the app with a bare `::-webkit-scrollbar`
 * rule, but a document stylesheet does not reach into a shadow root, so the
 * viewer kept its own: 8px, always painted. This is Holi's shape again (10px, a
 * clear track, a thumb inset from the edge that shows while the pointer is over
 * the scroller) written against `:host *`, the same selector as the viewer's
 * rule it replaces, and later in the root so it wins. The colours are the
 * palette's `scrollbar` group.
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
 * Its panel painted `surface`, which is the pane's colour here, so it sat on
 * the page with nothing to lift it; it is Holi's dialog surface, `--popover`,
 * as `primitives/Dialog.tsx` is. Its three places to make a signature (the
 * Draw canvas, the Type field, the Upload zone) were outlined, and the
 * borderless rules took the outlines away. They are paper instead, because a
 * signature is black ink: drawn, typed or uploaded, the mark was invisible on
 * a dark pad. `light-dark()` picks by the colour scheme the viewer inherits
 * from the root, so dark mode gets white paper and light mode, whose dialog is
 * already white, gets `--muted`. White is the one literal in these rules, and
 * it is the paper, not chrome, for the same reason PDFium paints pages white.
 *
 * The Upload zone showed a file dragged over it by its border; that is now
 * `--selection`. One class more than the paper rule, because `:is()` takes
 * its most specific argument and would otherwise win.
 */
export const PDF_SIGNATURE_DIALOG_CSS = [
  `.bg-bg-overlay > .bg-bg-surface { background-color: ${v('popover')}; }`,
  `.bg-bg-overlay :is(canvas.border-border-default, .border-dashed.border-border-default, .border-border-default:has(> input[type="text"])) { background-color: light-dark(${v('muted')}, white); }`,
  `.bg-bg-overlay .border-dashed.border-border-default.border-accent { background-color: ${v('selection')}; }`,
  // `PDF_SIGNATURE_NOTE`, at the foot of the Signatures panel. Tailwind's
  // classes do not reach into the shadow root, so its look is here.
  `.holi-signature-note { margin: 0; padding: 12px 16px; font-size: 12px; line-height: 1.5; color: ${v('muted-foreground')}; }`,
].join('\n')

/**
 * The viewer's fonts, none of them fetched.
 *
 * Left to itself the viewer adds Google Fonts stylesheets to Holi's page: Open
 * Sans for its UI whenever it starts, and Caveat, Dancing Script, Great Vibes
 * and Pacifico for typed signatures when that dialog opens. That is a request
 * on every PDF, from an app whose viewer was chosen partly for making none.
 * The UI is Holi's own font instead, and the four script faces are bundled
 * with the app (`@fontsource/*`, OFL-1.1, imported by `PdfDocument`) under the
 * family names the viewer already lists, so its font picker is unchanged.
 */
export const PDF_FONTS = {
  ui: { family: 'var(--font-sans)', stylesheetUrl: null },
  signature: { stylesheetUrl: null },
}

/**
 * The bundled script faces, by the family names the viewer lists. Loaded when
 * the signature panel opens: the viewer used to load them with the Google
 * stylesheet, and without that nothing asks for them before the Type tab's
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

/**
 * The main toolbar's items with Holi's buttons at the top level, first in the
 * right-hand group beside Search and Comment: Signatures, which the viewer
 * keeps in the Insert tab's secondary bar (at a narrow pane itself inside the
 * tab overflow menu), and the read-only toggle (`lib/pdf-read-only.ts`). Fed to
 * `ui.mergeSchema`, which replaces a toolbar's item list wholesale, so this
 * returns the whole list; applying it twice changes nothing.
 */
export function withHoliButtons(items: readonly PdfToolbarItem[]): PdfToolbarItem[] {
  return items.map((item) => {
    if (item.id !== 'right-group' || item.items === undefined) return item
    const present = new Set(item.items.map((child) => child.id))
    const missing = HOLI_BUTTONS.filter((button) => !present.has(button.id))
    return missing.length === 0 ? item : { ...item, items: [...missing, ...item.items] }
  })
}

/**
 * Holi's buttons keep their places as they come and go.
 *
 * A command that is not visible leaves its item's wrapper in the row, empty,
 * and an empty wrapper is still a flex item with a gap on either side. The
 * read-only toggle is two items of which one is always hidden, so the lock
 * sat 8px further from one neighbour than the other and the extra gap changed
 * sides with the state: the lock stepped right when locked and back when
 * unlocked. The viewer's own spacers are empty too, on purpose, so the rule
 * names Holi's items and nothing else.
 */
export const PDF_TOOLBAR_CSS = `:is(${HOLI_BUTTONS.map((b) => `[data-epdf-i="${b.id}"]`).join(', ')}):empty { display: none; }`

/** Everything Holi puts into the viewer's shadow root, as one stylesheet. */
export const PDF_SHADOW_CSS = [
  PDF_PAGE_PLACEHOLDER_CSS,
  PDF_VIEWPORT_CSS,
  PDF_BORDERLESS_CSS,
  PDF_SCROLLBAR_CSS,
  PDF_SIGNATURE_DIALOG_CSS,
  PDF_TOOLBAR_CSS,
].join('\n')

/**
 * Holi's own icons for the viewer's toolbar, as SVG path data (the viewer's
 * icon registry takes paths only). lucide's `lock` and `lock-open`, the set
 * the rest of Holi draws from, with the body's `rect` spelled as a path.
 */
const LOCK_BODY = 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z'
const lucideIcon = (...d: string[]) => ({
  paths: d.map((path) => ({ d: path, stroke: 'currentColor' })),
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})
export const PDF_ICONS = {
  'holi-lock': lucideIcon(LOCK_BODY, 'M7 11V7a5 5 0 0 1 10 0v4'),
  'holi-lock-open': lucideIcon(LOCK_BODY, 'M7 11V7a5 5 0 0 1 9.9-1'),
}

/**
 * What placing a signature shares, said where it is placed from: the foot of
 * the Signatures panel, for as long as the panel is open (D104). A signature
 * on a page is an image inside the PDF, the PDF is committed and synced, and
 * anyone with the file can extract that image, from any earlier commit too.
 */
export const PDF_SIGNATURE_NOTE =
  'A signature you place is saved into this PDF, which is committed to the vault. Anyone with access to the vault can copy it, and removing it later leaves it in the history.'

/** The widest a PDF opens: 150%, where 100% is one CSS pixel per PDF point. */
export const PDF_OPENING_ZOOM_MAX = 1.5

/**
 * A PDF opens at 150%, or at fit-width when the page would overflow the pane
 * at 150%. The viewer has no such mode (its `automatic` is fit-width capped at
 * 100%), so it opens at fit-width and this caps the result. Asked of the first
 * zoom a document gets and no later one, so choosing Fit Width from the menu
 * still fits the width. `null` is "leave it".
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
