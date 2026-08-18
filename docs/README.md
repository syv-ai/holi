# Docs index

The living documentation for Holi. The PRDs, architecture, and vision are the **continuously updated truth** — each states its requirements *and* the reasoning (why, and what was rejected) natively. Read top-to-bottom for the full picture.

## Foundation
| Doc | What it is |
|---|---|
| [vision.md](vision.md) | What Holi is, product principles, the shape of v1 |
| [architecture.md](architecture.md) | The whole system: the vault as a git repo, sync, the agent, security |
| [decisions.md](decisions.md) | **Decision inbox** — new load-bearing decisions land here first, then get consolidated natively into the docs above and the inbox is purged (cycle repeats) |
| [glossary.md](glossary.md) | Canonical terms (vault, task, push, reconcile, autosave commit…) |

## PRDs (v1 pillars)
| PRD | Owns |
|---|---|
| [prd/vaults-sync.md](prd/vaults-sync.md) | Vaults as clones, autosave commits, auto-pull, auto-push, conflicts + reconcile, history |
| [prd/auth-identity.md](prd/auth-identity.md) | GitHub device-flow sign-in, the token, collaborators as membership, the access model |
| [prd/notes-editor.md](prd/notes-editor.md) | CodeMirror live-preview editor, file persistence, external writes, wiki-links, rename, tree, tabs |
| [prd/tasks.md](prd/tasks.md) | `task.*.md` files, the board, swim lanes by folder, recurrence + local reminders |
| [prd/agent.md](prd/agent.md) | Interactive Claude xterm drawer, CC-native config layering, per-turn hook, zero ops, merge reconcile |
| [prd/daily-notes.md](prd/daily-notes.md) | Idempotent daily notes, personal-vault-only, archiving |
| [prd/onboarding.md](prd/onboarding.md) | First-run three-act ritual, create-or-join a vault, the add-vault mode that retired `AddVault` |
| [prd/google-mail-calendar.md](prd/google-mail-calendar.md) | @syv.ai Gmail + Calendar: triage, the sandboxed reader, the composer, meetings |
| [prd/pdf-export.md](prd/pdf-export.md) | Markdown → branded syv.ai PDFs via Typst, as a vault skill |

## PRDs (post-v1, designed)
| PRD | Owns |
|---|---|
| [prd/vault-apps.md](prd/vault-apps.md) | Agent-authored in-vault apps: app tabs, `holi.*` bridge. **State model needs redesign** — see its status note |

## PRDs (phase 2 stubs)
| Stub | |
|---|---|
| [prd/_phase2-pdf-docx-preview.md](prd/_phase2-pdf-docx-preview.md) | Import conversion (PDF/docx → markdown) + viewing archived originals. **Superseded by D62** — kept for one open question (where large originals live) |

*Google mail/calendar and Typst export used to sit here. Both are built and live, and both are now PRDs above — a built pillar filed as a phase-2 stub is a doc that lies about what the product does.*

## Dated records (history, not living docs)

**Nothing in here is authoritative.** Each file is a snapshot of what was believed on its date, kept because the reasoning behind a decision is sometimes worth more than the decision. When one of these disagrees with a living doc above, the living doc wins — always, and without needing to be reconciled.

| Dir | What it is |
|---|---|
| [notes/](notes/) | Findings worth keeping that own no PRD (e.g. what Dash's PTY handling taught the agent drawer) |
| [specs/](specs/) | Design docs — the shape of a feature as agreed, before it was built. The reasoning that did not fit in a PRD |
| [plans/](plans/) | Implementation plans, written lean and executed. Kept, not deleted — see Conventions |
| [verification/](verification/) | What was actually checked by hand, and what was left unverified |

## Conventions
- The PRDs are updated **in place** as decisions change — no changelog framing, no amendment trails. Git history is the archaeology.
- New decisions get drafted in [decisions.md](decisions.md), agreed with Nicolai, then folded natively into the owning PRD and purged from the inbox.
- **Implementation plans are kept, and they are not the truth.** The old rule said they were deleted after execution, on the consolidate-then-purge cycle `decisions.md` runs. That rule died the way the never-commit-docs rule died — quietly, by not being followed: there are dozens of plans on disk, and pretending otherwise made the index describe a repo that does not exist. What survives from it is the part that mattered: **a plan holding something the living docs do not is a docs bug.** The fix is to fold it up into the PRD, not to delete the plan.
- **`decisions.md` still purges**, and that difference is deliberate: a decision is a *claim about how things are*, so two copies can contradict each other. A plan is a record of *what was done on a date*, which cannot go stale — only be superseded.
- A term is ambiguous? [glossary.md](glossary.md) wins.
- **There is no server**, and no doc should imply otherwise. If you find one that does, it is stale.
