# anytype-ts — what to take, what to leave

Source: [`anyproto/anytype-ts`](https://github.com/anyproto/anytype-ts) @ `775df05` (v0.56.1), shallow
clone reviewed 2026-08-06. Electron + React + MobX desktop client over a Go middleware
(`anytype-heart`) reached by gRPC; local-first, E2E-encrypted, P2P-synced via any-sync. ~1,900 TS/TSX
files. All file references below are theirs unless prefixed with `apps/` or `docs/`.

**Verdict:** the product overlaps Holi's (a local-first knowledge base with a tree, tabs, a graph, a
board, sync status), the *architecture* almost nowhere — they are block-and-object-id native, Holi is
markdown-and-path native, and that difference cascades through everything above the file layer. The
value is concentrated in their **Electron main process** and their **repo-level agent/QA
conventions**, both of which are architecture-neutral and both of which are ahead of ours.

---

## The licence bounds the answer: nothing here can be *directly* used

`LICENSE.md` is the **Any Source Available License 1.0**, not an OSI licence. It grants use,
modification and redistribution only

> (a) for Non-Commercial Use, or (b) for Commercial Use in Allowed Networks.

with "Allowed Networks" defined as the networks at `https://networks.any.coop` that the Software may
send requests to, and "Non-Commercial Use" explicitly excluding *"uses where the Software facilitates
any transaction of economic value other than on Allowed Networks"*. "Use" is defined to include
modification and distribution of **any part of it**.

Holi is commercial infrastructure for Syv.ai that talks to GitHub, not to any-sync. So the grant does
not reach us for anything we would ship. That rules out vendoring a file, lifting a SCSS block, and
copying a JSON registry or a `SKILL.md` verbatim — the licence makes no size exemption.

