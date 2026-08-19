# Decision inbox

New load-bearing decisions land here first, as lightweight ADRs (context, decision, why, rejected alternatives). Once agreed with Nicolai, each entry is **consolidated natively into the owning living doc** — the relevant PRD, `architecture.md`, or `vision.md` — and purged from this file. The cycle then repeats.

The living docs are the truth; this file is only the staging area.

**The inbox is empty** (2026-08-18). Every decision through D73 has been consolidated into the doc that owns it, and the ledger below records where each one's prose went. An empty inbox is the resting state, not an unusual one — if this file has entries in it, there is consolidation owed.

## Number allocation — **next free is D74**

Living docs carry decisions as **prose, never as numbers**. D-numbers exist for two purposes only: **code comments** and **git history**. So this ledger is the one place that records which numbers are spent. Check it before allocating.

**Spent and purged from this file, with where each one's prose now lives** — a number vanishing from the inbox means it was consolidated, not withdrawn:

| | Consolidated into |
|---|---|
| D60 — the vault is a GitHub repo; there is no server | `vision.md`, `architecture.md`, `glossary.md` and every PRD (2026-07-21). Held open afterwards only to track code that had not caught up; the last gap, the reconcile → agent-drawer handoff, is now recorded in [`prd/agent.md`](prd/agent.md) §The agent as merge resolver where it belongs |
| D61 | spent amending D60 pt 2 (auto-push) — see D60 |
| D62 — text-first by authorship; binaries are assets | `vision.md` §Key design choices, [`prd/notes-editor.md`](prd/notes-editor.md) §Images and other binaries, [`prd/pdf-export.md`](prd/pdf-export.md), and [`not-built.md`](not-built.md) (the surviving blob-storage question, and the import-conversion stub D62 superseded — that stub is deleted, and its reasoning is in this row plus git history) |
| D63 — a task lane move is a note-style rename | [`prd/tasks.md`](prd/tasks.md) §Board UX |
| D64 — a vault's theme is a whitelisted token map | [`architecture.md`](architecture.md) §9, §10 |
| D65 — local-ness is legible from the name | [`architecture.md`](architecture.md) §3 + config layering, [`glossary.md`](glossary.md), [`prd/agent.md`](prd/agent.md), [`prd/auth-identity.md`](prd/auth-identity.md) |
| D66 — document-templates lives under a name that says what it is for | [`prd/agent.md`](prd/agent.md) |
| D67 — one main-held Google connector; the agent reaches it via a CLI, not MCP | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §The engine, §Calendar, §How a message is rendered, §Rejected; [`prd/agent.md`](prd/agent.md) §Tool surface; [`prd/auth-identity.md`](prd/auth-identity.md); [`prd/tasks.md`](prd/tasks.md) |
| D68 — mail is read-write within a bounded set | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §Goals — as built, §The engine; [`prd/auth-identity.md`](prd/auth-identity.md) (the scope-widening trap) |
| D69 — a cached list is defined by every filter that narrows it | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §The engine, §How a message is rendered |
| D70 — the agent may do anything the user can undo | [`prd/agent.md`](prd/agent.md) §Tool surface, §Permissions; [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) |
| D71 — the mail composer: markdown is the source | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §Composing |
| D72 — a vault agent inherits the vault, not the machine | [`prd/agent.md`](prd/agent.md) §Config layering, §Runtime, §Auth, §Permissions |
| D73 — a mail thread and a calendar event are joined by the invite's UID | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §Goals — as built, §How a message is rendered |

**D1–D59 are spent, and D60 supersedes all of them.** They are not listed here any more, and that is deliberate: their subjects — the CRDT doc store, the file↔CRDT bridge, the task record and its file projection, the SSE event stream, server-side membership, snapshot history, the git mirror — do not exist. A ledger of decisions about a deleted system is archaeology pretending to be law, and the docs are law.

The reasoning is not lost. Every one of them was written up in full in this file and is recoverable from git history (`git log -p docs/decisions.md`); the ones whose *lessons* outlive their mechanism were carried into the rewritten docs as prose, unattributed to a number:

- **The task file is the whole task** — the projection's parser, serializer, and file grammar survive in `prd/tasks.md`, minus the record they reconciled against.
- **A store loaded by whoever renders it fails silently** (was D58) — `architecture.md` §9. The second consumer cannot tell an unloaded store from an empty one.
- **Machine tokens do not belong in a file a human edits** (was D33) — the same argument now keeps the reminder watermark out of the repo, because a write that fires on a timer becomes a commit.
- **Select by an explicit marker, never by filename shape** (was D46) — `prd/daily-notes.md`, and the reason `task.` is a filename prefix rather than a frontmatter key.
- **The client passes its local date; nothing else computes "today"** (was D44) — `prd/daily-notes.md`.
- **A rename must reject a colliding destination before moving anything** — `prd/notes-editor.md` FR-11.

**D59 was spent** on the offline main-as-sync-hub work (commits `f1584f6`…`9bc7eef`) without this ledger being updated. It is the clearest casualty of the pivot: four slices building a Yjs sync hub inside a machine that no longer has Yjs.

**D61 was spent** on making push automatic — amending D60 point 2's "explicit push" to a coalescing auto-push with a leave-point set, an optimistic non-fast-forward recovery, and an `offline — N waiting` / `no write access` failure taxonomy. Consolidated 2026-07-24 into `prd/vaults-sync.md` (§Summary, §Pushing, §State display, §Why these choices; the debounce and budget numbers it left open now sit in FR-4 and FR-13), `architecture.md` §Sync, and `glossary.md` (§Push replaces §Publish); the Publish button, `publish()`, `sync.publish`, and the `publishing`/`ahead` sync states are deleted from the code. Its reasoning is the §Why-these-choices "why push automatically" paragraph. **Fully realized in code 2026-07-25:** an audit found two survivors, now cleaned up — the agent seed (`agent/seed-content.ts` `AGENTS.md`) still told the agent commits "stay on this machine until the user presses **Publish**", now corrected to auto-push; and a dead duplicate `SyncState` union carrying the removed `ahead` kind lingered in `packages/shared/src/types.ts` (imported nowhere — the live union is in `main/vault/active-vault.ts`), now deleted.
