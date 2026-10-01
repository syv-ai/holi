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
  marker: an agent writes an app file by file, so the manifest is written last. Its keys are
  `description`, `collections` and `dangerously-allow`, all optional; `holi apps init` writes
  all three with the unused ones blank (`appManifestText`), so the file shows what
  an app can say, and an empty file still finishes the app. The icon is the vault icon map's,
  as for any row. The parser never throws; a typo costs a field, never the app.
- **A personal app is `<name>.local.app`.** The `.local.` marker on the folder makes every file
  in it machine-local, so it never syncs; its name drops `.local.app`, and a rename or duplicate
  keeps the marker. Otherwise it is an app like any other.
- **Discovery is the snapshot.** A bundle's files are in `snapshot.files`, so the app list is
  derived in the renderer with no extra IPC, and an app appears on the next rescan.
- **In the file tree** a bundle is one row with an app glyph that opens the app with a note's
  gestures (click, double click, ⌘-click for a new pane, Enter). →, **Show App Files** or the chevron at the row's right end (shown on hover or focus) expands it
  in place so its files are edited as ordinary files; the leading chevron shows only while it is
  expanded.
  Rename, move, drag, copy, duplicate and delete are the tree's folder operations: a rename edits
  the name without `.app`, and Duplicate makes `Budget copy.app`. A drop on the row lands beside
  it, not among its files. A personal app's row shows only under show-hidden, like any local
  file; the launchers always list it. See [file tree](file-tree.md).
- **Launchers.** The tree's app row, the [nav menu](nav-menu.md)'s Apps drill-down (every
  finished app, most recently opened first, in the sidebar and on the rail; absent when there are none), and the
  [command palette](command-palette.md), which lists them with their folder. There is no separate
  Apps section. Its Finish this app is on the tree's app row, and its Edit Source gave way to the
  row's Show App Files, which expands the bundle so `index.html` opens like any file.
- **Tabs.** An app is the surface `app` with its bundle path as the tab's id, deduped across panes
  like a note (see [tabs and panes](tabs-panes.md)). The bundle is a folder document: the app's
  claim (`renderer/surface.tsx` in the plugin) says a
  `.app` folder with its `index.html` is one, finished once `app.yaml` is there. Reload is the
  surface's pane-header action, beside the other per-file buttons, that remounts the
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
- **The bridge** is `postMessage` from the frame to `AppFrame`, which answers `holi.open` itself
  (the shim sends `{target}`: a view registered in this vault by name wins, such as home, board,
  agenda, mail, settings or history; else a vault file, or an app's bundle as that app; a bare
  name that is neither answers "no such view") and
  forwards every other method to `apps.call` in main with the bundle it mounted. Reads:
  `docs.list`, `docs.read`, `docs.render` (a note as HTML, inline HTML escaped and only web links
  kept, so a note cannot run script as the app), `tasks.list`, `vault.recents`, `docs.search` (names, then
  bodies), `vault.settings`, `vault.members`, `vault.history`, `sync.status`, `agent.sessions`, and, opted into,
  `google.agenda` and `google.search` (`holi.google.agenda({ from, to })`,
  `holi.google.search(query)`, a page: `{ threads, nextPageToken }`). Writes: `holi.store(collection)` and `tasks.complete`,
  which applies the board's rule. `<holi-note path>` is a custom element the shim defines: the
  note rendered, themed and live. The theme is ambient CSS variables, not a call.
- **Push.** `holi.on(topic, fn)` hears `docs`, `tasks`, `sync`, `agent`, `recents`, `history` and
  `store:<collection>`. `AppFrame` posts a topic when its signature changes (`renderer/app-push.ts`),
  never on mount. A push carries no data: the app reads again through main, so every refusal
  still applies, and the signatures leave the agent surface out, so an app is not told a memory
  was written.
