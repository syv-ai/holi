# Holi

Holi is a local-first Electron desktop app for markdown vaults. A vault is a
GitHub repository cloned into a Holi-managed local directory; the filesystem and
git history are the source of truth for notes, tasks, sync, and the Claude Code
assistant. There is no Holi server or database.

## Stack and layout

- Node.js `>=20.19` with pnpm workspaces (`apps/*`, `packages/*`).
- `apps/desktop`: Electron 43, Vite, React 19, Jotai, Tiptap (notes), CodeMirror 6
  (code files and plain markdown), Tailwind v4, stock shadcn and ReUI components,
  tRPC over IPC, xterm, and Vitest 4.
- `packages/shared`: browser-safe TypeScript rules and types for vault paths,
  task files, wiki-links, dates, recurrence/reminders, settings, plugins, themes,
  and text merging. Rules only one plugin uses live in its own `shared/`.
- `docs/`: architecture, one short page per feature, and the glossary.

Within the desktop app, `src/main` owns filesystem/git/GitHub/Google work, the
vault store and sync. `src/preload` is the narrow
`contextBridge`/IPC adapter. `src/renderer/src` is the React UI and never gets
Node access or GitHub credentials. `router.ts` is main's typed API seam; keep
Electron dependencies out of code that should remain testable under plain Node.

Optional parts of Holi are plugins under `src/plugins/<id>/` (tasks, automations,
Holis, saved links, the browser, PDF, Google, vault apps and community plugins so
far), each with its own `main/`, `renderer/` and `test/` (and a `shared/` where it
has rules of its own), reaching core only through `src/main/plugin-api.ts` and
`@/plugin-api`. The agent lives there too, written to the same contract,
but is built in (`PluginInfo.builtIn`): it always runs, Settings does not list
it, and a stale `agent:` pin in `plugins.yaml` is ignored, as is a `chat:` pin
for the retired chat part (`RETIRED_PLUGINS`). Vault apps live in `src/plugins/apps/`; what a synced vault
holds of an app (the bundle grammar, the record merge, the `.local.app` rule)
stays in `packages/shared` and core main. Plugins from other repositories are
community plugins: processes the `community` plugin runs, never code it loads.

## Authoritative documentation

