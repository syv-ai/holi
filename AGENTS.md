# Holi

Holi is a local-first Electron desktop app for markdown vaults. A vault is a
GitHub repository cloned into a Holi-managed local directory; the filesystem and
git history are the source of truth for notes, tasks, sync, and the Claude Code
assistant. There is no Holi server or database.

## Stack and layout

- Node.js `>=20.19` with pnpm workspaces (`apps/*`, `packages/*`).
- `apps/desktop`: Electron 43, Vite, React 19, Jotai, CodeMirror 6, Tailwind v4,
  Radix/shadcn components, tRPC over IPC, xterm, and Vitest 4.
- `packages/shared`: browser-safe TypeScript rules and types for vault paths,
  task files, wiki-links, dates, recurrence/reminders, themes, and text merging.
- `docs/`: architecture, one short page per feature, and the glossary.

Within the desktop app, `src/main` owns filesystem/git/GitHub/Google work, the
vault store and sync. `src/preload` is the narrow
`contextBridge`/IPC adapter. `src/renderer/src` is the React UI and never gets
Node access or GitHub credentials. `router.ts` is main's typed API seam; keep
Electron dependencies out of code that should remain testable under plain Node.

Optional parts of Holi are plugins under `src/plugins/<id>/` (the agent, PDF,
Google, vault apps and community plugins so far), each with its own `main/`, `renderer/`, `shared/` and
`test/`, reaching core only through `src/main/plugin-api.ts` and
`@/plugin-api`. Vault apps live in `src/plugins/apps/`; what a synced vault
holds of an app (the bundle grammar, the record merge, the `.local.app` rule)
stays in `packages/shared` and core main. Plugins from other repositories are
community plugins: processes the `community` plugin runs, never code it loads.

## Authoritative documentation

Start with [`docs/README.md`](docs/README.md), then read
[`docs/architecture.md`](docs/architecture.md) and the relevant page in
[`docs/features/`](docs/features/). The glossary is canonical for domain terms,
and [`docs/ui-system.md`](docs/ui-system.md) holds the renderer's design rules.
The docs describe the current design and why. Code is the authority for what is
actually implemented: verify a page against the code rather than trusting it.

`docs/not-built.md` tracks designed-but-absent work, not every non-goal or open
question. A decision goes straight into the page that owns it, with its reason.
Code comments say what they mean in words, or name the page; they never cite a
decision number. The docs carry no dated history; git holds it.
GitHub issues are backlog/history and are non-authoritative unless current code
and the docs support them.

## Install, develop, and build

From the repository root:

```sh
pnpm install
pnpm dev
pnpm dev:debug
pnpm --filter @holi/desktop build
```

