# UI system

The renderer's design system: component layers, tokens, focus, motion, drawers, the page baseline
new screens start from, and how a vault re-skins the app without being able to change its layout.
Most of it is enforced by the lint gate or a test.

The look in one line: **Linear-like and monotone.** A near-black page (`#121212`) lit faintly from
the top-left, the `zinc` ramp for every surface and control, Geist for type, and colour only where
it identifies something (a brand's mark, a file's type, a status). The onboarding ritual is the
reference implementation; [Page baseline](#page-baseline) says what to copy from it.

## Component layers

- **`primitives/` → `composites/` → `features/*`.** Primitives are thin shadcn wrappers over Radix, or Base UI where shadcn builds on it (the combobox).
  ReUI parts (the `@reui` registry in `components.json`, on the `radix-nova` style, Pro licence
  key in `apps/desktop/.env.local`) are vendored into `primitives/` the same way:
  `InputOTP`, `InputGroup`, `Stepper`, `IconTile`, `Frame`, `Badge` and `FileType` so far, and so are the shadcn
  parts (`Select`, `Switch`, `Toggle`, `ToggleGroup`, `Tabs`, `Field`, …), written from `shadcn view`
  rather than `shadcn add`, which would write lowercase `button.tsx`-style files over the
  PascalCase primitives on a case-insensitive disk. A part keeps its shipped look and changes only
  where the gate below, the focus rule or a missing token says otherwise, and its header says
  what changed (`Badge` drops the variants whose tokens Holi does not define, and the sizes below
  `text-xs`; `InputGroup` takes the house text-field look). A ReUI **block** (`auth-5`,
  `settings-1`, `app-shell-7`) is a layout to read, not a file to vendor: its parts become
  composites, and the feature names the block it follows.
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
  - type under the floor: an arbitrary `text-[…]` below 12px, in px or rem (`text-[11px]`,
    `text-[0.6875rem]`), plugin renderers included. A short list of files being reworked
    elsewhere is named in the config until they are on `text-xs`;
  - arbitrary colour literals such as `bg-[#…]` or `text-[oklch(…)]`;
  - motion numbers at a call site: `duration-[…]`, `ease-[…]`, `delay-[…]`, `animate-[…]`, any
    `transition-*` except `transition-none`, and literal transition or animation values in a
    `style` object. A computed value (`animationDelay: staggerDelay(i)`) passes.
    `features/onboarding/` is exempt from the motion rules only.
  - a lucide or simple-icons glyph rendered directly as JSX, and a colour, background or hover
    class on an `IconButton` (see Icons).

## Tokens

- `index.css` is Tailwind v4 CSS-first. `:root` holds shadcn's semantic vocabulary (`background`,
  `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`,
  `border`, `input`, `ring`, and pairs) mapped onto Tailwind's zinc palette, and
  `@theme inline` exposes them as `--color-*` utilities that hold `var()` pointers, so overriding
  a token re-cascades every utility.
- Dark-first: `:root` is dark, `[data-theme='light']` overrides, and `color-scheme` is stamped per
  theme so unpainted native UI follows.
- Pairs that sound alike and are not: `primary` is the brand as a fill, `brand` is the brand as
  text (`text-brand`, never `text-primary`); `border` is an object's edge, `divider` is the seam
  between chrome (derived from `border` and `background`); `accent` is the neutral hover surface,
  not the brand. `drawer-edge` is transparent by default.
- **Monotone.** The brand is the grey ramp itself: `--primary` is near-white on dark and
  near-black on light, so the one filled button on a screen is the brightest thing on it without
  a hue. `secondary`, `muted` and `accent` are the same grey family a step apart; a grey control
  (the sign-in button, a step to come, an icon tile) is `secondary`/`muted`, never a tint of the
  brand. Hue is reserved for identity (a brand mark, a file type, a task status, the destructive
  red) and comes from Tailwind's palette with its `dark:` pair, or a `--file-*` token.
- Radius is one `--radius` (0.5rem) with `sm`/`md`/`lg`/`xl` derived from it. Shadows go through
  the `.shadow-popover` and `.shadow-dialog` classes, because Tailwind bakes shadow geometry into
  its utilities and they cannot be themed.
