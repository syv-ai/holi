# Vault apps — slice 1 Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent writes a directory into `.holi/apps/<id>/` and it opens in Holi as a themed tab that can read the vault's notes and tasks — nothing else, and nothing persisted.

**Architecture:** A privileged `holi-app://<appId>/` scheme serves files from one app's directory only, injecting the vault's theme tokens and a `postMessage` bridge into the entry document. The frame is `sandbox="allow-scripts"` with **no** `allow-same-origin`, so its origin is opaque and the bridge is its only route to the vault. The renderer forwards bridge calls into a new `apps.*` router namespace in main, which is where the agent-surface refusal is enforced; the renderer maps a frame to its `appId` at mount, so an app cannot claim to be another.

**Tech Stack:** TypeScript, Electron `protocol.handle` + `registerSchemesAsPrivileged`, tRPC over the existing IPC link, jotai, React, Vitest (`node` project for main/pure logic in `apps/desktop/test/`, `packages/shared` for shared predicates, `dom` for components).

**Spec:** `docs/prd/vault-apps.md` (D74) — §Trust & isolation, §Anatomy, §The `holi.*` bridge, §Slice 1. Read it first. `docs/decisions.md` D74 records what it settled and what it deliberately did not.

---

## Scope

**In:** the protocol handler, theme + bridge injection, the `apps.*` namespace with the agent-surface refusal, an app tab, `docs.list` / `docs.read` / `tasks.list` / `open` (the theme is ambient, not a call), a sidebar Apps section, a manual reload button, a tombstone for a deleted app, and the authoring skill.

**Out, each additive against the above rather than a change to it:** `holi.data` and any writes (§State, deferred), the `utilityProcess` backend, `manifest.json`, personal apps in `userData`, the command palette entry, auto-reload, and an agent action that opens an app.

## File map

- `packages/shared/src/path-safety.ts` — add `AGENT_SURFACE_FILES`, `isAgentSurfacePath`, `APPS_DIR`, `isValidAppId`, `appIdFromPath`. Existing file; these are path predicates and this is where every other one lives.
- `packages/shared/src/app-bridge.ts` *(new)* — the wire types both sides share: `APP_METHODS`, `AppRequest`, `AppResponse`.
- `apps/desktop/src/main/apps/app-protocol.ts` *(new)* — `parseAppUrl`, `appFileAbsPath`, `injectAppHead`, `appHeadHtml`. All pure; the handler that calls them stays in `index.ts`.
- `apps/desktop/src/main/apps/bridge-script.ts` *(new)* — `BRIDGE_JS`, the shim text injected into the entry document.
- `apps/desktop/src/main/index.ts` — add `holi-app` to the existing `registerSchemesAsPrivileged` block; add `protocol.handle('holi-app', …)` beside the `holi-vault` one.
- `apps/desktop/src/main/router.ts` — the `apps` namespace.
- `apps/desktop/src/renderer/src/state/panes.ts` — reshape the `Tab` union; add `openApp`.
- `apps/desktop/src/renderer/src/state/apps.ts` *(new)* — `appIdsAtom`, derived from the snapshot.
- `apps/desktop/src/renderer/src/features/apps/AppFrame.tsx` *(new)* — the frame, the message handler, reload, tombstone.
- `apps/desktop/src/renderer/src/features/apps/AppsSection.tsx` *(new)* — the sidebar list.
- `apps/desktop/src/renderer/src/components/Shell.tsx` — render `AppFrame` for `kind === 'app'`, mount `AppsSection`, label app tabs in the strip.
- `apps/desktop/src/main/agent/seed-content.ts` — add `.claude/skills/vault-apps/SKILL.md` to `SEED_FILES`.
- Tests: `packages/shared/src/__tests__/path-safety.test.ts` (extend), `packages/shared/src/__tests__/app-bridge.test.ts` *(new)*, `apps/desktop/test/app-protocol.test.ts` *(new)*, `apps/desktop/test/router.test.ts` (extend), `apps/desktop/src/renderer/src/state/__tests__/panes.test.ts` (extend), `features/apps/__tests__/AppFrame.test.tsx` and `AppsSection.test.tsx` *(new)*.

## Contracts

