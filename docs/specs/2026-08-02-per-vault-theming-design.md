# Per-vault theming — Design

**What this is.** Each vault carries its own **colour + chrome** theme that re-skins the app live and is authorable by the vault agent with native file tools. It realises the "add per-vault css customization … no change to layout — just colors and chrome" ask and generalises the `--color-*` token-override pattern the onboarding ritual introduced (commit `22cd63e`). **Landed 2026-08-02** (`b160542`…`90efb2c`); this spec is the design-of-record — it was built directly, without a separate plan.

**The one-line model.** The active vault contributes a set of **whitelisted CSS-custom-property values** that re-cascade the app's semantic tokens; the file is agent-writable, layout is structurally untouchable, and it live-reloads.

## What already existed (the seam this rode)

- `apps/desktop/src/renderer/src/index.css` — Tailwind v4 CSS-first tokens: `:root` speaks shadcn's semantic vocabulary (`--primary`, `--background`, …) and `@theme inline` exposes them as `--color-*` utilities that hold **`var()` pointers**. Overriding a raw token (`--primary`) therefore re-cascades every utility with no component change.
- The onboarding ritual (`features/onboarding/onboarding-ritual.css`) already proved a scoped `--color-*` override — this feature does the same on the document root, keyed to the active vault.
- The vault watcher → `rescan` → `vault:snapshot` push (`main/vault/{watcher,active-vault}.ts`) and the tRPC-over-IPC router (`main/router.ts`) — the delivery machinery.

## Settled decisions

Agreed with Nicolai 2026-08-02 (brainstorming). These are the substance of **D64**.

1. **Format: a whitelisted token map, not raw CSS.** `.holi/theme.json` — `light`/`dark` blocks, each a map of whitelisted token slug → CSS value. Chosen over raw scoped CSS + a sanitizer because "no layout change" becomes a **structural** guarantee: the vocabulary contains no token that can express spacing, size, or position, so a theme (whoever or whatever wrote it) *cannot* move anything. It also means **no CSS is ever injected** — see Security.
2. **Whitelist = colours + paint-only chrome.** The 19 semantic colour tokens (`background`/`foreground`/`card`/`popover`/`primary`/`secondary`/`muted`/`accent`/`destructive` + `-foreground` pairs, `border`, `input`, `ring`), plus `scrollbar-thumb(-hover)` and `selection`; and chrome: `radius`, `shadow-popover`, `shadow-dialog`. Every knob is paint-only. Titlebar/window chrome was **excluded** — see Deferred.
   - **`brand` joined later (2026-08-20), and the reason generalizes.** `--primary` is the brand as a **fill** — it is paired with `--primary-foreground` on top of it — and on a dark-first theme a fill dark enough to carry near-white text is far too dark to *be* text on a near-black background: sky-700 on neutral-950 measures **3.38:1**, under AA. `--brand` is the same brand as **text** (sky-400 dark / sky-700 light, **9.09:1**), and every `text-primary` in the tree moved onto it. A vault recolouring the brand should set both; setting only `primary` recolours the fills and leaves the text where it was. The same split is handed to vault apps (`APP_BASE_TOKENS`) and taught in the authoring skill, because the worst instances of the old blue were an app's own links.
3. **Storage: committed + personal override.** `.holi/theme.json` is committed (travels with the vault, shared with collaborators, agent-writable). `.holi/theme.local.json` is gitignored (`*.local.*`) and **overrides per key within each block** (deep merge, local wins) — a one-line local file recolours just `primary` and inherits the rest. **Both are seeded empty** (`{"dark":{},"light":{}}`) in every vault (`SEED_FILES`), so the theming slots are discoverable rather than something you must know to create; empty blocks = the standard look until edited.
4. **Light + dark blocks; dark applied today.** The schema carries both; the hook applies the block matching `data-theme` (unstamped today ⇒ dark). Ready for a future toggle, exercised by nothing now.
5. **Applied on `document.documentElement`.** Not an inner wrapper — Radix dialogs/popovers/menus portal to `document.body`, so only a root override reaches them.
6. **Malformed/unknown/invalid degrades, never breaks.** Bad JSON ⇒ empty theme; unknown/invalid keys are dropped per-key with a warning; the app is fully functional with no theme file at all.