- **One floating surface.** Menus, popovers, tooltips and dialogs are all `bg-popover` under
  `shadow-popover`. Menus are ReUI's (shadcn's radix-nova `dropdown-menu`): they open beside their trigger,
  rows `rounded-md px-1.5 py-1` in `text-nav`, and a right-click menu wears the same rows
  (`MENU_ROW`, `MENU_SURFACE` in `primitives/DropdownMenu.tsx`). In dark, `--popover`, `--card`
  and `--accent` are mixed from `--background` and white (93%, 96%, 89%), not from zinc: the zinc
  mixes carried a cool cast the page does not have, so a menu read as a different grey from the
  page it floats on. `--shadow-popover` carries the surface's hairline as an inset 1px ring plus
  one wide soft drop (after Linear's), so no overlay draws a border of its own.

## Focus

A field you type into has no edge at all: a calm grey fill (`TEXT_FIELD_LOOK` in
`primitives/field-look.ts`), and its focus is the caret blinking where the text goes. Any other
control recolours its own edge on `focus-visible` (`border-input` → `border-ring`, same 1px), so
nothing grows or shifts. Where there is no edge (a filled or ghost button, an icon button, the
resize handle) it draws `ring-1 ring-ring`. `ring-0` is only for
opting a bordered variant out of the ring. `test/focus-treatment.test.ts` is a source scan, so a
component pasted from shadcn upstream with the 3px halo fails before it is mounted anywhere.

## Icons

One place decides how an icon looks, so every icon in the app agrees.

- **Three sizes and one stroke.** `sm` is 14px (beside text, dense rows, tab close, chip remove,
  panel headers), `md` is 16px (toolbars, menus, a round button's mark), `lg` is 20px
  (the mark on an `IconTile`). They are `--icon-sm`, `--icon-md`, `--icon-lg` and
  `--icon-stroke` in `index.css`, applied as the `icon-*` utilities. Size is a
  class, never lucide's `size` attribute, so no container rule can override it. It is not a
  theme token: a vault re-skins colour, not layout.
- **`Icon`** (`primitives/Icon.tsx`) is the only way a glyph is drawn in React. Its colour is the
  holder's (`currentColor`); a bare icon beside text takes `tone="muted"`, and a signal (brand,
  destructive, a file type, a task status) comes in as a token class.
- **`IconButton`** (`primitives/IconButton.tsx`) is every control that is only an icon. It owns
  the whole look: muted at rest (`text-icon`), and under the pointer the foreground
  (`text-icon-active`), the neutral `accent` background and a slight grow (`scale-110`). Pressed,
  active and an open menu trigger look like the hover and stay. The label is both the accessible
  name and the tooltip. Disabled is `aria-disabled`, dimmed with no hover look, never the native
  attribute: a natively disabled button takes no pointer events, so its tooltip, the one place
  that says why it is off, would never show. `className` is for layout and reveal only.
- **Menus** colour their row icons `text-icon` through the row, so a menu item passes a bare
  `Icon`.
- **Outside React** (CodeMirror widgets, the completion popup, the PDF viewer's registry) glyphs
  come from the vanilla `lucide` package at the same version as `lucide-react`, sized from the
  same custom properties, never copied by hand.
- **File-type colours** are `--file-*` tokens, not hex at the call site. ReUI's `FileType`
  (`primitives/FileType.tsx`) is the larger form: a page in the format's colour with its
  extension on a band, for a tile or a list of attachments; `variant="mono"` where the shape
  should speak, not the hue.
- **Marks** (`composites/marks.tsx`) are what the app shows for the things it plugs into: a
  brand's own mark in its own colours where there is a brand (Claude, Google's four-colour G, a
  PDF page), a lucide glyph in the foreground where the thing is Holi's own (`Blocks` for vault
  apps, `Puzzle` for community plugins), and `Plug` for anything without one. `pluginMark(id)`
  is keyed by plugin id, because a plugin's info is shared and browser-free and a mark is a React
  element. A mark sits on an `IconTile`.

## Motion