```ts
// packages/shared/src/path-safety.ts

/** The files that configure the assistant rather than hold content. An app may
 *  neither read nor write them: `.claude/hooks/google-send-gate.mjs` IS the mail
 *  send gate, so a writable agent surface is an app escalating to the agent. */
export const AGENT_SURFACE_FILES: readonly string[] = [
  'AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'USER.local.md',
]
export function isAgentSurfacePath(rel: string): boolean

/** Where vault apps live. Hidden from the tree already (`isHiddenPath`). */
export const APPS_DIR = '.holi/apps'

/** An app id is the directory name, and it becomes the HOST of a `holi-app://`
 *  URL — hosts are case-folded, so `My_App` and `my_app` would collide and a
 *  mixed-case directory would 404 in a way that looks like a path bug. The
 *  grammar is restricted instead: anything else is not an app. */
export function isValidAppId(id: string): boolean          // /^[a-z0-9-]+$/

/** `.holi/apps/<id>/…` → `<id>`, or null when the path is not under APPS_DIR
 *  or the id is invalid. */
export function appIdFromPath(rel: string): string | null
```

```ts
// packages/shared/src/app-bridge.ts

export const APP_METHODS = ['docs.list', 'docs.read', 'tasks.list', 'open'] as const
export type AppMethod = (typeof APP_METHODS)[number]

export interface AppRequest { id: string; method: AppMethod; params?: unknown }
export type AppResponse =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string }
```

```ts
// apps/desktop/src/main/apps/app-protocol.ts

/** `holi-app://<appId>/<rel>` → its parts. The HOST is the app id; a bare `/`
 *  means `index.html`. Null when the scheme is malformed or the id is invalid. */
export function parseAppUrl(url: string): { appId: string; rel: string } | null

/** Absolute path for one file inside ONE app's directory, or null when the path
 *  escapes it. Two guards compose exactly as `assetAbsPath` does: the URL parser
 *  normalizes raw `../`, and `vaultRelPath` rejects the residue. The root is
 *  `<vaultRoot>/.holi/apps/<appId>` — narrower than `holi-vault://`, which is
 *  the whole point. */
export function appFileAbsPath(vaultRoot: string, appId: string, rel: string): string | null

/** The `<style>` + `<script>` an app cannot produce itself: the resolved theme as
 *  CSS custom properties (`themeBlockToVars`), then the bridge shim. */
export function appHeadHtml(block: ThemeBlock): string

/** Insert `head` immediately after the entry document's opening `<head…>`, or at
 *  the top when there is none (an app may ship a bare fragment). Only ever
 *  applied to the entry document; every other file is served byte-for-byte. */
export function injectAppHead(html: string, head: string): string
```

```ts
// apps/desktop/src/main/router.ts — the apps namespace.
// Every procedure refuses the agent surface HERE, in main. The renderer only
// forwards, and it supplies the appId from the frame it mounted, so an app
// cannot claim to be another one.
apps: {
  docs:  (input: { remote: string }) => Promise<VaultSnapshot['docs']>  // filtered
  read:  (input: { remote: string; path: string }) => Promise<string> // FORBIDDEN on agent surface
  tasks: (input: { remote: string }) => Promise<Task[]>               // snapshot.tasks
}
```

```ts
// apps/desktop/src/renderer/src/state/panes.ts — the reshape.
// Was: SingletonTab = Exclude<Tab, { kind: 'note' }>['kind'] — which encoded
// "every non-note tab is unique", so openSingleton(w, 'app') would have
// typechecked and meant nothing.
export type SingletonTab = 'board' | 'agenda' | 'mail'
export type Tab =
  | { kind: 'note'; path: string; preview?: boolean }
  | { kind: 'app'; appId: string }
  | { kind: SingletonTab }

/** Focus the app's tab if open, else append one. Dedupes by `appId`, exactly as
 *  `openNoteTab` dedupes by path. */
