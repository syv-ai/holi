# UI system

The renderer's design system: component layers, tokens, focus, motion, drawers, and how a vault
re-skins the app without being able to change its layout. Most of it is enforced by the lint gate
or a test.

## Component layers

- **`primitives/` → `composites/` → `features/*`.** Primitives are thin shadcn wrappers over Radix, or Base UI where shadcn builds on it (the combobox).
  Composites are domain-agnostic patterns (`DrawerShell`, `PanelHeader`). Features are
  domain-aware. A layer may import only layers below it, and a feature may not import another
  feature. The composition root (`components/Shell.tsx`) and `DialogHost` sit above the features.
- **The ESLint gate** (`apps/desktop/eslint.config.mjs`, `eslint-plugin-boundaries` plus
  `no-restricted-syntax`, at error across the renderer, run by `pnpm lint` and the pre-commit
  lint-staged hook) rejects:
  - native `<button|input|select|textarea|dialog|form>` outside `primitives/`;
  - Radix and Base UI imports outside `primitives/`;
  - upward and cross-feature imports;
  - native `title=` tooltips on DOM elements (use the `Tooltip` primitive);
  - arbitrary colour literals such as `bg-[#…]` or `text-[oklch(…)]`;
  - motion numbers at a call site: `duration-[…]`, `ease-[…]`, `delay-[…]`, `animate-[…]`, any
    `transition-*` except `transition-none`, and literal transition or animation values in a
    `style` object. A computed value (`animationDelay: staggerDelay(i)`) passes.
    `features/onboarding/` is exempt from the motion rules only.

## Tokens

- `index.css` is Tailwind v4 CSS-first. `:root` holds shadcn's semantic vocabulary (`background`,
  `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`,
  `border`, `input`, `ring`, and pairs) mapped onto Tailwind's neutral/sky palette, and
  `@theme inline` exposes them as `--color-*` utilities that hold `var()` pointers, so overriding
  a token re-cascades every utility.
- Dark-first: `:root` is dark, `[data-theme='light']` overrides, and `color-scheme` is stamped per
  theme so unpainted native UI follows.
- Pairs that sound alike and are not: `primary` is the brand as a fill, `brand` is the brand as
  text (`text-brand`, never `text-primary`); `border` is an object's edge, `divider` is the seam
  between chrome (derived from `border` and `background`); `accent` is the neutral hover surface,
  not the brand. `drawer-edge` is transparent by default.
- Radius is one `--radius` (0.5rem) with `sm`/`md`/`lg`/`xl` derived from it. Shadows go through
  the `.shadow-popover` and `.shadow-dialog` classes, because Tailwind bakes shadow geometry into
  its utilities and they cannot be themed.

## Focus

One treatment: a control recolours its own edge on `focus-visible` (`border-input` →
`border-ring`, same 1px), so nothing grows or shifts. Where there is no edge (a filled or ghost
button, an icon button, the resize handle) it draws `ring-1 ring-ring`. `ring-0` is only for
opting a bordered variant out of the ring. `test/focus-treatment.test.ts` is a source scan, so a
component pasted from shadcn upstream with the 3px halo fails before it is mounted anywhere.

## Motion

- **Every animation names one of four behaviours; anything that cannot, does not animate.**
  - **R, respond**: under the pointer or caret only. Always a transition (`motion-respond`), so
    leaving reverses it.
  - **A, arrive**: entering or leaving the layout, from the direction it belongs to, leaving
    faster than arriving (`motion-in-*`, `motion-out-*`). An animation, not a transition, because
    Radix `Presence` waits for `animationend`. Two exceptions are transitions, so a second press
    mid-way reverses from where it is: a drawer's width, and a tree folder's contents
    (`data-slot='disclose'`, the grid row track running `0fr → 1fr`).
  - **K, acknowledge**: one beat, once, for an act the user committed (`motion-ack-*` via
    `lib/use-ack.ts`). Never blocks or queues; a repeat replays, which needs a forced reflow.
  - **F, in flight**: the only loop (`motion-pulse`, `-shimmer`, `-orbit`), bound to a real
    in-flight state.
- **Tokens** live in `index.css`: `--ease-settle`, `--ease-loop`, `--motion-respond` 150ms,
  `-arrive` 300ms, `-leave` 190ms, `-ack` 800ms, `-inflight` 2400ms. `--motion-stagger`,
  `--motion-slide` and `--ease-slide` sit in plain `:root`, because Tailwind tree-shakes `@theme`
  variables that only JavaScript reads. Names are by purpose, not size, so re-pacing is one edit.
- **Arrivals are computed, not declared.** `arrivalIndex`/`useArrivals` animate only ids new since
  the last render; the first render animates nothing. Staggers are capped at 8 items.