- **One person's data is opt-in, twice.** `google.agenda` and `google.search` read the Google
  account of whoever has the app open, not the vault's; an app can keep what it reads in records
  that sync to every member, or send it over the network. So the app declares
  `dangerously-allow: [mail, calendar]` in `app.yaml`, or as a map giving each one a reason
  (`{ calendar: To show your next meeting }`, plain text, at most 200 characters) that the dialog
  quotes as the developer's explanation (without the flag the call fails and names it), and each person approves the app in a dialog before its frame loads. The approval is
  kept in main (`userData/app-grants.json`), never the renderer, which is the process running the
  app. It lapses after 30 days and whenever the app's code (anything but `data/`) changes, whoever
  changed it: approving a teammate's app approves that code, not what it becomes after a pull. A
  personal `.local.app` needs the flag but no approval, while git tracks none of it: its code was
  written on this machine and its records never sync. One someone force-added and pushed is shared
  code with a personal name, and is asked about like any other. An approval names the code the
  dialog showed (a hash of every file, link and folder the protocol can serve, `data/` and the log
  aside), so
  a pull that lands while the dialog is up is asked about again rather than approved unseen.
  The check is a field on the capability (`appGrant: 'mail'`), so Google's entries never import
  the approvals: the app door's one opener, the apps code, supplies it (`admitApps`), and an
  entry with an `appGrant` is refused at an app door with no check. The same entries open to the
  UI and CLI doors too, where no grant is asked: the views and the agent are this person's own.
- **No location.** Main refuses the browser's geolocation to every page. Electron answers it
  through Google's network location service, which needs an API key and does not answer on macOS
  even with one, so a request would hang until the page's timeout; refused, it fails at once and
  the app can offer a place search or an IP-based estimate.
- **The approval dialog** is asked in the app's own pane, over the app's markup and styles drawn
  blurred and without scripts (`sandbox=""`), so what is approved is seen and nothing of it runs
  first. It quotes the app's reasons, and names who added the app's code and who last changed it
  (`bundleAuthorship`: the first and last commits to the bundle, records and log aside). A name
  links to the person's GitHub profile when their login is known (a GitHub noreply email, or a git
  name that is a member's login), and a short hash opens that commit in History.
- **Links leave Holi.** A web or `mailto:` link from an app opens in the system browser or mail
  app, whether it is a plain link (main's `will-frame-navigate` stops the frame leaving its bundle)
  or `target=_blank`/`window.open` (the sandbox's `allow-popups` lets it reach
  `setWindowOpenHandler`, which never makes a window). Any other scheme opens nothing.
- **The log.** `log.local.txt` at the bundle's root is what went wrong while the app ran here: the
  bridge shim reports `console.error`/`warn`, uncaught errors, unhandled rejections and refused
  bridge calls, plus `holi.log(...)`, capped at 50 a second, and main appends them
  (`log.ts`, one write at a time, never through a link, never into a deleted bundle).
  Each line is timed; a stack continues indented. It keeps the last day and at most 500 entries,
  trimmed as it is written (`appendAppLog`). It is for the agent: `.local.`, so it never syncs;
  not served to the app, not readable through the bridge, not in the approval hash, and not
  watched, so it never triggers a rescan. The pane header's log button, beside reload, opens it in a
  new pane; it is disabled until a rescan has seen one.
- **Showing.** The frame is hidden until its document has loaded, then fades in
  (`motion-in-fade`), so a half-styled first paint is never seen; a reload or a mode change starts
  it over.
- **One registry, two doors.** What main answers is the capability registry
  (`main/capabilities/`, see [architecture](../architecture.md)); the apps feature registers
  `store.*` and `apps.*` (`src/plugins/apps/main/capabilities.ts`). Each entry has its params, its refusals, and the doors
  it opens to: the app's bridge, the agent's `holi` CLI (`/cli` on the bridge server), and Holi's
  own UI, which reaches `apps.call`, `apps.grants`, `apps.grant`, `apps.log` and `apps.init`. An app sees
  exactly what the agent can inspect from the terminal, written once. At the app door the bundle
  is the frame's, and a `bundle` param is ignored; at the CLI door the agent names it. One
  capability host (`capabilities/dispatch.ts`) runs a call for every door: the clone, the open
  vault's cached snapshot or a fresh scan, and a rescan after a write. The UI and CLI doors call
  its `dispatch`; the app door exists only once the apps code opens it (`openAppDoor`, once per
  process), and `apps.call` calls through what that returns. What core's entries need beyond
  the files (sync, members cached ten minutes, the recents) comes from one services factory
  (`capabilities/services.ts`); a feature's entries close over their own (sessions, Google,
  approvals) when the composition root registers them.
- **State.** An app declares `collections` in `app.yaml`, each with an optional JSON Schema
  subset (`type`, `properties`, `required`, `additionalProperties`, `enum`, `items`,
  `minimum`/`maximum`, `minLength`/`maxLength`; other keywords are ignored). A record is one JSON
  object in one file, `<bundle>/data/<collection>/<id>.json`, keys sorted and pretty-printed so a
  diff shows only what changed. `holi.store(c)` has `get`, `put(value)` (a time-sortable ULID id),
  `put(id, value)`, `delete`, `list` and `query(fn)`, which filters the listed collection inside
  the frame. Main does every write: the collection is declared, the id is one safe filename
  segment with no `.local.`, the value fits its schema and 256 KiB. A file broken by hand is
  skipped and named rather than failing the list. Rename, move and duplicate carry the data with
  the bundle. The agent reaches the same records with `holi store list|get|put|delete`, and the
  check hook asks `holi store check` about a record it wrote by hand.
