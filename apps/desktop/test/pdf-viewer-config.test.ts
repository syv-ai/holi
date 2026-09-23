import { THEME_TOKENS } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  PDF_COMMENT_FIELD_CSS,
  PDF_DISABLED_CATEGORIES,
  PDF_FONTS,
  PDF_ICONS,
  PDF_BORDERLESS_CSS,
  PDF_PAGE_PLACEHOLDER_CSS,
  PDF_SCROLLBAR_CSS,
  PDF_SHADOW_CSS,
  PDF_SIGNATURE_DIALOG_CSS,
  PDF_SIGNATURE_FONT_FAMILIES,
  PDF_SIDEBAR_MOTION_CSS,
  PDF_SIDEBAR_WIDTHS,
  PDF_SIGNATURE_NOTE,
  PDF_TOOLBAR_CSS,
  PDF_VIEWPORT_CSS,
  openingZoomCap,
  withHoliButtons,
  pdfViewerTheme,
  shortcutOf,
  singleLine,
} from '../src/renderer/src/lib/pdf-viewer-config'

describe('PDF_DISABLED_CATEGORIES', () => {
  it('removes every viewer command whose shortcut Holi or the OS already owns', () => {
    // ⌘O opens a file picker, ⌘P is the palette, ⌘W is the menu accelerator,
    // ⌘⇧S is the screenshot the mail view's save would collide with.
    expect(PDF_DISABLED_CATEGORIES).toEqual(
      expect.arrayContaining(['document-open', 'document-print', 'document-close', 'capture']),
    )
  })

  it("hides the Insert tab's stamp, image and attachment, and keeps its signatures", () => {
    // The viewer's real category names, read from its commands: `insert-*`.
    // A bare `signature` matched nothing, which is how the whole Insert tab
    // leaked in; signatures are now a feature (D104), the rest are not.
    expect(PDF_DISABLED_CATEGORIES).toEqual(
      expect.arrayContaining(['insert-rubber-stamp', 'insert-image', 'insert-attachment']),
    )
    // Signatures sit on the top bar, so the Insert tab, which would only
    // repeat them, is gone too.
    expect(PDF_DISABLED_CATEGORIES).toContain('mode-insert')
    for (const kept of ['insert', 'insert-signature', 'signature']) {
      expect(PDF_DISABLED_CATEGORIES).not.toContain(kept)
    }
  })

  it('keeps reading, searching and marking', () => {
    for (const kept of ['zoom', 'search', 'selection', 'annotation', 'history', 'scroll', 'pan']) {
      expect(PDF_DISABLED_CATEGORIES).not.toContain(kept)
    }
  })
})

describe('pdfViewerTheme', () => {
  const walk = (node: unknown, out: string[] = []): string[] => {
    if (typeof node === 'string') out.push(node)
    else if (node && typeof node === 'object') Object.values(node).forEach((v) => walk(v, out))
    return out
  }

  it('speaks only in Holi tokens, never a colour literal', () => {
    const theme = pdfViewerTheme('dark')
    const values = [...walk(theme.light), ...walk(theme.dark)]
    expect(values.length).toBeGreaterThan(10)
    for (const value of values) {
      const m = /^var\(--([a-z-]+)\)$/.exec(value)
      expect(m, value).not.toBeNull()
      expect(THEME_TOKENS, value).toContain(m![1])
    }
  })

  it('paints its toolbars from the pane background, so they sit flush with Holi', () => {
    // `surface` is every toolbar and sidebar, `surfaceAlt` the Annotate and
    // Shapes secondary toolbar: both measured, both were grey bands.
    const { background } = pdfViewerTheme('dark').dark
    expect(background.app).toBe('var(--background)')
    expect(background.surface).toBe('var(--background)')
    expect(background.surfaceAlt).toBe('var(--background)')
  })

  it("paints tooltips and scrollbars the way Holi's own are painted", () => {
    // Left out, these fell back to embedpdf's palette: a light #f9fafb tooltip
    // in dark mode and a grey-blue scrollbar track.
    const theme = pdfViewerTheme('dark').dark
    expect(theme.tooltip).toEqual({
      background: 'var(--popover)',
      foreground: 'var(--popover-foreground)',
    })
    expect(theme.scrollbar).toEqual({
      track: 'var(--background)',
      thumb: 'var(--scrollbar-thumb)',
      thumbHover: 'var(--scrollbar-thumb-hover)',
    })
    expect(theme.foreground.disabled).toBe('var(--muted-foreground)')
  })

  it('carries the mode as the preference and the same map for both modes', () => {
    expect(pdfViewerTheme('light').preference).toBe('light')
    expect(pdfViewerTheme('dark').preference).toBe('dark')
    // The variables already flip with the mode; the map does not have to.
    expect(pdfViewerTheme('dark').light).toEqual(pdfViewerTheme('dark').dark)
  })
})

