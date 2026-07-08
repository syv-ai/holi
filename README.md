# better-holi-final

The rebuild of **Holi** — Syv.ai's collaborative document-management system and vault assistant.

Holi is moving from a single-user **Tauri 2 (Rust + React)** desktop app to a **full-TypeScript, multiplayer** product: an Electron client, a self-hosted Syv server, and a shared domain package. Each employee gets a **personal vault**; teams get **shared vaults** with real-time (Google-Docs-style) collaboration, presence, and an in-app **Claude Code vault assistant** running in an interactive terminal drawer.

## Where to start

This repo currently holds the **planning docs** for the rebuild. Read in this order:

1. [`docs/vision.md`](docs/vision.md) — why we're rebuilding, what Holi is, product principles.
2. [`docs/architecture.md`](docs/architecture.md) — the whole system: CRDT sync, client/server split, the agent, data model, security.
3. [`docs/decisions.md`](docs/decisions.md) — the design decisions (with rationale) that fixed the architecture. Read this if a choice in the other docs looks arbitrary — the "why" is here.
4. [`docs/glossary.md`](docs/glossary.md) — canonical terms. When a word is ambiguous ("vault", "area", "thread"), this is the source of truth.
5. [`docs/prd/`](docs/prd) — one PRD per product pillar, plus phase-2 stubs.

## Planned repo layout (once we scaffold the build)

```
better-holi-final/
  apps/
    desktop/     Electron + React client (the app)
    server/      Node/TS: Hocuspocus (Yjs) + tRPC API + Postgres
  packages/
    shared/      Domain types, task model, wiki-link grammar,
                 path-safety — imported by BOTH client and server
  docs/          These planning docs
  pnpm-workspace.yaml
```

## Status

Planning. No application code yet. The docs define v1 and the phased roadmap.
