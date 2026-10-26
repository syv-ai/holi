# Architecture

A map of how Holi fits together. Each section points at the pages that own the detail.

## 1. System shape

Holi is one desktop app. There is no server, no database and no hosted service.

```
┌──────────────────────── apps/desktop (Electron) ────────────────────────┐
│  Renderer (React, Jotai, Tiptap)           Main (Node)                  │
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
  the vault: a git clone           pure rules: paths, wiki-links, dates,
  of markdown files                settings, plugins, themes, 3-way merge
```

**The filesystem is the truth.** The editor, the board, the file tree and the agent all read and
write the same files in one directory. Nothing is derived and stored elsewhere, so nothing can
disagree.

`packages/shared` holds the rules the app uses with itself and with the files on disk. It is a
separate package because its contents are pure and browser-safe, which keeps them testable without
Electron. `@holi/shared/path-safety-node` is the one Node-only entrypoint.

## 2. Build only what Claude Code does not do

The agent is a coding agent's own CLI, unmodified: Claude Code or Codex, one **provider** each
([agent-sessions](features/agent-sessions.md), Providers). Holi adds no adapter layer and no
prompt-building, and fixes forward when a release changes something. The terminal is the
interface, whichever agent runs in it: Holi draws around it (the session list, the tab, links to
vault files) and never re-draws it, which is what lets any agent with a
CLI be a session. A provider's core is the command it runs; what else it offers (a supervisor
that runs sessions unwatched, hooks that report turns, a context reading) are capabilities the UI
reads rather than assumes. With the vault being plain files in a git repo, the agent needs no
Holi-specific operations at all. Holi once drew Claude Code as a conversation on its structured
channel; it was retired because it bound the session UI to one agent's protocol.

## 3. Processes and the IPC seam

- **Main** owns everything with side effects: the filesystem, git, GitHub and Google calls, the
  vault store and watcher, sync, reminders, Typst, the Claude PTYs, the bottom panel's shells
  (`main/terminal/`) and the activity log (`main/activity/`). It holds every credential.
- **Preload** is a narrow `contextBridge` adapter over `ipcRenderer`.
- **Renderer** is the React UI. It runs with `contextIsolation` and without Node, and never sees a
  token. It reaches main through a typed tRPC router (`src/main/router.ts`).
  Its layers (stock shadcn and ReUI in `components/`, `composites/`, `features/`, `state/`,
  `lib/`) and the direction imports may go are [renderer](renderer.md); notes are Tiptap
  (`features/documents/rich-text`), code files and plain markdown CodeMirror (`editor/`).

Across the seam a document is named by its vault-relative path, validated with `vaultRelPath`,
never by an absolute path or a generated id. A binary the renderer draws itself (a PDF) crosses as
bytes; `holi-vault://` serves `<img>` only. Vault-scoped stores (the tree, the task set) mount in the
app shell for the life of the active vault: a store loaded by whichever view reads it first cannot
tell "not loaded" from "empty", and the failure looks like data loss.

What a vault app or the agent's `holi` CLI may ask main for is one capability registry
(`src/main/capabilities/`). Each entry is named `<namespace>.<verb>`, says which doors reach it (an
app's bridge, the CLI) and holds its own refusals, and, for the CLI, how its answer reads
(`cliValue`, `text`). Core registers its namespaces and each feature
registers its own from the composition root (`src/main/index.ts`); a namespace has one owner.

The CLI door's output lands in an agent's context and stays there, so it is kept short and
actionable (`src/main/bridge/`):

- **A refusal names its code and the next step**: `holi google search: UNAUTHORIZED: <cause>`, then
  `next: <what to do>`. The step is the thrower's own when it knows one (`CapabilityError`'s
  `next`: "ask the person to press Reconnect for Google in Holi's vault settings"), else the
  code's default (`NEXT_STEP`);
  a bad request also prints the command's usage line. An error that is not a refusal is a failure
  inside Holi and prints its message alone.
