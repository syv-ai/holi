# Six fixes — scrollbars, fences, frontmatter, tabs, panes, images

Verified **2026-08-20**, in the running dev app (`electron-vite dev --remote-debugging-port=9333`)
against the real `nthomsencph/privat` vault, driven over CDP.

**Legend:** `[x]` verified in-app · `[~]` verified another way, named below · `[ ]` not verified.

Six symptoms, reported together. Two were not what they looked like: "images cannot be opened"
opened fine, and "scrollbars make content jump" could not be made to jump on this machine. Both are
below, with what they turned out to be.

## 1. Scrollbars — themed everywhere, gutter where it scrolls

- [x] **Reproduced the theming half.** `getComputedStyle(document.documentElement).colorScheme` was
      `normal` in a dark-first app, so every scrollbar Holi did not paint itself came up in
      Chromium's LIGHT default. Only **3** elements wore `.holi-scroll`; a sweep of the live DOM
      found **8** scroll containers on the default screen alone and 25 `overflow-*` sites in source.
- [x] **Measured the trap before choosing a rule.** With scrollbars styled, `scrollbar-gutter:
      stable` applies to `overflow: hidden` boxes too — a 200px hidden box reported `clientWidth`
      190. So `* { scrollbar-gutter: stable }` would have inset every clipped box in the app. The
      gutter is keyed to the vertical-overflow utilities instead.
- [x] **Fixed, live.** `colorScheme: dark`. `.cm-scroller` now reports `scrollbarGutter: stable` and
      reserves its 10px (`offsetWidth` 930 → `clientWidth` 920); the two sidebar lists keep theirs
      without the class they used to need; the five `react-resizable-panels` elements (which set
      `overflow: auto` inline and should NOT reserve) correctly stay `auto`. Six
      `::-webkit-scrollbar` rules live in the sheet.
- [ ] **The jump itself was never reproduced.** This machine has macOS overlay scrollbars
      (`AppleShowScrollBars` unset, no mouse attached at the time): measured, an unstyled
      `overflow: auto` box takes **zero** layout width, so nothing can jump. The reported symptom
      needs classic scrollbars — "always show" in System Settings, or a mouse plugged in, which is
      the likely explanation. What is verified is that the gutter is now reserved, which is what
      makes the jump impossible; what is not is watching it stop happening.
- [ ] **The light theme's arm**, and the thumb's hover fade. Both are `[ ]` for the same dull
      reason: the window is occluded (see §7), so hovering is not available and no vault here sets
      a light theme.

## 2. Fenced code blocks

- [x] **Reproduced by reading, and it was two missing things, not one.** `markdown()` got no
      `codeLanguages`, so a fence's body parsed as plain text and had no tokens to colour; and
      `codeHighlighting` was in the plain-file stack only. Either alone leaves the block grey.
- [~] **Fixed, verified in a real `EditorView`** (jsdom, `editor/__tests__/fence-languages.test.tsx`
      — the full notes stack, mounted). ` ```python ` renders `def` as a coloured span; a fence with
      no language still renders none; `.cm-code-line`'s grey backing is still there behind the
      tokens. 15 tests, including one that resolves every one of the ~75 names in the table —
      a misspelled `legacy-modes` export is a runtime `undefined`, not a type error.
- [ ] **Not seen in the running window.** Every fence in this vault sits below the fold
      (`.claude/skills/vault-apps/SKILL.md:53` is the earliest), and the occluded window cannot
      scroll: `requestAnimationFrame` never fires, so CodeMirror cannot re-measure. Setting
      `scrollTop` reports back `0`. This is §7, not a doubt about the change.

## 3. Frontmatter on a file whose frontmatter is the point

- [x] **Reproduced.** `.claude/skills/theme/SKILL.md` rendered `▸ 5051 chars · Last updated
      20/08/26, nthomsencph` — a summary of the **body** — with `name` and `description` behind a
      chevron.
- [x] **Fixed, live.** The same file now opens with `data-frontmatter="expanded"` and the widget's
      text reads `▾ name: theme / description: Recolour this vault's Holi app — …`, in the nested
      plain-YAML editor, editable.
- [x] **A note is unchanged.** `20-08-2026.md` still opens collapsed to its pill.
- [x] **It is a default, not a lock** — the chevron still collapses a revealed file (unit test;
      also visible as the `▾` in the screenshot).

## 4. Tab overflow

- [x] **Reproduced.** Six tabs in an 886px strip previously grew the row past its pane.
- [x] **Fixed, live.** The strip reports `scrollWidth === clientWidth` (886/886) with six tabs open:
      four pills and a `+2`. The pane no longer grows.