Start with [`docs/README.md`](docs/README.md), then read
[`docs/architecture.md`](docs/architecture.md) and the relevant page in
[`docs/features/`](docs/features/). The glossary is canonical for domain terms.
[`docs/renderer.md`](docs/renderer.md) is the renderer's standing convention (layers,
names, tests, rules) and [`docs/ui-system.md`](docs/ui-system.md) holds its design
rules. [`docs/refactor/`](docs/refactor/agent-first.md) is the plan and decision log
of the agent-first renderer refactor.
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
pnpm knip
pnpm rulecast
pnpm exec prettier --check <the files you touched>
```

CI (`.github/workflows/ci.yml`) runs all of them on every push and pull request, plus
`pnpm knip:production`, the rulecast validation and the commit-message range. A rule that
is not in CI does not exist. When one fails, read its id in the output and look it up in
[`.agents/skills/holi-rules/SKILL.md`](.agents/skills/holi-rules/SKILL.md): it says what
the rule forbids, the fix, and how to change a rule. Run `pnpm rulecast:install` once per
clone so rulecast findings reach Claude Code while it edits.

Do not run the repository-wide `pnpm format` for a scoped change: the existing
tree is not globally Prettier-clean, so it rewrites unrelated files. Format or
check only the files you touched.

`pnpm test` runs both workspace test scripts. The desktop Node project matches
`apps/desktop/test/**/*.test.ts` and `src/plugins/*/test/**/*.test.ts`; the jsdom
project matches renderer tests (`src/renderer/**/*.test.ts(x)`) and plugin
component tests (`src/plugins/**/*.test.tsx`). Where a new test goes is in
[`docs/renderer.md`](docs/renderer.md#tests); some renderer state tests still sit in
`apps/desktop/test/` and are a known exception, not a model. The Node project has
`fileParallelism: false` intentionally: watcher and git tests must run one
file at a time. Do not “fix” flakes by parallelising that project or merely
increasing event waits. Shared-package tests run from its own Vitest script.

`pnpm typecheck` runs each package's `tsc --noEmit`. `pnpm lint` is ESLint with the
layer boundaries and `@shadcn/lint` over `apps/desktop/src/renderer/src/**` and
`apps/desktop/src/plugins/**` (`--max-warnings 0`); main and preload are not
ESLint-covered, so use typecheck, tests, and the Electron build for those areas.
There is no `lint:gate`.

## Commits

A commit message is a single subject line, `type: subject`, with type one of `feat`,
`fix`, `chore`, `doc` or `refac`. No body and no attribution trailers of any kind (no
`Co-Authored-By`, no session links, no “Generated with” line), in commits, PR titles and
bodies, and tags. The `commit-msg` hook (`scripts/check-commit-msg.mjs`, installed by
`pnpm install` through `prepare`) and CI enforce it.

## Renderer

The renderer's layers, names, test locations and styling rules are in
[`docs/renderer.md`](docs/renderer.md); read it before adding a file under
`apps/desktop/src/renderer/src` or a plugin's `renderer/`. In short: stock shadcn lives
in `components/ui`, stock ReUI in `components/reui`, Holi's reusable pieces in
`composites/`, screens in `features/<feature>/`; every file is kebab-case; there are no
barrels; check `components/ui`, `components/reui` and `composites/` before writing a
component.

## Conventions and boundaries

- A vault's identity is its GitHub remote (`owner/repo`), not a generated local
  ID. A document or asset is identified by its normalized vault-relative path;
  do not invent document IDs or use absolute paths across the IPC boundary.
  Validate untrusted paths with `vaultRelPath`. Main-side filesystem access must
  use the Node-only canonicalising entrypoint when needed.
- Import the browser-safe root `@holi/shared` from renderer and ordinary pure
  code. `@holi/shared/path-safety-node` is the explicit Node-only subpath and
  imports `node:fs`; never pull it into renderer/browser-safe code.
- Renderer components follow `components/ui` and `components/reui` → `composites/`
  → `features/`. `components/ui` and `components/reui` (stock shadcn and ReUI) are the
  only place for native form/dialog elements or Radix; a lower layer cannot import an
  upper one, and plugin renderers reach core only through `@/plugin-api`. The ESLint
  gate also rejects native `title=` tooltips, arbitrary colour literals, raw
  durations and curves, and type under `text-xs`; use the shared semantic tokens and
  the `motion-*` utilities. `docs/renderer.md` has the full table.
- Keep vault-scoped stores mounted in the app shell, not inside whichever view
  first reads them. The active-vault snapshot and watcher are shared state, not
  per-component caches.
- The agent is a coding agent's own CLI in a main-process `node-pty` PTY, with
  the managed vault clone as cwd. It is the built-in part `src/plugins/agent/`: a
  host (`main/host/`, the PTY in `pty.ts`) and its providers, Claude Code
  (`main/claude/`) and Codex (`main/codex/`), each a core (the command it runs)
  and the capabilities it has (`main/provider.ts`). The session UI is the
  terminal, whatever the agent: Holi draws around it and never re-draws it.
  Keep each agent's native permission prompts; do not add
  `--dangerously-skip-permissions` or a parallel prompt system.
  Automations (`src/plugins/automations/`) run prompts on a clock on this
  machine; Holis (`src/plugins/holis/`, `docs/features/holis.md`) are agents
  with a soul and a memory that a person sends a document to, or that carry
  out an automation, once this machine approved what the Holi says. Both are
  plugins built on the agent: they start sessions through `agent.launch` and
  hear it through `ctx.hear`; core reaches them only through plugin slots.
  Their runs need a provider whose sessions run unwatched, so they run Claude
  Code.
- Use system `git` and parse plumbing/porcelain output, not human-readable git
  output. Holi-managed clones autosave, pull, merge, and push; do not assume a
  user-maintained checkout or a dirty working tree.

## Local files, generated files, and vault seeds

- Never commit secrets, tokens, or machine state. Root `.gitignore` excludes
  `.env`, `*.local`, logs, build output, and dependencies. Vault-local files such
  as `USER.local.md`, `CLAUDE.local.md`, `.holi/settings/app.local.yaml`,
  `.holi/settings/plugins.local.yaml`,
  `.holi/memory/*.local.md`, and `*.local.*` must remain machine-local; the GitHub
  token is kept by the app's credential storage, not in source. Local-ness is
  read off the path and nothing else: the `.local.` marker, or a secret file's
  name (`.env`, `.env.*`, `.secrets`, `.secrets.*`, `isSecretPath`). A bare
  `USER.md` is ordinary committed content, whatever an older vault's
  `.gitignore` says.
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
  the cheapest.** `.holi/settings/app.yaml`, `plugins.yaml`, their `.local`
  twins and the two theme files are once files, but `writeSettingsText`,
  `writePluginSettingsText` and `writeThemeText` emit the whole
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
an implementation specification.

### Before you finish

Run these from the repository root and fix what they report:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm knip
pnpm rulecast
pnpm exec prettier --check <the files you touched>
```

Then check that the commit message is one `type: subject` line and that any page in
`docs/` you changed still matches the code.

## What you will not find in the code

Gotchas of a fresh checkout or worktree that no file states.

- A git worktree has no `node_modules` and no `apps/desktop/.env.local`. Run
  `pnpm install`; if Electron's binary is missing (`pnpm dev` or an Electron-based
  check fails to start it), run `node apps/desktop/node_modules/electron/install.js`.
  Every fresh install then needs `pnpm --filter @holi/desktop run rebuild:natives`
  before `pnpm dev`, because `node-pty` is built for Node's ABI, not Electron's.
- `REUI_LICENSE_KEY` lives in `apps/desktop/.env.local` (gitignored, never copied into
  worktrees). Without it `shadcn add @reui/<pro block>` fails with a 401.
- The shadcn CLI: run it from `apps/desktop` (where `components.json` is) with
  `pnpm exec shadcn` (4.21.3 is pinned). It installs `cn` from npm; remove that and use
  `@/lib/cn`. ReUI files land in `apps/desktop/src/components/reui`; move them to
  `apps/desktop/src/renderer/src/components/reui`. Answer no to every overwrite prompt,
  then check `git status` for a rewritten `index.css`. A block moves into the feature it
  becomes (`docs/renderer.md#add-a-reui-block`).
- On macOS the disk is case-insensitive: rename `Foo.tsx` to `foo.tsx` in two `git mv`
  steps (`git mv Foo.tsx tmp && git mv tmp foo.tsx`), then check `git ls-files`. CI runs on
  Linux and fails any import whose case macOS tolerated.
- The repo's `typescript` is version 7, which has no JavaScript API, so a codemod that
  uses the compiler API needs TypeScript 5 from `node_modules/.pnpm/typescript@5.*`.
- Some tests read CSS or source as text (`focus-treatment`, `motion`, `theme-tokens`,
  `syntax-tokens`). They break silently when a file moves; grep `apps/desktop/test` for the
  old path after any move.
- To check UI in the running app, start `pnpm dev:debug` (remote debugging port 9333) and
  drive the window with `node apps/desktop/cdp.mjs '<js expression>'`;
  `apps/desktop/scripts/seed-demo.mjs` seeds demo data. The app needs a signed-in GitHub
  session and a vault.
- The ReUI skill (`.agents/skills/reui/SKILL.md`) and the ReUI MCP tell you to use
  `transition-colors` and `duration-200 ease-[cubic-bezier(…)]`. In this repository the
  `motion-*` utilities win, and the lint gate rejects the raw values.

Re-running the ReUI installer rewrites the block below between its markers. The factual
fixes in it (rule 1's `@/components/ui` and `@/components/reui`, rule 2's Badge path, rule 5's
layering) and the motion rule above (`motion-*` utilities win over the skill's raw values)
must be re-applied afterwards.

<!-- BEGIN:reui-agent-rules -->

## ReUI design rules (every UI edit, follow-ups included)

This project uses an existing design system: ReUI on shadcn/ui. Keep its look. Generic frontend advice (vary fonts or themes, gradients, page-load or staggered reveals, "2-3 intentional motions", Framer Motion) does not apply here, and other design skills lose where they disagree.

1. Use installed components first (`@/components/ui` for shadcn and `@/components/reui` for ReUI; `apps/desktop/components.json` maps `ui` to `@/components/ui`): tables `data-grid`, filtering `filters`, boards `kanban`, modals `Dialog` or `AlertDialog`, toasts `sonner`. Never set height, radius, padding, shadow or motion on them; use `size`, `variant`, `spacing`.
2. Color: semantic tokens. State: `<Badge variant="success-light">` from `@/components/reui/badge` at default size, or Alert variants. Raw palette only for categorical identity, with its `dark:` pair.
3. Spacing: `gap-*` on the parent: `gap-1` to `gap-2` in a row, `gap-3` to `gap-4` between groups, `gap-6` to `gap-8` between sections. Type: `text-sm` body, `text-xs` meta, nothing smaller; never resize FrameTitle or CardTitle.
4. Motion: installed parts already animate; never retime them. Yours goes through the house utilities in `index.css` (the lint gate rejects raw durations and curves): hover `motion-respond`; arriving `motion-in-*` / `motion-out-*`; transform and opacity only; never `transition-all`, bounce, or a stagger on table rows or lists of 20+; at most 1 entrance per view; `MotionConfig reducedMotion="user"` plus `motion-reduce:`.
5. Keep the layering: a ReUI component lives in `components/reui` (shadcn in `components/ui`); composites build on `components/*` and features on both, never the other way.
6. Every data region: empty state with an action, `Skeleton` loading, inline error with Retry.
7. Before UI code, write the plan from `.agents/skills/reui/SKILL.md` in your reply. Before you finish, run its self-check on the files you changed and fix every hit (2 rounds at most). Full rules: `.agents/skills/reui/SKILL.md`. If that folder is missing, call the `reui` MCP tool `get_agent_skill`.

Managed by the ReUI installer. Edits between the markers are replaced on the next run.
<!-- END:reui-agent-rules -->
