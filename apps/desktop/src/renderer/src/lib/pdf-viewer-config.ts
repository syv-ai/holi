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
/**
 * Disabled by category, which removes the command AND its shortcut together.
 *
 * The first block is what would collide: `document-open` is ⌘O and a file
 * picker; `document-print` is ⌘P, which the plugin would `stopPropagation` on
 * before Holi's palette saw it; `document-close` is ⌘W, which is a menu
 * accelerator and closes Holi's tab, not the viewer's document; `capture` is
 * ⌘⇧S. The second block is what a pane is not for: exporting, protecting,
 * fullscreen, the hamburger menu they hang from, and the annotation families
 * outside "highlight and mark up": redaction, signatures, stamps, forms.
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
  'signature',
  'stamp',
  'form',
  'security',
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
  // The selected one also had a drop shadow of its own.
  'button:is(.ring-accent, .hover\\:ring-accent:hover) { --tw-ring-color: transparent; }',
  'button.ring-accent { box-shadow: none; }',
  '.outline-border-default { outline-color: transparent; }',
  // A sidebar (thumbnails, search, comments) is set apart from the pane by
  // colour: `--card`, a step up from `--background`, where the viewer drew a
  // border on `surface`. Nothing inside it has an edge either, a selected
  // search hit included, except a form field's dimmed outline.
  `[data-sidebar-id], [data-sidebar-id] .bg-bg-surface { background-color: ${v('card')}; }`,
  '[data-sidebar-id] :not(input, textarea) { border-color: transparent !important; }',
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

/** Everything Holi puts into the viewer's shadow root, as one stylesheet. */
export const PDF_SHADOW_CSS = [
  PDF_PAGE_PLACEHOLDER_CSS,
  PDF_VIEWPORT_CSS,
  PDF_BORDERLESS_CSS,
  PDF_SCROLLBAR_CSS,
].join('\n')

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