- **Still on purpose:** document text; direct manipulation while it happens (motion applies to
  the release); anything on the path of input; diff and mail bodies.
- **Inside a document the line is "is it a thing you can click".** Chips, orbs, checkboxes,
  images, the table widget and frontmatter rows respond; text does not. Inside CodeMirror all of it
  is paint only (see [editor](features/editor.md)).
- **Reduced motion reduces, not removes:** F stops, A becomes instant, R and painting K survive.
- **Overshoot belongs to springs.** `--ease-spring` and spring keyframes exist only in
  `features/onboarding/onboarding-ritual.css`; the one other spring is the morph shared by the
  [nav menu](features/nav-menu.md) and the [command palette](features/command-palette.md), on
  `motion` (`primitives/springs.ts`), which keeps its bounce. The vocabulary's curves stay
  overshoot-free.

## Drawers

Every sidebar is one drawer: the nav, history and the last turn are `composites/DrawerShell.tsx`.
A drawer pushes: its column's width transitions 0 → w at the slide pace, the same both ways, so a
press mid-slide reverses it. It is the one layout property animated outside CodeMirror, and the
editor beside it reflows during the slide. It owns its column rather than living in
`react-resizable-panels`, which cannot animate a size. Each opens at 320px and resizes between 150
and 560 (`lib/drawer.ts`) by pointer (1:1, transition off) or arrow keys, remembering its own
width. The nav closes to a 44px rail holding its toggle (an `edgeControl` that slides with the
edge), an orb per running session and the [nav menu](features/nav-menu.md) on its side. The PDF viewer's sidebars are that library's
DOM: they copy width, motion, header and edge through the injected stylesheet and cannot resize.

## Per-vault theming

- A vault re-skins colours and chrome, never layout, through a whitelisted token map in
  `.holi/settings/theme.css` (committed) and `.holi/settings/theme.local.css` (machine-local,
  overrides per token). The whitelist (`THEME_TOKENS`) is the colour tokens plus `radius`,
  `shadow-popover` and `shadow-dialog`.
- The file is CSS but is read as data: only `--<token>` declarations under
  `[data-theme='dark'|'light']` are parsed, each value validated. It is CSS because a theme is a
  set of custom properties, and because the editor's colour picker only finds colours through the
  CSS grammar.
- `useVaultTheme` (mounted in `Shell`) writes the resolved values onto
  `document.documentElement`, so Radix portals inherit them. A malformed file degrades to no theme.
  The agent authors themes through the seeded `theme` skill.
- A third-party UI in a shadow root is themed by a token map, not restyled: the PDF viewer's
  palette is `var(--token)` strings (`lib/pdf-viewer-config.ts`), which inherit across the shadow
  boundary.

## Rules

- State shows by background colour, never by borders, rings or outlines. Form fields keep a dimmed
  edge; focus is the one exception, defined above.
- Sidebars are flat `--background` with no separator from the pane.
- Only floating things (dialogs, menus, popovers, tooltips) get `--popover` and a shadow.
- Never coloured text on a tinted background of the same hue: coloured text on no background, or
  default text.
- Tokens or nothing: no colour literal and no motion number at a call site.
- A theme injects no CSS. Values only become custom-property values consumed through `var()`,
  which cannot open a declaration or rule; the validator also refuses `url()`, comments and
  rule-breaking punctuation. No token can express size, spacing or position, so "no layout
  change" is structural.

## Rejected

- Raw scoped CSS plus a sanitizer, or a token map with a raw-CSS escape hatch: an injection
  surface, and "no layout" becomes best effort.
- A theme in `localStorage`: the agent cannot write it and it does not travel with the vault.
- Motion by convention without a lint rule: that is how the unchosen `transition-all` pile arose.
- Overshoot or springs in the daily app, beyond the morph above.
- Theming the titlebar: needs a custom titlebar, which is a layout change.

## Code

- `apps/desktop/src/renderer/src/index.css`: tokens, motion utilities, drawer and reduced-motion rules.
- `apps/desktop/eslint.config.mjs`: the gate.
- `apps/desktop/src/renderer/src/lib/motion.ts`, `lib/use-ack.ts`, `lib/use-arrivals.ts`.
- `apps/desktop/src/renderer/src/composites/DrawerShell.tsx`, `lib/drawer.ts`.
- `apps/desktop/src/renderer/src/state/theme.ts`, `lib/theme-applicator.ts`, `lib/pdf-viewer-config.ts`.
- `packages/shared/src/theme.ts`: parse, whitelist, validate, merge.
- `apps/desktop/test/focus-treatment.test.ts`, `test/motion.test.ts`, `test/theme-tokens.test.ts`.
