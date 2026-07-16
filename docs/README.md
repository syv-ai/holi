# Docs index

The living documentation for the Holi rebuild. The PRDs, architecture, and vision are the **continuously updated truth** — each states its requirements *and* the reasoning (why, and what was rejected) natively. Read top-to-bottom for the full picture.

## Foundation
| Doc | What it is |
|---|---|
| [vision.md](vision.md) | Why we're rebuilding, what Holi is, product principles |
| [architecture.md](architecture.md) | The whole system: CRDT sync, client/server split, agent, data model, security |
| [decisions.md](decisions.md) | **Decision inbox** — new load-bearing decisions land here first, then get consolidated natively into the docs above and the inbox is purged (cycle repeats) |
| [glossary.md](glossary.md) | Canonical terms (vault, area, doc, persona, git mirror…) |

## PRDs (v1 pillars)
| PRD | Owns |
|---|---|
| [prd/vaults-collaboration.md](prd/vaults-collaboration.md) | Vaults, real-time collab, presence, offline, sync, history/backup, the git mirror |
| [prd/auth-identity.md](prd/auth-identity.md) | Google SSO, membership/roles, authorization, GitHub account linking, per-user UI prefs |
| [prd/notes-editor.md](prd/notes-editor.md) | CodeMirror + Yjs editor, simple live-preview, wiki-links, rename |
| [prd/tasks.md](prd/tasks.md) | Structured task records, stripped board, swim lanes, recurrence/reminders |
| [prd/agent.md](prd/agent.md) | Interactive Claude xterm drawer, CC-native config layering, per-turn hook, minimal MCP, history via native `--resume` |
| [prd/server-data.md](prd/server-data.md) | **The server hub** — Hocuspocus + tRPC + Postgres schema + API surface |
| [prd/daily-notes.md](prd/daily-notes.md) | Idempotent daily notes, personal-vault-only, archiving |

## PRDs (post-v1, designed)
| PRD | Owns |
|---|---|
| [prd/vault-apps.md](prd/vault-apps.md) | Agent-authored in-vault apps: app tabs, `holi.*` bridge, Yjs-multiplayer app state |

## PRDs (phase 2 stubs)
| Stub | |
|---|---|
| [prd/_phase2-pdf-docx-preview.md](prd/_phase2-pdf-docx-preview.md) | Import conversion (PDF/docx → markdown on entry) + viewing archived originals |
| [prd/_phase2-google-mail-calendar.md](prd/_phase2-google-mail-calendar.md) | @syv.ai Gmail + Calendar on Google APIs |
| [prd/_phase2-typst-export.md](prd/_phase2-typst-export.md) | Render docs into branded syv.ai Typst templates |

## Dated records (history, not living docs)
| Dir | What it is |
|---|---|
| [specs/](specs/) | Point-in-time design documents from brainstorming sessions (e.g. the vault git mirror design) |
| [notes/](notes/) | Findings worth keeping that own no PRD (e.g. what Dash's PTY handling taught the agent drawer) |
| [spikes/](spikes/) | Spike findings (e.g. the bridge turn protocol — **verdict: holds**) |

## Conventions
- The PRDs are updated **in place** as decisions change — no changelog framing, no amendment trails. Git history is the archaeology.
- New decisions get drafted in [decisions.md](decisions.md), agreed with Nicolai, then folded natively into the owning PRD and purged from the inbox.
- **Implementation plans are not kept.** They are written lean, executed, and deleted once their reasoning is in the living docs — the same consolidate-then-purge cycle decisions.md runs. Git history is the archaeology (the whole set as of 2026-07-16 is in `f136352`, purged in `7ef4270`). A plan that still holds something the living docs do not is a docs bug, not a reason to keep the plan.
- A term is ambiguous? [glossary.md](glossary.md) wins.
- [server-data.md](prd/server-data.md) is the schema/API reference the other PRDs point to.
