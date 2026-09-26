# Vault apps

A vault app is a small web app the vault agent writes on request (a dashboard, a burndown, a CSV
explorer) into `.holi/apps/<id>/`. It syncs with the vault like any other content and opens inside
Holi as a tab, where it can read the vault's documents and tasks through a narrow bridge.

## How it works

- **An app is a directory holding `index.html` and `app.yaml`**, both at its root. The id is the
  directory name. `app.yaml` is the registration marker: an agent writes an app file by file, so
  the manifest is written last and means "finished". Every key (`name`, `icon`, `description`) is
  optional and an empty file registers the app. The parser never throws; a typo costs a field,
  never the app.
- **Discovery is the snapshot.** `.holi/apps/**` files are already in `snapshot.files`, so the
  app list is derived in the renderer with no extra IPC, and an app appears on the next rescan.
  `.holi/` keeps them out of the file tree.
- **Launchers.** The nav's Apps section sits under the tree and is hidden when there are no apps.
  The rail shows the apps as a menu while the nav is hidden, and the
  [command palette](command-palette.md) lists them too. A directory with `index.html` and no
  manifest shows dimmed, with **Finish this app** (writes the manifest only). The row menu is
  Open, Open in a New Pane, Edit Source, Rename, Delete, Copy Path, Reveal in Finder.
- **Tabs.** An app opens as an ordinary tab keyed by `appId`, deduped across panes like a note is
  by path (see [tabs and panes](tabs-panes.md)). Reload is a button in the tab that remounts the
  frame. If the directory disappears under an open tab (a teammate's pull), the tab stays as a
  tombstone saying the app was deleted. Deleting from the menu removes the files and closes the
  tab instead.
- **Rename** is one `rename` of the directory, then a second pass rewriting inbound `[[links]]`,
  then the open tab is retargeted by id. Buffers are flushed first. Main re-checks the target id
  and returns a refusal as a value.
- **Serving.** `holi-app://<appId>/<path>` is served by a protocol handler rooted at that app's own
  directory. Only the entry document is rewritten: Holi injects a `<style>` of theme tokens
  (Holi's base palette, `APP_BASE_TOKENS`, with the vault's resolved theme laid over it) and the
  `window.holi` bridge script. Every other file is served byte for byte.
- **The bridge** is `postMessage` from the frame to `AppFrame`, which forwards into the `apps.*`
  router in main. Methods: `holi.docs.list()`, `holi.docs.read(path)`, `holi.tasks.list()`, and
  `holi.open(path)`, which opens a vault file in Holi. The theme is ambient CSS variables, not a
  call. There is no write method and no state store: an app holds nothing across a reload.
- **The authoring loop.** A seeded skill (`.claude/skills/vault-apps/SKILL.md`) documents the
  contract. The `holi` CLI gives the agent `holi app open <id>` and `holi app init <id>` (never
  overwrites). A `PostToolUse` hook (`vault-app-check.mjs`) reports, on every write under
  `.holi/apps/`, a syntax error and its line, a `.ts`/`.tsx`/`.jsx` file nothing will build, a
  `localStorage` call, a missing manifest, and a hard-coded colour. It is advisory, exits 0, and is
  silent when nothing is wrong. See [agent config](agent-config.md) for the CLI and hooks.
- **Migration.** On vault open, before the first snapshot, `migrate-manifests.ts` writes an
  `app.yaml` for any valid app directory that has an entry document and no manifest.

## Rules

- An app is a web app the user wrote: it may reach all vault content except the agent surface
  (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `USER.local.md`, `.claude/`, `memory/`; see the
  [glossary](../glossary.md)). The reason is escalation, not privacy: an app that could write
  `.claude/hooks/google-send-gate.mjs` could make the agent send mail unprompted.
- The agent-surface refusal lives in main (`apps.*`), not the renderer. The process rendering
  untrusted code must not be the one deciding what it may read. `read` answers `FORBIDDEN`,
  distinct from `NOT_FOUND`.
- The frame is `sandbox="allow-scripts"` and never also `allow-same-origin`. Both together let the
  frame drop its own sandbox. The opaque origin is also why `localStorage` throws.
- `AppFrame` identifies a message by `event.source === contentWindow`, never by origin (it is the
  string `"null"`), and the app never names itself: every call carries the id the frame was mounted
  with. It answers with an exhaustive switch over `APP_METHODS`; never turn that into a passthrough,
  since `apps.*` also holds Holi's own `rename` and `register`.
- `appId` is `[a-z0-9-]+`. It becomes a URL host, and hosts are case-folded; anything else is not
  an app. Migration skips an invalid directory rather than renaming it.
- One app cannot reach another's files or the vault's: the handler resolves only under its own
  directory, and `holi-vault://` sends no CORS header, so a frame cannot fetch it.
- The network is allowed and there is no CSP. An app is therefore an exfiltration channel for
  whatever the bridge hands it; the agent-surface rule keeps a prompt-injected app from reaching
  the assistant. If a CSP is ever added it must name `holi-app:`, since `'self'` matches nothing in
  an opaque origin.
- The bridge is injected, not a required tag: a forgotten tag is an app that silently does nothing.
- The injected palette must be complete. Injecting only the vault's overrides gives an unthemed
  vault `:root{}` and an unreadable app. A test pins that every themeable token has a base value.
- Only local authorship opens a tab (`holi app open`). An app arriving by sync never opens itself.
- Reload is manual. Auto-reload fires on the half-written state while the agent is still writing.
- Personal apps, when they exist, are told apart by location (`userData`), not by the `.local.`
  marker, which is a basename rule and cannot mark a directory.

## Rejected

- A per-app shared Yjs doc on a relay: there is no relay.
- Reusing `holi-vault://`: one shared origin with no `.local.` exclusion, so any app could read
  `USER.local.md`.
- Doing the bridge purely in the renderer with existing `notes.read`: makes the renderer the
  security boundary.
- A Deno or Bun sidecar for backends: Electron's `utilityProcess` already ships Node.
- A CSP with `connect-src 'none'`: rules out any app that calls an API.
- Note-embedded app widgets: keeps the editor lean.
- An app store, versioning, or permission prompts: trust is vault membership; reuse is copying the
  directory.
- npm dependency trees in the vault: an app ships its libraries bundled to files.

## Code

- `apps/desktop/src/main/apps/`: the protocol helpers, bridge shim, base tokens, open/init/rename
  ops and the manifest migration.
- `apps/desktop/src/main/index.ts`: scheme registration and the `holi-app` handler.
- `apps/desktop/src/main/router.ts`: the `apps` namespace.
- `apps/desktop/src/main/agent/hooks/vault-app-check.mjs`, `apps/desktop/src/main/agent/cli.ts`.
- `apps/desktop/src/renderer/src/features/apps/`: `AppFrame`, `AppsSection`, `AppsMenu`.
- `apps/desktop/src/renderer/src/state/apps.ts`: the app lists and actions.
- `packages/shared/src/app-manifest.ts`, `packages/shared/src/path-safety.ts` (`APPS_DIR`,
  `isValidAppId`, `isAgentSurfacePath`).