- **Every animation names one of four behaviours; anything that cannot, does not animate.**
  - **R, respond**: under the pointer or caret only. Always a transition (`motion-respond`), so
    leaving reverses it.
  - **A, arrive**: entering or leaving the layout, leaving faster than arriving: a popup grows
    out of its trigger and shrinks back (`motion-in-origin`, `motion-out-origin`), anything else
    fades in where it is (`motion-in-fade`), and a view's headline rises 6px into place as the
    view opens (`motion-in-rise`, Home's title; its fade alone under reduced motion). An animation, not a transition, because
    Radix `Presence` waits for `animationend`. One exception is a transition, so a second press
    mid-way reverses from where it is: a drawer's width. A tree folder opens and closes at
    once (see Trees).
  - **K, acknowledge**: one beat, once, for an act the user committed (`motion-ack-*` via
    `lib/use-ack.ts`). Never blocks or queues; a repeat replays, which needs a forced reflow.
  - **F, in flight**: the only loop (`motion-pulse`, `-shimmer`, `-orbit`), bound to a real
    in-flight state.
- **Shell** (after the knowledge bases that float their page). The sidebar sits on the window's
  ground (`--ground`, a step under the page) and the content floats beside it as one panel on the
  page colour (`[data-slot='content-panel']`: `rounded-xl`, a `--divider` hairline and the
  faintest lift), its toggle beside the window's lights ([sidebar](features/sidebar.md)). **One product
  from the door to the desk:** the ground carries the light of the screens before a vault, held
  still (`[data-slot='window-ground']`: the same warm and cool from the top-left as a faint wash,
  and the grain at a third, under the sidebar and the panel so no text is grainy). The page
  stays plain, so nothing is ever written on a gradient. Home's title speaks in sign-in's display
  voice (`text-4xl`, −0.03em); the warm-to-violet accent of sign-in's "own." is
  `--brand-gradient`, carried by exactly two things in the shell, the focused tab's line and the
  open vault's tile, so it stays a signature; the Agents segment wears a Holi's pixel face; an
  empty state's icon stands on a small lit plate (an error's does not). **On macOS the window is
  glass** (after MonoCode's): transparent over the system's blur of what is behind it
  (`vibrancy: 'under-window'`, drawn light or dark from the app's own scheme through
  `nativeTheme.themeSource`), the ground tinting it at `--glass-tint` (80%) so the desk shows
  through the sidebar faintly. The page panel stays opaque: a note is never read over the
  desktop. Elsewhere the ground is opaque.
- **The app icon follows the theme.** It is the "h" (`assets/holi-logo-new-short.svg`) on a
  squircle of the chrome's colour (`--sidebar`), frosted from above like the window's glass, with
  a glow of the theme's `--primary` from the lower corner; the "h" is `--foreground`. The window
  draws it (`lib/app-icon.ts`) whenever the root's `data-theme` or its theme tokens change, and
  main sets it on the dock (`holi:dockIcon`), so a light theme gets a light icon and a vault's
  own theme its own colours. `build/icon.svg` and `icon.png` are the same drawing in the default
  dark theme: the bundle's icon in Finder, and the dock's until the window has drawn one.
- **Before a vault**, sign-in and the onboarding ritual stand on the plain page. Sign-in's GitHub button is the GitHub mark that opens into "Continue with
  GitHub" (`primitives/RevealButton.tsx`, the `reveal` spring). The ritual's acts crossfade in its
  own stylesheet (`onboarding-ritual.css`). The loading screen stays the plain page.
- **Tokens** live in `index.css`: `--ease-settle`, `--ease-loop`, `--motion-respond` 150ms,
  `-arrive` 300ms, `-pop` 180ms (a menu, popover, tooltip or select growing from its trigger:
  it answers a click, so it is quicker than an arrival), `-leave` 190ms, `-ack` 800ms, `-inflight` 2400ms. `--motion-stagger`,
  `--motion-slide` and `--ease-slide` sit in plain `:root`, because Tailwind tree-shakes `@theme`
  variables that only JavaScript reads. Names are by purpose, not size, so re-pacing is one edit.
- **Arrivals are computed, not declared.** `arrivalIndex`/`useArrivals` animate only ids new since
  the last render; the first render animates nothing. Staggers are capped at 8 items.
- **Still on purpose:** document text; direct manipulation while it happens (motion applies to
  the release); anything on the path of input; diff and mail bodies. Opening a note, switching
  tabs and closing a pane land at once, with no fade or exit: they are the most frequent acts,
  usually from the keyboard, and an exit only the closing side has reads as lag.
- **Inside a document the line is "is it a thing you can click".** Chips, orbs, checkboxes,
  images, the table widget and frontmatter rows respond; text does not. Inside CodeMirror all of it
  is paint only (see [editor](features/editor.md)).
- **Reduced motion reduces, not removes:** F stops, A becomes instant, R and painting K survive.
- **Chrome moves only through the CSS vocabulary.** Menus, popovers, the one `Dialog` (the
  command palette and quick add are it, anchored near the top) and the nav menu open and close
  with `motion-in-origin`/`motion-out-origin`; nothing cascades rows in or blurs. The task board is
  ReUI's kanban, whose drag is dnd-kit's own sorting transition, left as shipped; completing a
  card is one fade of its check. The few JS springs still in use
  live in `primitives/springs.ts` and nowhere else; nothing new reaches for them.

## Page baseline

New full screens (a settings page, a setup flow, an empty state) start from the onboarding
ritual's shape. What to copy, in the order a screen is built:

### Frame

- **Rows, not cards.** A header (the `BrandMark`, a dismiss `IconButton` where there is
  somewhere to go back to), progress where there is a sequence, the stage, and a footer. The
  footer holds the screen's actions so a long list cannot push them off the bottom: Back, a ghost
  button with `ArrowLeft`, at the start; the one primary action, a `Button` with `ArrowRight`,
  at the end, with a `Kbd` hint ("Press Enter") beside it where Enter runs it.
- **The page is the surface.** No card around a screen's content: the plain page is already the
  quiet ground a card would add. A list of options on a page is one stacked ReUI `Frame`, its
  rows the panels; a page has one container family.
- **Widths by content.** Prose and a single question centre in `max-w-xl`; a list takes
  `max-w-2xl`; a form field is as wide as its longest likely value (`max-w-sm` for a name). The
  stage between header and footer is the scroller, so a long list scrolls while the footer's
  actions stay put.
- **Spacing** is `gap-*` on the parent: `gap-1`–`gap-2` inside a row, `gap-3`–`gap-4` between
  items, `gap-6`–`gap-8` between sections.

### Type

- Geist and Geist Mono (`@fontsource-variable`, in `main.tsx`), antialiased.
- **Heading**: each screen's title, `text-2xl font-semibold tracking-tight`, with one sentence
  under it in `text-sm` muted that says why the screen asks what it asks
  (`features/onboarding/ActHeading.tsx`). No eyebrows, display sizes or gradient words.
- **Body** is `text-sm`, **meta** is `text-xs`, and nothing is smaller (the gate rejects an
  arbitrary size under 12px; CodeMirror's CSS-in-JS uses `var(--text-xs, 12px)` for its meta).
  One title size for "the thing this page is": `text-2xl` on Home, Settings and a note's H1. A card's title is
  `text-sm font-medium`; its description `text-sm text-muted-foreground text-pretty`.
- **Chrome is `text-nav`** (13px on an 18px line, a theme size in `index.css` that `cn` knows):
  the sidebar's rows, the mode toggle, the tree, the vault switcher and the profile menu, a step
  under the page's body so the frame reads quieter than what it frames (after Linear and Notion).
- **Lists over cards.** A page of things (Home's library) is a plain table: 44px rows, hairline
  dividers, the name in body text and its facts muted beside it. Cards made every row a box and
  the page a grid of boxes; a list reads faster and asks less of the eye.
- A number that counts or aligns is `tabular-nums`; a path, a slug or a code is Geist Mono.

### Building blocks

- **`SettingCard`** (`composites/SettingCard.tsx`, after ReUI `settings-1`): one setting or
  option as a `FramePanel` of a `<Frame stacked>`: its mark on an `IconTile`, the title with an
  optional `Badge`, a sentence, a note line (why it cannot change, what off means), and the
  control at the end of the row. `pressable` makes the row its control's label, so a press
  anywhere ticks a `Checkbox` (the plugins act); a control that needs width (pills, a list of
  sub-switches divided by hairlines) goes under the text. Disabled dims and says why.
- **`IconTile`** (`primitives/IconTile.tsx`, ReUI's `icon-tile`, `outline` variant): the
  square holding an `lg` icon, a brand mark or a `FileType`. It is what makes a list of options
  scannable before a word is read.
- **`Badge`** (`primitives/Badge.tsx`): a short state or category beside a name. `outline` with
  `radius="full"` for a quiet fact ("Optional", the plugin a transform belongs to);
  `destructive-light` for a problem. A count in chrome (a board column's) is a `secondary` badge.
- **On or off** is the `Switch` (`primitives/Switch.tsx`, shadcn's): the primary track when on,
  the input track when off, its thumb crossing with `motion-respond`. A box you tick is a
  `Checkbox`.
- **One choice among a few** is a `ToggleGroup` (`primitives/ToggleGroup.tsx`, shadcn's), the
  app's one segmented control: `type="single"` is a radio group, `type="multiple"` pressed
  buttons (the recurrence weekdays). The pick changes in place; nothing travels between options.
  `PillGroup` (`primitives/Choice.tsx`) is a `ToggleGroup` behind a value-picking API (`isOn`,
  `onPick`). A choice that switches a panel is `Tabs` (`primitives/Tabs.tsx`: the library's
  Recent/Notes/Tasks/Activity, the sidebar's mode). A choice among more than five, or one that
  needs a search, is a `Select` or `Combobox`; a `Select` opens on the menus' surface below its
  trigger (`motion-in-origin`).
- **A labelled control** is `FormField` (`primitives/Field.tsx`, on shadcn's `Field`): vertical,
  the caption above (a dialog's form), or `orientation="horizontal"`, the caption a fixed column
  beside the control (the frontmatter block, the recurrence rows), whose control takes its id from
  `useFieldControlId` or `children` as a function.
- **A search with a scope** is one `InputGroup` (after ReUI `c-input-group-38`): the search
  icon, the field, a clear button while there is text, and the scope as a menu inside the
  field's end, rather than a second control beside it (the join picker's account selector).
- **A switcher in a path** is a ghost button with an avatar, the value and `ChevronsUpDown`,
  opening a `DropdownMenu` radio group with a label (after ReUI `app-shell-7`): the owner in
  `github.com / owner / name`. The choice is made where its effect shows.
- **Progress through a sequence** is the `Stepper` (`primitives/Stepper.tsx`, ReUI's
  `stepper`): a `StepperNav` of numbered indicators with their titles beside them and a
  separator between, a done step ticked through `indicators.completed`. Progress only: no
  `StepperTrigger`, so nothing reads as a way to jump ahead. It counts only the screens that ask
  something and is absent on the ones that do not.
- **The primary action** on a screen is a plain `Button` with its icon and label ("Continue
  with GitHub").
- **A pane's row of controls** is `PaneToolbar` (`composites/PaneToolbar.tsx`): `h-11`, `px-4`,
  `gap-1`, no edge and no hotkeys of its own (that is `PanelHeader`). Mail's toolbar, selection
  bar, find bar and reader header and both Agenda headers are one, and what sits under it is
  `px-4` too, so every plugin pane has one left edge. Secondary actions that would crowd a narrow
  pane go behind a "More actions" `DropdownMenu` rather than off its edge.
- **A region with nothing to show** is `EmptyState` (`composites/EmptyState.tsx`): a muted icon,
  one sentence, a quieter line under it and at most one action, centred in the region the same
  way in every pane. An error is the same shape with `role="alert"` and "Try again"; a
  disconnected account offers the setting that fixes it. `LoadingRows`, beside it, is the
  loading state: skeleton rows of `motion-shimmer` the height of the real rows, under
  `role="status"`.

### Trees

Every tree is `primitives/Tree.tsx`: ReUI's `tree` (installed with its `c-tree-1` example) driven
by a `@headless-tree/react` instance. The file tree, the settings rail and History's log use it,
so the app has one tree look.

- **A row is a chevron, an icon and a name**, `text-nav`, with the chrome rows' fills (hover
  `[0.04]`, current or selected `[0.06]`, a drop target `[0.08]`) on ReUI's own `rounded-md`
  label. A row without children has no chevron and is padded by the chevron's width, so names at
  one level line up. The indent is flat, 20px a level: the chevron and its gap, so a child's
  chevron sits under its parent's icon. No connector lines, no bars.
- **Calm.** The only motion is the hover colour (`motion-respond`). A folder opens and closes at
  once, the chevron turns without a transition, and rows arrive without an entrance. The trees
  are read all day; a line to follow or a slide to wait for on each of them was noise.
- **The instance flattens, indents and labels; the tree's own code handles input.** A prop on
  `Tree` or `TreeItem` wins over the instance's, so a tree keeps its own click, tab stop and
  selection. The explorer uses no headless-tree feature beyond the data loader. The settings
  rail and History add its arrow keys (`hotkeysCoreFeature`), mapping a key's expand onto their
  own state (opening a section shows it; opening a commit picks it).
- **A drop beside a row** is `TreeDragLine`: a rule with a ring at its start, at the row's indent.

### Doing the work last

A flow that changes the world (creates a repo, writes files, sends something) **collects every
answer first and acts once, at the end**, behind a button that names the act ("Create vault",
not "Continue"). Backing out before that leaves nothing behind. The act then runs on a screen of
its own that lists its real steps as they land (spinner, then tick; `aria-live="polite"`), each
held on screen for a short beat so a fast network still reads as something being made, and
turns into the result when the last lands. A step is listed only if it is real work: no
decorative "finishing up". A failure goes back to the screen whose answer caused it (a taken
name, to naming), with the reason and every other answer kept. The onboarding ritual is the
reference ([onboarding](features/onboarding.md)).

### States

Every region that loads has all three, in the region, not as a page-level overlay:

- **Loading**: rows of `motion-shimmer` the height of the real rows (three is enough), with
  `role="status"` and a label.
- **Empty**: says why it is empty and offers the one thing to do about it, and the reasons are
  told apart when they need different fixes (the join picker: nothing matches, everything is
  already added, or an organisation has not approved Holi).
- **Error**: inline, where the data would be, with Retry; the user's place is kept.

### Copy

Short, plain and specific: a button is a verb and its object ("Create vault", "Show all
vaults"); a lede says why, not what; reassurance ("Change any of these later in Settings")
appears once per screen, not per row; a status is a sentence ("Waiting for you to approve…").
British spelling in the interface, as in the docs.

## Drawers

Every sidebar is one drawer: the nav, history and the last turn are `composites/DrawerShell.tsx`.
A drawer pushes: its column's width transitions 0 → w at the slide pace, the same both ways, so a
press mid-slide reverses it. It is the one layout property animated outside CodeMirror, and the
editor beside it reflows during the slide. It owns its column rather than living in
`react-resizable-panels`, which cannot animate a size. Each opens at 320px and resizes between 150
and 560 (`lib/drawer.ts`) by pointer (1:1, transition off) or arrow keys, remembering its own
width. The nav closes to an 80px rail (`features/nav/NavRail.tsx`): the window's lights, its toggle, the
modes and the sidebar's destinations as icons, sliding in on the same width transition. The PDF viewer's sidebars are that library's
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
- Holi's own theme is one file, `main/vault/seed/vault/once/.holi/settings/theme.css`, written on
  Tailwind's palette (monotone: the brand is the `zinc` ramp itself, a near-white `--primary` in dark and near-black in light; dark surfaces on the slightly cool
  `zinc` ramp, lifted off black: the page is `#121212`, cards and menus a
  step up mixed from the page itself, `--divider` a `color-mix()` of border and
  background). It is a vault's seed and what a reset writes back, and `index.css` imports it, so the
  look outside a vault and a fresh vault's theme are one text that cannot drift.
- Seeded once, then the vault's: Holi never fills the file in again, so what a vault changes or
  removes stays. A token the file leaves out shows the built-in value. Appearance resets one token
  to Holi's value, or a whole mode (Holi's block into `theme.css`, that mode's local overrides
  cleared), each confirmed first for a mode.
- A colour value is a literal, `var()` of another colour token or a palette colour
  (`--color-<hue>-<shade>`, `white`, `black`), or a `color-mix()` of two of those. A reference
  names only a colour, so it cannot reach spacing or size.
- `useVaultTheme` (mounted in `Shell`) writes the resolved values onto
  `document.documentElement`, so Radix portals inherit them. A malformed file degrades to no theme.
  The agent authors themes through the seeded `theme` skill.
- A third-party UI in a shadow root is themed by a token map, not restyled: the PDF viewer's
  palette is `var(--token)` strings (`plugins/pdf/renderer/pdf-viewer-config.ts`), which inherit across the shadow
  boundary.

## Rules

- State shows by background colour, never by borders, rings or outlines. A text field is a grey
  fill, not an edge; focus is the one exception, defined above. A ticked card and the current
  step lift their fill, nothing else.
- Chrome rows (sidebar rows, tabs, tree rows, the settings rail, the vault switcher, the
  profile trigger, Home's tabs and rows) share one fill scale on the foreground:
  hover `bg-foreground/[0.04]`, pressed `[0.07]`, current, open or selected `[0.06]`, a drop
  target `[0.08]`; `rounded-lg`, `h-7`, `px-2`. A fill mixed from the foreground keeps the
  page's own hue on any theme, where `accent` is a fixed step.
- Hue identifies, it does not decorate: a brand mark, a file type, a status, the destructive red.
  Everything else is the grey ramp. The two exceptions are the brand's own: the still light on the
  ground and `--brand-gradient` on its two carriers; neither is spent on anything else.
- The sidebar sits on the window's `--ground`; the content floats beside it as one panel on the
  page. The panel is the shell's frame, not a card: nothing inside it is a card around a screen.
- Only floating things (dialogs, menus, popovers, tooltips, toasts) get `--popover` and a shadow,
  `rounded-lg` and no border of their own, in React and CodeMirror alike (the wiki preview, the
  outline flyout, the completion popup).
- A toast is `toast()` from `primitives/Sonner.tsx` (shadcn's `sonner`), shown by the one
  `Toaster` the shell mounts with the mode in force; never a hand-rolled status box.
- A dialog is the menu's surface, not a modal page: no dimmed backdrop, solid `--popover`, and
  stock buttons (the primary act in the theme colour, a destructive one in red). A question about one thing is asked where that thing is (`Dialog`'s `within`), leaving
  the rest of the app usable.
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
- Filling a vault's file with Holi's resolved values on every read: a token could never be left to
  Holi, and a vault's own removals came back.
- A second copy of Holi's theme as resolved hex values beside `index.css`: two sources that drift,
  and derived tokens frozen instead of following the tokens they mix.
- Motion by convention without a lint rule: that is how the unchosen `transition-all` pile arose.
- Springs beyond the three families above, or stated at a call site instead of `springs.ts`.
- A coloured brand: the violet primary went monotone, because one hue on every button competed
  with the marks that identify things.
- A card around a whole screen (sign-in's glass card): it framed the one thing on the page and
  added nothing the page did not already give.
- Creating the vault at the naming step: every later answer had to be written over a repo that
  already existed, and backing out left a repo behind.
- Theming the titlebar: needs a custom titlebar, which is a layout change.

## Code

- `apps/desktop/src/renderer/src/index.css`: tokens, motion utilities, drawer and reduced-motion rules.
- `apps/desktop/eslint.config.mjs`: the gate, including the local `holi/icon-through-primitive` rule.
- `apps/desktop/src/renderer/src/primitives/Icon.tsx`, `IconButton.tsx`, `FileType.tsx`,
  `composites/file-icons.tsx`, `composites/marks.tsx`.
- The baseline's parts: `composites/SettingCard.tsx`; `primitives/Frame.tsx`, `IconTile.tsx`,
  `Badge.tsx`, `InputGroup.tsx`, `Stepper.tsx`, `Skeleton.tsx`, `Choice.tsx`; the reference screens in
  `features/onboarding/` and `features/auth/SignIn.tsx`.
- `apps/desktop/src/renderer/src/lib/motion.ts`, `lib/use-ack.ts`, `lib/use-arrivals.ts`.
- `apps/desktop/src/renderer/src/composites/DrawerShell.tsx`, `lib/drawer.ts`.
- `apps/desktop/src/renderer/src/composites/PaneToolbar.tsx`, `composites/EmptyState.tsx`.
- `apps/desktop/src/plugins/pdf/renderer/pdf-viewer-config.ts`.
- `packages/shared/src/theme.ts`: parse, whitelist, validate, merge.
- `apps/desktop/test/focus-treatment.test.ts`, `test/motion.test.ts`, `test/theme-tokens.test.ts`.