## Architecture (as built)

- **Pure core** — `packages/shared/src/theme.ts`: `parseVaultTheme`, `resolveTheme(committed, local)` (parse → per-key deep-merge → whitelist filter → validate → `{light, dark, warnings}`), `themeBlockToVars`, and the `THEME_TOKENS` whitelist. Colour values validated as colour-shaped, `radius` as a length, shadows gated only by an injection-safety check. Red→green tested (`packages/shared/test/theme.test.ts`).
- **Main** — `main/vault/theme.ts`: `readVaultTheme(root)` (reads both files, resolves) and `resetVaultTheme(root)` (deletes both). Exposed as `theme.read` (query) and `theme.reset` (mutation) on the router. `main/vault/watcher.ts` gains a **watch-only carve-out** so `theme.local.json` live-reloads despite the `*.local.*` filter — without entering the snapshot or a commit.
- **Renderer** — `lib/theme-applicator.ts` (`ThemeApplicator`, a framework-free Humble Object owning the diff/clear DOM bookkeeping) driven by `state/theme.ts` (`useVaultTheme`, mounted in `Shell`). Reads on vault open + on each snapshot tick, diff-applies (no bleed on switch, no flash on unrelated ticks), clears on leaving Shell, and `console.warn`s the resolver's dropped-key warnings.
- **Token layer** — `index.css` gains `--scrollbar-thumb(-hover)`, `--selection`, `--shadow-popover`, `--shadow-dialog` (defaults reproduce the prior look); overlays/dialogs move onto `var()`-backed `.shadow-popover`/`.shadow-dialog` classes (Tailwind v4 bakes `shadow-*` geometry in, so it isn't runtime-themeable). The `wake` keyframe's invalid `hsl(var(--primary)/α)` is fixed to `color-mix`.
- **Reset** — `features/vault/VaultSettings.tsx` → Appearance → **Reset theme**, behind a confirm; the app reverts live via the watcher.
- **Agent authoring** — `.claude/skills/theme/SKILL.md`, seeded into every vault (new and existing, on next open), documents the file schema + token vocabulary so the pure-Claude-Code agent themes via native edits — no bespoke IPC.
- **Drift guard** — `test/theme-tokens.test.ts` asserts every whitelisted token has a `--slug` definition in `index.css`, so the two stores of the vocabulary (TS whitelist, CSS defaults) can't silently diverge.

## Security

The token-map format **eliminates the CSS-injection risk** the old repo carried (a substring-blocklist "theme validator" was the weak point; see `architecture.md` §10). Values only ever become the *value* of a CSS custom property written via `setProperty` and consumed through `var()`; custom-property substitution cannot open a new declaration or rule, and validation additionally refuses `url()`, comments, and rule-breaking punctuation. There is no privileged-context CSS injection to sandbox.

## Rejected

- **Raw scoped CSS + sanitizer** — powerful but makes "no layout" a best-effort promise and reintroduces an injection surface.
- **Token map + raw escape hatch** — two mental models and the same injection surface for the 5% case.
- **localStorage pref** (like `panelLayoutsByVaultAtom`) — can't be agent-written and doesn't travel with the vault.

## Deferred / not built

- **Titlebar / window chrome** — the window uses the native macOS titlebar, which CSS can't recolour; theming it needs a custom (hidden) titlebar, i.e. a **layout change**, which the hard constraint forbids. Out unless that constraint is explicitly relaxed.
- **`theme:changed` push channel** — the renderer currently re-pulls `theme.read` on every snapshot tick (incl. the 30s heal), so reapply is **O(vault activity)**, not O(theme changes). Correct and cheap for a local app, no flash/leak; the clean fix (main watches the two theme files and pushes only on real change) is deferred as efficiency polish.
- **Local per-token "unset" sentinel** — `theme.local.json` can override a token but not reset one to the app default while a shared `theme.json` sets it; **Reset theme** is all-or-nothing at the vault level. A `"unset"`/`null` sentinel in the resolver would close this if wanted.

## Consolidates into

`architecture.md` §9 (UI system — the token tier now carries per-vault overrides) and §10 (the Theme-injection note, resolved by construction).