- **An answer over 16 KiB is spilled to a file** (`SPILL_BYTES`): written to
  `.holi/state/out/spill-<stamp>-<command>-<rand>.local.json` (`.txt` when it is not JSON), while the
  command prints the path, the size and the shape (an array's length and its items' keys, an
  object's keys). Asked for `--json`, that notice is JSON too,
  `{"spilled": "<path>", "bytes": <n>, "shape": "<shape>"}`, so a pipe into `jq` still parses. The
  agent then reads only the part it needs. 16 KiB is about 4k tokens, under Claude
  Code's own 30,000-character cut of a command's output, past which the agent would read a
  truncated answer without knowing it. The files are machine state, never committed and out of a
  vault app's reach; the newest 50 spills are kept (`main/vault/out-files.ts`).
- **The agent's view of a result can differ from an app's.** An entry's `cliValue` turns its
  result into what the CLI door answers, before `text` and for `--json` alike. Google's reads use
  it to fence text other people wrote (`fenceUntrusted`), so a mail reaches the agent's context as
  data, not instructions, while an app gets the result as it is.

### Plugins

Optional parts of Holi are plugins: first-party modules in the build, under
`apps/desktop/src/plugins/<id>/`, listed once per process in `src/plugins/main.ts` and
`src/plugins/renderer.ts`. Only the composition roots (`src/main/index.ts`, the renderer's
`main.tsx`) import those lists. A plugin reaches core through one module per process,
`src/main/plugin-api.ts` and `@/plugin-api`, plus the renderer's `components/ui`
and `composites/`; ESLint holds the renderer side and plugin code to that, and
`test/plugin-boundary.test.ts` holds main.
A plugin's renderer reaches its main side only through capabilities that open the `ui` door: the
`cap.run` mutation, called through `capClient<typeof table>(namespace)`, which offers just those
verbs with their types read from the table (params cross as JSON, results by structured clone).
Plugins call each other the same way, each typing only the slice it calls, and a plugin's main
side reaches another's through `ctx.call(name, params)`, the same UI-door call its renderer makes; before offering such a
call, a plugin asks `useHasCapability(name)`, backed by the `cap.names` query (the UI door's names
whose owner the vault runs), so a button for another plugin's verb hides while that plugin is off.
Tasks' `tasks.create` is one: the board and the Google views create tasks through it.
A plugin that builds on another says so in `PluginInfo.requires`: it runs only where every plugin
it requires runs, down a chain, so turning one off turns off what stands on it, its seeds included.
The dependency runs one way: the plugin underneath knows nothing of what requires it. One resolver,
`resolvePlugins`, answers which plugins run and why each other one does not (off in the vault, off
on this machine, or needing one that is off), and every reader in both processes asks it. Both
processes check their list with `checkPluginCatalogue` at boot, which refuses a missing or circular
requirement.
A part of Holi may be written to the plugin contract without being optional: `PluginInfo.builtIn`.
The agent is built in. The resolver runs a built-in part in every vault whatever the
plugins files say, the settings tab and the onboarding act do not list it, a write refuses to pin
it, and the writer leaves its id out of the `plugins` block, so a pin an older Holi wrote
(`agent: false`) is ignored at once and gone at the file's next write, as is a retired part's
(`chat`, `RETIRED_PLUGINS`). They stay under
`src/plugins/` rather than moving into core: the contract is what keeps core free of Claude Code,
and what lets Holis, automations and the rest build on the agent (`requires`, `ctx.hear`, its
`.claude/` seed) without core knowing them. A built-in part may require only other built-in parts,
which `checkPluginCatalogue` checks.
A plugin that only adds to another says so in `PluginInfo.addsTo`: Google, PDF and vault apps add
skills, hooks and settings fragments to the agent. Unlike `requires`, it runs without the other;
what it adds waits until that one runs, and the resolver says what each running plugin is adding
to right now (`addingTo`).
A plugin claims vault paths: the first enabled claim with a `view` opens a note tab of that path,
and its `rowMenu` items join the file tree's menu. A claim can say more about its files: what
the explorer's New makes (`create`), that they stay out of the tree until shown (`hideable`), what
it adds to the notes editor (`editor`: how a link to one is drawn, what the `@` menu offers, a
layer for its own files) and how their frontmatter is drawn (`frontmatter`: fields, controls by
key, an always-open block, suggestions), and how the graph draws them (`graph`). One
`useEditorDeps` wires every notes editor from them. On the main side a claim
(`MainPlugin.claims`, `{match, parse, normalize?, checkNoteWrite?}`) owns markdown files in the
snapshot: the scanner (`scanVault(root, claims)`, the claims from `PluginHost.scanClaimsFor`)
parses them into `snapshot.claimed[id]` instead of `docs`, and a settings write that changes
`plugins` rescans. Core asks a claimed file's plugin about it through the claims rather than
naming the plugin: a capability reads the vault's (`ctx.claims()`), so a vault app's note write
(`docs.write`) is checked by `checkNoteWrite` (a task's body only), and a file a running plugin
claims takes no comments.
A plugin adds `surfaces` (tab kinds) and `rail`
items to the nav menu ([tabs and panes](features/tabs-panes.md)), each with a badge if it likes,
registered beside core's own, `settingsSections` to the settings tab
([settings](features/settings.md)), and `slashCommands` to the notes editor's slash menu
([editor](features/editor.md)). It marks paths in the tree and the tabs (`pathMarks`: a glyph, a
strike, a badge) and lays `overlays` over the panes (a drawer, quick add), each deciding whether
it shows. Its dialogs open as `{id: 'plugin', render}`.
Main tells a plugin's renderer something through events: `ctx.emit(remote, name, payload)` sends
`{remote, name, payload}` on the plugin's one channel, `plugin:<id>`, read by one preload member,
`window.holi.plugin.on(id, cb)`. Main sends only about a vault that runs the plugin, so the renderer
subscribes every installed plugin's `events` handlers at boot, and a handler drops an event about a
vault it does not care about. The other way, `window.holi.plugin.send(id, event)` is ordered and
unanswered, and `ctx.on(name, handler)` hears only messages about the open vault.
Main-side plugins started in a vault tell each other one kind of thing, the events that start
[scheduled agents](features/scheduled-agents.md): `ctx.events.emit` and `ctx.events.on` carry a
typed `VaultEvent` (`packages/shared/src/triggers.ts`) to every plugin started in that vault, and
keep nothing, so a speaker says its piece again rather than relying on a listener having started
first. `ctx.onSnapshot` hears each scan of the vault, the latest one at once.
A plugin may serve URL schemes (`MainPlugin.schemes`). Electron takes schemes only before the app
is ready, so every scheme in the build (vault apps' `holi-app:`) is registered at boot beside
core's `holi-vault:`, and a plugin's handler answers 404 while the open vault has the plugin off. A scheme
marked `frame` serves framed pages: the window guard lets such a frame move within its scheme and
sends a link out of it to the browser.
A plugin's own code sits in `main/`, `renderer/` and `test/` under its folder, and `shared/` where
it has rules of its own (apps, browser, links, pdf); its renderer imports its main side as types
only, for `capClient`, and its tests live in its own `test/`. The built-in part is the agent
([agent-sessions](features/agent-sessions.md)). The optional plugins are tasks
([tasks](features/tasks.md)), automations and Holis, built on the agent, PDF
([pdf](features/pdf.md)), links ([links](features/links.md)), the browser
([browser](features/browser.md)), Google
([google](features/google.md)), vault apps ([vault apps](features/vault-apps.md)) and community
plugins ([community plugins](features/community-plugins.md)), which hosts plugins from other
repositories as processes it runs, never as code it loads. A renderer plugin may give its claims as
an atom, for claims that follow what main tells it, and a plugin may register a frame origin with
the window guard (`ctx.frameOrigin`).
A seed contribution can own a path prefix (`owns`): the agent owns `.claude/`. Another plugin seeds
there only by declaring it adds to the agent, which `install` checks at boot. The agent is built
in, so what is added there is seeded whenever the adding plugin runs.
The app door, through which a vault app's frame calls capabilities, is core's, and the apps plugin
is its one opener (`ctx.openAppDoor`), supplying the consent check for entries with an
`appGrant`; with apps off, no entry is reachable through it.
What a synced vault holds stays core whatever this machine runs: an app's records still merge
field by field and a `.local.app` still never syncs with the apps plugin off, so that bundle
grammar is in `packages/shared` and the merge driver and fences in core.

Enablement has two layers: `.holi/settings/plugins.yaml` declares the vault's plugins for everyone,
and `plugins.local.yaml` can only turn one off on this machine ([settings](features/settings.md)).
The same pair holds each plugin's own settings under its id (`PluginInfo.settings`).
Each vault is its own world: a plugin starts in the open vault (`MainPlugin.activate`, with one
context bound to that vault: register capabilities, emit, hold sync, commit, read the head, hear the
renderer's focus report, hear a pulled comment that mentions the person, serve a bridge route, ask
before quit, raise a native notification while no Holi window has focus) and nothing it starts outlives the
vault, so nothing carries from one vault to the next. The plugin host (`src/main/plugin-host/`)
keeps what is started in step with the vault's resolution (`reconcile`): at the open, on a settings
write and on any change to the files, so a hand edit to `plugins.yaml` takes effect at once. It
starts a plugin's providers before it and stops it before them, seeds a plugin that joins before
starting it, and stops everything, newest first, when Holi leaves the vault or quits: each
disposer, then what it registered. A plugin that throws as it starts is reported with its message
(`settings.pluginFailures`) and tried again on the next write or open, never on a bare change.
One kind of work outlives the open vault: a plugin's work across every registered vault that runs
it (`MainPlugin.background`), such as reminders, which fire for a vault that is not open. It
starts at launch while some registered vault runs its plugin, so a launch's catch-up runs whichever
vault opens, and is looked at again whenever that may change: a change to what the open vault
runs, a vault leaving the registry, or no vault being open. Its context (`AppCtx`) lists those
vaults, scans their files, can show a path, knows the signed-in login and raises a notification
whatever has focus, and holds no vault open. While any runs, Holi stays in the tray with its window
closed; with none, closing the last window quits (except on macOS).
Turning off a plugin whose renderer side says stopping it costs something (`leaveGuard`, the
agent's busy sessions) asks before the write; a hand edit stops it without asking. Dispatch refuses
a capability whose plugin is off in the calling vault, as "no such method".

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

The agent is a built-in part written to the plugin contract (`src/plugins/agent/`): a host (`main/host/`: PTYs, terminal mirror, turn
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

**Automations** (scheduled agents) are one person's `.local.md` files in `.holi/schedules/` that
the `automations` plugin starts as background sessions at their times, or when one of their triggers
hears an event (a file added, a task due, a meeting about to start, a mail), once that person
approved their content. The events come from the plugins that own them over `ctx.events`, and the
plugin's trigger router dedupes and batches them into runs
([scheduled-agents](features/scheduled-agents.md)). **Holis** are agents that belong to the vault,
folders in `.holi/holis/` with a soul and a memory, that a person sends a document to from its Agent
menu or that carry out an automation, once this machine approved what they say. Both are plugins
built on the agent: they start sessions through `agent.launch` (`ctx.call`), hear its session list
and turn ends through `ctx.hear` (what a plugin's main side `publish`es, heard only by the plugins
that require it), and fill the Agents view and the Agent menu from slots core knows nothing of
([holis](features/holis.md)).

**The inbox** is how the agent asks for attention while nobody is watching: `holi agent notify`
adds an entry and, by quiet rules, a banner, and every run leaves a line in the day's work log
([agent-inbox](features/agent-inbox.md)).

See [agent-sessions](features/agent-sessions.md), [agent-config](features/agent-config.md),
[agent-memory](features/agent-memory.md), [scheduled-agents](features/scheduled-agents.md),
[holis](features/holis.md) and [agent-inbox](features/agent-inbox.md).

## 6. The pillars

| Page                                           | What it covers                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| [editor](features/editor.md)                   | Tiptap notes, CodeMirror text files, external writes, completion    |
| [tabs-panes](features/tabs-panes.md)           | Panes, preview and pinned tabs, split panes, moving tabs            |
| [frontmatter](features/frontmatter.md)         | The frontmatter block and its typed rows                            |
| [wiki-links](features/wiki-links.md)           | Path-based links, rename, backrefs                                  |
| [tasks](features/tasks.md)                     | `task.*.md` files, the board, recurrence and reminders              |
| [planning](features/planning.md)               | The vault as one project: `.holi/project.md`, `.holi/statuses.yaml` |
| [daily-notes](features/daily-notes.md)         | Idempotent daily notes and their archive                            |
| [google](features/google.md)                   | Gmail and Calendar, per vault                                       |
| [pdf](features/pdf.md)                         | Typst export and the PDF viewer                                     |
| [links](features/links.md)                     | `link.*.md` files and page previews                                 |
| [browser](features/browser.md)                 | Web pages in a tab, and `holi browser` for the agent                |
| [vault-apps](features/vault-apps.md)           | Agent-authored apps in their own origin                             |
| [command-palette](features/command-palette.md) | Quick open and the one table of commands                            |
| [onboarding](features/onboarding.md)           | First run and adding a vault                                        |

## 7. State outside the repo

- `userData` holds the GitHub and Google tokens (encrypted with Electron `safeStorage`), the vault
  registry (which repos are added and where), each vault's agent config directory, the Google cache,
  which schedules this machine runs (and their run log) and the `holi` CLIs. It is a machine fact: a
  second laptop starts empty.
- Per vault, `.holi/settings/app.local.yaml` and `plugins.local.yaml` hold machine-local settings
  (the first also the reminder watermark); `app.yaml` and `plugins.yaml` hold the shared ones.
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
  that never gets `allow-scripts`; see [google](features/google.md). The text other people wrote
  reaches the agent fenced as `<untrusted ...>`, which the skills teach as data, never instructions.
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

Every structural rule is a tool, and `.github/workflows/ci.yml` runs them all on each push and
pull request: `pnpm typecheck`, `pnpm lint` (layers, styling, motion, the plugin seam), `pnpm knip`,
`pnpm rulecast` (names and folders), `pnpm test` and the commit-message check. A rule that is not in
CI does not exist; [renderer](renderer.md#rules) lists who owns which.
