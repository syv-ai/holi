# Architecture

A map of how Holi fits together. Each section points at the pages that own the detail.

## 1. System shape

Holi is one desktop app. There is no server, no database and no hosted service.

```
┌──────────────────────── apps/desktop (Electron) ────────────────────────┐
│  Renderer (React, Jotai, CodeMirror)       Main (Node)                  │
│  editor · board · drawers · views          vault store (walk, watcher)  │
│              │                             sync engine (commit, pull,   │
│              │  tRPC over IPC                push, reconcile)           │
│  preload / contextBridge ◄──────────────── PTYs → `claude agents|attach`│
│                                            GitHub · Google · Typst      │
└────────────────────────────────────────────────────┬────────────────────┘
                                                     │ git over HTTPS, REST
                                                     ▼
                                          GitHub: the vault repo,
                                          collaborators, history

  ~/Holi/<owner>/<repo>            packages/shared
  the vault: a git clone           pure rules: paths, task files, wiki-links,
  of markdown files                dates, recurrence, themes, 3-way merge
```

**The filesystem is the truth.** The editor, the board, the file tree and the agent all read and
write the same files in one directory. Nothing is derived and stored elsewhere, so nothing can
disagree.

`packages/shared` holds the rules the app uses with itself and with the files on disk. It is a
separate package because its contents are pure and browser-safe, which keeps them testable without
Electron. `@holi/shared/path-safety-node` is the one Node-only entrypoint.

## 2. Build only what Claude Code does not do

The agent is Claude Code, unmodified. Holi adds no adapter layer and no prompt-building, and fixes
forward when a Claude Code release changes something. Users are developers: the raw terminal is the
interface, git is a tool they already know, and Claude Code is already installed and signed in. With
the vault being plain files in a git repo, the agent needs no Holi-specific operations at all.

## 3. Processes and the IPC seam

- **Main** owns everything with side effects: the filesystem, git, GitHub and Google calls, the
  vault store and watcher, sync, reminders, Typst and the Claude PTYs. It holds every credential.
- **Preload** is a narrow `contextBridge` adapter over `ipcRenderer`.
- **Renderer** is the React UI. It runs with `contextIsolation` and without Node, and never sees a
  token. It reaches main through a typed tRPC router (`src/main/router.ts`).

Across the seam a document is named by its vault-relative path, validated with `vaultRelPath`,
never by an absolute path or a generated id. A binary the renderer draws itself (a PDF) crosses as
bytes; `holi-vault://` serves `<img>` only. Vault-scoped stores (the tree, the task set) mount in the
app shell for the life of the active vault: a store loaded by whichever view reads it first cannot
tell "not loaded" from "empty", and the failure looks like data loss.