**Everything below is a technique to reimplement from a described mechanism, not a file to copy.**
Where the technique is an OS fact (statfs magic numbers, Squirrel.Mac's handoff behaviour) the fact
is not theirs to license; the code expressing it is. Write our own.

---

## Take these (Electron main, ranked by what it costs us today)

### 1. Local-state writes that can actually survive a crash — `electron/ts/safeStorage.ts:19-102`

Their `SafeStorage` is a small JSON store with three properties we don't have:

- **fsync before rename.** `openSync` → `writeSync` → **`fsyncSync`** → `closeSync` → `renameSync`
  (`:84-102`). Ours stops one step short.
- **A `.bak` kept across each write**, and `_load` falls back to it when the main file is missing or
  unparseable, then restores it (`:44-59`).
- **Orphaned-`.tmp` recovery on load** (`:20-40`) — if the process died after fsync but before the
  rename, the next launch finds the temp file, validates it parses, and promotes it. Otherwise it
  deletes it as a torn write.

We already do tmp+rename in five places — `main/vault/registry.ts:98-103`,
`main/github/token-store.ts:115-120`, `main/google/token-store.ts`, `main/google/calendar-prefs.ts`,
`main/reminders/delivered-log.ts:58` — and **`fsync` appears nowhere in the repo** (grepped). Without
it, a rename can be durable while its data isn't, which lands a zero-length or truncated file at the
final path. Each of those five also open-codes the same dance slightly differently.

The one that matters most is the **vault registry**, because its corrupt-read path returns `[]`
(`registry.ts:85-96`) — a clean, silent, empty vault list on next launch. The clones are still on
disk and GitHub still has the content, so nothing is *lost*; it just looks exactly like everything
is. That is precisely the failure `architecture.md` §9 names ("a second consumer cannot tell an
unloaded store from an empty one, and the failure looks like data loss"), reached by a different
road.

**Do:** one `atomicJsonStore` helper in `main/`, with fsync + `.bak` + tmp-recovery, and move all
five call sites onto it.

### 2. Refuse to sit on a cloud-sync folder or a network filesystem — `electron/js/preload.cjs:15-200`

The single best piece of engineering in the repo, and the one with the most scar tissue visible:

- **Segment-level** cloud markers, matched per path segment rather than per path — their comment
  calls out that a substring match turns `Sandbox` into `box` (`:17`).
- macOS File Provider folders are `<Provider>-<account>`, so `GoogleDrive-<email>` needs its own
  pattern (`:22`).
- **Dropbox's real folder is read from `~/.dropbox/info.json`** (`%APPDATA%` on Windows) rather than
  guessed by name, because it can be anywhere (`:89-110`).
- Linux: `/proc/self/mounts` fstype is authoritative and is checked **before** statfs magic —
  explicitly because FUSE also backs *local* filesystems (`ntfs-3g`, `gocryptfs`), so a FUSE magic
  number proves nothing while `fuse.sshfs` / `fuse.rclone` do (`:35-37`, `:112-142`).
- macOS: `statfs.type` is not a usable name, so they parse `/sbin/mount`, greedily, so mount points
  containing `" ("` still parse (`:170-190`).
- Windows: UNC paths detected; **mapped network drive letters explicitly not detected in v1** and
  said so in the comment (`:145`).

Holi's exposure is narrower than theirs — `~/Holi` is fixed at `os.homedir()/Holi`
(`docs/glossary.md:12`), and neither OneDrive Known Folder Move nor iCloud Desktop&Documents
redirects the home *root*. But the network-filesystem half lands squarely: a corporate `$HOME` on
NFS or SMB is ordinary, and a **git repo on NFS** is a known-bad combination (lock files, mtime
granularity, `index.lock` races) — and we run `git` against that clone on an autosave debounce, a
coalescing push timer, an interval pull, and every focus.

**Do:** the network-FS check on vault add and on launch, surfaced as a warning banner naming the
detected filesystem, not a hard refusal. The cloud-marker half is worth having behind the same
function for the Dropbox-synced-home case, but it is second priority given the fixed root.

### 3. One id-keyed shortcut registry — `src/json/shortcut.ts` + `src/ts/lib/keyboard.ts:150,2103`

A single declarative tree of `{ id, name: translate(...), keys: [ cmdKey, 'n' ] }`. It is the source
of truth for **four** things at once:

- **Dispatch.** `keyboard.shortcut('createObject', e, cb)` (`keyboard.ts:2103-2145`) resolves the id
  through the registry and falls back to parsing a literal `'cmd+c'` when the id is unknown — so the
  registry and ad-hoc bindings coexist during migration instead of requiring a big-bang cutover.
- **The shortcuts help sheet**, rendered from the same tree.
- **User rebinding** — `Storage.getShortcuts()` overrides `keys` by id at registry-build time
  (`shortcut.ts:14-19`), so a rebind needs no change at any call site.
- **Platform variance** — `cmdKey`, and `isWin ? {...} : null` entries, resolved once in one place.

Holi has `renderer/src/lib/hotkey.ts` (a glyph string that both displays and binds — a genuinely nice
idea, and better ergonomics than their array-of-keys), but no registry: `⌘⇧D` and `⌘T` are hand-rolled
in `components/Shell.tsx:150,168`, `⌘S` in `composites/EditorPane.tsx:207`, more in
`features/agent/AgentPanel.tsx:122`, and only `composites/PanelHeader.tsx:56` and `MailView.tsx:484`
go through `matchHotkey`. Twelve `metaKey` sites, no way to enumerate them.

**Do:** keep the glyph string, add the registry — `Record<CommandId, { label, hotkey: '⌘⇧D' }>` in the
renderer, with `matchHotkey` reading from it. That buys a shortcuts sheet, conflict detection at
build time, and rebinding later, for roughly the cost of moving twelve string literals. It fits
Holi's layering: the registry is domain-agnostic, so it sits at `lib/` or `composites/`, and no
feature needs to import another feature to know a key is taken.

### 4. An explicit key → scope map for local state — `src/ts/lib/storage.ts:6-38`

Three literal `Set`s — `ACCOUNT_KEYS`, `SPACE_KEYS`, `LOCAL_KEYS` — decide, per key, which scope a
preference is stored under, and `get`/`set` route through them. Not clever; the point is that the
routing decision is a **list you can read in one screen** rather than a judgement made afresh at each
call site.

Holi has the same three-way split with sharper consequences, because ours is a *sync* boundary and
not just a namespace: `.holi/settings.json` (committed, travels to the whole team),
`.holi/settings.local.json` (gitignored, machine-local), and the app-level registry in `userData`.
A setting written to the wrong one either fails to follow you or follows you into a shared commit.
The `.local.` marker (D65) is the rule, but nothing enumerates which keys belong where.

**Do:** a single `SettingScope` map in `packages/shared`, keyed by setting name, that the main-process
readers and writers both consult. Pure and testable, which is what `packages/shared` is for.

### 5. Window + tab session restore, with a versioned fallback — `electron/ts/window.ts:886-970`

`serializeWindow` captures `{ tabs, activeIndex, bounds }` per window; `saveTabs` writes an array of
them and **puts the exiting window first** so its tabs land in the window created at startup
(`:911-936`). `loadAllWindows` reads the multi-window key, and falls back to the legacy
single-window key for users upgrading (`:943-958`), then deletes the old key on next write. Window
geometry itself is `electron-window-state` (`:126-140`), not hand-rolled.

Holi's `createWindow` (`main/index.ts:93-114`) is a fixed 1200×800 with no state persistence at all,
and `prd/notes-editor.md` §Panes & tabs is a forward-looking constraint we haven't paid for yet.
The migration-fallback shape is the part worth copying deliberately: our persisted shapes *will*
change once vault-apps open as first-class tabs (`prd/vault-apps.md`), and reading-old/writing-new
beats a migration step.

### 6. Sync status as two enums and a separate error taxonomy — `src/ts/interface/syncStatus.ts`

`SyncStatusSpace` (Synced/Syncing/Error/Offline/Upgrade) and `SyncStatusObject`
(Synced/Syncing/Error/**Queued**) are distinct types, `SyncStatusError` is a *separate* axis
(StorageLimitExceed, IncompatibleVersion, NetworkError, Oversized), and counters
(`syncingCounter`, `notSyncedCounter`, `devicesCounter`) sit alongside rather than being folded into
the status.

`prd/vaults-sync.md` FR-21 gives a vault exactly one of seven states, and FR-22 argues the unpushed
count must appear **only** while a push is failing. I think FR-21/FR-22 remain right for the
vault-level indicator — a git working tree genuinely has one state, and their `Upgrade` and
`StorageLimitExceed` are artefacts of a hosted network we don't have. What their split earns is the
**per-object** row: `Queued` is a state a single file can be in while the space is merely `Syncing`,
and it is the state that answers "is *this* note safe to close the laptop on". We have no per-file
answer. Worth knowing we chose not to have one, rather than discovering it.

### 7. The updater's scar tissue — `electron/ts/update.ts:81-160`

We ship no auto-updater yet (`electron-updater` appears nowhere in our tree), so this is a bookmark
for when we do. Three things they learned the hard way, all in comments:

- **Linux `quitAndInstall` can fail silently.** It runs the package install synchronously via
  `spawnSync` (`pkexec dpkg -i`); if the user cancels the polkit dialog, electron-updater never calls
  `app.quit()`, leaving a zombie app with its middleware already stopped. They force-exit after 5s
  (`:139-160`).
- **The same force-exit must not run on macOS.** Squirrel.Mac needs the app and its internal proxy
  server alive until the native handoff completes; exiting early kills the proxy mid-fetch, the
  install silently fails, and the app relaunches on the old version. This is the kind of thing you
  only learn by shipping it wrong.
- **`isAllowed()`** refuses to update on Windows ≤ 8 and macOS ≤ 10 and on unparseable versions
  (`:81-110`) — a version gate that fails closed rather than half-installing.

### 8. `setWindowOpenHandler` → deny — `electron/ts/window.ts:89, 339`

Every window and every tab view denies `window.open` and routes the URL to the OS browser. Holi
sets none, so Electron's default applies: a popup gets a **new `BrowserWindow` with the inherited
`webPreferences`** — same preload, same tRPC bridge — pointed at whatever URL asked for it.

Being accurate about the size of this: it is **defence in depth, not a live hole.** Our one
untrusted-HTML surface is the mail frame, and it is already correct twice over —
`features/google/SandboxedHtml.tsx:248` is `sandbox="allow-same-origin"` with no `allow-popups` (so
the sandbox blocks popups outright), and `:175-182` delegates anchor clicks to `openExternal` after
`preventDefault`. The reason to add the handler anyway is that
`prd/vault-apps.md` puts agent-authored HTML in a webview inside the app, and
`architecture.md` §10 already books prompt-injection-via-shared-content as a residual risk. It is one
line in `createWindow`; add it now while the cost is one line.

---

## Take these from their repo conventions (this is where they are furthest ahead)

### 9. The product repo carries its own QA skills — `.claude/skills/`

An inversion worth noticing: **Holi seeds `.claude/skills/` into the *vault*, and has none in the
product repo.** anytype-ts has seven, each an executable convention rather than prose:

- **`dark-mode-check`** — audits SCSS/TSX for hardcoded colours, missing dark icon variants, inline
  `html.themeDark` overrides living outside the theme folder, and dynamic icon paths missing
  `getThemePath()`. It even encodes the negative rule: *never duplicate an unchanged light value into
  the dark theme.*
- **`/polish-ui`** — a design-system audit with an explicit checklist (font sizes come from mixins
  never raw px; colours are `var(--color-*)`; spacing on the 2/4/6/8/10/12/16/20/24/32 grid;
  radii from {4,6,8,12}; and the project-specific `no cursor: pointer anywhere`).
- **`update-docs`, `qa-engineer`, `release-notes`, `typescript-code-review`, `commit-push`.**

Their `CLAUDE.md` then wires these as **post-conditions**: "after any task that edits `src/scss/`,
`src/img/`, or adds a UI component, run `/dark-mode-check`"; "after any task that modifies
user-facing behaviour in editor/menu/popup/sidebar/widget, run `/qa-engineer`" — each with an
explicit *skip* clause so the gate doesn't fire on type refactors or CSS-only tweaks.

This maps onto Holi almost one-for-one, and onto the part of our stack that is currently guarded by
an ESLint rule and nothing else. Our token discipline is enforced structurally where it can be
(`eslint-plugin-boundaries`, the banned-native-element rule, the colour-literal ban) — but the
per-vault theme whitelist (D64), the motion tier, and the `primitives/composites/features` altitude
call are all judgement, and judgement is what a skill is for. **A `/theme-check` skill — does this
token exist in the whitelist, is the value expressible as a custom property, is this the right
altitude — is the natural Holi analogue of `dark-mode-check`.**

### 10. A `docs/` tree that mirrors the source tree, kept delta-driven

`docs/src/ts/component/block/README.md`, `docs/src/ts/lib/api/README.md`, `docs/electron/README.md`
— a README per module, each a table of files with one-line descriptions, linked from `CLAUDE.md` as
a directory. The `update-docs` skill keeps them honest with a rule I'd adopt verbatim in spirit:
**only update sections the change actually touched; never rewrite unrelated content; skip trivial
changes entirely.** It also lists what *not* to document (function-level API docs, changelog,
TODOs, anything already in `CLAUDE.md`).

Holi's `docs/` is deep on *reasoning* — PRDs, specs, plans, a decision inbox — and thin on
*orientation*: nothing tells you what lives in `main/vault/` or what the eleven modules in
`packages/shared/src` are for without reading them. Those are different jobs and we only do one.
The counter-argument is real (a mirror tree is a second copy of the truth, which is the exact
argument `architecture.md` §7 uses to reject a link index) — the difference is that a link index
must be *correct* to be useful, while an orientation README that is 90% right still saves the read.

**Do:** a README per top-level module directory, capped at a table and a paragraph, plus the
delta-driven update rule. Not the full mirror.

### 11. A dependency-licence gate — `check-licenses.js`

`license-checker --production --json` → check every package against an allowlist fetched from
`anyproto/open/main/compliance/licenses-config.json`, exit 1 on a violation, with per-package
carve-outs commented with the reason (`hyphenation.*` is LGPL; first-party `Any Association`
packages pass).

Note the honest part: in `.husky/pre-commit` **the licence check and the gitleaks scan are both
commented out**, while `package.json:1197-1201` still declares a `husky.hooks.pre-commit` that runs
neither. The mechanism exists and is not running. Take the mechanism, and take the warning about
gates that quietly stop being gates — we have our own pre-commit lint-staged hook to keep honest.

---

## Deliberately not taking

- **Auto-imports (`unplugin-auto-import`).** `docs/RFC-AUTO-IMPORTS.md` is a genuinely good RFC:
  ~250 files importing from a `Lib` barrel produced `Lib → Store → Lib` cycles, killed tree-shaking,
  and made every file depend on everything. Their fix injects the imports at build time so `S`, `U`,
  `J`, `I`, `keyboard`, `translate` are ambient globals. It solves the cycle and **keeps the
  coupling** — every module can still reach every other, there is just no longer a written record of
  it. That is the opposite of Holi's bet: our whole UI system is an *import graph* constraint
  (`primitives` → `composites` → `features`, enforced by `eslint-plugin-boundaries`), and a rule that
  bans an import cannot see an import that was never written. Adopting this would disarm our gate.
  The right lesson from the RFC is the diagnosis, not the cure: **don't build barrel files** — which
  we currently don't, and shouldn't start.
- **MobX class stores.** Jotai's atoms + action atoms are already load-bearing for us
  (`architecture.md` §9) and their `observer()`-everywhere posture buys nothing we lack.
- **`WebContentsView` per tab.** They run each tab as a separate `WebContentsView` with its own
  renderer, which is why they need `getTabBarHeight()` arithmetic (`window.ts:806-830`), per-view
  focus restoration with a `setImmediate` race guard (`:60-72`), and menu-bar height fudging on
  Windows. Holi's tabs are in-renderer views over one CodeMirror host; the process isolation would
  buy crash containment we don't need and cost us the shared vault store.
- **Storybook-first QA.** 357 `.stories.tsx` against **29** `.test.ts`, with real coverage pushed
  into a *separate* Playwright repo (`../anytype-desktop-suite`). Holi is the mirror image — 105
  test files, zero stories, CDP probes in `apps/desktop/e2e/`. For a component library that ratio
  makes sense; for our shape (pure rules in `packages/shared`, thin renderer) ours is right. Storybook
  is worth revisiting only as documentation for `primitives/`, not as the QA strategy.
- **Object ids as identity.** Their objects have stable ids, so rename is free, backlinks are an
  index, and a link never breaks. We chose paths (D60 §6), which costs us exactly that — a
  skill-driven rename that isn't atomic and can miss a link (`architecture.md` §5). Seeing their
  side priced out doesn't change the call: the id model is what forces the gRPC middleware, the
  block store, and the mapper layer, and it is fundamentally *not* greppable by an agent holding a
  directory of markdown. But it does confirm which bill we agreed to pay.
- **Their `AGENTS.md`.** 305 lines describing `src/main/`, `src/renderer/`, `webpack.config.js` and
  MobX store boilerplate — a structure the repo does not have (it's `src/ts/` + `electron/`, on Vite).
  It reads as generated-once and never revisited, while `CLAUDE.md` next to it is precise and
  current. A cautionary data point for us, since `prd/agent.md:125` makes `AGENTS.md` the home of
  every vault convention, read through a `CLAUDE.md` shim: **the file the agent actually reads is the
  file that stays true.** Whatever we put in `AGENTS.md` needs the same maintenance path
  `CLAUDE.md` gets, or it will drift the same way.

---

## Calibration: we already share their workflow

`docs/superpowers/{plans,specs}/` holds date-prefixed design docs
(`2026-08-03-sticky-scrollbar-autohide-design.md`, `2026-06-26-chat-render-performance-design.md`) in
the same shape as `docs/plans/` and `docs/specs/` here — same naming, same Problem → Why → Design
structure. Their specs are good: the scrollbar one traces a visual bug to styling
`::-webkit-scrollbar` opting Chromium out of macOS overlay scrollbars, cites the existing
`platformWindows, platformLinux` scoping at `src/scss/common.scss:227-232`, and frames the change as
**restoring an intent the codebase already holds** rather than adding a preference. That is the
standard we hold ourselves to, arrived at independently.

Which is the useful calibration overall: on documentation discipline we're peers, on repo-level
agent tooling they're ahead, and on Electron main-process hardening they've been shipping to three
platforms for years and we haven't shipped once.

---

## Shortlist, if only three things get done

1. **`atomicJsonStore`** with fsync + `.bak` + tmp-recovery, and move all five call sites onto it
   (item 1) — smallest change, and the vault registry is the one whose failure looks like data loss.
2. **The network-filesystem check** on vault add and launch (item 2) — we run git against that clone
   on four different timers, and NFS is where that goes wrong quietly.
3. **The shortcut registry** (item 3) — cheap now, and it only gets more expensive as tabs and
   vault-apps add surfaces that want keys.