- [x] **The count is reachable.** The `+2` opens a menu listing exactly the hidden tabs
      (`MEMORY.md`, `.gitignore`).
- [x] **The window slides to the active tab.** Picking `.gitignore` from that menu — the last tab —
      re-rendered the strip as `SKILL · AGENTS · CLAUDE · MEMORY · .gitignore · +1`: the window moved
      right, the active tab is the last visible one, and the tab that fell off the left is now the
      one counted.

## 5. Split panes

All live, in the real vault:

- [x] **⌘\ splits.** One `main` became two, the second empty and focused.
- [x] **A file opens into the focused pane.** Double-clicking `AGENTS.md` in the tree filled the new
      pane, leaving the first alone.
- [x] **Two strips, and the focus cue.** Each pane draws its own; the unfocused pane's active pill
      renders `bg-secondary/40 text-muted-foreground` against the focused one's full-weight pill.
- [x] **Closing the last tab of a split unsplits.** Closing `AGENTS.md` in pane 2 took the pane with
      it — back to one `main`, one strip.
- [x] **Open in a New Pane, from the tree.** The row menu now leads with it; picking it on
      `CLAUDE.md` produced a second pane holding exactly that file.
- [x] **One buffer per file holds ACROSS panes.** With `CLAUDE.md` open in pane 2, focusing pane 1
      and clicking `CLAUDE.md` in the tree moved the focus to pane 2 rather than opening a second
      copy — the guard D77 rests on, watched working rather than reasoned about.
- [x] **Close-pane control** appears on both strips only while a split exists.
- [~] **The apps menu's Open in a New Pane** — the item renders and calls the same
      `openInNewPane`; exercised through the file-tree row rather than the app row, since the two
      differ only in the tab they construct.
- [ ] **A split at a usable width.** Measured in a 1200px window with the agent drawer holding
      658px, the editor slot was at its 360px floor and the two panes came out 179px each — below
      the `minSize={240}` each asks for, because two of them cannot fit. That is the library
      degrading when the minimums are unsatisfiable, not a layout bug, but it means the split was
      only ever seen cramped. Worth one look on a wide window with the drawer closed.
- [ ] **A restart.** Panes are not persisted, and neither are tabs — the same open question,
      recorded under D77.

## 6. Images

- [x] **Not reproduced as reported, and that was the finding.**
      `.holi/document-templates/_brand/logo.png` opens fine: `ImageViewer` mounts, the
      `holi-vault://` URL loads, `naturalWidth` 180, laid out 180×180, `opacity: 1`,
      `visibility: visible`. The file is **black ink on transparency**, and the viewer painted it
      onto `--background` (neutral-950). Everything worked and nothing was visible — which is why
      it read as "cannot be opened".
- [x] **Fixed, live and photographed.** The same file now renders on the checkerboard plate, logo
      plainly visible.
- [ ] **A white-ink logo on the light plate** — the acknowledged half of the trade (the plate is
      paper, not chrome). Not staged; no such asset in this vault.

## 7. The environment, and what it cost

The dev window reports `visibilityState: 'hidden'` while occluded, which pauses
`requestAnimationFrame` **entirely** — measured again today: an `rAF` callback scheduled from CDP
never fires within 1.5s. Anything React renders on mount is therefore verifiable over CDP, and
anything that needs a measured re-layout is not: CodeMirror will not scroll, so §2 could not be
seen and §1's hover fade could not be triggered. `Page.captureScreenshot` forces a frame and does
work, which is why the screenshots above exist.

## Found along the way, not fixed

**A binary with no known extension opens as text and looks like corruption.** A `.ttf` under
`.holi/document-templates/_brand/fonts/` opened in the plain editor as screens of replacement
characters. `fileKind` defaults unknown extensions to `text`, which is right for a `.env` or a
`Makefile` and wrong for a font. Recorded in [`../not-built.md`](../not-built.md); the fix is a
third answer between "editable text" and "typed placeholder", and probably a byte-sniff rather
than a longer extension list.

## Cost worth naming

Two `probe.local.*` image files were written into the vault root while chasing §6 and deleted
again; the working tree ended clean and nothing was committed. They also demonstrated something
worth keeping: **the watcher does not see `*.local.*` files** (`isIgnoredPath`, with a carve-out
only for `theme.local.json`), so they never appeared in the tree at all. Correct, and surprising if
you are using such a name as a scratch file.

## Gates

From `apps/desktop`: `--project node` **1533** · `--project dom` **463** · `@holi/shared` **248** ·
`pnpm typecheck` clean · `pnpm exec eslint src` — 0 errors, the same 2 known warnings
(`EditorPane.tsx:240`, `TaskDetail.tsx:348`).