What a vault app or the agent's `holi` CLI may ask main for is one capability registry
(`src/main/capabilities/`). Each entry is named `<namespace>.<verb>`, says which doors reach it (an
app's bridge, the CLI) and holds its own refusals. Core registers its namespaces and each feature
registers its own from the composition root (`src/main/index.ts`); a namespace has one owner.

### Plugins

Optional parts of Holi are plugins: first-party modules in the build, under
`apps/desktop/src/plugins/<id>/`, listed once per process in `src/plugins/main.ts` and
`src/plugins/renderer.ts`. Only the composition roots (`src/main/index.ts`, the renderer's
`main.tsx`) import those lists. A plugin reaches core through one module per process,
`src/main/plugin-api.ts` and `@/plugin-api`, plus the renderer's primitives and composites; ESLint
holds the renderer side and plugin code to that, and `test/plugin-boundary.test.ts` holds main.
A plugin's renderer reaches its main side only through capabilities that open the `ui` door: the
`cap.run` mutation, called through `capClient<typeof table>(namespace)`, which offers just those
verbs with their types read from the table (params cross as JSON, results by structured clone).
Plugins call each other the same way, each typing only the slice it calls; before offering such a
call, a plugin asks `useHasCapability(name)`, backed by the `cap.names` query (the UI door's names
whose owner the vault runs), so a button for another plugin's verb hides while that plugin is off.
Core's `tasks.create` is one: the board and the Google views create tasks through it.
A plugin claims vault paths: the first enabled claim with a `view` opens a note tab of that path,
and its `rowMenu` items join the file tree's menu. On the main side a claim
(`MainPlugin.claims`, `{match, parse, normalize?}`) owns markdown files in the snapshot: the scanner
(`scanVault(root, claims)`, the claims from `PluginHost.scanClaimsFor`) parses them into
`snapshot.claimed[id]` instead of `docs`, and a settings write that changes `plugins` rescans.
A plugin adds `surfaces` (tab kinds) and `rail`
items to the nav menu ([tabs and panes](features/tabs-panes.md)), registered beside core's own, and
`settingsSections` to the settings tab ([settings](features/settings.md)).
Its dialogs open as `{id: 'plugin', render}`.
Main tells a plugin's renderer something through events: `ctx.emit(remote, name, payload)` sends
`{remote, name, payload}` on the plugin's one channel, `plugin:<id>`, read by one preload member,
`window.holi.plugin.on(id, cb)`. Main sends only about a vault that runs the plugin, so the renderer
subscribes every installed plugin's `events` handlers at boot, and a handler drops an event about a
vault it does not care about. The other way, `window.holi.plugin.send(id, event)` is ordered and
unanswered, and `ctx.on(name, handler)` hears only messages about the open vault.
A plugin may serve URL schemes (`MainPlugin.schemes`). Electron takes schemes only before the app
is ready, so every scheme in the build (vault apps' `holi-app:`) is registered at boot beside
core's `holi-vault:`, and a plugin's handler answers 404 while the open vault has the plugin off. A scheme
marked `frame` serves framed pages: the window guard lets such a frame move within its scheme and
sends a link out of it to the browser.
A plugin's own code sits in `main/`, `renderer/`, `shared/` and `test/` under its folder; its
renderer imports its main side as types only, for `capClient`. The plugins are the agent
([agent-sessions](features/agent-sessions.md)), PDF ([pdf](features/pdf.md)), Google
([google](features/google.md)) and vault apps ([vault apps](features/vault-apps.md)).
A seed contribution can own a path prefix (`owns`): the agent owns `.claude/`, so every other
plugin's skills, hooks and settings fragments there are left out while the agent is off and
seeded once when it turns on.
The app door, through which a vault app's frame calls capabilities, is core's, and the apps plugin
is its one opener (`ctx.openAppDoor`), supplying the consent check for entries with an
`appGrant`; with apps off, no entry is reachable through it.
What a synced vault holds stays core whatever this machine runs: an app's records still merge
field by field and a `.local.app` still never syncs with the apps plugin off, so that bundle
grammar is in `packages/shared` and the merge driver and fences in core.

Enablement has two layers: `.holi/settings/app.yaml` declares the vault's plugins for everyone,
and `app.local.yaml` can only turn one off on this machine ([settings](features/settings.md)). The
plugin host (`src/main/plugin-host/`) starts a plugin once per process when a vault that enables it
opens (`activateApp`), seeds only enabled plugins' files, and stops them all at quit. Once the vault
is open it runs `activateVault` with a context bound to that vault (hold sync, commit, read the
head, hear the renderer's focus report, emit), at most once per open; the disposer runs when Holi
leaves the vault, while it is still open, and at quit before the bridge stops and the editor
flushes. A plugin can also ask before Holi quits (`guardQuit`) and serve a bridge route
(`route`). Dispatch refuses a
capability whose plugin is off in the calling vault, as "no such method".

Whatever runs inside a vault (the `holi` CLI, the agent's hooks, git's pre-commit hook and merge
driver) reaches main through one loopback bridge (`src/main/bridge/`) with a token per vault,
found by walking up to the vault's root and parsing `.holi/state/bridge.local.env`. The
CLI's verbs are capabilities; the few callers that are not (the agent's turn and status-line hooks,
which must answer empty, and git's two) are routes their owner registers.

## 4. The vault

A vault is a GitHub repository cloned under a Holi-managed root, `~/Holi/<owner>/<repo>`. Its
identity is its remote. Holi never adopts a checkout the user maintains, because it commits on its
own and would trample WIP branches and staged changes.

- **Autosave commits** keep the working tree clean, so a pull can always merge.
- **Auto-push** sends them within seconds; ⌘S, a vault switch and quit commit and push at once.
- **Auto-pull merges, never rebases.**
- **A conflicting merge is aborted** at once, and the user may hand it to the agent to reconcile.

The file tree is a walk plus a watcher. Folders are real directories. A file with the `.local.`
marker is machine-local: it shows under _show hidden files_ and never syncs. A file changing under
an open editor (the agent, a pull, another window) is one event: a clean buffer reloads, a dirty one
takes a 3-way merge, and an overlap goes to reconcile.

See [vaults-sync](features/vaults-sync.md), [history](features/history.md),
[file-tree](features/file-tree.md), [settings](features/settings.md) and [auth](features/auth.md).

## 5. The agent

The agent is a plugin (`src/plugins/agent/`): a host (`main/host/`: PTYs, terminal mirror, turn
coordinator, turn review) and a provider (`main/claude/`: Claude Code's CLI, session listing,
config directory, hook routes and seed), with the line between them in `main/provider.ts`.
Every session is a Claude Code background session: the vault's supervisor runs it, its job
id names it, and it keeps running with no window open. Main opens terminals onto them in `node-pty`
PTYs (`claude agents` for the list, `claude attach <id>` for one session) with the vault clone as
cwd, and the renderer draws each in xterm as an ordinary tab. What a session is doing is read from
Claude Code itself (its session listing and turn hooks), never inferred from terminal output.

Each vault's agent gets its own `CLAUDE_CONFIG_DIR`, so it inherits the vault's committed `.claude/`,
`AGENTS.md` and `.holi/memory/`, not the machine's global config. Claude Code's own permission prompts
stay on. There is no MCP server: the agent uses its native tools plus one small Holi CLI (`holi`)
that talks to main. Holi pauses sync while a turn runs and reviews a turn as the commit
range it produced.

See [agent-sessions](features/agent-sessions.md), [agent-config](features/agent-config.md) and
[agent-memory](features/agent-memory.md).

## 6. The pillars

| Page                                           | What it covers                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| [editor](features/editor.md)                   | CodeMirror live preview, tables, images, external writes, completion |
| [tabs-panes](features/tabs-panes.md)           | Panes, preview and pinned tabs, split panes, moving tabs             |
| [frontmatter](features/frontmatter.md)         | The frontmatter block and its typed rows                             |
| [wiki-links](features/wiki-links.md)           | Path-based links, rename, backrefs                                   |
| [tasks](features/tasks.md)                     | `task.*.md` files, the board, recurrence and reminders               |
| [daily-notes](features/daily-notes.md)         | Idempotent daily notes and their archive                             |
| [google](features/google.md)                   | Gmail and Calendar, per vault                                        |
| [pdf](features/pdf.md)                         | Typst export and the PDF viewer                                      |
| [vault-apps](features/vault-apps.md)           | Agent-authored apps in their own origin                              |
| [command-palette](features/command-palette.md) | Quick open and the one table of commands                             |
| [onboarding](features/onboarding.md)           | First run and adding a vault                                         |

## 7. State outside the repo

- `userData` holds the GitHub and Google tokens (encrypted with Electron `safeStorage`), the vault
  registry (which repos are added and where), each vault's agent config directory, the Google cache
  and the `holi` CLIs. It is a machine fact: a second laptop starts empty.
- Per vault, `.holi/settings/app.local.yaml` holds machine-local settings and the reminder
  watermark; `.holi/settings/app.yaml` holds the shared ones.
- Conversations are Claude Code's own transcripts, local to the machine that ran them.

## 8. Security boundaries

- **Path safety.** `packages/shared` rejects `..`, absolute paths and NUL, canonicalises through the
  closest existing ancestor and re-checks containment. It is the only thing between a path and the
  user's filesystem.
- **Renderer isolation.** No Node in the renderer, no token in the renderer.
- **Authorization is GitHub's**, at push time. Holi performs no permission checks of its own: a
  check running on the machine of the person it restricts is not a boundary.
- **The agent's trust boundary is repo access.** Members are trusted colleagues. A destructive git
  command is possible from the vault, and is bounded by Claude Code's permission prompts, a managed
  clone holding nothing else, and branch protection. Git is not blocklisted, because reconcile needs
  it. Prompt injection through shared content is an accepted residual risk.
- **Token scope.** A `repo` grant reaches every repo the user has. Mitigated by encrypting it with
  `safeStorage` and keeping it in main.
- **Untrusted HTML** (mail bodies, event descriptions) is sanitised and shown in a sandboxed frame
  that never gets `allow-scripts`; see [google](features/google.md).
- **Vault apps** run in their own `holi-app://` origin and cannot reach the agent surface; see
  [vault-apps](features/vault-apps.md). `holi-vault://` sends no CORS header, because a packaged
  renderer and an app frame share the `null` origin and the header's absence is what keeps apps out.
- **The renderer's CSP is not an XSS defence.** It omits `script-src` because Vite's dev preamble
  is inline, and a policy with `'unsafe-inline'` would look like protection while stopping nothing.

## 9. Build

`pnpm dev` runs the app and `pnpm --filter @holi/desktop build` builds it with electron-vite.
`pnpm --filter @holi/desktop package:mac` packages it with electron-builder
(`apps/desktop/electron-builder.yml`); CI publishes a signed, notarized build as a GitHub release
whenever the version changes, and the installed app updates itself from there
([updates](features/updates.md)). There is no Docker, database or compose file.
