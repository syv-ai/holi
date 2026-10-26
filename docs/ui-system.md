# UI system

The renderer's design rules: which components are the design system, tokens, type, focus, icons,
motion, the baseline a new screen starts from, drawers, and how a vault re-skins the app. Where
files live and what they are called is [renderer](renderer.md); this page is how things look and
move. Most of it is enforced by the lint gate or a test.

The look in one line: **shadcn's neutral theme and ReUI, as published, in Geist.** Colour appears
only where it identifies something (a brand's mark, a file's type, a status). Holi adds no second
design system on top of the stock one.

## The design system is the stock one

- **`components/ui`** is stock shadcn (style `radix-nova`, base colour `neutral`), installed with
  the CLI and edited in place. **`components/reui`** is stock ReUI (`@reui` in `components.json`,
  which reads `REUI_LICENSE_KEY` from `apps/desktop/.env.local`). Neither is ever re-added over
  the edits, and neither is wrapped to give it a second look.
- **A caller places a component and picks its `variant` and `size`.** It never sets height,
  radius, padding, shadow or motion on one. A look the component lacks is a variant or size added
  to its file in `components/ui` or `components/reui`, so every caller gets it.
- **Composites** (`composites/`) are Holi's reusable pieces, built only from `components/*`:
  `icon-button`, `confirm-dialog`, `empty-state`, `setting-card`, `pane-toolbar`, `panel-header`,
  `drawer-shell`, `section-label`, `person-avatar`, `find-bar`. One concept, one file; see
  [renderer](renderer.md#where-does-it-go) for how to decide.
- **A ReUI block is a layout, not a design.** It is installed with the CLI and moved into the
  feature it becomes; its markup and classes stay as published, and its first line
  (`// ReUI block: @reui/<name>`) keeps the install name.
- **The lint gate** (`apps/desktop/eslint.config.mjs` with `@shadcn/lint`, run by `pnpm lint` and
  the pre-commit hook) rejects, in the renderer and the plugin renderers:
  - native `<button|input|select|textarea|dialog|form>` and Radix or Base UI imports outside
    `components/ui` and `components/reui`;
  - upward imports and plugins reaching into core;
  - a `title=` tooltip on a DOM element (use `Tooltip`);
  - type under the floor: an arbitrary `text-[…]` below 12px;
  - arbitrary colour literals (`bg-[#…]`, `text-[oklch(…)]`) and palette classes outside the
    categorical allow-list;
  - motion numbers at a call site: `duration-[…]`, `ease-[…]`, `delay-[…]`, `animate-[…]`, any
    `transition-*` except `transition-none`, and literal transitions in a `style` object. A
    computed value (an `animationDelay` built in code) passes;
  - a restyled stock component (`shadcn/no-restyle`): `Button` and `Badge` take layout classes
    only, overlay content (`DialogContent`, `AlertDialogContent`, `SheetContent`,
    `PopoverContent`) takes none, `CardTitle` and `FrameTitle` are never resized.

  `components/ui` and `components/reui` are exempt from the class-shape rules only. Each rule, its
  message and its exemptions are in the [rules registry](../.agents/skills/holi-rules/SKILL.md).

## Tokens

- `index.css` is Tailwind v4 CSS-first. `:root` holds shadcn's neutral semantic vocabulary
  (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`,
  `destructive`, `border`, `input`, `ring`, the `sidebar-*` set, and pairs), and `@theme inline`
  exposes them as `--color-*` utilities that hold `var()` pointers, so overriding a token
  re-cascades every utility. State tokens (`success`, `info`, `warning`, `invert`) are exposed the
  same way.
- Dark follows the `data-theme` stamp on `<html>` (`state/color-scheme.ts`); `dark:` variants key
  off it, and `color-scheme` follows so unpainted native UI does.
- `index.css` also carries Holi's own names, in sections: `brand`, `divider`, `drawer-edge`,
  `--selection`, `--shadow-popover`, `--task-*`, `--diff-*`, the `--syntax-*` palette, the `icon-*`
  utilities and the `motion-*` vocabulary below. New code uses shadcn's tokens first and these
  only where no stock token says the same.
- Radius is one `--radius` with `sm`/`md`/`lg`/`xl` derived from it. Floating things (menus,
  popovers, tooltips, dialogs) are `bg-popover`; their shadow is the component's own.

### Type

**Type** is set a step under Tailwind's defaults, the size desktop tools use (`index.css`):
`text-xs` 11px, `text-sm` 13px, `text-base` 14px, `text-lg` 16px, and `text-nav` 13px on an
18px line for chrome rows. **`text-sm` is body, `text-xs` is meta, and nothing is smaller.**
Geist and Geist Mono (`@fontsource-variable`, loaded in `main.tsx`), antialiased. A number that
counts or aligns is `tabular-nums`; a path, a slug or a code is Geist Mono.

### Colour

The palette is shadcn's neutral ramp, monotone: the brand is the grey ramp itself. **Hue identifies, it does not decorate:** a brand mark, a file type, a task status, the
destructive red. State is a `Badge` variant (`success-light`, `destructive-light`) or an `Alert`
variant. A raw palette class is for categorical identity only (a tag or folder colour) and always
carries its `dark:` pair. Never coloured text on a tinted background of the same hue.

### Window

**On macOS the window is glass** (`main/liquid-glass.ts`): the root, body and shadcn's sidebar
wrapper paint no ground, and the sidebar and title band tint themselves by the vault's
Transparency choice (`state/window-glass.ts`, `data-glass`, `--glass-chrome`, `--glass-view` in
`index.css`). A new full-screen ground that should carry that tint once marks itself
`data-glass-ground`.

## Focus

The stock components' treatment, app-wide: a control recolours its own edge (`border-input` to
`border-ring`) and adds shadcn's soft halo, `ring-[3px] ring-ring/50`. App code uses the same pair
rather than inventing a third; state still shows by background, not by borders or rings.
Nothing is source-scanned for it: the stock components are installed as published, and a scan
would only fight them.

## Icons

- **Three sizes and one stroke:** `icon-sm` 14px (beside text, dense rows), `icon-md` 16px
  (toolbars, menus), `icon-lg` 20px (the mark on an `IconTile`). They are `--icon-sm|md|lg` and
  `--icon-stroke` in `index.css`, applied as utilities. Size is a class, never lucide's `size`
  attribute, so no container rule overrides it. It is not a theme token: a vault re-skins colour,
  not layout.
- **Icons are lucide-react glyphs.** An icon takes its holder's colour (`currentColor`); a bare
  icon beside text is `text-muted-foreground`, and a signal (brand, destructive, a file type, a
  task status) comes in as a token class. Outside React (CodeMirror widgets, the completion popup,
  the PDF viewer's registry) glyphs come from the vanilla `lucide` package at the same version.
- **A control that is only an icon is `IconButton`** (`composites/icon-button`): stock `Button`
  (ghost, `icon-sm`) plus `Tooltip`, with `label` as both the tooltip and the accessible name.
  Disabled is `aria-disabled`, never the native attribute, so the tooltip, the one place that
  says why it is off, still shows.
- **File-type colours** are `--file-*` tokens, not hex at the call site. ReUI's `FileType`
  (`components/reui/file-type.tsx`) is the larger form; `variant="mono"` where the shape should
  speak, not the hue. **Marks** (`composites/marks.tsx`) are what the app shows for the things it
  plugs into: a brand's own mark where there is a brand (Claude, Google, a PDF page), a lucide
  glyph where the thing is Holi's own, `Plug` for anything without one; `pluginMark(id)` is keyed
  by plugin id. A mark sits on an `IconTile` (`components/reui/icon-tile.tsx`).

## Motion

- **Every animation names one of four behaviours; anything that cannot, does not animate.**
  - **R, respond**: under the pointer or caret only, always a transition (`motion-respond`), so
    leaving reverses it.
  - **A, arrive**: entering or leaving the layout, leaving faster than arriving: a popup grows out
    of its trigger and shrinks back (`motion-in-origin`, `motion-out-origin`), anything else fades
    in where it is (`motion-in-fade`), and a view's headline rises into place
    (`motion-in-rise`; its fade alone under reduced motion). An animation, not a transition,
    because Radix `Presence` waits for `animationend`. One exception is a transition, so a second
    press mid-way reverses from where it is: a drawer's width.
  - **K, acknowledge**: one beat, once, for an act the user committed (`motion-ack-bloom|tick|flash|nudge`
    through `hooks/use-ack.ts`). Never blocks or queues; a repeat replays.
  - **F, in flight**: the only loops (`motion-pulse`, `motion-shimmer`, `motion-orbit`), bound to a
    real in-flight state.
- **The tokens** live in `index.css`'s Motion section: `--ease-settle`, `--ease-loop`, `--motion-respond`
  150ms, `-arrive` 300ms, `-pop` 180ms (a menu or tooltip growing from its trigger; it answers a
  click, so it is quicker than an arrival), `-leave` 190ms, `-ack` 800ms, `-inflight` 2400ms, and
  `--motion-stagger`, `--motion-slide`, `--ease-slide` in plain `:root`, because Tailwind
  tree-shakes `@theme` variables that only JavaScript reads. `lib/motion.ts` holds the JavaScript
  reads of the vocabulary (`prefersReducedMotion`). Names are by purpose, not size, so re-pacing is one edit.
- **Installed parts already animate; never retime them.** Yours goes through these utilities only:
  transform and opacity, never `transition-all`, never bounce, never a stagger on table rows or
  lists of 20+, at most one entrance per view, and `motion-reduce:` plus
  `MotionConfig reducedMotion="user"` where JavaScript drives it. This overrides the
  `transition-colors` / `duration-200` values the ReUI skill suggests.
- **Still on purpose:** document text; direct manipulation while it happens (motion applies to the
  release); anything on the path of input. Opening a note, switching tabs and closing a pane land
  at once: they are the most frequent acts, usually from the keyboard, and an exit only the
  closing side has reads as lag.
- **Reduced motion reduces, not removes:** F stops, A becomes instant, R and painting K survive.
- The board is ReUI's kanban, whose drag is dnd-kit's own sorting transition, left as shipped.

## Page baseline

New full screens (a settings page, a setup flow, an empty state) start from the onboarding
ritual's shape (`features/onboarding/`, `features/auth/sign-in.tsx`).

- **Rows, not cards.** A header, progress where there is a sequence, the stage, and a footer. The
  footer holds the screen's actions so a long list cannot push them off the bottom: Back (a ghost
  `Button` with `ArrowLeft`) at the start; the one primary action, a `Button` with `ArrowRight`, at
  the end, with a `Kbd` hint where Enter runs it. The stage between is the scroller.
- **The page is the surface.** No card around a screen's content. A list of options is one stacked
  ReUI `Frame` (`components/reui/frame.tsx`), its rows the panels; a page has one container family,
  and never a `Card` inside a `Frame` or the reverse.
- **Widths by content:** prose and a single question centre in `max-w-xl`; a list takes
  `max-w-2xl`; a field is as wide as its longest likely value (`max-w-sm` for a name).
- **Spacing** is `gap-*` on the parent: `gap-1` to `gap-2` in a row, `gap-3` to `gap-4` between
  items, `gap-6` to `gap-8` between sections.
- **Headings:** each screen's title is `text-2xl font-semibold tracking-tight`, with one `text-sm`
  muted sentence under it saying why the screen asks what it asks. A card's title is
  `text-sm font-medium`. Chrome rows (sidebar, tree, vault switcher) are `text-nav`. A page of
  things is a plain list or table with hairline dividers, not a grid of cards.
- **Building blocks, one definition each:**
  - a setting or option row: `composites/setting-card` (a `FramePanel` with a mark on an
    `IconTile`, title, optional `Badge`, note, and the control at the end);
  - on or off: `Switch`; a box you tick: `Checkbox`; one choice among a few: `ToggleGroup`; a choice
    that switches a panel: `Tabs`; more than five, or a search: `Select` or `Command`;
  - a labelled control: `Field` (`components/ui/field.tsx`), vertical or horizontal;
  - a search with a scope: one `InputGroup`, the scope as a menu inside the field's end;
  - progress through a sequence: `Stepper` (`components/reui/stepper.tsx`), progress only, never a
    way to jump ahead;
  - a pane's row of controls: `composites/pane-toolbar` (one left edge for every plugin pane);
  - a state or category beside a name: `Badge`; a count in chrome is a `secondary` badge;
  - a tree: `components/reui/tree.tsx` over `@headless-tree/react`, calm (hover colour only, a
    folder opens at once). The file tree, the settings rail and History share it
    ([file-tree](features/file-tree.md)).
- **Doing the work last.** A flow that changes the world (creates a repo, writes files, sends
  something) collects every answer first and acts once, at the end, behind a button that names the
  act ("Create vault", not "Continue"). The act runs on a screen of its own that lists its real
  steps as they land; a failure goes back to the screen whose answer caused it, every other answer
  kept ([onboarding](features/onboarding.md)).
- **Copy** is short, plain and specific: a button is a verb and its object; a lede says why, not
  what; reassurance appears once per screen; British spelling in the interface, as in the docs.
- **A toast** is `toast()` from `sonner`, shown by the one `<Toaster />`
  (`components/ui/sonner`) the vault host mounts; never a hand-rolled status box. A dialog is
  `Dialog` or `AlertDialog`; a confirmation is `composites/confirm-dialog`.

### States

Every region that loads has all three, in the region, not as an overlay: loading (`Skeleton` rows the height of the real rows, `role="status"`), empty (`composites/empty-state`: a muted icon, one sentence, at most one action, saying why it is empty), and error (inline, where the data would be, `role="alert"`, with Retry; the user's place is kept).

## Drawers

Every sidebar panel (history, the last turn) is `composites/drawer-shell.tsx`. A drawer pushes: its
column's width transitions from 0 to its width at the slide pace, the same both ways, so a press
mid-slide reverses it. It is the one layout property animated outside CodeMirror, and it owns its
column rather than living in `react-resizable-panels`, which cannot animate a size. Each opens at
320px and resizes between 150 and 560 (`lib/drawer.ts`) by pointer (1:1, transition off) or arrow
keys, remembering its own width. The PDF viewer's sidebars are that library's DOM: they copy width,
motion, header and edge through the injected stylesheet and cannot resize.

## Per-vault theming

- A vault re-skins colours and chrome, never layout, through a whitelisted token map in
  `.holi/settings/theme.css` (committed) and `.holi/settings/theme.local.css` (machine-local,
  overrides per token). The whitelist (`THEME_TOKENS` in `packages/shared/src/theme.ts`) is the
  colour tokens plus `radius`, `shadow-popover` and `shadow-dialog`.
- The file is CSS but is read as data: only `--<token>` declarations under
  `[data-theme='dark'|'light']` are parsed, each value validated. A value is a literal, `var()` of
  another colour token or a palette colour, or a `color-mix()` of two of those; a reference names
  only a colour, so it cannot reach spacing or size. A theme injects no CSS: no `url()`, comments or
  rule-breaking punctuation, so "no layout change" is structural.
- Seeded once, then the vault's: Holi never fills the file in again, and a token the file leaves
  out shows the built-in value. Appearance resets one token or a whole mode.
- A third-party UI in a shadow root is themed by a token map, not restyled: the PDF viewer's
  palette is `var(--token)` strings (`plugins/pdf/renderer/pdf-viewer-config.ts`), which inherit
  across the shadow boundary.
- **Not built:** the renderer does not apply a vault's theme file today. `features/shell/vault-host.tsx`
  runs on shadcn's neutral theme, and the Appearance page that edited tokens is not in the fresh
  settings; see [not-built](not-built.md).

## Rules

- State shows by background colour, not by borders or rings, except focus, above.
- Only floating things (dialogs, menus, popovers, tooltips, toasts) get `--popover` and a shadow,
  in React and CodeMirror alike, and no border of their own.
- Tokens or nothing: no colour literal and no motion number at a call site.
- A question about one thing is asked where that thing is, leaving the rest of the app usable.

## Rejected

- Raw scoped CSS plus a sanitiser, or a token map with a raw-CSS escape hatch for themes: an
  injection surface, and "no layout" becomes best effort.
- A theme in `localStorage`: the agent cannot write it and it does not travel with the vault.
- Motion by convention without a lint rule: that is how the `transition-all` pile arose.
- Holi forks of shadcn and ReUI parts beside the stock ones (the retired `primitives/`): two
  Buttons, two Dialogs, and every fix made twice.
- A card around a whole screen: it framed the one thing on the page and added nothing the page did
  not already give.
- Creating the vault at the naming step: every later answer had to be written over a repo that
  already existed, and backing out left one behind.
- Theming the title bar: needs a custom title bar, which is a layout change.

## Code

- `apps/desktop/src/renderer/src/index.css`: tokens, the `icon-*` and `motion-*`
  utilities, glass and window rules.
- `apps/desktop/eslint.config.mjs`, `apps/desktop/design-system.lint.json`: the gate.
- `apps/desktop/src/renderer/src/components/ui/`, `components/reui/`, `composites/`.
- `apps/desktop/src/renderer/src/lib/motion.ts`, `hooks/use-ack.ts`, `lib/drawer.ts`,
  `composites/drawer-shell.tsx`.
- `apps/desktop/src/plugins/pdf/renderer/pdf-viewer-config.ts`.
- `packages/shared/src/theme.ts`: parse, whitelist, validate, merge.
- `apps/desktop/src/renderer/src/lib/__tests__/motion.test.ts`, `editor/__tests__/syntax-tokens.test.ts`, `apps/desktop/test/theme-tokens.test.ts`.
