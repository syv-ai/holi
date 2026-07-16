# PRD — Server & Data Model

The Syv-hosted backend and the canonical data model for Holi. **This PRD owns the server** (the Node/TS monolith — Hocuspocus + tRPC + Postgres + Google OAuth + object storage) and the full Postgres schema. Every other PRD (editor, tasks, agent, client shell) cross-references the tables and procedures defined here.

## Summary

One self-hosted Node/TypeScript service is the durable source of truth for every vault. It runs four cooperating subsystems in a single process:

1. **Hocuspocus** — the Yjs relay: WebSocket sync, awareness/presence fan-out, and persistence hooks that read/write CRDT state and snapshots to Postgres.
2. **tRPC API** — the structured surface: auth/session, vaults, membership, tasks, reminders, note/doc/folder metadata, document version history (snapshot list/restore), per-user UI prefs. Request/response and live subscriptions over the same transport. (Conversation history is *not* here — it lives in Claude Code's native `--resume`, client-local.)
3. **Postgres** — durable store for Yjs binary state + snapshots, task records, vault/membership/user rows, folder identity, per-user UI prefs, reminders, and a derived link index.
4. **Google OAuth (Workspace SSO)** + **object storage (Hetzner)** — identity and blob durability: archived original binaries from import conversion (phase 2) and snapshot/backup exports.

A fifth, feature-scoped subsystem — the **vault git mirror** (a server-side mirror clone with debounced export and webhook-driven ingest, so Claude Code web/cloud sessions can operate on vault content via a GitHub repo) — also lives in this process. This PRD owns its two tables ([`github_connections`](#github_connections-git-mirror-feature), [`vault_git`](#vault_git-git-mirror-feature)); the detailed design is [`../specs/2026-07-13-vault-git-mirror-design.md`](../specs/2026-07-13-vault-git-mirror-design.md).

All OSS, Syv-hosted on Hetzner, containerized. **Why self-hosted:** all-TypeScript end to end with one shared types package, full control over core company document data, no vendor lock-in, and it aligns with the OSS preference. **Rejected:** managed CRDT platforms (Liveblocks, PartyKit) — a vendor would hold Syv's core doc data, and parts are closed-source.

The client is not thin and the server is not thin: the server owns truth, auth, structured data, and durability; the client owns live editing, the agent runtime, and the file bridge. `packages/shared` is the seam — one definition of Task, link grammar, path-safety, and recurrence/reminder rules, imported by both sides with **no codegen across it**.

## Goals / Non-goals

**Goals**
- Be the single durable source of truth per vault (CRDT state + structured records). History is the Yjs snapshot timeline in Postgres; backup is Postgres + object-storage exports; clients' disk files are working copies, never tracked artifacts.
- Enforce authorization totally and server-side — every tRPC call and every Yjs connection checked against membership/role, including agent MCP ops that proxy in.
- Serve tasks as live structured records with server-pushed updates and server-evaluated reminders/recurrence.
- Provide atomic, server-side `note_rename` that preserves Doc identity and rewrites `[[links]]` across affected CRDT docs in one transaction — a **docs-only** operation: task records store stable IDs and never need rewriting.
- Back personal and shared vaults on one sync engine — cross-device sync plus server history/backup for personal notes, and a single code path (no second local-only sync engine).
- Keep the schema and API concrete enough that dependent PRDs point here rather than redefining.

**Non-goals**
- Git is never a client↔client sync mechanism and never the backup story — no auto-commit, no `.gitignore` sync-filter, no `.git` in client working copies. The server-side **git mirror** (tables below) is an export mirror + remote-edit ingress for Claude Code cloud sessions, with the relay as the only git writer — not sync, not backup.
- No file-based task *truth* — tasks are structured server records; their `.md` projection is a view the server rewrites, never an index the server reads. `area` is a settable folder reference, never derived from a task's source note; there is no `source_file` field or orphan-rescue machinery (that coupling, not files as such, was the old complexity).
- No self-improvement/curator loop in v1 — memory and skills change only when the user or agent edits them explicitly in a normal turn.
- No content migration/import in v1 (a generic "import a markdown folder" path is deferred).
- No bundled mail client — Gmail/Calendar integration arrives in phase 2 on Google APIs.
- No server-side agent runtime — the agent runs client-side in a PTY; the server only serves the ops it proxies.
- No bespoke agent permission modes — vault role gating is the only permission system.

## Service architecture (Hocuspocus + tRPC + Postgres + OAuth + object storage)

Single Node/TS process, one Postgres, one object-storage bucket — all Syv-hosted on **Hetzner**.

**Transport surfaces**
- **WebSocket (Hocuspocus):** one connection per client per open Doc room (room name = `docId`). Carries Yjs sync + awareness. Authenticated at connect via `onAuthenticate` with the session token.
- **HTTPS (tRPC):** all structured calls. Uses tRPC's HTTP link for request/response and a WebSocket link (or SSE) for subscriptions (live task boards, reminder fires, presence-adjacent metadata).
- **HTTPS (OAuth callback):** Google Workspace OAuth 2.0 authorization-code flow; issues the Syv session.

**Auth flow**
1. Desktop app opens the Google OAuth consent (Workspace-restricted `hd` domain).
2. Server exchanges the code, verifies the ID token, upserts `users`, mints a **Syv session token** (signed, short-ish TTL + refresh).
3. That token authenticates both tRPC (header) and the Yjs WebSocket (Hocuspocus `onAuthenticate` payload).

Sign-in is **Google-only**. A user may additionally **link a GitHub account** (OAuth) — required only for vault owners enabling the git mirror (one row in [`github_connections`](#github_connections-git-mirror-feature)). **Rejected:** switching sign-in to GitHub — it loses Workspace-managed offboarding, and the phase-2 Gmail/Calendar integration needs Google OAuth anyway.

**Shared context.** A tRPC `createContext` resolves the session → `{ user, ... }`; middleware resolves `{ vault, role }` from `memberships` for any vault-scoped procedure. The same membership resolution backs Hocuspocus `onAuthenticate`. This is the single authorization chokepoint (see [Authorization](#authorization-where-every-check-lives)).

**Process layout.** Hocuspocus and tRPC share the Node HTTP server and the same Postgres pool and shared-types package. The MCP ops server does **not** live here — it runs in Electron main and calls these tRPC procedures as an authenticated client, so agent ops converge on the same authorization and the same write paths as human actions.

## Postgres schema (tables with columns + relationships)

Types are indicative (Postgres). `id` columns are `uuid` — server-assigned, never client-minted. Timestamps are `timestamptz`. JSON payloads that mirror `packages/shared` types are `jsonb`.

The schema is defined in TypeScript with **Drizzle ORM**, and drizzle-kit autogenerates the SQL migrations. This codegen is internal to the server's DB layer only: `packages/shared` remains the only client↔server type seam, and there is **no API/type codegen across that seam**.

### `users`
Google identity + profile.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | server-assigned |
| `google_sub` | text UNIQUE NOT NULL | Google `sub` claim (stable identity) |
| `email` | text UNIQUE NOT NULL | Workspace email |
| `name` | text | display name |
| `avatar_url` | text | from Google profile |
| `created_at` | timestamptz NOT NULL | |
| `updated_at` | timestamptz NOT NULL | |

### `vaults`
A collaborative container. `kind` distinguishes personal vs shared — personal vaults ride the **same** Yjs server, schema, and per-user scoping as shared ones (one sync engine for everything; sign-in required, offline works via local cache).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text NOT NULL | |
| `kind` | text NOT NULL | `'personal' \| 'shared'` |
| `owner_id` | uuid NOT NULL → `users(id)` | for personal: the sole member; for shared: initial owner |
| `theme` | jsonb | shared vault-wide theme tokens/override CSS; owner-only edit |
| `created_at` / `updated_at` | timestamptz | |

Relationships: `memberships`, `docs`, `folders`, `tasks`, `per_user_state`, `vault_git` all FK `vault_id → vaults(id) ON DELETE CASCADE`.

### `memberships`
The ACL on a vault. Personal vaults have exactly one row (owner).

| column | type | notes |
|---|---|---|
| `vault_id` | uuid → `vaults(id)` | |
| `user_id` | uuid → `users(id)` | |
| `role` | text NOT NULL | `'owner' \| 'member'` |
| `invited_by` | uuid → `users(id)` | nullable |
| `created_at` | timestamptz | |
| PK | `(vault_id, user_id)` | |

Index on `(user_id)` for "list my vaults". Role semantics: **member** = read + write all content (notes, tasks); **owner** = member + vault administration (membership management, transfer, delete, theme/settings). **No viewer/read-only role** — everyone with access can edit, so there is no read-only connection tier. **Rejected:** a viewer role — the agent's native file writes can't be cleanly role-blocked, so read-only was an awkward fit, and nobody wanted it.

### `docs`
Metadata for a note. CRDT bytes live in `yjs_docs`; this row carries identity, path, and kind. Doc **identity is the `id`** — path is mutable (rename preserves `id`).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | stable Doc identity |
| `vault_id` | uuid NOT NULL → `vaults(id)` | |
| `path` | text NOT NULL | vault-relative, e.g. `projects/q2/roadmap.md` |
| `kind` | text NOT NULL | `'note' \| 'daily'` |
| `created_at` / `updated_at` | timestamptz | |
| UNIQUE | `(vault_id, path)` | one doc per path |

Folders are **not** implicit in `path` — they have their own identity rows (see [`folders`](#folders)) because `tasks.area` references a folder by stable id. The file tree is derived from `folders` + `docs.path`. `kind='daily'` marks `DD-MM-YYYY.md` daily notes (the daily-note stub heuristic and archival live client/agent-side; the row just tags kind).

### `folders`
Stable identity for folders — required because `tasks.area` and folder-typed refs store a **folder id**, never a path. `area` is a real, **settable** folder reference: swim lanes are folders, dragging a task across lanes re-sets `area`, and a task created from a note defaults `area` to that note's folder but is freely changeable. **Rejected:** a per-vault defined area list, and free-text areas — the folder reference preserves the doc-centric organizing model. (The board and task-model behavior live in [`tasks.md`](tasks.md); this PRD owns the records and sync.)

Renaming a folder updates `path` here (plus contained `docs.path` prefixes and prose-link rewrites via the rename machinery); every task whose `area` points at it follows automatically, with zero task-record writes.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | stable folder identity |
| `vault_id` | uuid NOT NULL → `vaults(id)` | |
| `path` | text NOT NULL | vault-relative folder path, e.g. `projects/q2` |
| `created_at` / `updated_at` | timestamptz | |
| UNIQUE | `(vault_id, path)` | one folder per path |

### `yjs_docs`
Current authoritative CRDT state per Doc (Hocuspocus persistence target).

| column | type | notes |
|---|---|---|
| `doc_id` | uuid PK → `docs(id) ON DELETE CASCADE` | 1:1 with `docs` |
| `state` | bytea NOT NULL | latest merged Yjs update (full state vector) |
| `updated_at` | timestamptz NOT NULL | last `onStoreDocument` |

### `yjs_snapshots`
Point-in-time CRDT states forming the history timeline **and the merge-safety net**. Snapshots are a Doc's version history — there are no commits anywhere in the history story.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `doc_id` | uuid NOT NULL → `docs(id) ON DELETE CASCADE` | |
| `state` | bytea NOT NULL | Yjs snapshot bytes |
| `taken_at` | timestamptz NOT NULL | |
| `reason` | text | `'interval' \| 'manual' \| 'pre-rename' \| 'pre-agent-write' \| 'pre-offline-merge' \| 'pre-reconcile'` etc. |
| `label` | text | human-readable auto-label for risky-op snapshots, e.g. *"before Claude edited"*, *"before your offline changes merged"* |
| `author_id` | uuid → `users(id)` | best-effort last editor at snapshot time |

Index on `(doc_id, taken_at DESC)` for timeline reads and restore.

**Auto-labeled snapshots:** before risky operations — an agent bulk-write, reconciling a long-offline session, an agent reconcile itself — the server appends a snapshot with `reason` + `label` set, so the timeline offers one-click restore points at exactly the moments merges can garble. These snapshots are also what the **agent-reconcile 3-way is reconstructed from**: base / mine / theirs for the one-click reconcile flow come from the snapshot timeline, not from any separate merge store.

### `tasks`
The full Task record — the authoritative shape mirrors `packages/shared`'s `Task`. Tasks are first-class **structured server records** (queryable, shareable, real-time) and are **projected into the vault as files** (`tasks/<slug>-<id>.md`; [`tasks.md`](tasks.md) §Task file projection). **The record is the truth:** reminders fire while every client is closed, recurrence rolls server-side, and the board queries across members — none of which a file can do. The projection is a view: record → file is a rewrite, file → record is a per-field patch.

The table therefore gains a **`version` integer** (bumped on every mutation) — the optimistic-concurrency token — and a **`description` text** column, which is the task file's markdown body. `description` is a **plain column, not a CRDT doc**: it syncs last-writer-wins per field like everything else on the record.

**The token is carried out-of-band, not in the file** (revised 2026-07-14). The desktop keeps the version each file was rendered from in its `ProjectionStore`; an inbound *desktop* write carrying a stale `version` is discarded and the file rewritten from the record. An inbound *git* write carries no version and needs none — the commit's own base blob is the diff base, so the per-field patch is exact by construction. **Why it left the frontmatter:** `version` bumps on every mutation, so a reminder firing would rewrite the file to change one integer, and with the git mirror on the bot would *commit* that on an otherwise idle vault, forever.

Parse/serialize is a single pair of pure functions over the `Task` shape (`packages/shared/src/task-file.ts`). The **serializer** runs on every outbound render (the desktop's file rewrite *and* the git export); the **parser** runs only on an inbound write (the desktop projector *and* the git ingester). The invariant is not "one call site" — it is that **the parser never answers a question**. **Nothing queries the files.**

**Exactly one place a task changes: `src/tasks/mutations.ts`.** Every mutation — from the tRPC router, or from the git ingester — goes through it, and each ends in `finishMutation` (`recomputeReminder` + `bus.emitTasks` + `wakeEvaluator`). Writing the `tasks` table directly would skip all three: no reminder would fire, and **no SSE would reach the desktop, so no client would rewrite the file**. This module *is* the enforcement of the "one write path" rule; before it existed, the router was that place only by accident of being the only caller.

**Rejected:** files as the source of truth (the server would have to parse and mutate markdown to evaluate reminders — the same record, plus a parser); structured records kept in sync with inline note checkboxes (reintroduces note↔task coupling). The deep task model, projection contract, and board behavior live in [`tasks.md`](tasks.md); this PRD owns the table, records, and sync.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `vault_id` | uuid NOT NULL → `vaults(id)` | |
| `title` | text NOT NULL | |
| `status` | text NOT NULL | `'todo' \| 'doing' \| 'done'` |
| `area` | uuid → `folders(id) ON DELETE SET NULL` | **stable folder id** — settable, drives swim lanes; rendered as the folder's current path client-side. Nullable = the "(no area)" lane |
| `due` | date | `YYYY-MM-DD` |
| `priority` | text | `'low' \| 'medium' \| 'high'` |
| `tags` | text[] | |
| `reminder` | text | `Nd` \| `Nw` \| absolute `YYYY-MM-DDTHH:MM` |
| `reminded_at` | timestamptz | server-written; last fire time (re-arm bookkeeping) |
| `recurrence` | jsonb | `Recurrence` rule (`frequency, interval, weekdays[], endDate`) |
| `related` | jsonb | `RelatedRef[]` — unified `note \| task \| email \| event`, each holding a **stable id** (doc id / task id / email id / event id), never a path; rendered as the current path/title client-side |
| `description` | text | nullable — the task file's markdown body. A **plain column, not a CRDT doc** |
| `version` | integer NOT NULL default 1 | optimistic-concurrency token, bumped on every mutation. Carried **out-of-band**, never in the file |
| `completed_at` | timestamptz | set on transition to `done` (drives roll-forward) |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(vault_id, status)` for the board; `(vault_id, area)` for swim lanes. `related` is **one unified list** across all four ref kinds — there are no per-kind relation arrays and no `source_file` field. Because `area` and `related[]` hold stable IDs, **renames never touch task rows** (display just re-resolves), and **deletes never cascade through refs** — a dangling id renders as a tombstone ("[deleted note]") client-side.

**A deleted folder unfiles its tasks** — `area` is `ON DELETE SET NULL` (migration `drizzle/0004_fresh_james_howlett.sql`, 2026-07-14), so the tasks fall into the "(no area)" lane rather than blocking the delete. The FK was originally un-cascaded, which meant Postgres **refused** to delete any folder a task pointed at — folders were silently undeletable, and the "renders by its last-known path" folder tombstone the PRDs described was unreachable code. A task is allowed to exist without an area (that is what the "(no area)" lane *is*), so the folder delete wins and the task falls into it. **There is no folder tombstone.** *Folder rename* still cascades to the lane label with zero task-row writes, as before.

### `reminders`
Derived/scheduled fire times the server-side evaluator consumes. Kept as a materialized projection of `tasks.reminder` so the scheduler queries a small, indexed table instead of scanning tasks.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `task_id` | uuid NOT NULL → `tasks(id) ON DELETE CASCADE` | |
| `vault_id` | uuid NOT NULL → `vaults(id)` | denormalized for fan-out |
| `fire_at` | timestamptz NOT NULL | computed next fire time |
| `fired` | boolean NOT NULL DEFAULT false | set when pushed |
| `computed_from` | text | source rule snapshot (`reminder` value) for invalidation |

Index on `(fire_at) WHERE NOT fired` — the evaluator's hot query (earliest pending). Recomputed whenever a task's `reminder`/`due`/`status`/recurrence changes, or on roll-forward.

### `per_user_state`
**UI prefs only**: per-user, per-vault, synced across that user's devices, invisible to the team. A generic key→value store.

| column | type | notes |
|---|---|---|
| `user_id` | uuid → `users(id)` | |
| `vault_id` | uuid → `vaults(id)` | |
| `key` | text | e.g. `ui/prefs`, `ui/color-mode` |
| `value` | jsonb (or text) | |
| `updated_at` | timestamptz | |
| PK | `(user_id, vault_id, key)` | |

Holds **UI prefs** (incl. per-user light/dark mode) and nothing else. **Personal agent config — USER.md, personal skills — is machine-local and never synced** (Claude Code's native `~/.claude` / `CLAUDE.local.md` layering); it does not live in this table or anywhere on the server. **No chat-history pointers here either** — conversation history is client-local via native `--resume`.

### Conversation history — *not a server table*

**There is no server-side conversation store — and no Holi conversation subsystem at all.** Chat history *is* Claude Code's native `--resume` session picker: conversations stay local to the machine that ran them, never synced, replayed at full fidelity in the terminal. **Why:** a custom history system would couple to Claude Code's undocumented session-file format — the most brittle dependency imaginable — while duplicating what `--resume` does natively. **Rejected:** full structured transcript reconstruction (JSONL parser + summarizer + server store), and a thin Holi-rendered session list reading session-file metadata (still a coupling touchpoint; the native picker suffices). (Document version history — Yjs snapshots — is a separate, server-side concern; see [`yjs_snapshots`](#yjs_snapshots).)

### `link_index` *(optional / derived)*
Denormalized `[[link]]` edges for O(1) backrefs and rename without scanning every Doc's CRDT text.

| column | type | notes |
|---|---|---|
| `vault_id` | uuid → `vaults(id)` | |
| `src_doc_id` | uuid → `docs(id) ON DELETE CASCADE` | doc containing the link |
| `target_path` | text | the `[[folder/note.md]]` target (may dangle) |
| `occurrences` | int | count within the source doc |
| PK | `(src_doc_id, target_path)` | |

Rebuilt incrementally on `onStoreDocument` (parse the doc's text via the shared wiki-link grammar). Backed by an index on `(vault_id, target_path)`. If dropped, backrefs/rename fall back to scanning materialized CRDT text — correctness-equivalent, just slower.

### `github_connections` *(git-mirror feature)*
Per-user GitHub account link, part of the **vault git mirror** — the server-side mirror clone + remote-edit ingress that lets Claude Code web/cloud sessions operate on vault content through a GitHub repo. Detailed design: [`../specs/2026-07-13-vault-git-mirror-design.md`](../specs/2026-07-13-vault-git-mirror-design.md). One row per linked user; required only for vault owners enabling the mirror.

| column | type | notes |
|---|---|---|
| `user_id` | uuid PK → `users(id)` | one row per linked user |
| `github_user_id` | text | GitHub account id |
| `github_login` | text | GitHub username |
| `oauth_token` | text NOT NULL | **encrypted**; used only at repo wiring/un-wiring time, never for background operations |
| `created_at` / `updated_at` | timestamptz | |

### `vault_git` *(git-mirror feature)*
Per-vault repo connection state. The relay is the **only git writer** for a vault — day-to-day operations run on the deploy key, and client working copies never carry `.git`.

**Tasks *do* appear in the repo** (revised 2026-07-14 — this reverses the earlier "tasks never appear in the repo; remote sessions can't see or edit tasks in v1" limitation, which the [task file projection](tasks.md#task-file-projection) removed). The exporter has **two sources** — the `docs` ⋈ `yjs_docs` join *and* the `tasks` table — and writes each task to `tasks/<slug>-<id>.md`. Inbound, the ingester **branches before its A/M/D/R dispatch**: a `tasks/**.md` path routes to the record path (`src/git/task-ingest.ts`) and **never** reaches `createDoc`, which hardcodes `kind: 'note'` and would otherwise turn every remotely-edited task file into a CRDT note. A remote Claude Code session on a clone therefore reads, edits, creates and deletes tasks as files.

| column | type | notes |
|---|---|---|
| `vault_id` | uuid PK → `vaults(id)` | one connected repo per vault |
| `repo_url` | text NOT NULL | owner-provided; github.com only |
| `default_branch` | text NOT NULL | the export target and only ingest source |
| `deploy_private_key` | text NOT NULL | **encrypted**; private half of the write deploy key installed on the repo |
| `webhook_id` | text | GitHub push-webhook id |
| `webhook_secret` | text | HMAC secret verifying webhook payloads |
| `base_commit` | text | last commit exported **or** ingested — the diff base for both directions |
| `status` | text NOT NULL | `'ok' \| 'paused' \| 'attention'` (force-push/rewritten history ⇒ `attention`, sync pauses until the owner resolves) |
| `enabled_by` | uuid → `users(id)` | owner who connected the repo |
| `created_at` / `updated_at` | timestamptz | |

## tRPC API surface (routers/procedures by domain; note subscriptions)

Grouped into routers. **(S)** marks subscriptions (live server push); everything else is request/response. All vault-scoped procedures pass through the membership/role middleware.

### `auth` / `session`
- `auth.beginGoogle()` → returns the OAuth authorization URL.
- `auth.completeGoogle({ code })` → exchanges code, upserts `users`, returns session token + user.
- `auth.session()` → current user from token.
- `auth.refresh()` / `auth.signOut()`.

### `vaults`
- `vaults.list()` → vaults the caller is a member of (joins `memberships`).
- `vaults.get({ vaultId })`.
- `vaults.create({ name, kind })` → creates vault + owner membership (personal ⇒ single-member).
- `vaults.rename({ vaultId, name })` — owner.
- `vaults.setTheme({ vaultId, theme })` — owner; vault-wide shared theme.
- `vaults.delete({ vaultId })` — owner; cascades.
- `vaults.listDocs({ vaultId })` → doc + folder metadata (the file tree source; folders are identity rows).
- **(S)** Live doc-metadata changes (create/rename/delete) arrive on the **`docs`** channel of the user-scoped SSE stream (below), so the file tree updates without polling. *(There was a `vaults.watchDocs` tRPC subscription here. It was deleted 2026-07-16: no client could reach it — there is no WS link and the IPC link throws on subscriptions — so it advertised a transport that does not exist. Plain SSE is the transport, chosen so the client can authenticate with a normal `Authorization` header over fetch.)*

### `membership`
- `membership.list({ vaultId })`.
- `membership.invite({ vaultId, email, role })` — owner. Resolves/creates the invited `users` row on first sign-in.
- `membership.setRole({ vaultId, userId, role })` — owner.
- `membership.remove({ vaultId, userId })` — owner.
- `membership.leave({ vaultId })` — self (non-owner).
- `membership.transferOwnership({ vaultId, toUserId })` — owner.

### `tasks`
- `tasks.list({ vaultId, filter? })` → board data.
- `tasks.get({ taskId })`.
- `tasks.create({ vaultId, ...Task })`.
- `tasks.update({ taskId, patch })` — last-writer-wins per field (tasks are not CRDTs).
- `tasks.complete({ taskId })` — transitions to `done`, triggers server-side recurrence roll-forward.
- `tasks.link({ taskId, related })` / `tasks.unlink(...)` — mutate the unified `related[]`.
- `tasks.delete({ taskId })`.
- `tasks.heartbeat({ taskId })` — **presence**. A mutation that **touches no row**: it stamps an `expiresAt` (10s TTL), emits, and returns. It must never bump `version` — a heartbeat that did would rewrite every task file, and with the git mirror on, commit it.
- **(S)** Live task upserts/deletes reach every member on the **`tasks`** channel of the user-scoped SSE stream, so boards stay live (architecture §5). *(A `tasks.watch` subscription was deleted 2026-07-16 — same reason as `vaults.watchDocs`.)*

Every one of these mutations goes through `src/tasks/mutations.ts` (above), as does the git ingester — the router is input validation plus a call.

The agent's MCP surface is **3 ops** — `task_set`, `task_list`, `note_rename` — and they proxy to these procedures, role-gated. `task_new` / `task_get` / `task_link` / `task_delete` are **retired**: the agent does all of that with native file tools against the projection. (The tRPC procedures above survive regardless — the *board* calls them.) Calendar/mail ops join in phase 2 with the Google integration. There are no conversation/session-search procedures anywhere — conversation history has no server surface.

### `reminders`
- `reminders.listPending({ vaultId })` — introspection/debug.
- **(S)** **Fire events are pushed** on the **`reminders`** channel of the user-scoped SSE stream; the client raises a native Electron notification. There is no client-side scheduler loop. Fires arrive for **every vault you are in**, not only the one on screen. *(A `reminders.subscribe` subscription was deleted 2026-07-16 — same reason as `vaults.watchDocs`.)*
- `reminders.catchUpAll()` → fires you missed while disconnected, across every vault, grouped as `{ vaultId, event }`. A mutation, not a query: it advances the per-`(vault, user)` delivery watermark. Replaced a per-vault `catchUp` whose only caller knew its vault because the stream was per-vault.

### `notes` / `docs` (metadata; content is Yjs)
- `notes.create({ vaultId, path, kind })` → creates the `docs` row + an empty `yjs_doc`. Content editing happens over Hocuspocus, not here.
- `notes.rename({ vaultId, docId, newPath })` → **atomic, docs-only** server-side path change + `[[link]]` rewrite (see [Atomic note rename](#atomic-note-rename-docs-only)). Preserves `docId`; task records are untouched.
- `notes.renameFolder({ vaultId, folderId, newPath })` → updates `folders.path` + contained `docs.path` prefixes + prose-link rewrites; `tasks.area` display follows automatically because it stores the folder **id**.
- `notes.delete({ vaultId, docId })` — no ref cascades; dangling `related[]` ids render tombstones client-side.
- `notes.backrefs({ vaultId, path })` → docs referencing this path (via `link_index`) — surfaced before delete.
- These are the metadata operations; the CRDT text itself is never sent through tRPC.

### `snapshots` (document version history)
- `snapshots.list({ docId })` → the timeline: `taken_at`, `reason`, **`label`**, `author_id` (labels surface the auto-snapshot restore points: *"before Claude edited"* etc.).
- `snapshots.restore({ docId, snapshotId })` → materializes the snapshot as the current Yjs state (applied as a normal update so it merges/propagates) — the one-click restore.
This is **document** history only; conversation history has no server surface.

### `userState` (UI prefs)
- `userState.get({ vaultId, key })` / `userState.getAll({ vaultId })`.
- `userState.set({ vaultId, key, value })`.
- `userState.delete({ vaultId, key })`.
Backs **UI prefs only**. USER.md and personal skills are machine-local, never synced; chat/session pointers are client-local too.

## Yjs persistence & history (Hocuspocus hooks, snapshots, restore)

Hocuspocus wires four hooks into this server:

- **`onAuthenticate(token, documentName)`** → resolves the session → user, resolves the Doc's `vault_id` (from `docs.id = documentName`), checks `memberships`. **Non-member ⇒ reject; member/owner ⇒ read-write connection.** No read-only connection tier — there is no viewer role, so every accepted connection can edit. Returns a **connection context** carrying `role` (owner vs member) for downstream vault-admin gating. The authoritative authz for every editing connection.
- **`onLoadDocument(documentName)`** → hydrate the Yjs doc from `yjs_docs.state`; if absent, initialize empty (paired with `notes.create`). Loads the awareness-free document; awareness is transient.
- **`onStoreDocument(documentName, document)`** → debounced write of the merged state back to `yjs_docs.state`; opportunistically refresh `link_index` for that doc (parse text via shared grammar) and bump `docs.updated_at`. **Snapshot policy:** append a `yjs_snapshots` row on an interval, on significant boundaries (e.g. `reason='pre-rename'` before a rename touches the doc), and — **auto-labeled** — before risky operations: agent bulk-writes and long-offline reconciles (`reason='pre-agent-write'` / `'pre-offline-merge'` with a human `label`).
- **Awareness fan-out** — standard Hocuspocus awareness channel carries cursors/selections + doc-viewer presence; ephemeral, never persisted.

**History timeline & restore.** `yjs_snapshots` ordered by `taken_at` is a Doc's version history. A restore materializes a chosen snapshot as the current Yjs state (applied as a normal update so it merges/propagates, not a hard overwrite) — exposed via `snapshots.list` / `snapshots.restore`, with `label` surfacing the auto-labeled restore points. Snapshots + object-storage exports are the backup story.

**Overlap detection & agent reconcile.** When two concurrent edits that touched **overlapping ranges** merge (or a long-offline session reconciles), the doc gets a **non-blocking flag** — *"this merge may need a look — let Claude reconcile?"* Whether the server detects this during merge or the client does is an implementation choice (*open*). Accepting the prompt hands a git-style 3-way — **base / mine / theirs, reconstructed from `yjs_snapshots`** — to the user's local agent, which writes a clean reconciled version back through the bridge (taking its own `reason='pre-reconcile'` snapshot first). **No conflict dialogs, ever** — the Google Docs model; this is recoverability + opt-in semantic repair, never a blocking UI. **Why opt-in:** auto-running reconciliation on every overlap means unattended rewrites, token spend per collision, and per-user divergence; a real conflict-resolution UI is a large build that fights the CRDT's point.

## Reminders & recurrence (server-side eval/push)

**Reminder rules are pure functions in `packages/shared`** (port the math from the old app's `services/reminder.rs`, test-first): resolve `Nd`/`Nw` relative-to-`due` (09:00 anchor) or absolute `YYYY-MM-DDTHH:MM` into a concrete fire time; the pending predicate (open task ∧ reminder resolves ∧ `reminded_at < fire time`). The server is the *only* evaluator — **why:** tasks are server records, so one evaluator on the source of truth means no per-client scheduler drift, and fires push to every member's clients as native notifications. There is no client-side scheduler loop.

**Evaluation loop** (port the loop semantics from the old `reminder_scheduler.rs`):
1. On any task mutation touching `reminder`/`due`/`status`/`recurrence`, recompute that task's next `fire_at` and upsert/clear its `reminders` row.
2. A single loop sleeps until the earliest `fire_at WHERE NOT fired` across all vaults (indexed query), woken early by a change signal on mutation.
3. On fire: stamp `fired_at`, write `tasks.reminded_at`, and **push** a fire event to that vault's members on the SSE `reminders` channel (S). Clients raise the native notification.
4. First iteration doubles as the missed-reminder pass on boot (fire times already past → coalesced; a backlog of more than 5 missed reminders collapses into one summary event).
5. Invalid/due-less-relative reminders are inert, never errors.

**Recurrence roll-forward** runs **server-side on `tasks.complete`** (port from the old `services/recurrence.rs`): compute the next occurrence from the `Recurrence` rule (shared pure function), advance `due`, shift any absolute reminder by the due delta, clear `reminded_at`, reset `status` to `todo`, and recompute the `reminders` row. Because the pending predicate re-arms naturally, nothing is ever explicitly cleared beyond `reminded_at` on re-set.

## Atomic note rename (docs-only)

`notes.rename({ vaultId, docId, newPath })` is a single server operation — the reason rename is an MCP op, not a native `mv` — and it is **docs-only**: it touches `docs.path` and CRDT link spans, nothing else. The split follows one principle: **machine references use stable IDs; human prose uses paths.** Prose links stay path-based `[[folder/note.md]]` — readable and authorable by the agent in raw markdown, matching Obsidian mental models (**rejected:** stable doc IDs rendered in prose — opaque `[[doc:a1b2]]` in raw md; hybrid id+slug — uglier markdown, more normalization). Rename is safe to centralize because the server is the single rewrite authority. In one Postgres transaction:

1. **Authz + validation** — role ≥ member; validate `newPath` through the shared **path-safety** module (reject `..`/absolute/NUL; reassert vault containment); ensure `(vault_id, newPath)` is free.
2. **Identify affected docs** — query `link_index WHERE vault_id AND target_path = oldPath` (fallback: scan). These are the docs whose `[[oldPath]]` must become `[[newPath]]`.
3. **Rewrite links in CRDT space** — for each affected Doc, load its Yjs state, apply a **targeted Yjs update** that replaces the link occurrences (via the shared wiki-link grammar), and persist the new state. Concurrent edits to unaffected regions of those docs still merge (CRDT); this touches only the link spans.
4. **Move the doc** — update `docs.path = newPath` for `docId` (**identity `docId` preserved** — no new Doc, no lost history/snapshots).
5. **Update `link_index`** and take a `reason='pre-rename'` snapshot of touched docs for the timeline.

Live Hocuspocus rooms for the touched docs receive the update through the normal relay path, so open editors reflect the rewrite. **No task-record rewrite** — `tasks.related[]` and `tasks.area` store stable IDs, so their rendered paths simply re-resolve; there is no cross-subsystem (Yjs + SQL) atomic transaction to coordinate. **Rejected:** paths everywhere held consistent by a saga/outbox coordinator across Yjs and SQL (distributed-transaction machinery — exactly the fragile seam to avoid), and paths + a background reconciler (transient dangling refs).

**Folder rename** (`notes.renameFolder`) is the same shape one level up: update `folders.path` (id preserved), update contained `docs.path` prefixes, rewrite prose links to the moved docs via the same machinery. Every task whose `area` points at the folder id follows automatically for display — zero task writes.

**Deletes** don't cascade through refs: a deleted doc/task leaves dangling stable ids in `related[]`, which the client renders as tombstones ("[deleted note]").

## Authorization (where every check lives)

Authorization is **server-side and total** (architecture §9). Two enforcement points, one source of truth:

- **tRPC middleware** — a vault-scoped middleware resolves `{ user, vault, role }` from the session + `memberships` and gates per procedure: **any member reads and writes content procedures** (notes, tasks); **owner-only** for membership management / transfer / delete / theme. No procedure trusts a client-supplied role.
- **Hocuspocus `onAuthenticate`** — the *same* membership resolution for every WebSocket; members and owners get read-write connections; non-members are rejected. No read-only tier.

The **agent's MCP ops are gated by the identical boundary**: the MCP server in Electron main holds a per-run bearer token, but it calls these tRPC procedures as an authenticated user — so it can never grant itself more than the user's role. There is no second permission system — no safe/power_user-style agent modes; `memberships` is the one ACL, and every path funnels through it.

## packages/shared (what's shared, no codegen)

The security- and correctness-critical domain, imported verbatim by **both** server and client — the types are the source; there is no codegen across the client↔server seam (the server's Drizzle layer generates SQL migrations internally, never types):

- **`Task`, `Recurrence`, `Reminder`, `RelatedRef`, `Status`, `Role`, `Doc`/`DocKind`, `Folder`, `Vault`/`VaultKind`** — the record shapes the tables mirror and the tRPC procedures accept/return. `RelatedRef` carries a **stable id** per kind.
- **Wiki-link grammar** — one parser (port `vaultRefs.ts`); used by the editor renderer, the agent's link authoring, `link_index` construction, and the rename rewrite. Single source, thin renderers.
- **Path-safety** — reimplement `resolve_relative` / `VaultPath` containment **test-first** (reject `..`/absolute/NUL, canonicalize through the closest existing ancestor, reassert vault containment). Guards `notes.rename`, `notes.create`, the file bridge, every git-mirror ingest path, and any agent-supplied path. First-class module, security-critical (architecture §9).
- **Recurrence + reminder pure functions** — the `Nd`/`Nw`/absolute resolution and roll-forward math (port the well-tested implementation from the old Rust services). The server's evaluator and the client's display both call these; identical results by construction.
- **Prompt content / memory budgets** — the `agent_context` strings, USER.md (4000) / MEMORY.md (5000) char budgets and fill-indicator logic, consumed by the `UserPromptSubmit` hook. (USER.md itself is machine-local — only the budget/fill logic is shared.)

## Scaling & backup

- **Snapshots** are the version history, part of backup, *and* the merge-safety net: `yjs_snapshots` interval + boundary + auto-labeled risky-op snapshots per Doc; prune policy TBD (keep recent dense, thin older; labeled risky-op snapshots likely outlive interval ones — *open*).
- **Object storage (Hetzner)** holds **archived original binaries** from import conversion (phase 2 — the vault is markdown-first: PDFs/Word files convert to markdown on entry, the original is archived and fetchable on demand, never a working format) and **backup exports** (periodic Postgres dumps + Yjs state exports). Archived originals referenced by object key; served via signed URLs. The git mirror is *not* part of the backup story.
- **Postgres** is the transactional core; `yjs_docs.state` (bytea) can grow — large docs may warrant TOAST tuning or moving cold state to object storage (*open*).
- **WebSocket scaling** *(flag: open)* — a single Hocuspocus process caps at one node's connections. Horizontal scale needs a shared awareness/broadcast layer (Hocuspocus + Redis pub/sub extension, or a room-affinity load balancer) so clients in the same Doc room reach the same authority. Not needed at Syv's initial headcount; called out as the first scaling wall.
- **tRPC subscriptions** (tasks/reminders/doc-metadata) fan out per-vault; at multi-node they need the same shared pub/sub as awareness (*open*).

## Edge cases & risks

- **Snapshot growth vs restore fidelity** — too-sparse snapshots lose granular history; too-dense bloats storage. Policy is *open*. (The auto-labeled snapshots add rows only at risky-op boundaries, so they don't move the growth needle much — but the 3-way reconcile depends on the pre-op snapshot existing, so risky-op snapshotting must be unconditional.)
- **`link_index` drift** — if incremental updates miss an edit, backrefs/rename under-match. Mitigate with a periodic reconcile scan; correctness fallback is full-text scan of CRDT state.
- **Rename vs concurrent edit of a link span** — if a user is mid-typing exactly over a `[[link]]` while rename rewrites it, the CRDT converges with both edits surviving adjacently (acceptable, same as any co-edit; spike-verified — [`../spikes/2026-07-10-bridge-turn-protocol.md`](../spikes/2026-07-10-bridge-turn-protocol.md)) — with the overlap flag + snapshot restore as the net.
- **Reminder timezone anchoring** — the 09:00 anchor and absolute local times must resolve against a consistent tz; server must know the user/vault timezone (*open* — likely per-user in `per_user_state`).
- **Task last-writer-wins** — two members editing the same task field concurrently: last write wins per field (accepted for small structured records); no CRDT merge for tasks.
- **Offline reminders** — a client offline at fire time gets the event on reconnect via the subscription replay of `fired`-but-unacked events (*open*: ack/dedup semantics).

## Dependencies (all other PRDs depend on this)

This PRD is the reference; the key downstream dependencies:

- **Tasks / board PRD** → `tasks` table (stable-ID `area`/`related[]`), `folders` for lane identity, `tasks.*` procedures + the SSE `tasks` channel (S), reminders/recurrence eval.
- **Editor / notes PRD** → `docs`/`folders`/`yjs_docs`/`yjs_snapshots` (+ labels), Hocuspocus hooks + awareness, `notes.rename`/`notes.renameFolder` atomicity, `snapshots.list`/`restore`, the overlap-detection flag + agent reconcile, `link_index`, wiki-link grammar.
- **Agent PRD** → MCP ops proxying to `tasks`/`notes.rename` (the whole v1 surface), role gating, per-turn context content, the agent-reconcile flow. `per_user_state` is UI prefs only — USER.md/personal skills are machine-local; conversation history is native `--resume`, client-local, no server table or search ops.
- **Client shell / sync PRD** → `auth`/`session`, `vaults`/`membership`, the WebSocket + tRPC transports, sync-status semantics, offline replay.
- **Vault git mirror** ([`../specs/2026-07-13-vault-git-mirror-design.md`](../specs/2026-07-13-vault-git-mirror-design.md)) → `github_connections`, `vault_git`, the per-vault exporter/ingester lock, pre-ingest auto-labeled snapshots, `VaultPath` validation on every ingested path.
- **`packages/shared`** → consumed by every PRD; changes here ripple to both apps.

## Open questions

- **Snapshot retention/pruning** — the interval policy is set: one snapshot per 10 min of active editing (`SNAPSHOT_INTERVAL_MS` in `server/config.ts`). Pruning is still open (dense-recent, thin-old vs fixed cadence; how long labeled risky-op snapshots outlive interval ones).
- **Overlap detection placement** — does the server detect overlapping-range concurrent merges during Yjs merge, or does the client flag them? Implementation open.
- **WebSocket horizontal scaling** — Redis pub/sub extension vs room-affinity LB; when to build (post-v1 likely).
- **Timezone source** for reminder anchoring — currently server-wide `HOLI_TZ` (default Europe/Copenhagen; `server/config.ts`); per-user (per-vault?) later, stored where — open.
- **Archived-original lifecycle** (phase 2) — import upload path, GC of unreferenced objects, size limits.
- **Offline reminder delivery** — ack/dedup so a client offline across a fire doesn't miss or double-fire.
- **`link_index` as source of truth vs pure derived cache** — do we ever trust it without a reconcile pass?
- **Session tokens** — currently opaque DB tokens, 30-day sliding TTL, revocation by row delete (`server/auth/sessions.ts`). Open: whether membership removal revokes live sessions immediately vs within the TTL.