export function openApp(workspace: Workspace, appId: string): Workspace
```

---

## Task 1: the shared predicates

**Files:**
- Modify: `packages/shared/src/path-safety.ts`
- Test: `packages/shared/src/__tests__/path-safety.test.ts`

- [ ] **Write failing tests** covering: `isAgentSurfacePath` true for each of `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `USER.local.md`, `.claude/settings.json`, `.claude/hooks/google-send-gate.mjs`, `.claude/skills/theme/SKILL.md`; **false** for `notes/AGENTS.md` (an exact-match rule, like `isVaultConfigPath` — a same-named file elsewhere is an ordinary note), `agents.md` (case differs), `.holi/settings.json` (Holi's config, not the agent's), and `inbox.md`. `isValidAppId` true for `retro-board`, `csv2`, `a`; false for `My_App`, `retro_board`, `retro board`, `Retro`, `` (empty), `..`, `a/b`. `appIdFromPath`: `.holi/apps/retro/index.html` → `retro`; `.holi/apps/retro/sub/app.js` → `retro`; `.holi/apps/retro` (the bare dir) → `retro`; `.holi/apps/My_App/index.html` → null; `.holi/theme.json` → null; `notes/x.md` → null.
- [ ] Run `pnpm --filter @holi/shared exec vitest run path-safety` → FAIL (exports missing).
- [ ] **Implement** in `path-safety.ts`, beside the existing predicates: `AGENT_SURFACE_FILES` as the four-string array; `isAgentSurfacePath(rel)` returns `AGENT_SURFACE_FILES.includes(rel) || rel.startsWith('.claude/')`; `APPS_DIR = '.holi/apps'`; `isValidAppId(id)` returns `/^[a-z0-9-]+$/.test(id)`; `appIdFromPath(rel)` — return null unless `rel === APPS_DIR || rel.startsWith(APPS_DIR + '/')`, take `rel.split('/')[2]`, return it when `isValidAppId` accepts it, else null. Export all four from `packages/shared/src/index.ts` if that file re-exports explicitly (check).
- [ ] Run → PASS.
- [ ] Commit: `feat(shared): agent-surface and app-id path predicates`.

## Task 2: the bridge wire types

**Files:**
- Create: `packages/shared/src/app-bridge.ts`
- Test: `packages/shared/src/__tests__/app-bridge.test.ts`

- [ ] **Write failing tests** covering: `APP_METHODS` contains exactly the four slice-1 methods and no more (assert against a literal array — this test is the thing that fails when someone adds a method without adding a handler); `APP_METHODS` does **not** contain any `data.*`, `docs.write`, or `theme.*` entry, so slice 1's deliberate absences are asserted rather than assumed. **There is no `theme` method on purpose:** the theme arrives as CSS custom properties on serve (Task 4), so an app reads it with `getComputedStyle` or just uses `var(--primary)` — a getter would be a second source for something already ambient.
- [ ] Run `pnpm --filter @holi/shared exec vitest run app-bridge` → FAIL (module missing).
- [ ] **Implement** `app-bridge.ts` exactly as in Contracts, and re-export from `packages/shared/src/index.ts`.
- [ ] Run → PASS.
- [ ] Commit: `feat(shared): the vault-app bridge wire types`.

## Task 3: URL parsing and containment

**Files:**
- Create: `apps/desktop/src/main/apps/app-protocol.ts`
- Test: `apps/desktop/test/app-protocol.test.ts`

- [ ] **Write failing tests** for `parseAppUrl`: `holi-app://retro/index.html` → `{appId:'retro', rel:'index.html'}`; `holi-app://retro/` → `rel:'index.html'`; `holi-app://retro` → `rel:'index.html'`; `holi-app://retro/sub/app.js` → `rel:'sub/app.js'`; `holi-app://retro/a%20b.css` → `rel:'a b.css'` (decoded); `holi-app://My_App/index.html` → null (invalid id — note the URL parser has already lowercased the host, so assert the *upper*case input yields `my_app`, which `isValidAppId` then rejects for the underscore, and add `holi-app://Retro/index.html` → `{appId:'retro'}` to pin the folding as intended rather than accidental); `holi-vault://retro/x` → null (wrong scheme); `not a url` → null.
- [ ] **Write failing tests** for `appFileAbsPath`: `('/v','retro','index.html')` → `/v/.holi/apps/retro/index.html`; `('/v','retro','sub/a.js')` → nested; `('/v','retro','../../../etc/passwd')` → null; `('/v','retro','/abs')` → null; `('/v','retro','')` → null. Assert the resolved path always starts with `/v/.holi/apps/retro/` — that single assertion is the containment guarantee.
- [ ] Run `pnpm exec vitest run --project node test/app-protocol.test.ts` → FAIL (module missing).
- [ ] **Implement** `parseAppUrl`: `new URL(url)` in a try/catch returning null; return null unless `protocol === 'holi-app:'`; `appId = u.hostname`; return null unless `isValidAppId(appId)`; `rel = decodeURIComponent(u.pathname).replace(/^\/+/, '')`, and `rel === '' → 'index.html'`. **Implement** `appFileAbsPath`: build `join(vaultRoot, APPS_DIR, appId)` as the root, then reuse the same pair of guards `assetAbsPath` uses — `vaultRelPath(rel)` inside a try/catch returning null, then join under that root; return null if `!isValidAppId(appId)`.
- [ ] Run → PASS.
- [ ] Commit: `feat(apps): holi-app URL parsing with per-app containment`.

