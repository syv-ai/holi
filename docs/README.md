# Docs index

The living documentation for Holi. The PRDs, architecture, and vision are the **continuously updated truth** — each states its requirements *and* the reasoning (why, and what was rejected) natively. Read top-to-bottom for the full picture.

**The PRDs describe the product that exists.** Work that is designed and *not* built lives in [not-built.md](not-built.md), and the split is load-bearing: a PRD section specifying a future is indistinguishable from one describing the present, and both were being believed. What stays in a PRD regardless of the split: **non-goals** (a boundary is part of the product's shape), **rejected alternatives** (the reason nobody should re-propose a thing, which is only useful beside the design that won), and **admitted uncertainty about behaviour that ships** ("the debounce is 3 seconds, tuned rather than derived").

## Foundation
| Doc | What it is |
|---|---|
| [vision.md](vision.md) | What Holi is, product principles, the shape of v1 |
| [architecture.md](architecture.md) | The whole system: the vault as a git repo, sync, the agent, security |
| [not-built.md](not-built.md) | **What is designed and not built** — one entry per gap, each pointing back at the pillar that owns its reasoning. Names what is being built next; below that, no ordering, no sizing, no dates. **Purges an entry when it ships** |
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
| [prd/vault-apps.md](prd/vault-apps.md) | Agent-authored in-vault apps: the per-app `holi-app://` origin, app tabs, the `holi.*` bridge, the authoring skill. Slice 1 only — app **state** is still undecided, see [not-built.md](not-built.md) |

## Designed, not built
Not PRDs, because they describe nothing that exists — *yet*. [not-built.md](not-built.md) owns their status, and a doc graduates into the table above when it ships.

**The table is empty.** `prd/vault-apps.md` was its last entry and graduated on 2026-08-20 when slice 1 shipped; what remains unbuilt of that feature is a gap inside a built pillar, which is [not-built.md](not-built.md)'s job rather than a second table's.

*Google mail/calendar and Typst export used to sit in a "phase 2 stubs" table here. Both are built and live and are PRDs above — a built pillar filed as a stub is a doc that lies about what the product does. The one remaining stub, PDF/docx import conversion, was **deleted**: D62 killed its premise (the vault emits rich documents rather than importing them), and what survived it — where large binaries live at scale, and viewing a binary Holi cannot render — is in [not-built.md](not-built.md).*

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
- **A PRD section must not describe itself.** "Status: designed, not built" inside a specification is the failure this doc system has hit most often, in both directions — a section claiming to be unbuilt three weeks after it shipped, a built pillar filed as a stub, a PRD promising "a skill, not a UI" after the UI shipped. The rule that follows: **check the code, never the claim**, and when something is not built, say so in [not-built.md](not-built.md) and leave the PRD to describe what is.
- New decisions get drafted in [decisions.md](decisions.md), agreed with Nicolai, then folded natively into the owning PRD and purged from the inbox.
- **Implementation plans are kept, and they are not the truth.** The old rule said they were deleted after execution, on the consolidate-then-purge cycle `decisions.md` runs. That rule died the way the never-commit-docs rule died — quietly, by not being followed: there are dozens of plans on disk, and pretending otherwise made the index describe a repo that does not exist. What survives from it is the part that mattered: **a plan holding something the living docs do not is a docs bug.** The fix is to fold it up into the PRD, not to delete the plan.
- **`decisions.md` still purges**, and that difference is deliberate: a decision is a *claim about how things are*, so two copies can contradict each other. A plan is a record of *what was done on a date*, which cannot go stale — only be superseded.
- **A PRD may carry verification status, and it must be dated.** "Proven in real use as of *date*", "still unproven — treat as broken". It is the one kind of claim in a PRD that is about a *moment* rather than a design, so the date is part of the claim. Status kept away from the thing it qualifies is how *"nothing in this repo has ever talked to Google"* survived into four documents after it stopped being true. [verification/](verification/) is history, not where this lives.
- **A gap purges when it ships.** [not-built.md](not-built.md) runs the same consolidate-then-purge cycle [decisions.md](decisions.md) does, and for the reason given below: "X does not exist" is a claim about how things are, so two copies of it can contradict. When the thing is built, its reasoning — including any sub-question the entry carried — folds into the owning PRD as a description of what now exists, and the entry is deleted.
- **A boundary with a trigger stays in the PRD, and only there.** "No OS network listener; add one only if the retry latency proves annoying" is product shape plus the observation that would change it — not a gap. Filing it in [not-built.md](not-built.md) as well would be the second copy the rule above forbids.
- A term is ambiguous? [glossary.md](glossary.md) wins.
- **There is no server**, and no doc should imply otherwise. If you find one that does, it is stale.
