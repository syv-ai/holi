# better-holi-final

The rebuild of **Holi** — Syv.ai's document-management system and vault assistant.

A vault is a **GitHub repository** of markdown, cloned locally. Holi is an Electron app over that clone: a CodeMirror live-preview editor, a task board built from `task.*.md` files, and an in-app **Claude Code vault assistant** running in an interactive terminal drawer. Sync is git — pulled automatically, published when you say so. There is no server.

## Where to start

1. [`docs/vision.md`](docs/vision.md) — what Holi is, product principles, the shape of v1.
2. [`docs/architecture.md`](docs/architecture.md) — the whole system: the vault as a repo, sync, the agent, security.
3. [`docs/decisions.md`](docs/decisions.md) — the decision inbox. D60 is the pivot that produced the current shape; read it if a choice elsewhere looks arbitrary.
4. [`docs/glossary.md`](docs/glossary.md) — canonical terms. When a word is ambiguous ("vault", "publish", "reconcile"), this wins.
5. [`docs/prd/`](docs/prd) — one PRD per product pillar, plus phase-2 stubs.

## Repo layout

```
better-holi-final/
  apps/
    desktop/     Electron + React client — the whole product
  packages/
    shared/      Domain rules: task file grammar, wiki-links, path-safety,
                 recurrence/reminder math
  docs/          The living documentation
  pnpm-workspace.yaml
```

## Status

**Mid-pivot, and deliberately not running.** The docs describe the local, git-backed architecture (D60); the code has had the server and CRDT stack removed and is being rebuilt against it. `apps/desktop` does not compile until main's router is reimplemented file-backed.

## Dev

```sh
pnpm install
pnpm dev        # desktop app
pnpm test
pnpm typecheck
```

No database, no Docker.
