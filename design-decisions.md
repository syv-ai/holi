# Plugin split: design decisions

The running record of the decisions behind splitting Holi's agent, tasks, Google, vault apps and
PDF into plugins. Each entry says what was decided and why. Once the docs pages describe the
landed design, this file can go. Code comments never cite this file.

## Model

- **Plugins are first-party modules in the build.** There is no runtime loading. The contract is
  namespaced per plugin (capabilities, events, surfaces and settings keys all live under the plugin
  id), so a later runtime loader changes how plugins are loaded and trusted, not the API.
- **Plugins live in `apps/desktop/src/plugins/<id>/`.** There is one electron-vite build, and
  ESLint boundaries forbid core from importing `src/plugins/**`. They become workspace packages
  when installable plugins arrive, because only then does a package boundary pay for its build
  wiring.
- **Each process has one static plugin list.** A disabled plugin's code is never activated.
- **Third-party plugins, when they come, are renderer-only.** They would be sandboxed UI that runs
  like a vault app and calls existing capabilities, under the code-hash consent model apps already
  have. No third-party code runs in main. Nothing is built for this now.

## Enablement

- **Two layers.** `.holi/settings/app.yaml` declares the vault's plugins (committed, shared by the
  team). `.holi/settings/app.local.yaml` can only turn a plugin off on this machine. A plugin runs
  where the vault says on and the machine has not said off.
- **A plugin missing from `app.yaml` gets the plugin's own default.** The agent, tasks and PDF
  default on. The settings writers emit the whole document, so the default becomes visible in the
  file on the next write.
- **An open tab whose plugin turns off closes,** by the same path as a tab whose file was deleted.
- **Seeded files of a disabled plugin stay as user content and go inert.** Hooks fail closed (the
  Google send gate) or exit cleanly when their endpoint is gone. Enabling a plugin seeds only the
  files that are missing.

## Interface: six concepts

The first draft had about 25 separate contribution points: an interface nearly as wide as the core
it plugs into. These six cover them.

1. **Capability**: a named entry `{doors, params, run, text?, writes?}` under the plugin id. Doors
   are `ui` (the renderer), `cli` (`holi <plugin> <verb>`) and `app` (vault apps). This is the only
   way a plugin's renderer reaches its main side: plugins contribute no tRPC routers. It is also the
   seam between plugins: a caller checks `has('tasks.create')` and hides its button when the
   capability is absent.
2. **Surface**: a tab kind `{kind, label, icon, render, keepMounted?, homeable?}`, possibly dynamic
   (one per app bundle). It replaces the closed `Tab` union and every switch on it.
3. **Path claim**: a plugin owns a path pattern, `{match, parse?, view?, decorate?, rowMenu?,
frontmatter?, editor?}`. It replaces `isTaskFilePath`, `isAppBundlePath` and the `.pdf` cases
   scattered through core.
4. **Activation**: `activateApp(ctx)` once per process and `activateVault(ctx)` per enabled vault.
   Each returns a disposer, and disposal is the leave and quit path.
5. **Seed folder**: `vault/once/**` (written if absent) and `vault/shipped/**` (written at creation,
   refreshed by `holi skills update`) inside the plugin folder.
6. **Events**: one namespaced push channel per plugin, `plugin:<id>`, over a single core preload
   member.

These small UI contributions remain plain lists: commands, settings section, settings keys, commit
transforms, dialogs, rail, sidebar section, pane-header actions.

**Interface creep rule:** a new plugin-facing seam is added only when a real plugin needs it, and
first fitted into the six if it can be.

## Agent

- **Host plus provider.** The host owns the PTY and terminal mirror, the turn coordinator, turn
  review, the session surface and the `agent.ask` capability. Claude Code is the provider. The
  provider interface starts as exactly what the host calls today, and is widened when a second
  provider (such as OpenCode) is actually written. Until then it has one implementation, so any
  extra abstraction in it is a guess.
- **`AGENTS.md`, `memory/` and its pre-commit transform stay core.** `AGENTS.md` is a vault file
  other agents read too. `isAgentSurfacePath` stays core as the protected-paths fence, because those
  files exist in synced vaults whether or not the plugin runs.

## Order

0. Move the hidden core out of feature folders (bridge, capabilities, seeder), add a native Home,
   move `splitFrontmatter`, remove dead imports.
1. Build the minimal contract and carry PDF on it.
2. Google: surfaces, events, the first call from one plugin to another.
3. Vault apps.
4. Tasks.
5. The agent host and the Claude Code provider.

PDF goes first because it is the smallest plugin that still exercises capabilities, claims, seed
and activation.

## Decisions made during execution

### Phase 0

