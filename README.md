# Holi

Syv.ai's document and task system with a Claude Code assistant living in the vault.

A vault is a GitHub repository of markdown, cloned locally. Holi is an Electron app over that clone:
a CodeMirror live-preview editor, a task board built from `task.*.md` files, Gmail and Calendar, PDF
export, and Claude Code sessions running in terminal tabs. Sync is git, committed, pulled and pushed
automatically. There is no server.

## Where to start

1. [`docs/vision.md`](docs/vision.md): what Holi is and why.
2. [`docs/architecture.md`](docs/architecture.md): how the system fits together.
3. [`docs/features/`](docs/features): one page per feature.
4. [`docs/glossary.md`](docs/glossary.md): canonical terms.
5. [`AGENTS.md`](AGENTS.md): conventions and checks for anyone (or any agent) changing the code.

## Repo layout

```
apps/desktop/     Electron + React app: the whole product
packages/shared/  Browser-safe domain rules: paths, task files, wiki-links,
                  dates, recurrence, themes, text merge
docs/             Living documentation
```

## Dev

```sh
pnpm install
pnpm dev          # run the desktop app
pnpm test
pnpm typecheck
pnpm lint
pnpm --filter @holi/desktop build
```

Requires Node `>=20.19`, pnpm, the system `git`, and Claude Code installed and signed in. No
database, no Docker.
