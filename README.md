# Holi

Syv.ai's local-first document and task system with coding agents living in the vault.

A vault is a GitHub repository of markdown, cloned locally. Holi is an Electron app
over that clone: a rich-text note editor (Tiptap, with CodeMirror for code files), a
task board built from `task.*.md` files, Gmail and Calendar, PDF export, and agent
sessions running in terminal tabs. Built-in agent presets support Claude Code,
Codex, and Pi; custom CLI harnesses can be added too. Sync is git, committed,
pulled and pushed automatically. There is no Holi server or database.

## Where to start

1. [`docs/README.md`](docs/README.md): the documentation index.
2. [`docs/vision.md`](docs/vision.md): what Holi is and why.
3. [`docs/architecture.md`](docs/architecture.md): how the system fits together.
4. [`docs/features/`](docs/features): one page per feature.
5. [`docs/glossary.md`](docs/glossary.md): canonical terms.
6. [`AGENTS.md`](AGENTS.md): conventions and checks for anyone (or any agent) changing the code.
7. [`docs/renderer.md`](docs/renderer.md): renderer layers, names and enforced rules.

## Repo layout

```text
apps/desktop/     Electron + React desktop app
apps/mobile/      NativeScript + Vue iOS scaffold and vault-storage checks
packages/shared/  Browser-safe domain rules: paths, task files, wiki-links,
                  dates, recurrence, themes, text merge
site/             Landing page and app handoff links
skills/holi/      Installable Holi CLI skill for external agents
scripts/          Repository tooling and agent-compatibility checks
docs/             Living documentation
patches/          pnpm patches for dependencies
.agents/skills/   Skills for agents working on the repo (ReUI design rules, the rules registry)
.github/          CI: typecheck, lint, knip, rulecast, tests, commit messages, releases
```

## Agent skill

Install the [`holi` skill](skills/holi/SKILL.md) for external agents:

```sh
npx skills add syv-ai/holi
```

Add `-g` to install globally instead of in the current project. The skill
explains Holi's CLI; it does not install the app. Run the CLI from an open vault.

## Development

Requires Node `>=20.19`, pnpm and the system `git`. On macOS and Linux, desktop
builds also require a C compiler (`cc`, or set `CC`); macOS's Xcode Command Line
Tools provide it. To use an agent, install its CLI and authenticate with its
provider. Claude Code is not required when using another agent.

```sh
pnpm install
# macOS/Linux: rebuild node-pty for Electron before the first launch
pnpm --filter @holi/desktop run rebuild:natives
pnpm dev          # run the desktop app
```

Repeat the native rebuild for each fresh clone or git worktree. On Windows, skip
`rebuild:natives`: `node-pty` ships an Electron-compatible prebuilt binary.
`pnpm dev:debug` also exposes the renderer debugging port at `9333`.

Run checks and build from the repository root:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm knip
pnpm rulecast
pnpm --filter @holi/desktop build
```

The iOS scaffold requires macOS, Xcode and an iOS Simulator. Build it with
`pnpm --filter @holi/mobile build:ios`; run its simulator checks with
`pnpm --filter @holi/mobile test:ios`.

Installing ReUI Pro blocks requires `REUI_LICENSE_KEY` in
`apps/desktop/.env.local`, which is gitignored and not copied into worktrees.
It is not needed for ordinary development. `AGENTS.md` lists the other gotchas.