- **`splitFrontmatter` lives in its own `packages/shared/src/frontmatter.ts`.** Finding the `---`
  fence is neither YAML editing (`yaml-document.ts`) nor key meaning (`frontmatter-schema.ts`). It
  throws `FrontmatterError`; `parseTaskFile` rethrows it as `TaskFileError` so a task with an
  unclosed fence is still listed as broken rather than crashing the scan.
- **Body search is core (`main/vault/search.ts`).** The palette's `notes.search` uses it, so it
  cannot live in the apps feature.
- **`.holi/state/**` is machine state that vault apps can never read.** The git hook's endpoint
  file there carried the hook server's token, and `holi.docs.read` returned it to any app. Every
  bridge token moves into that directory, so it is fenced in shared path-safety
  (`isMachineStatePath`) before any token moves.
- **Capabilities live in core (`main/capabilities/`), one registry for every door.** Every name
  is `<namespace>.<verb>`. A caller registers the namespaces it owns, and each namespace has
  exactly one owner (apps owns `apps` and `store`; core owns `docs`, `vault`, `sync` and
  `skills`). One `dispatch` handles snapshot choice, refresh after writes and error mapping for
  every door. Feature services leave `CapabilityServices`: each feature closes over its own
  dependencies when it registers.
- **The hook server becomes a core bridge (`main/bridge/`) with a route table.** Only routes
  whose caller is not an agent verb stay routes: git's pre-commit and merge driver, and the
  agent's turn and status-line hooks, which must answer empty. Everything else is a capability,
  and `ops.ts` is gone.
- **The `holi` CLI is generic.** It posts argv to `/cli`, and main resolves
  `<namespace> <verb>` against the capabilities that open the `cli` door, with positionals
  declared on the capability. Plugins add no shell code. Exit codes are 0 for success, 1 for a
  refusal, and 2 for usage. Spellings change with no aliases (no users).
- **Endpoint discovery is provider-neutral.** CLIs and hooks walk up from the current directory
  to `.holi/vault` and parse `.holi/state/bridge.local.env`, a key/value map that plugins
  contribute to. It replaces `$CLAUDE_CONFIG_DIR/holi.env`, which only Claude sessions could
  find. The file is parsed, never sourced: a collaborator could force-add a malicious one.
- **The renderer's `ui` door lands with its first consumer (PDF), not before.** It is one
  `cap.call` mutation plus a typed per-namespace client.
- **Home defaults to a native "Recently opened" list (`home: recents`).** Core's default must not
  name an app, or Home breaks when the apps plugin is off. An app bundle stays a valid `home`
  value, and new vaults are no longer seeded with `Home.app`. The list leaves out terminals,
  because `holi.open` cannot open them either.

### Phase 1

- **Seeding is contributions, and a contribution is a folder.** Core, the agent and each plugin
  contribute `vault/once/**` and `vault/shipped/**` via eager `import.meta.glob` in their own
  module (the glob must be static, and core cannot glob plugins). Binaries ride `?inline`, which
  retires the brand-asset generator and its 740 KB generated module. A merged file
  (`.gitignore`, `.claude/settings.json`) has one owner, and others add fragments, replacing the
  hand-written `settingsWithRequired` blocks.
- **Plugins reach core through one module per process.** `src/main/plugin-api.ts` and
  `src/renderer/src/plugin-api/` are the only core imports a plugin may make (plus primitives and
  composites). One reviewable list instead of cross-imports. ESLint enforces it in the renderer;
  a small test enforces it for main, which is not linted.
- **Enablement is a `plugins` map setting** resolved by a pure function in shared: the vault's
  value, else the plugin's default, minus the machine's local offs. A local `true` is ignored.
  The settings tab shows a toggle per installed plugin.
- **A disabled plugin's capabilities are refused at dispatch,** so `holi pdf ...` answers "no
  such method" in a vault with PDF off, whatever the process has loaded.
- **Enabling a plugin seeds its shipped files once,** recorded per machine in seed state, so a
  skill the team deleted stays deleted.
- **An unclaimed `.pdf` opens in the file placeholder.** The file still exists; only plugin
  surfaces close when their plugin turns off.
- **Typst's path reaches the agent through a capability, not the environment.** `holi pdf typst`
  ensures the binary and prints its path. An environment contribution from one plugin to the
  agent would be a seam outside the six concepts.

### Phase 2

- **Google needs neither events nor per-vault activation, so phase 2 adds neither.** Main pushes
  nothing Google-related, and the vault-to-account map is machine-wide and resolved from the
  caller's remote. Events arrive with the first real pusher, and `activateVault` with the agent.
- **A surface is its own tab member, `{kind: 'surface', surface, id?}`.** An open `{kind: string}`
  would break narrowing everywhere. The pane, tab strip, palette, commands, Home options and
  `holi.open` all read the registry. Surface kinds are validated only in the renderer, where the
  registry lives.
