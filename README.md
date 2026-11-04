# Holi

Syv.ai's document and task system with a Claude Code assistant living in the vault.

A vault is a GitHub repository of markdown, cloned locally. Holi is an Electron app over that clone:
a rich-text note editor (Tiptap, with CodeMirror for code files), a task board built from `task.*.md` files, Gmail and Calendar, PDF
export, and Claude Code sessions running in terminal tabs. Sync is git, committed, pulled and pushed
automatically. There is no server.

## Where to start

1. [`docs/vision.md`](docs/vision.md): what Holi is and why.
2. [`docs/architecture.md`](docs/architecture.md): how the system fits together.
3. [`docs/features/`](docs/features): one page per feature.
4. [`docs/glossary.md`](docs/glossary.md): canonical terms.
5. [`AGENTS.md`](AGENTS.md): conventions and checks for anyone (or any agent) changing the code.
6. [`docs/renderer.md`](docs/renderer.md): where renderer code goes, what it is called, which rules enforce it.

## Repo layout

```
apps/desktop/     Electron + React app: the whole product
packages/shared/  Browser-safe domain rules: paths, task files, wiki-links,
                  dates, recurrence, themes, text merge
skills/holi/      Installable Holi CLI skill for external agents
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

## Dev

```sh
pnpm install
pnpm dev          # run the desktop app
pnpm test
pnpm typecheck
pnpm lint
pnpm knip
pnpm rulecast
pnpm --filter @holi/desktop build
```

A fresh clone or git worktree needs `pnpm install`, then
`pnpm --filter @holi/desktop run rebuild:natives` once (`node-pty` is built for Electron's ABI)
before `pnpm dev`. ReUI Pro blocks need `REUI_LICENSE_KEY` in `apps/desktop/.env.local`, which is
gitignored and not copied into worktrees. `AGENTS.md` lists the other gotchas.

Requires Node `>=20.19`, pnpm, the system `git`, and Claude Code installed and signed in. No
database, no Docker.
