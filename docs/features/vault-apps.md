# Vault apps

A vault app is a small web app the vault agent writes on request (a dashboard, a burndown, a CSV
explorer) as a `<name>.app` folder anywhere in the vault, usually beside the notes it is about. It
syncs with the vault like any other content, shows in the file tree as one row, and opens inside
Holi as a tab, where it can read the vault's documents and tasks through a narrow bridge.

## How it works

- **An app is a bundle: a directory named `<name>.app` holding `index.html` and
  `app.yaml`**, both at its root, anywhere in the vault except the agent surface, and not inside
  another bundle. Like a note it is identified by its vault-relative path (`Finance/Budget.app`);
  its name is the folder name without `.app`, as a note drops `.md`. `app.yaml` is the "finished"
  marker: an agent writes an app file by file, so the manifest is written last. Its one key is
  `description`, optional, and an empty file finishes the app. The icon is the vault icon map's,
  as for any row. The parser never throws; a typo costs a field, never the app.
- **Discovery is the snapshot.** A bundle's files are in `snapshot.files`, so the app list is
  derived in the renderer with no extra IPC, and an app appears on the next rescan.
- **In the file tree** a bundle is one row with an app glyph that opens the app with a note's
  gestures (click, double click, ⌘-click for a new pane, Enter). → or **Show Contents** expands it
  in place so its files are edited as ordinary files; the chevron shows only while it is expanded.
  Rename, move, drag, copy, duplicate and delete are the tree's folder operations: a rename edits
  the name without `.app`, and Duplicate makes `Budget copy.app`. A drop on the row lands beside
  it, not among its files. See [file tree](file-tree.md).
- **Launchers.** The tree's app row, the [nav menu](nav-menu.md)'s Apps drill-down (every
  finished app by name, in the sidebar and on the rail; absent when there are none), and the
  [command palette](command-palette.md), which lists them with their folder. There is no separate
  Apps section. Its Finish this app is on the tree's app row, and its Edit Source gave way to the
  row's Show Contents, which expands the bundle so `index.html` opens like any file.
- **Tabs.** An app opens as an ordinary tab keyed by its bundle path, deduped across panes like a
  note (see [tabs and panes](tabs-panes.md)). Reload is a button in the pane header, beside the other per-file buttons, that remounts the
  frame. If the bundle disappears under an open tab (a teammate's pull), the tab stays as a
  tombstone saying the app was deleted. Deleting from a menu removes the files and closes the tab
  instead. A move of the bundle carries its tab along, like a note's.
- **Serving.** `holi-app://<host>/<path>` is served by a protocol handler rooted at that app's own
  bundle. The host is the bundle path's UTF-8 bytes in hex, split into DNS-sized labels, then a
  fixed `app` label (`appHost`): a path cannot be a host (slashes, case folding), and encoding
  rather than hashing lets main decode the host with no lookup and no collision. The fixed last
  label stops a URL parser reading hex such as `41` as an IPv4 address. Only the entry document is
  rewritten: Holi injects a `<style>` of theme tokens
  (Holi's base palette, `APP_BASE_TOKENS`, with the vault's resolved theme laid over it) and the
  `window.holi` bridge script. Every other file is served byte for byte.
- **The bridge** is `postMessage` from the frame to `AppFrame`, which forwards into the `apps.*`
  router in main. Methods: `holi.docs.list()`, `holi.docs.read(path)`, `holi.tasks.list()`, and
  `holi.open(path)`, which opens a vault file in Holi. The theme is ambient CSS variables, not a
  call. There is no write method and no state store: an app holds nothing across a reload.
- **The authoring loop.** A seeded skill (`.claude/skills/vault-apps/SKILL.md`) documents the
  contract. The `holi` CLI gives the agent `holi app open <path>` and `holi app init <path>`
  (never overwrites). A `PostToolUse` hook (`vault-app-check.mjs`) reports, on every write inside
  a `<name>.app` folder below the session's cwd, a syntax error and its line, a `.ts`/`.tsx`/`.jsx` file nothing will build, a
  `localStorage` call, a missing manifest, and a hard-coded colour. It is advisory, exits 0, and is
  silent when nothing is wrong. See [agent config](agent-config.md) for the CLI and hooks.
- **Migration.** Apps used to live in `.holi/apps/<id>/`, hidden with the other dotfiles. On
  vault open, before the first snapshot, `migrate-apps.ts` moves each to `<id>.app/` at the root
  with one `rename`, then rewrites inbound `[[links]]`; the autosave commits it. An app whose
  destination exists is left in place. A `landing` setting naming an app id reads as that bundle.

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
  string `"null"`), and the app never names itself: every call carries the bundle the frame was
  mounted with. It answers with an exhaustive switch over `APP_METHODS`; never turn that into a passthrough,
  since `apps.*` also holds Holi's own `register`.
