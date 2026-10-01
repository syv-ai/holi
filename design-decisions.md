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