- **Rail items carry visibility as an atom,** read by one derived atom, so plugins that toggle
  cannot break React's hook order.
- **Google's own loopback server, token and `holi-google` CLI are deleted.** The core bridge
  already authenticates per vault and supplies the remote, so `holi google <verb>` needs nothing
  more. The send gate matches the new spelling, and `/cli` rejects anything before the verb so
  the gate's pattern stays sound.
- **A command that reads a body from stdin asks for it explicitly.** If the body is missing, the
  server answers 428 without running, and the script retries once with stdin. A write never runs
  on the first leg, and `send --draft` never blocks waiting on stdin.
- **An app's consent is a field on the capability (`appGrant`),** enforced by the app door, so a
  plugin never imports the apps plugin's grants.
- **Plugins call each other through capabilities they hand-type.** Google types only the slice of
  `tasks` it calls and gates its buttons on `useHasCapability('tasks.create')`. Dispatch
  validates at runtime.
- **The capability registry is an instance, not a module singleton.** The composition root
  creates it and each test builds its own, so tests stay isolated. The APP_METHODS
  exhaustiveness check is a compile-time `satisfies` at the composition point.
- **Each door maps `CapabilityError` itself** (tRPC error for the renderer, 422 text for the
  CLI). It is three lines per door, so a shared mapper would be indirection.

### Phase 3

- **What a synced vault holds stays core, whatever this machine runs.** The record merge driver,
  the `.local.app` never-commit rule and the app `data/` fences stay in core, with a small bundle
  grammar in shared. A teammate's record edit must merge correctly even on a machine with apps
  off, for the same reason the agent-surface fence stays core.
- **The app door is core; the apps plugin is its only opener.** Core dispatch knows door `app`,
  `ctx.bundle` and `appGrant`. The plugin opens the door once and supplies the consent check.
  With apps off the door has no opener, so other plugins' app-door capabilities are unreachable
  with no special case.
- **Events carry the vault's remote.** The agent's `holi apps open` used to open a path in
  whichever vault was active. Now a handler drops events for other vaults.
- **An app is one surface `app` with the bundle path as its id,** listing its instances for the
  palette, rail and Home picker. A path claim gains `folder` (a directory that is one document),
  `decorate`, `create` and conditional row items, which tasks reuses.
- **Pane-header actions are a surface member,** not a separate list.
- **"Create Home app" and the seeded Home app files are deleted.** Home defaults to the native
  recents list, and an app is created with `holi apps init` or by asking the agent. Keeping the
  button would make core's Home know about apps. (Removes a visible button: flagged for the
  owner.)
- **`activateVault` is still not needed.** Nothing in apps is per vault beyond what a call's
  remote resolves.

### Phase 4

- **Claimed files are parsed once, in main, and ride the existing snapshot push.**
  `snapshot.claimed[pluginId]` replaces the typed `tasks`/`broken` fields. The board stays
  instant, and with tasks off the files fall into `docs` as notes with no special case. A
  capability plus change event would add a round trip and a second consistency path, and a
  renderer-side parse would read every file twice. `scanVault` requires its claims argument, so
  no caller can silently forget it.
- **Frontmatter controls are keyed by field, not by kind.** The tasks plugin's `status` control
  completes the task itself, so core needs no write interceptor.
- **Staying alive in the background belongs to core, switched on by a plugin flag**
  (`runsInBackground`). The tray, the launch-at-login prompt and the keep-alive are active only
  while such a plugin is enabled in some vault. Without tasks, closing the last window quits.
- **Plugins that work across vaults activate at boot** for any vault that enables them, so the
  reminder catch-up sweep still runs at launch. The renderer listens to every installed plugin's
  events, and main gates when it emits.
- **The seeded `AGENTS.md` loses its Tasks section; the `using-tasks` skill carries it.** A
  once-only file cannot follow a plugin being toggled. A skill's description is always in
  Claude's context while the plugin has seeded it.
- **What the theme and shared UI speak stays core:** the `task-*` theme tokens (vault apps use
  them), dates, the calendar grid, `DateTimePicker` and the GFM checkbox code, which is not about
  task files.
- **The claim has grown members** (`parse`, `normalize`, `editor`, `frontmatter`, `hideable`,
  `folder`, `decorate`, `create`, `rowMenu`). Each is used by a real plugin, and all are one
  concept: what a plugin does with the paths it owns.

### Phase 5

- **The provider line is the agent's existing dependency interface** (`AgentSessionsDeps`):
  Claude's CLI verbs, its session listing, its config silo, its terminal command and its seed.
  The types keep Claude's shapes until a second provider exists.