`pnpm dev` launches the desktop app. `pnpm dev:debug` also enables the remote
renderer debugging port used by manual/CDP checks. Holi shells out to the
system `git` binary and expects a usable GitHub desktop environment; there is
no Docker, database, or compose setup.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm exec prettier --check AGENTS.md
```

Do not run the repository-wide `pnpm format` for a scoped change: the existing
tree is not globally Prettier-clean, so it rewrites unrelated files. Format or
check only the files you touched.

`pnpm test` runs both workspace test scripts. Desktop Node tests are matched by
`apps/desktop/test/**/*.test.ts`; renderer tests are a separate jsdom project
matched by `apps/desktop/src/renderer/**/*.test.tsx`. The desktop Node project
has `fileParallelism: false` intentionally: watcher and git tests must run one
file at a time. Do not “fix” flakes by parallelising that project or merely
increasing event waits. Shared-package tests run from its own Vitest script.

`pnpm typecheck` runs each package's `tsc --noEmit`. `pnpm lint` intentionally
lints only `apps/desktop/src/renderer/src/**/*.{ts,tsx}`; main and preload are
not ESLint-covered, so use typecheck, tests, and the Electron build for those
areas. The renderer gate already runs at error level; `pnpm lint:gate` is a
legacy alias with the same behavior as `pnpm lint`.

## Conventions and boundaries

- A vault's identity is its GitHub remote (`owner/repo`), not a generated local
  ID. A document or asset is identified by its normalized vault-relative path;
  do not invent document IDs or use absolute paths across the IPC boundary.
  Validate untrusted paths with `vaultRelPath`. Main-side filesystem access must
  use the Node-only canonicalising entrypoint when needed.
- Import the browser-safe root `@holi/shared` from renderer and ordinary pure
  code. `@holi/shared/path-safety-node` is the explicit Node-only subpath and
  imports `node:fs`; never pull it into renderer/browser-safe code.
- Renderer components follow `primitives/` → `composites/` → `features/`.
  Primitives are the only place for native form/dialog elements or Radix;
  lower layers cannot import upper layers and features cannot import each other.
  The renderer ESLint gate also rejects native `title=` tooltips and arbitrary
  colour literals; use the shared semantic tokens.
- Keep vault-scoped stores mounted in the app shell, not inside whichever view
  first reads them. The active-vault snapshot and watcher are shared state, not
  per-component caches.
- The agent is a real `claude` process in a main-process `node-pty` PTY, with
  the managed vault clone as cwd. It is the plugin `src/plugins/agent/`: a
  host (`main/host/`, the PTY in `pty.ts`) and Claude Code as its provider
  (`main/claude/`). Keep Claude's native permission prompts; do
  not add `--dangerously-skip-permissions` or a parallel prompt system.
- Use system `git` and parse plumbing/porcelain output, not human-readable git
  output. Holi-managed clones autosave, pull, merge, and push; do not assume a
  user-maintained checkout or a dirty working tree.

## Local files, generated files, and vault seeds

- Never commit secrets, tokens, or machine state. Root `.gitignore` excludes
  `.env`, `*.local`, logs, build output, and dependencies. Vault-local files such
  as `USER.local.md`, `CLAUDE.local.md`, `.holi/settings/app.local.yaml`,
  `.holi/memory/*.local.md`, and `*.local.*` must remain machine-local; the GitHub
  token is kept by the app's credential storage, not in source. Local-ness is
  the `.local.` marker and nothing else: a bare `USER.md` is ordinary
  committed content, whatever an older vault's `.gitignore` says.
- A vault's seed files are real files in seed folders: `vault/once/**` and
  `vault/shipped/**` beside the module that contributes them
  (`main/vault/seed/core.ts`, a plugin's `main/seed.ts`; the agent's is
  `src/plugins/agent/main/claude/`), at the
  path they get in the vault. Binaries such as the brand fonts and logo are
  read in with `?inline`; edit the file itself, there is nothing to regenerate.
- Holi seeds a vault's root `AGENTS.md` as user-owned vault content, distinct
  from this repository guide. Neither has a `CLAUDE.md`: Claude Code reads
  `AGENTS.md` directly. Treat seeded files as user content once present; do not
  overwrite them casually.
- **A seeded once file is frozen from the moment it exists, so changing its
  text in its seed folder reaches new vaults only.** `AGENTS.md` is the one
  that bites: vaults seeded earlier still tell the agent that `USER.md` is
  gitignored, which stopped being true when local-ness became the `.local.`
  marker. When a decision changes what the agent is _told_, ask how existing
  vaults are reached before assuming the seed covers it — a merged file's
  fragment is the pattern that does reach them, and it only covers the merged
  files (`.claude/settings.json`, `.gitignore`).
  A shipped skill or hook (`vault/shipped/`) is written only at vault creation and
  reaches an existing vault only when its user runs `holi skills update`.
- **A file whose writer regenerates it is the third answer to that question, and
  the cheapest.** `.holi/settings/app.yaml`, `app.local.yaml` and the two theme
  files are once files, but `writeSettingsText`/`writeThemeText` emit the whole
  document on every write rather than merging into it — so the list of settings
  and theme tokens they carry is rebuilt from `VAULT_SETTINGS` and
  `THEME_TOKEN_GROUPS` each time, and a vault seeded years earlier gains a newly
  added token the next time anything writes. The cost is the other half of the
  same property: a comment a person wrote inside one of those files does not
  survive, which is why `AGENTS.md` is emphatically not written this way.
- A vault's memory is `.holi/memory/`: one fact per file, `type` and
  `description` frontmatter, a `.holi/memory/index.md` regenerated by the
  `memory-index` pre-commit transform, and a `SessionStart` hook that prints an
  overview. `.holi/memory/` is on the agent surface, so vault apps may not read or
  list it.
- `node-pty` is built for Electron's ABI, not just the installed Node ABI. If
  an agent tab reports a native-module load error (the lazy `require` in
  `src/plugins/agent/main/host/pty.ts`), run:

  ```sh
  pnpm --filter @holi/desktop run rebuild:natives
  ELECTRON_RUN_AS_NODE=1 pnpm --filter @holi/desktop exec electron scripts/check-node-pty.cjs
  ```

  Tests inject/fake the PTY and do not prove that the live Electron native
  module is loadable.

## Working safely

Keep main/preload/renderer changes on their respective sides of the IPC seam,
and put pure domain rules in `packages/shared` rather than duplicating them in
UI or main. When a feature changes a documented contract, update its
feature page or the architecture text; do not treat a plan or an issue body as
an implementation specification. Before finishing, run the narrow checks for
the touched package and the root checks above.