describe('PDF_PAGE_PLACEHOLDER_CSS', () => {
  it("overrides the viewer's hard-coded white page with a Holi token", () => {
    // embedpdf paints every page wrapper `#fff` inline until PDFium's bitmap
    // lands; on a dark PDF that is the white flash. The bitmap brings its own
    // paper, so the wrapper is only ever a placeholder.
    expect(PDF_PAGE_PLACEHOLDER_CSS).toContain('[style*="background-color: rgb(255, 255, 255)"]')
    const values = [
      ...PDF_PAGE_PLACEHOLDER_CSS.matchAll(/\{\s*background-color:\s*([^;!]+?)\s*!important/g),
    ]
    expect(values).toHaveLength(1)
    const m = /^var\(--([a-z-]+)\)$/.exec(values[0]![1]!)
    expect(m, values[0]![1]).not.toBeNull()
    expect(THEME_TOKENS).toContain(m![1])
  })
})

describe('PDF_VIEWPORT_CSS', () => {
  it("reserves the scroller's scrollbar gutter, so fit-width is right the first time", () => {
    // Without it the scrollbar appears once pages lay out, the viewport
    // narrows by its width, and fit-width is recomputed mid-fade.
    expect(PDF_VIEWPORT_CSS).toMatch(
      /^\.bg-bg-app\[style\*="overflow: auto"\] \{ scrollbar-gutter: stable; \}$/,
    )
  })
})

describe('PDF_BORDERLESS_CSS', () => {
  it('clears every separator and container edge, and nothing else', () => {
    // Region edges and section rules (toolbars, sidebars, menus, the page
    // pill) are `border-border-default`/`-subtle`; the toolbar dividers are
    // 1px boxes painted `bg-border-default`. Form controls sit on
    // `bg-bg-input` and keep their outline.
    expect(PDF_BORDERLESS_CSS).toContain(
      ':is(.border-border-default, .border-border-subtle):not(.bg-bg-input) { border-color: transparent; }',
    )
    expect(PDF_BORDERLESS_CSS).toContain(
      ':is(.w-px, .h-px).bg-border-default { background-color: transparent; }',
    )
    expect(PDF_BORDERLESS_CSS).toContain('.ring-border-default { --tw-ring-color: transparent; }')
    // A form control keeps its edge, dimmed to the divider tone, and brightens
    // to its accent when focused (the rule stands aside under :focus).
    expect(PDF_BORDERLESS_CSS).toContain(
      '.bg-bg-input.border-border-default:not(:focus) { border-color: var(--divider); }',
    )
  })
})

describe('PDF_BORDERLESS_CSS, buttons and sidebars', () => {
  it('shows a toolbar button as selected or hovered by its background alone', () => {
    // The selected tool and every hovered button drew a 1px `--tw-ring`, a
    // box-shadow; the narrow-width mode select drew an outline.
    expect(PDF_BORDERLESS_CSS).toContain(
      'button:is(.ring-accent, .hover\\:ring-accent:hover) { --tw-ring-color: transparent; }',
    )
    expect(PDF_BORDERLESS_CSS).toContain('.outline-border-default { outline-color: transparent; }')
    // The selected tool also carried a drop shadow; background alone means none.
    expect(PDF_BORDERLESS_CSS).toContain('button.ring-accent { box-shadow: none; }')
    // Its icon kept the accent colour of the ring, blue on the blue selection;
    // the background is the state, the icon stays the foreground.
    expect(PDF_BORDERLESS_CSS).toContain(
      'button.bg-interactive-selected.text-accent { color: var(--foreground); }',
    )
    // The zoom group (select and its two buttons) was painted the hover colour
    // at rest; it is the only <div> that wears that class statically.
    expect(PDF_BORDERLESS_CSS).toContain(
      'div.bg-interactive-hover { background-color: transparent; }',
    )
  })

  it('lays a sidebar flat on the pane, with no border inside it', () => {
    // Like Holi's own file tree: `--background`, nothing between it and the pane.
    expect(PDF_BORDERLESS_CSS).toContain(
      '[data-sidebar-id], [data-sidebar-id] .bg-bg-surface { background-color: var(--background); }',
    )
    expect(PDF_BORDERLESS_CSS).toContain(
      '[data-sidebar-id] :not(input, textarea) { border-color: transparent !important; }',
    )
  })

  it('draws no round avatar beside a comment or a reply, only the name', () => {
    expect(PDF_BORDERLESS_CSS).toContain(
      '[data-sidebar-id="comment-panel"] .rounded-full:is(.bg-bg-surface-alt, .text-white) { display: none; }',
    )
  })

  it("starts each page's heading where the comments under it start", () => {
    expect(PDF_BORDERLESS_CSS).toContain(
      '[data-sidebar-id="comment-panel"] .sticky.top-0:has(h3) { padding-inline-start: calc(0.25rem + 1px + 1rem); }',
    )
  })

  it('draws no ring or shadow in a sidebar, so a comment is selected by colour', () => {
    // The selected comment drew `ring-2` in the focus-ring blue, the comment
    // field `focus:ring-2`, the edit field `focus:ring-1`; cards a shadow. A
    // menu that floats over the panel (`bg-bg-elevated`) keeps its shadow.
    expect(PDF_BORDERLESS_CSS).toContain(
      '[data-sidebar-id] :not(.bg-bg-elevated) { box-shadow: none !important; }',
    )
    expect(PDF_BORDERLESS_CSS).toContain(
      '[data-sidebar-id] .ring-interactive-focus-ring { background-color: var(--accent); }',
    )
    // A field keeps its dimmed edge, focused or not, never the accent.
    expect(PDF_BORDERLESS_CSS).toContain(
      '[data-sidebar-id] :is(input, textarea) { border-color: var(--divider) !important; }',
    )
  })
})

describe('PDF_SCROLLBAR_CSS', () => {
  it("draws Holi's scrollbar: 10px, clear track, a thumb that shows on hover", () => {
    expect(PDF_SCROLLBAR_CSS).toContain('width: 10px; height: 10px;')
    expect(PDF_SCROLLBAR_CSS).toContain(
      ':host *::-webkit-scrollbar-track { background: transparent; }',
    )
    expect(PDF_SCROLLBAR_CSS).toMatch(
      /:host \*:hover::-webkit-scrollbar-thumb \{ background: var\(--scrollbar-thumb\);/,
    )
    // Motion from D98's tokens, never a number.
    expect(PDF_SCROLLBAR_CSS).toContain('var(--motion-respond) var(--ease-settle)')
    expect(PDF_SCROLLBAR_CSS).not.toMatch(/\d+m?s\b/)
  })
})

describe('PDF_SIGNATURE_DIALOG_CSS', () => {
  it("is Holi's dialog surface, with paper to sign on", () => {
    expect(PDF_SIGNATURE_DIALOG_CSS).toContain(
      '.bg-bg-overlay > .bg-bg-surface { background-color: var(--popover); }',
    )
    // Signatures are black ink: on a dark pad the drawn, typed or uploaded mark
    // was invisible. White paper in dark mode, --muted on the white light-mode
    // dialog, chosen by the colour-scheme the viewer inherits.
    expect(PDF_SIGNATURE_DIALOG_CSS).toContain(
      '.bg-bg-overlay :is(canvas.border-border-default, .border-dashed.border-border-default, .border-border-default:has(> input[type="text"])) { background-color: light-dark(var(--muted), white); }',
    )
    // The drop zone's drag highlight was its border; it is now a colour.
    expect(PDF_SIGNATURE_DIALOG_CSS).toContain(
      '.bg-bg-overlay .border-dashed.border-border-default.border-accent { background-color: var(--selection); }',
    )
  })
})

describe('PDF_SIGNATURE_DIALOG_CSS, the panel header', () => {
  const header = '[data-sidebar-id="signature-panel"] .border-b.p-3:has(> h2)'

  it('puts Create New Signature beside the title, as a toolbar icon button', () => {
    expect(PDF_SIGNATURE_DIALOG_CSS).toContain(
      `${header} { display: flex; align-items: center; justify-content: space-between;`,
    )
    const button = PDF_SIGNATURE_DIALOG_CSS.split('\n').find((r) =>
      r.startsWith(`${header} > button {`),
    )
    // The top bar's icon buttons: 32px, rounded-md, no fill at rest.
    expect(button).toMatch(/width: 32px; height: 32px;/)
    expect(button).toMatch(/border-radius: 6px;/)
    expect(button).toMatch(/background-color: transparent;/)
    expect(PDF_SIGNATURE_DIALOG_CSS).toContain(
      `${header} > button:hover { background-color: var(--accent); }`,
    )
    // The label stays in the DOM as its accessible name, at no size.
    expect(button).toMatch(/font-size: 0;/)
    // The plus is drawn in a token, never a literal or a fetched image.
    expect(button).toMatch(/linear-gradient\(var\(--foreground\), var\(--foreground\)\)/)
    expect(button).not.toMatch(/url\(/)
  })
})

describe('PDF_SIGNATURE_NOTE', () => {
  it('says where a placed signature goes and who can copy it, in plain words', () => {
    expect(PDF_SIGNATURE_NOTE).toMatch(/saved into this PDF/)
    expect(PDF_SIGNATURE_NOTE).toMatch(/copy it/)
    expect(PDF_SIGNATURE_NOTE).toMatch(/history/)
    expect(PDF_SIGNATURE_NOTE).not.toMatch(/\u2014/) // no em dashes in UI copy
  })

  it('is styled from Holi tokens inside the shadow root', () => {
    expect(PDF_SIGNATURE_DIALOG_CSS).toMatch(
      /\.holi-signature-note \{[^}]*color: var\(--muted-foreground\);[^}]*\}/,
    )
  })
})

describe('PDF_SHADOW_CSS', () => {
  it('is every rule Holi puts into the viewer, in one stylesheet', () => {
    for (const rule of [
      PDF_PAGE_PLACEHOLDER_CSS,
      PDF_VIEWPORT_CSS,
      PDF_BORDERLESS_CSS,
      PDF_SCROLLBAR_CSS,
      PDF_SIGNATURE_DIALOG_CSS,
      PDF_TOOLBAR_CSS,
      PDF_SIDEBAR_MOTION_CSS,
      PDF_COMMENT_FIELD_CSS,
    ]) {
      expect(PDF_SHADOW_CSS).toContain(rule)
    }
  })
})

describe('PDF_FONTS', () => {
  it("fetches nothing: every font is Holi's or bundled with the app", () => {
    // Left to itself the viewer adds Google Fonts stylesheets to the page, Open
    // Sans on every open and four script faces for typed signatures.
    expect(PDF_FONTS.ui).toEqual({ family: 'var(--font-sans)', stylesheetUrl: null })
    expect(PDF_FONTS.signature).toEqual({ stylesheetUrl: null })
    expect(JSON.stringify(PDF_FONTS)).not.toMatch(/https?:/)
  })

  it('names the bundled script faces, to load before a signature is typed', () => {
    expect(PDF_SIGNATURE_FONT_FAMILIES).toEqual([
      'Caveat',
      'Dancing Script',
      'Great Vibes',
      'Pacifico',
    ])
  })
})

describe('withHoliButtons', () => {
  // The shape of the live main toolbar, trimmed to what matters here.
  const items = [
    { type: 'group', id: 'left-group', items: [{ type: 'command-button', id: 'x' }] },
    { type: 'spacer', id: 'spacer-2' },
    {
      type: 'group',
      id: 'right-group',
      items: [
        { type: 'command-button', id: 'search-button', commandId: 'panel:toggle-search' },
        { type: 'command-button', id: 'comment-button', commandId: 'panel:toggle-comment' },
      ],
    },
  ]

  it('puts Signatures and the read-only toggle at the top level, first on the right', () => {
    const right = withHoliButtons(items).find((i) => i.id === 'right-group') as {
      items: { id: string; commandId?: string }[]
    }
    expect(right.items.map((i) => i.id)).toEqual([
      'signature-button',
      'make-read-only-button',
      'make-editable-button',
      'search-button',
      'comment-button',
    ])
    expect(right.items.map((i) => i.commandId).slice(0, 3)).toEqual([
      'insert:add-signature',
      'holi:make-marks-read-only',
      'holi:make-marks-editable',
    ])
  })

  it('leaves the rest alone, is idempotent, and does not mutate its input', () => {
    const once = withHoliButtons(items)
    expect(withHoliButtons(once)).toEqual(once)
    expect(once.filter((i) => i.id !== 'right-group')).toEqual(
      items.filter((i) => i.id !== 'right-group'),
    )
    expect((items[2] as { items: unknown[] }).items).toHaveLength(2)
  })
})

describe('PDF_TOOLBAR_CSS', () => {
  it('takes a hidden Holi button out of the row, so its twin does not move', () => {
    // A command that is not visible renders its item's wrapper empty, and an
    // empty wrapper is still a flex item: one more 8px gap on one side of the
    // lock, which swapped sides with the read-only state.
    expect(PDF_TOOLBAR_CSS).toContain(
      ':is([data-epdf-i="signature-button"], [data-epdf-i="make-read-only-button"], [data-epdf-i="make-editable-button"]):empty { display: none; }',
    )
  })
})

describe('PDF_SIDEBAR_MOTION_CSS', () => {
  it('slides a sidebar in from the side it docks on, in the motion tokens', () => {
    expect(PDF_SIDEBAR_MOTION_CSS).toContain(
      '[data-sidebar-id].border-r { animation: holi-sidebar-in-left var(--motion-arrive) var(--ease-settle) both; }',
    )
    expect(PDF_SIDEBAR_MOTION_CSS).toContain(
      '[data-sidebar-id].border-l { animation: holi-sidebar-in-right var(--motion-arrive) var(--ease-settle) both; }',
    )
    expect(PDF_SIDEBAR_MOTION_CSS).toMatch(/holi-sidebar-in-left \{ from \{[^}]*translateX\(-/)
    expect(PDF_SIDEBAR_MOTION_CSS).not.toMatch(/\d+m?s\b/)
  })
})

describe('PDF_SIDEBAR_WIDTHS', () => {
  it('widens the comments panel and no other', () => {
    expect(PDF_SIDEBAR_WIDTHS).toEqual({ 'comment-panel': { width: '360px' } })
  })
})

describe('PDF_COMMENT_FIELD_CSS', () => {
  it('grows the field with its text, first in the row, drawn in tokens', () => {
    const field = PDF_COMMENT_FIELD_CSS.split('\n').find((r) =>
      r.startsWith('textarea.holi-comment-field {'),
    )
    expect(field).toMatch(/field-sizing: content;/)
    expect(field).toMatch(/max-height: \d+px;/)
    expect(field).toMatch(/order: -1;/)
    expect(field).toMatch(/background-color: var\(--input\);/)
    expect(field).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
  })

  it("keeps the viewer's input focusable, only out of sight", () => {
    const input = PDF_COMMENT_FIELD_CSS.split('\n').find((r) => r.includes('> input[type="text"]'))
    expect(input).toMatch(/opacity: 0;/)
    expect(input).not.toMatch(/display: none|visibility: hidden/)
  })
})

describe('singleLine', () => {
  it('makes a line break a space, and leaves the rest', () => {
    expect(singleLine('one\ntwo\r\nthree')).toBe('one two three')
    expect(singleLine('  spaced  ')).toBe('  spaced  ')
  })
})

describe('PDF_ICONS', () => {
  it("carries Holi's lock glyphs as path data only", () => {
    // lucide's lock and lock-open, the set the rest of Holi draws from.
    expect(Object.keys(PDF_ICONS).sort()).toEqual(['holi-lock', 'holi-lock-open'])
    for (const icon of Object.values(PDF_ICONS)) {
      for (const path of icon.paths) expect(path.d).toMatch(/^M[\d\s.,a-zA-Z-]+$/)
    }
  })
})

describe('openingZoomCap', () => {
  it('holds a wide pane at 150%, which fit-width would overshoot', () => {
    expect(openingZoomCap('fit-width', 2.37)).toBe(1.5)
  })

  it('leaves fit-width alone when the page would overflow at 150%', () => {
    expect(openingZoomCap('fit-width', 0.75)).toBeNull()
    expect(openingZoomCap('fit-width', 1.5)).toBeNull()
  })

  it('never touches a zoom that is not the fit-width opening', () => {
    expect(openingZoomCap(2, 2)).toBeNull()
    expect(openingZoomCap('automatic', 2)).toBeNull()
  })
})

describe('shortcutOf', () => {
  const ev = (init: Partial<KeyboardEvent>) => init as KeyboardEvent

  it("normalises the way the viewer's commands plugin does", () => {
    expect(shortcutOf(ev({ key: 'P', metaKey: true }))).toBe('meta+p')
    expect(shortcutOf(ev({ key: 'h' }))).toBe('h')
    expect(shortcutOf(ev({ key: 'Z', ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+z')
    expect(shortcutOf(ev({ key: 'ArrowLeft' }))).toBe('arrowleft')
    expect(shortcutOf(ev({ key: ' ' }))).toBe('space')
  })

  it('is null for a bare modifier', () => {
    expect(shortcutOf(ev({ key: 'Shift', shiftKey: true }))).toBeNull()
    expect(shortcutOf(ev({ key: 'Meta', metaKey: true }))).toBeNull()
  })
})