- **Events go both ways.** Terminal keystrokes are ordered fire-and-forget messages
  (`holi.plugin.send`), not `cap.call`s, because async invokes do not preserve the order a TUI
  needs. This is concept 6 with a real consumer, not a second transport.
- **"Ask" is a renderer service, not a capability.** Picking the default target, landing the tab
  and focusing the terminal are renderer state. Core exposes `useAgentService()`, which is null
  when no agent plugin is enabled. Every "Ask" button, the reconcile hand-off and the stuck-push
  investigation gate on it. Other plugins never import the agent plugin.
- **`activateVault` arrives with the agent, its first real consumer.** `VaultCtx` gives sync
  pause, commit, head, UI reports and events bound to the remote. It runs after the vault is
  open, and its disposer runs inside leave while the vault is still active.
- **A quit guard is its own registration, not a disposer that can ask,** because disposers run
  after the decision to quit and cannot cancel it.
- **A sticky sync conflict clears with "Try again", not only when a turn ends.** Without the
  agent nothing would ever clear it. Reconcile is offered only when an agent service exists.
- **A seed contribution can own a prefix (`.claude/`).** Other plugins' files and fragments under
  it are skipped while the owner is off, and seeded once when it turns on. Google's gate, the
  apps check, the tasks deny rules and PDF's skills all follow from this one rule.

### Executed in phase 0

- **`/cli` is the only CLI door.** `/cap/` was removed once nothing posted to it. The registry
  refuses a capability that opens the `cli` door without a `cli` spec. Bare `holi` prints usage
  and exits 2.
- **The bridge env keys are `HOLI_BRIDGE_PORT`/`HOLI_BRIDGE_TOKEN`.** The scripts always assign
  the variables they read, so an inherited environment cannot steer them.
- **Existing vaults reach the new hooks only through `holi skills update`,** by the standing rule
  for shipped files. Until then an old `turn-signal.mjs` finds no `holi.env` and stops pausing
  sync. No legacy reader was added.
- **Seed fragments are a list per file,** so Google, apps and tasks stay separate pieces inside
  the agent contribution until each moves out. Merged files run first in `ensureSeeded`, so the
  settings merge already sees the hooks the same run writes. A fragment for a file nobody merges
  is ignored, which is how a disabled owner skips other plugins' pieces.
- **The router's seed dependency is required,** because a router that silently skips seeding
  leaves `.gitignore` without the `.local.` rule.
- **Legacy migrations are deleted** (`migrate-layout`, `migrate-settings-format`, the shared
  agent-config migration). The remaining ones (`migrate-apps`, the old Google cache delete, the
  old seed-state record format) go with the phase that owns their code.
- **A plugin's activation runs after seeding and before the vault opens; its gate follows the
  settings on disk.** The enablement cache is invalidated on every snapshot, so a hand edit opens
  or closes the capability gate at once, while activation and seeding wait for the next open
  (the settings tab does both immediately).
- **The plugin host undoes a plugin's registrations itself** at dispose, even if the plugin's own
  disposer forgets them. A failed start is not memoised, so the next open retries.
- **The settings tab toggles the committed value only.** Turning a plugin off for this machine is
  an `app.local.yaml` edit; the row says so when it applies.
- **The renderer's door is the mutation `cap.run`** (tRPC reserves `call`). Results cross by
  structured clone and params as JSON.
- **A plugin's capability table is declared with `satisfies CapabilityTable`, one namespace per
  typed client.** An annotation would widen the doors, and the client would offer every verb.
- **Plugins open only the generic plugin dialog,** never a core one. A claim's menu item gets an
  opener narrowed to that variant.
- **PDF is the first plugin** (`src/plugins/pdf/`). The agent gets Typst from `holi pdf typst`,
  allowed without a prompt, rather than from an environment variable. One shared download serves
  the warm-up, renders and the CLI. Typst warms when the plugin starts.
- **A plugin's info lives in one file both halves read** (`src/plugins/<id>/info.ts`).
- **A plugin's renderer may import its own `main/` for types only,** enforced by
  `no-restricted-imports` with `allowTypeImports`, because a value import would bundle main code
  into the renderer. Plugin tests may import core main to drive the registry. Shipped plugin code
  may not.
- **UI-door calls always carry a remote,** even for per-machine stores such as signatures, so
  every door resolves the same way.
- **Core surfaces are installed into the registry like plugins,** from the renderer's entry point,
  because their renders import features and state cannot import those without a cycle. The first
  surface to claim a kind wins, so a plugin cannot take over a core surface.
- **`holi.open(target)` resolves a registered surface first,** then a path. A bare name that is
  neither a view nor a root file is "no such view".
- **The capability host has two faces.** `dispatch` serves the ui and cli doors, and
  `openAppDoor` is the app door, opened once by the apps code with its consent check. An
  `appGrant` capability fails closed when the door was opened without one.
