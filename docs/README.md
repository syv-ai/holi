# Docs index

Planning docs for the Holi rebuild. Read top-to-bottom for the full picture.

## Foundation
| Doc | What it is |
|---|---|
| [vision.md](vision.md) | Why we're rebuilding, what Holi is, product principles |
| [architecture.md](architecture.md) | The whole system: CRDT sync, client/server split, agent, data model, security |
| [decisions.md](decisions.md) | Every load-bearing decision (D1–D31) with rationale + rejected alternatives |
| [glossary.md](glossary.md) | Canonical terms (vault, area, doc, persona, tier…) |

## PRDs (v1 pillars)
| PRD | Owns |
|---|---|
| [prd/vaults-collaboration.md](prd/vaults-collaboration.md) | Vaults, real-time collab, presence, offline, sync, history/backup |
| [prd/auth-identity.md](prd/auth-identity.md) | Google SSO, membership/roles, authorization, per-user UI prefs (D6) |
| [prd/notes-editor.md](prd/notes-editor.md) | CodeMirror + Yjs editor, simple live-preview (no morph, D22), wiki-links, rename |
| [prd/tasks.md](prd/tasks.md) | Structured task records, stripped board, swim lanes, recurrence/reminders |
| [prd/agent.md](prd/agent.md) | Interactive Claude xterm drawer, CC-native config layering (D6), per-turn hook, minimal MCP, history via native `--resume` (D9) |
| [prd/server-data.md](prd/server-data.md) | **The server hub** — Hocuspocus + tRPC + Postgres schema + API surface |
| [prd/daily-notes.md](prd/daily-notes.md) | Idempotent daily notes, personal-vault-only (D24), archiving |

## PRDs (post-v1, designed)
| PRD | Owns |
|---|---|
| [prd/vault-apps.md](prd/vault-apps.md) | Agent-authored in-vault apps: app tabs, `holi.*` bridge, Yjs-multiplayer app state (D31) |

## PRDs (phase 2 stubs)
| Stub | |
|---|---|
| [prd/_phase2-pdf-docx-preview.md](prd/_phase2-pdf-docx-preview.md) | Import conversion (PDF/docx → markdown on entry) + viewing archived originals (D28) |
| [prd/_phase2-google-mail-calendar.md](prd/_phase2-google-mail-calendar.md) | @syv.ai Gmail + Calendar on Google APIs (Mailspring is dead) |
| [prd/_phase2-typst-export.md](prd/_phase2-typst-export.md) | Render docs into branded syv.ai Typst templates |

## Reading tips
- A choice looks arbitrary? Its **D#** is in [decisions.md](decisions.md).
- A term is ambiguous? [glossary.md](glossary.md) wins.
- [server-data.md](prd/server-data.md) is the schema/API reference the other PRDs point to.