## Task 4: theme and bridge injection

**Files:**
- Create: `apps/desktop/src/main/apps/bridge-script.ts`
- Modify: `apps/desktop/src/main/apps/app-protocol.ts`
- Test: `apps/desktop/test/app-protocol.test.ts` (extend)

- [ ] **Write failing tests** for `injectAppHead`: `<html><head><title>x</title></head>` puts the injected block immediately after `<head>` and before `<title>`; `<head lang="en">` (attributes) is matched too; a document with **no** `<head>` gets the block at position 0; the app's own content is otherwise byte-identical (assert by removing the injected block and comparing to the input). For `appHeadHtml`: given a `ThemeBlock` of `{ primary: 'oklch(0.7 0.1 250)' }` the output contains `--primary:oklch(0.7 0.1 250)` inside a `<style>`, and contains `BRIDGE_JS` inside a `<script>`; a `</script>`-bearing token in a theme value does not escape the style block (feed a hostile value and assert the tags are still balanced).
- [ ] **Write a failing test** asserting every `APP_METHODS` entry appears verbatim in `BRIDGE_JS` — the shim is a string and cannot be typechecked, so this is what keeps it in step with the wire types.
- [ ] Run `pnpm exec vitest run --project node test/app-protocol.test.ts` → FAIL.
- [ ] **Implement** `BRIDGE_JS`: an IIFE defining `window.holi` with one `call(method, params)` returning a promise — a `Map` of pending ids, a `crypto.randomUUID()` id per call, `parent.postMessage({id, method, params}, '*')`, and a `message` listener resolving/rejecting by id. Expose `holi.docs.list/read`, `holi.tasks.list` and `holi.open` as thin wrappers over `call`. No theme method — the tokens are already on `:root` in the same injected head. **Note `'*'` is correct here and not lazy:** the frame's origin is opaque, so there is no origin string it could target instead; the renderer is what verifies identity (Task 8).
- [ ] **Implement** `appHeadHtml(block)`: `themeBlockToVars(block)` → `--k:v` pairs joined with `;` inside `<style>:root{…}</style>`, values passed through a `String(v).replace(/[<>]/g, '')` guard, then `<script>${BRIDGE_JS}</script>`. **Implement** `injectAppHead(html, head)`: match `/<head[^>]*>/i`; splice `head` after the match, or prepend when there is no match.
- [ ] Run → PASS.
- [ ] Commit: `feat(apps): inject the vault theme and the holi bridge on serve`.

## Task 5: register the scheme and serve

**Files:**
- Modify: `apps/desktop/src/main/index.ts:82-88` (the `registerSchemesAsPrivileged` block) and beside `protocol.handle('holi-vault', …)` at `:200`

