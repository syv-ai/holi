# Vault apps slice 1 — what was checked by hand

Companion to [`../plans/2026-08-19-vault-apps-slice1.md`](../plans/2026-08-19-vault-apps-slice1.md).
Verified **2026-08-20**, in the running dev app (`electron-vite dev --remote-debugging-port=9333`),
signed in, against the real `nthomsencph/privat` vault — driven over CDP, with screenshots.

**Legend:** `[x]` verified in-app · `[!]` verified and found broken (fixed; see below) · `[ ]` not verified.

## The app, end to end

- [x] **An app written to disk appears without a restart.** `.holi/apps/vault-dashboard/{index.html,style.css,app.js}`
      written straight into the vault; the sidebar grew an **APPS** section with `vault-dashboard`
      in it within seconds, from the watcher's rescan — no refetch, no reopen.
- [x] **It opens as a tab and renders real vault data.** `holi-app://vault-dashboard/index.html`,
      showing `5 notes` / `15 open tasks` and the first four note paths — the same counts the board
      and tree show.
- [x] **Sibling files are served beside it.** `style.css` and `app.js` load through relative
      `href`/`src`, so an app is a directory rather than one file.
- [x] **`holi.open` navigates Holi.** Clicking `cbs/opslag.md` inside the frame (a real
      `Input.dispatchMouseEvent`, not a synthetic DOM click) opened that note as a third tab with
      its 5311 characters in the editor.
- [x] **The reload button rebuilds the frame**, and the rebuilt document picked up a theme change
      made while it was open.
- [x] **A deleted app leaves a tombstone.** Moving the directory away: the frame disappeared, the
      tab stayed and read *"vault-dashboard was deleted."* with a close button, the sidebar's APPS
      section vanished (hidden when empty), and the close button closed the tab. Restoring the
      directory brought both back.
- [x] **The skill reaches an existing vault with no migration.** `privat` predates this feature;
      `.claude/skills/vault-apps/SKILL.md` was on disk after the next open, because `ensureSeeded`
      runs on open (D70) and create-if-missing writes only what is absent.

## The refusals

Each was run **from inside the app**, by the app's own code, and rendered in the page — a passing
unit test and a working boundary are not the same claim.

- [x] `holi.docs.read('AGENTS.md')` → rejects (`FORBIDDEN`).
- [x] `holi.docs.read('.claude/settings.json')` → rejects (`FORBIDDEN`).
- [x] `holi.docs.read('../../../etc/passwd')` → rejects (`BAD_REQUEST`, "relative path contains '..'").
- [x] `fetch('holi-vault://vault/USER.local.md')` → fails ("Failed to fetch"): wrong origin, and the
      frame has no `allow-same-origin` to give it one.
- [x] `localStorage.getItem('x')` → **throws** ("Failed to read the 'localStorage' property from
      'Window'"), which is what makes slice-1 statelessness structural rather than stated.
- [x] The frame's attributes in the live DOM: `sandbox="allow-scripts"`, and no `allow-same-origin`.

Reasoned, not separately measured: **one app cannot read another's directory.** It is blocked twice
over — the handler resolves only under `<vault>/.holi/apps/<appId>/`, and a cross-app `fetch` is
cross-origin from an opaque origin, which is the same wall `holi-vault://` hit above.

## Found broken, and fixed

- [!] **An unthemed vault rendered an unreadable app.** `appHeadHtml` injected only what the vault's
      theme *overrides*, and the seeded `.holi/theme.json` is `{}` — so a normal vault handed the
      frame `:root{}`. Every `var(--foreground)` resolved to nothing, and the app drew black text on
      a transparent page while **every unit test passed**. The authoring skill tells authors to use
      exactly those tokens, so the default had to be a real palette: `APP_BASE_TOKENS` now underlies
      the vault's block (`app-tokens.ts`), with a test that every themeable token has a default.
      Re-verified: readable, and Holi's own palette.
- [x] **A vault theme still overrides it.** With `primary: #e8a33d` and a warm `background` in
      `.holi/theme.local.json`, the reloaded app was amber on warm-dark — the vault's block wins over
      the base, per key. (The override file was restored afterwards.)

## Not verified

- [ ] **The agent building an app from the drawer**, which is the slice's actual goal. It needs a
      live Claude Code session in the user's own vault and their quota, so it is theirs to run:
      ask the drawer for a dashboard and confirm it discovers the contract from
      `.claude/skills/vault-apps/SKILL.md` without being told the API. Everything the agent depends
      on is verified above — the skill is on disk, and a hand-written app matching its contract runs.
- [ ] **A second app open at the same time.** Dedupe-by-`appId` and two-apps-are-two-tabs are unit
      tested; nothing exercised two live frames at once.
- [ ] **Anything on Windows or Linux.** macOS only.
- [ ] **A large or slow app.** The one app used is trivial; nothing was measured about frame startup
      cost or a big `docs.list`.

## Gates at the time of writing

`vitest --project node` 1284 · `--project dom` 427 · `@holi/shared` 239 · `tsc --noEmit` clean ·
`eslint src` 0 errors and the 2 known warnings (`EditorPane.tsx:240`, `TaskDetail.tsx:348`).