- **Merging records.** Holi installs a git merge driver for `**/*.app/data/**/*.json` on every
  vault open, in `.git/config` and `.git/info/attributes`, so nothing committed changes and every
  existing vault gets it. It merges field by field: edits of different fields both land; a field
  both sides changed differently, or a record deleted on one side and edited on the other (git
  never asks a driver about that), is an ordinary conflict for reconcile. The driver is a sh shim
  that posts the three versions to Holi (`/merge/record`), and fails to a conflict when Holi does
  not answer.
- **The authoring loop.** A seeded skill (`.claude/skills/vault-apps/SKILL.md`) documents the
  contract. The `holi` CLI gives the agent `holi apps open <path>` and `holi apps init <path>`
  (never overwrites). A `PostToolUse` hook (`vault-app-check.mjs`) reports, on every write inside
  a `<name>.app` folder below the session's cwd, a syntax error and its line, a `.ts`/`.tsx`/`.jsx` file nothing will build, a
  `localStorage` call, a missing manifest, and a hard-coded colour. It is advisory, exits 0, and is
  silent when nothing is wrong. See [agent config](agent-config.md) for the CLI and hooks.
- **Home can be an app.** When the `home` setting ([settings](settings.md)) names a finished app
  the vault has, the Home tab shows it, through the claim like any folder document. No vault is
  created with one: Home defaults to Holi's own recents view ([nav menu](nav-menu.md)). When
  `home` names an app the vault lacks, the Home tab says so.

## Rules