- The host decodes only to a path `isAppBundlePath` accepts, so a crafted host cannot name the
  agent surface or a folder that is not a bundle.
- One app cannot reach another's files or the vault's: the handler resolves only under its own
  bundle, and `holi-vault://` sends no CORS header, so a frame cannot fetch it.
- The network is allowed and there is no CSP. An app is therefore an exfiltration channel for
  whatever the bridge hands it; the agent-surface rule keeps a prompt-injected app from reaching
  the assistant. If a CSP is ever added it must name `holi-app:`, since `'self'` matches nothing in
  an opaque origin.
- The bridge is injected, not a required tag: a forgotten tag is an app that silently does nothing.
- The injected palette must be complete. Injecting only the vault's overrides gives an unthemed
  vault `:root{}` and an unreadable app. A test pins that every themeable token has a base value.
- Only local authorship opens a tab (`holi app open`). An app arriving by sync never opens itself.
- Reload is explicit, never automatic: the ⟳ button, or the agent's `holi app open` on an app
  already open, run once it has finished writing. Auto-reload fires on the half-written state
  while the agent is still writing.
- No `allow-forms`: a form's submission is blocked before its submit handler runs, so the check
  flags `<form>` and the skill says to handle the click and Enter instead.
- Personal apps, when they exist, are told apart by location (`userData`), not by the `.local.`
  marker, which is a basename rule and cannot mark a directory.
- An app inside another app is just files of the outer one; otherwise the outer app could serve
  the inner one's code as its own.

## Rejected

- Keeping apps in `.holi/apps/`: hidden with the dotfiles, so an app the agent wrote was invisible
  in the tree by default.
- A single `name.app.html` file: every existing app is several files, and the agent would write
  one large one.
- A manifest file in the tree pointing at a source folder elsewhere: two places for one app.
- A hashed host with a lookup in main: encoding the path is reversible and cannot collide.
- A generated app id in the manifest: an invented id, where a path already identifies it.

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

- `apps/desktop/src/main/apps/`: the protocol helpers, bridge shim, base tokens, open/init ops and
  the move out of `.holi/apps`.
- `apps/desktop/src/main/index.ts`: scheme registration and the `holi-app` handler.
- `apps/desktop/src/main/router.ts`: the `apps` namespace.
- `apps/desktop/src/main/agent/hooks/vault-app-check.mjs`, `apps/desktop/src/main/agent/cli.ts`.
- `apps/desktop/src/renderer/src/features/apps/`: `AppFrame`.
- `apps/desktop/src/renderer/src/state/apps.ts`: the app lists and actions.
- `apps/desktop/src/renderer/src/features/explorer/FileTree.tsx`, `RowMenu.tsx`: the app row.
- `packages/shared/src/app-bundle.ts` (`isAppBundlePath`, `appBundleOf`, `appName`, `appHost`),
  `packages/shared/src/app-manifest.ts`, `packages/shared/src/path-safety.ts`
  (`isAgentSurfacePath`).
