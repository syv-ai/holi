/**
 * What the embedded PDF viewer may do, as data (D103).
 *
 * embedpdf's ready-made viewer ships a toolbar and a commands plugin that binds
 * shortcuts on `document`. Three things about it are Holi's to decide and live
 * here as pure values so a node test can hold them still: which command
 * categories are switched off, how its palette is fed from Holi's theme tokens,
 * and how a keydown is spelled the way its shortcut table spells one.
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
      // three are the pane; the toolbar's own border is what separates them.
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
 * looks white. Adopted into the viewer's shadow root, where `!important` beats
 * the inline style; the selector is the library's own white, so it catches
 * every place it paints one and nothing else.
 */
export const PDF_PAGE_PLACEHOLDER_CSS = `[style*="background-color: rgb(255, 255, 255)"] { background-color: ${v('muted')} !important; }`

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