- [ ] **Add `holi-app` to the existing `registerSchemesAsPrivileged` array**, same privileges as `holi-vault` (`standard`, `secure`, `supportFetchAPI`, `stream`). `standard: true` is what makes the host parse as the app id. It must stay at **module top level** — the call is invalid after app-ready, which is why the existing block is not inside `main()`.
- [ ] **Add `protocol.handle('holi-app', …)`** next to the `holi-vault` handler: `const vault = host.active()`; 404 when null; `parseAppUrl(request.url)` → 400 when null; `appFileAbsPath(vault.root, appId, rel)` → 403 when null; `readFile` → 404 on throw; respond with `mimeFor(abs)`. When `rel === 'index.html'`, read as `utf8`, run `injectAppHead(html, appHeadHtml(block))` and respond with that string; the block comes from `readVaultTheme(vault.root)` picking `dark` unless the document is in light mode (mirror `state/theme.ts`'s `activeMode` default — dark-first, `:root` wins). Every other file is served as bytes, untouched.
- [ ] **Do not set a `Content-Security-Policy` header.** Network is allowed by D74, so there is no restrictive policy to set — and the keyword a future one would reach for is a trap: **`'self'` matches nothing in an opaque origin**, so `default-src 'self'` would block the app's own `app.js` and read as a path bug. If a policy is ever added it must name `holi-app:` explicitly. Leave a comment saying so.
- [ ] Run `pnpm typecheck` → clean.
- [ ] Commit: `feat(apps): serve an app from its own holi-app origin`.

## Task 6: the `apps.*` router namespace

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/router.test.ts` (extend)

- [ ] **Write failing tests** covering: `apps.read` on `inbox.md` returns its text; `apps.read` on `AGENTS.md`, `MEMORY.md`, `USER.local.md` and `.claude/settings.json` each throw `FORBIDDEN` (assert the code, not the message — the UI distinguishes it from `NOT_FOUND`); `apps.read` on `../outside.md` throws (the existing `safe()` boundary); `apps.docs` omits `AGENTS.md`, `CLAUDE.md` and `MEMORY.md` while including `inbox.md`; `apps.tasks` returns the snapshot's tasks. Seed the fixture vault with `AGENTS.md` and `MEMORY.md` present so the filter has something to remove — a test that passes because the file is absent asserts nothing.
- [ ] Run `pnpm exec vitest run --project node test/router.test.ts` → FAIL.
- [ ] **Implement** an `apps` router beside `notes`: `read` takes `fields({ remote: 'string', path: 'string' })`, throws `new TRPCError({ code: 'FORBIDDEN', message: input.path })` when `isAgentSurfacePath(input.path)`, and otherwise reuses `notes.read`'s body verbatim (`absPathFor(await rootFor(...), safe(...))` → `readFile` → `NOT_FOUND`). `docs` and `tasks` each need the snapshot, and **there is no `snapshotFor` helper** — mirror `vaults.snapshot` (`router.ts:744`) exactly: `const active = deps.host.active()`, use `active.snapshot()` when `active?.remote === input.remote`, else `scanVault(await rootFor(input.remote))`. Then `docs` returns that snapshot's `docs` filtered by `!isAgentSurfacePath(d.path)`, and `tasks` returns its `tasks` unchanged. If the duplication with `vaults.snapshot` grates, lift those four lines into a local `snapshotFor(remote)` and have both call it — but do that as its own commit, not inside this task. Add `apps` to the root router. **The refusal lives here and not in the renderer** — the process rendering untrusted app code must not also be the process deciding what it may read; leave that sentence as the namespace's doc comment.
- [ ] Run → PASS.
- [ ] Commit: `feat(apps): an apps.* namespace that refuses the agent surface`.

## Task 7: the tab union and `openApp`

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/panes.ts`
- Test: `apps/desktop/src/renderer/src/state/__tests__/panes.test.ts`

- [ ] **Write failing tests** covering: `openApp(w, 'retro')` on an empty pane appends `{kind:'app', appId:'retro'}` and makes it active; calling it again focuses the existing tab rather than appending a second (length unchanged); `openApp(w,'a')` then `openApp(w,'b')` yields two app tabs; an app tab survives `pinTab`/close operations like any other. Add a **type-level** assertion that `'app'` is not assignable to `SingletonTab` — `// @ts-expect-error` on `openSingleton(w, 'app')` — which is the regression this reshape exists to prevent.
- [ ] Run `pnpm exec vitest run --project dom panes` → FAIL.
- [ ] **Implement** the reshape from Contracts: replace the derived `SingletonTab` with the literal `'board' | 'agenda' | 'mail'`, add the `{kind:'app'; appId}` member, and express the singletons in `Tab` as `{ kind: SingletonTab }`. Add `openApp` modelled on `openNoteTab`'s dedupe: find `t.kind === 'app' && t.appId === appId`; if found set `active` to its index, else append and activate. Update the doc comment above `Tab` to say the two categories are named rather than derived, and why.
- [ ] Run → PASS. Then `pnpm typecheck` and fix any consumer that assumed every non-note tab was a singleton.
- [ ] Commit: `refactor(panes): name the tab categories; add an app tab`.

## Task 8: `AppFrame`

**Files:**
- Create: `apps/desktop/src/renderer/src/features/apps/AppFrame.tsx`
- Create: `apps/desktop/src/renderer/src/state/apps.ts`
- Test: `apps/desktop/src/renderer/src/features/apps/__tests__/AppFrame.test.tsx`

- [ ] **Write failing tests** covering: the frame's `src` is `holi-app://retro/index.html` and its `sandbox` attribute is exactly `allow-scripts` — assert the *absence* of `allow-same-origin` explicitly, mirroring the existing `'the frame is sandboxed without allow-scripts'` test in `MailView.test.tsx`, because these two frames are opposites and the pair of tests is what says so; a `message` event whose `source` is **not** the frame's `contentWindow` is ignored (post from `window` itself and assert no trpc call); a well-formed `docs.read` request calls `apps.read` with the `appId` the frame was mounted with and posts back `{id, ok:true, value}`; a rejected call posts `{id, ok:false, error}` rather than throwing; an unknown `method` posts `ok:false`; the reload button changes the frame's React `key` (assert a fresh element); an `appId` absent from `appIdsAtom` renders the tombstone and no frame.
- [ ] Run `pnpm exec vitest run --project dom AppFrame` → FAIL.
- [ ] **Implement** `state/apps.ts`: `appIdsAtom` derives from `snapshotAtom` — map `snapshot.files` through `appIdFromPath`, keep entries whose path ends `/index.html` so a directory without an entry document is not an app, dedupe, sort. **Implement** `AppFrame({ appId })`: a `<iframe>` (allowed here — `iframe` is not in the eslint `NATIVE` selector, the same reason `SandboxedHtml` uses one) with `src`, `sandbox="allow-scripts"`, and a `key` from a reload counter. A `useEffect` adds a `window` `message` listener that **verifies `e.source === ref.current?.contentWindow` and ignores everything else** — note `e.origin` is the string `"null"` for an opaque origin, so it is useless as an identity check and must not be used as one. Dispatch on `method` to `trpc.apps.read/docs/tasks` or `openNoteTabAtom`, always passing the **mounted** `appId` rather than anything from the message, so an app cannot address another app's directory. Reply with `AppResponse`. Render the tombstone branch when `!appIdsAtom.includes(appId)`: the app's name, "this app was deleted", and a close button — a tab that evaporates while you are looking at it reads as a crash, and a teammate deleting an app during a pull is exactly when that happens.
- [ ] Run → PASS.
- [ ] Commit: `feat(apps): the app frame, its bridge handler and its tombstone`.

## Task 9: the sidebar Apps section

**Files:**
- Create: `apps/desktop/src/renderer/src/features/apps/AppsSection.tsx`
- Test: `apps/desktop/src/renderer/src/features/apps/__tests__/AppsSection.test.tsx`

- [ ] **Write failing tests** covering: with `appIdsAtom` empty the component renders **nothing** — not a heading, not an empty state; with two apps it renders both names in sorted order; clicking one dispatches `openApp` with that id.
- [ ] Run `pnpm exec vitest run --project dom AppsSection` → FAIL.
- [ ] **Implement** `AppsSection`: read `appIdsAtom`, return `null` when empty, else a small labelled list of `Button variant="ghost"` rows calling `openApp`. **Hidden when empty on purpose** — the same rule the agenda and mail chips follow, because a launcher whose only destination is "go make one" is a dead end wearing the clothes of a feature.
- [ ] Run → PASS.
- [ ] Commit: `feat(apps): a sidebar Apps section, hidden until there is an app`.

## Task 10: wire it into the Shell

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx` (the tab-strip map at ~`:352`, the body dispatch at ~`:420`, the sidebar between `FileTree` and the chip rows at ~`:256`)

- [ ] **Mount `AppsSection`** below `FileTree` and above the chip rows.
- [ ] **Add the body branch**: `tab?.kind === 'app' ? <AppFrame appId={tab.appId} /> : …`, placed with the other non-note branches.
- [ ] **Label app tabs in the strip**: extend the existing `TAB_LABEL` lookup and the icon expression so an app tab shows its `appId` and a default app glyph (`LayoutGrid` from lucide, matching the icon vocabulary already imported there).
- [ ] Run `pnpm exec vitest run --project dom` → PASS (the Shell's existing tests must still pass; fix any exhaustive-switch fallout).
- [ ] Commit: `feat(apps): open an app as a tab from the sidebar`.

## Task 11: seed the authoring skill

**Files:**
- Modify: `apps/desktop/src/main/agent/seed-content.ts`
- Test: `apps/desktop/test/seed-content.test.ts` (extend if it exists; else assert via `ensureSeeded` in `router.test.ts`)

- [ ] **Write a failing test** asserting `ensureSeeded` on a vault with no `.claude/skills/vault-apps/` writes `SKILL.md`, and that running it twice does not rewrite it (never-overwrite). This also pins the property that makes the skill reach **existing** vaults: `ensureSeeded` runs on vault **open** (D70), and never-overwrite only skips files that already exist — so a brand-new seed file lands by itself with no migration.
- [ ] Run `pnpm exec vitest run --project node seed` → FAIL.
- [ ] **Implement** a `vaultAppsSkill` string and add `'.claude/skills/vault-apps/SKILL.md'` to `SEED_FILES`. Content, stated as the authoring contract: an app is a directory under `.holi/apps/<id>/` whose name must match `[a-z0-9-]+`; it must contain `index.html`; other files are served as-is beside it and relative `src` works. `window.holi` is already defined — do not add a script tag for it. The available calls are exactly `holi.docs.list()`, `holi.docs.read(path)`, `holi.tasks.list()` and `holi.open(path)`; **there is no storage** (`localStorage` throws — the frame's origin is opaque) and **no way to write**, so an app must be useful while holding nothing across a reload. Theme tokens are already applied as CSS custom properties, so style with `var(--primary)` etc. rather than literal colours. `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `USER.local.md` and `.claude/` are refused by the bridge.
- [ ] Run → PASS.
- [ ] Commit: `feat(apps): seed the vault-apps authoring skill`.

## Task 12: gates and a real app

**Files:** none — verification.

- [ ] Run the full gates: `pnpm exec vitest run --project node` (~1252, ~2 min), `--project dom` (~415), `pnpm --filter @holi/shared exec vitest run` (~229), `pnpm typecheck`, and from `apps/desktop`: `pnpm exec eslint src` — **0 errors and exactly the 2 known warnings** (`EditorPane.tsx:240`, `TaskDetail.tsx:348`); a third is yours.
- [ ] **Hand-write one app** into a scratch vault at `.holi/apps/vault-dashboard/index.html`: it calls `holi.docs.list()` and `holi.tasks.list()` and renders the two counts, styled with `var(--primary)`. Confirm in the running app: it appears in the sidebar without a restart (the watcher feeds the snapshot), opens as a tab, shows real numbers, and picks up the vault's theme.
- [ ] **Verify the refusals by hand**, because these are the claims that matter and a passing unit test is not the same as a working boundary: from the app's console, `holi.docs.read('AGENTS.md')` rejects; `fetch('holi-vault://vault/USER.local.md')` fails (wrong origin, and there is no `allow-same-origin`); `localStorage.getItem('x')` throws; and `holi.docs.read('../../../etc/passwd')` rejects.
- [ ] **Ask the agent to build one** in the drawer — the actual goal of the slice. Confirm it discovers the contract from the seeded skill without being told the API, and that what it writes opens and runs.
- [ ] Commit: `docs: slice-1 verification for vault apps` with a short `docs/verification/2026-08-19-vault-apps-slice1.md` recording what was checked by hand and what was not, per the README convention that a PRD's verification status carries its date.

---

## Gotchas

- **`pnpm exec` always** — bare `node`/`npx` are broken in this repo. The shell's cwd drifts between tool calls, so use absolute paths.
- **Never run `pnpm run format` / `prettier --write`** — it corrupts this repo. `printWidth` is 100; wrap by hand.
- **Vitest 4 silently drops `poolOptions`** — use `fileParallelism: false` if you need serial runs.
- **`registerSchemesAsPrivileged` is invalid after app-ready.** That is why the existing call sits at module top level in `index.ts` rather than inside `main()`.
- **`'self'` in a CSP matches nothing in an opaque origin.** See Task 5.
- **`event.origin` is the string `"null"` for the app frame.** Identity is `event.source === iframe.contentWindow`. See Task 8.
- **Never add `allow-same-origin` beside `allow-scripts`.** Granting both lets the frame drop its own sandbox — the footgun documented at `SandboxedHtml.tsx:297`, and the reason the mail frame has exactly one of the two.
- **Two different `window.holi` objects now exist**: the renderer's preload bridge (`window.holi.trpc`) and the app frame's injected shim. They are in different documents and never meet, but a reader skimming will assume they are the same object.
- **The app never supplies its own `appId`.** The renderer knows which frame it mounted; taking an id from a message would let one app read another's directory.
- **Main-process edits do not restart the dev app** — relaunch it after touching `main/`, or the handler you just wrote is not the one running.
- **A directory without `index.html` is not an app**, so `appIdsAtom` filters on it. Otherwise an agent that created the directory and then crashed leaves a permanent broken row in the sidebar.