- An app is a web app the user wrote: it may reach all vault content except the agent surface
  (`AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `USER.local.md`, `.claude/`, `.holi/memory/`; see the
  [glossary](../glossary.md)). The reason is escalation, not privacy: an app that could write
  `.claude/hooks/google-send-gate.mjs` could make the agent send mail unprompted.
- The agent-surface refusal lives in main (the capability registry), not the renderer. The process rendering
  untrusted code must not be the one deciding what it may read. `read` answers `FORBIDDEN`,
  distinct from `NOT_FOUND`.
- This machine's state under `.holi/state/` (`isMachineStatePath`) is refused the same way and left
  out of every listing: it holds the loopback bridge's tokens, and an app holding one could drive
  Holi as the agent does.
- The frame is `sandbox="allow-scripts"` and never also `allow-same-origin`. Both together let the
  frame drop its own sandbox. The opaque origin is also why `localStorage` throws.
- `AppFrame` identifies a message by `event.source === contentWindow`, never by origin (it is the
  string `"null"`), and the app never names itself: every call carries the bundle the frame was
  mounted with. It refuses a name not in `APP_METHODS` and forwards the rest to `apps.call`,
  which dispatches only into the registry's app door. `apps.call` and `apps.grant` open only the
  UI door, so no name an app sends reaches them: an app cannot call as another, or approve itself.
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
- Only local authorship opens a tab (`holi apps open`). An app arriving by sync never opens itself.
  The open is an `apps` event carrying the vault's remote, so it opens nothing once you have
  switched to another vault.
- Reload is explicit, never automatic: the ⟳ button, or the agent's `holi apps open` on an app
  already open, run once it has finished writing. Auto-reload fires on the half-written state
  while the agent is still writing.
- No `allow-forms`: a form's submission is blocked before its submit handler runs, so the check
  flags `<form>` and the skill says to handle the click and Enter instead.
- A personal app is told apart by the `.local.` marker on its folder, which marks every path
  under it. Git already agrees: `*.local.*` has no slash, so it matches the folder. The watcher,
  which ignores local paths so per-turn state files do not storm the rescan, still watches a local
  bundle, or an app the agent writes would not appear until the heal.
- An app inside another app is just files of the outer one; otherwise the outer app could serve
  the inner one's code as its own.
- Records are reached through the store only. The protocol never serves `data/`, and
  `holi.docs.read` refuses any app's `data/`, its own included, so no app reads another's records,
  a personal app's least of all. Both checks ignore case, as macOS's filesystem does.
- Nothing an app reaches goes through a symlink. The protocol, the store and every read through
  the bridge open a path only when its real path is the path as named (`exactPath`), so a committed
  `lib -> ../../.holi/memory` serves nothing and a store collection that is a link refuses reads and
  writes. The same comparison refuses a case alias such as `Data/`. The snapshot never lists a link
  either, so to Holi a symlink is simply not there.
- Records are always objects, because the merge works field by field.

## Rejected

- Keeping apps in `.holi/apps/`: hidden with the dotfiles, so an app the agent wrote was invisible
  in the tree by default.
- A single `name.app.html` file: every existing app is several files, and the agent would write
  one large one.
- A manifest file in the tree pointing at a source folder elsewhere: two places for one app.
- A hashed host with a lookup in main: encoding the path is reversible and cannot collide.
- A generated app id in the manifest: an invented id, where a path already identifies it.

- A per-app shared Yjs doc on a relay: there is no relay.
- SQLite for app state, local or shared: a database file neither diffs nor merges, and a local
  one splits an app's state from the vault it lives in. Personal data belongs in a personal app.
- A record's deletion as a tombstone file, so the driver could keep an edit over a delete: deleted
  records would linger as files for a rare case reconcile already handles.
- Reusing `holi-vault://`: one shared origin with no `.local.` exclusion, so any app could read
  `USER.local.md`.
- Doing the bridge purely in the renderer with existing `notes.read`: makes the renderer the
  security boundary.
- A Deno or Bun sidecar for backends: Electron's `utilityProcess` already ships Node.
- A CSP with `connect-src 'none'`: rules out any app that calls an API.
- Note-embedded app widgets: keeps the editor lean.
- An app store, versioning, or permission prompts for what the vault shares: trust is vault
  membership; reuse is copying the directory. The one prompt is for one person's own Google data,
  which vault membership does not cover.
- npm dependency trees in the vault: an app ships its libraries bundled to files.

## Code

- `apps/desktop/src/plugins/apps/`: the vault apps plugin, on by default. Its `main/` holds the
  `holi-app:` scheme (`protocol.ts`), the bridge shim, base tokens, open/init ops, the `apps.*`
  and `store.*` capabilities (`capabilities.ts`), the store (`store.ts`), the approvals
  (`grants.ts`), and its seed: the vault-apps skill and the `vault-app-check.mjs` hook under
  `main/vault/shipped/.claude/`. It opens the app door once it starts, and with it off a vault
  serves no app, while what the vault holds (records, `.local.app`) is still core's. Its
  `renderer/` holds `AppFrame` with the approval dialog, the push signatures (`app-push.ts`),
  the app lists and reload counts (`apps.ts`), and the surface, claim, rail item and pane-header
  actions (`surface.tsx`); its `open` event is the agent's `holi apps open`. Its `shared/` holds
  the bridge vocabulary (`bridge.ts`: `APP_METHODS`, the topics), the manifest (`manifest.ts`),
  an app's name and `holi-app:` host (`bundle.ts`), and the store's schema subset, ids and log
  (`store.ts`).
- `apps/desktop/src/main/capabilities/`: the registry, its dispatch and services, the read
  fences and core's entries, with note rendering (`render-note.ts`).
- `apps/desktop/src/main/vault/search.ts`: the vault search behind `holi.search`, shared with
  Holi's own search.
- `apps/desktop/src/main/vault/record-merge.ts`: the record merge driver's install;
  `apps/desktop/src/main/vault/git-routes.ts`: `/merge/record`;
  `apps/desktop/src/main/bridge/server.ts`: `/cli`.
- `apps/desktop/src/main/index.ts`: scheme registration, every plugin's included.
- `apps/desktop/src/main/bridge/cli.ts`: the `holi` CLI.
- `apps/desktop/src/plugins/app-methods.test.ts`: every bridge method is answered by an app-door
  capability in this build.
- `apps/desktop/src/renderer/src/state/ui-report.ts`: the one report of focus and recents to main.
- `apps/desktop/src/renderer/src/features/explorer/FileTree.tsx`, `RowMenu.tsx`: the folder
  document row an app is.
- `packages/shared/src/app-bundle.ts` (`isAppBundlePath`, `appBundleOf`, `appSuffix`) and
  `packages/shared/src/app-store.ts` (where records and the log live, the record format and the
  field merge): the bundle grammar core keeps, because a synced vault holds bundles whatever
  this machine runs; `packages/shared/src/path-safety.ts` (`isAgentSurfacePath`).
