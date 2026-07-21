# Docs index

The living documentation for Holi. The PRDs, architecture, and vision are the **continuously updated truth** — each states its requirements *and* the reasoning (why, and what was rejected) natively. Read top-to-bottom for the full picture.

## Foundation
| Doc | What it is |
|---|---|
| [vision.md](vision.md) | What Holi is, product principles, the shape of v1 |
| [architecture.md](architecture.md) | The whole system: the vault as a git repo, sync, the agent, security |
| [decisions.md](decisions.md) | **Decision inbox** — new load-bearing decisions land here first, then get consolidated natively into the docs above and the inbox is purged (cycle repeats) |
| [glossary.md](glossary.md) | Canonical terms (vault, task, publish, reconcile, autosave commit…) |

## PRDs (v1 pillars)
| PRD | Owns |
|---|---|
| [prd/vaults-sync.md](prd/vaults-sync.md) | Vaults as clones, autosave commits, auto-pull, publish, conflicts + reconcile, history |
| [prd/auth-identity.md](prd/auth-identity.md) | GitHub device-flow sign-in, the token, collaborators as membership, the access model |
| [prd/notes-editor.md](prd/notes-editor.md) | CodeMirror live-preview editor, file persistence, external writes, wiki-links, rename, tree, tabs |
| [prd/tasks.md](prd/tasks.md) | `task.*.md` files, the board, swim lanes by folder, recurrence + local reminders |
| [prd/agent.md](prd/agent.md) | Interactive Claude xterm drawer, CC-native config layering, per-turn hook, zero ops, merge reconcile |
| [prd/daily-notes.md](prd/daily-notes.md) | Idempotent daily notes, personal-vault-only, archiving |

## PRDs (post-v1, designed)
| PRD | Owns |
|---|---|
| [prd/vault-apps.md](prd/vault-apps.md) | Agent-authored in-vault apps: app tabs, `holi.*` bridge. **State model needs redesign** — see its status note |

## PRDs (phase 2 stubs)
| Stub | |
|---|---|
| [prd/_phase2-pdf-docx-preview.md](prd/_phase2-pdf-docx-preview.md) | Import conversion (PDF/docx → markdown) + viewing archived originals |
| [prd/_phase2-google-mail-calendar.md](prd/_phase2-google-mail-calendar.md) | @syv.ai Gmail + Calendar on Google APIs (and the shared Google connector Drive needs) |
| [prd/_phase2-typst-export.md](prd/_phase2-typst-export.md) | Render docs into branded syv.ai Typst templates |

## Dated records (history, not living docs)
| Dir | What it is |
|---|---|
| [notes/](notes/) | Findings worth keeping that own no PRD (e.g. what Dash's PTY handling taught the agent drawer) |

## Conventions
- The PRDs are updated **in place** as decisions change — no changelog framing, no amendment trails. Git history is the archaeology.
- New decisions get drafted in [decisions.md](decisions.md), agreed with Nicolai, then folded natively into the owning PRD and purged from the inbox.
- **Implementation plans are not kept.** They are written lean, executed, and deleted once their reasoning is in the living docs — the same consolidate-then-purge cycle decisions.md runs. A plan that still holds something the living docs do not is a docs bug, not a reason to keep the plan.
- A term is ambiguous? [glossary.md](glossary.md) wins.
- **There is no server**, and no doc should imply otherwise. If you find one that does, it is stale.
