# PRD — Server & Data Model

The Syv-hosted backend and the canonical data model for the Holi rebuild. **This PRD owns the server** (the Node/TS monolith — Hocuspocus + tRPC + Postgres + Google OAuth + object storage) and the full Postgres schema. Every other PRD (editor, tasks, agent, client shell) cross-references the tables and procedures defined here. Decisions cited as **D#** live in [`../decisions.md`](../decisions.md).

## Summary

One self-hosted Node/TypeScript service is the durable source of truth for every vault (D1, D14). It runs four cooperating subsystems in a single process:

1. **Hocuspocus** — the Yjs relay: WebSocket sync, awareness/presence fan-out (D20), and persistence hooks that read/write CRDT state and snapshots to Postgres.
2. **tRPC API** — the structured surface: auth/session, vaults, membership, tasks, reminders, note/doc/folder metadata, document version history (snapshot list/restore), per-user UI prefs. Request/response and live subscriptions over the same transport. (Conversation history is *not* here — it lives in Claude Code's native `--resume`, client-local, D9.)
3. **Postgres** — durable store for Yjs binary state + snapshots, task records, vault/membership/user rows, folder identity, per-user UI prefs, reminders, and a derived link index.
4. **Google OAuth (Workspace SSO)** + **object storage (Hetzner)** — identity (D7) and blob durability: archived original binaries from import conversion (phase 2) and snapshot/backup exports (D28).

All OSS, Syv-hosted on Hetzner, containerized (D14, D28). The client is not thin and the server is not thin: the server owns truth, auth, structured data, and durability; the client owns live editing, the agent runtime, and the file bridge. `packages/shared` is the seam — one definition of Task, link grammar, path-safety, and recurrence/reminder rules, imported by both sides with **no codegen** (D14, D15).

## Goals / Non-goals

**Goals**
- Be the single durable source of truth per vault (CRDT state + structured records), replacing local files + git (D1, D3).
- Enforce authorization totally and server-side — every tRPC call and every Yjs connection checked against membership/role, including agent MCP ops that proxy in (D7, D10).
- Serve tasks as live structured records with server-pushed updates and server-evaluated reminders/recurrence (D4, D19).
- Provide atomic, server-side `note_rename` that preserves Doc identity and rewrites `[[links]]` across affected CRDT docs in one transaction (D12) — a **docs-only** operation: task records store stable IDs and never need rewriting (D27).
- Back personal and shared vaults on one sync engine (D13).
- Keep the schema and API concrete enough that dependent PRDs point here rather than redefining.

**Non-goals**
- No git, no GitHub-as-backup, no `.gitignore` sync-filter (D3).
- No file-based tasks, no `area` phantom / orphan-rescue / `source_file` (D4).
- No self-improvement/curator loop, `activity.jsonl`, review counters, or threat scanner in v1 (D11).
- No content migration/import in v1 (D16); no Mailspring (D17).
- No server-side agent runtime — the agent runs client-side in a PTY (D5); the server only serves ops it proxies.
- No safe/power_user permission modes — role gating replaces them (D10).

## Service architecture (Hocuspocus + tRPC + Postgres + OAuth + object storage)

Single Node/TS process, one Postgres, one object-storage bucket — all Syv-hosted on **Hetzner** (D14, D28).

**Transport surfaces**
- **WebSocket (Hocuspocus):** one connection per client per open Doc room (room name = `docId`). Carries Yjs sync + awareness. Authenticated at connect via `onAuthenticate` with the session token.
- **HTTPS (tRPC):** all structured calls. Uses tRPC's HTTP link for request/response and a WebSocket link (or SSE) for subscriptions (live task boards, reminder fires, presence-adjacent metadata).
- **HTTPS (OAuth callback):** Google Workspace OAuth 2.0 authorization-code flow; issues the Syv session.

**Auth flow (D7)**
1. Desktop app opens the Google OAuth consent (Workspace-restricted `hd` domain).
2. Server exchanges the code, verifies the ID token, upserts `users`, mints a **Syv session token** (signed, short-ish TTL + refresh).
3. That token authenticates both tRPC (header) and the Yjs WebSocket (Hocuspocus `onAuthenticate` payload).

**Shared context.** A tRPC `createContext` resolves the session → `{ user, ... }`; middleware resolves `{ vault, role }` from `memberships` for any vault-scoped procedure. The same membership resolution backs Hocuspocus `onAuthenticate`. This is the single authorization chokepoint (see [Authorization](#authorization-where-every-check-lives)).

**Process layout.** Hocuspocus and tRPC share the Node HTTP server and the same Postgres pool and shared-types package. The MCP ops server does **not** live here — it runs in Electron main (D10) and calls these tRPC procedures as an authenticated client, so agent ops converge on the same authorization and the same write paths as human actions.

## Postgres schema (tables with columns + relationships)

Types are indicative (Postgres). `id` columns are `uuid` (server-assigned — never client-minted; the old client-minted vault UUIDs are gone). Timestamps are `timestamptz`. JSON payloads that mirror `packages/shared` types are `jsonb`.

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
A collaborative container (D-glossary). `kind` distinguishes personal vs shared (D13).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text NOT NULL | |
| `kind` | text NOT NULL | `'personal' \| 'shared'` |
| `owner_id` | uuid NOT NULL → `users(id)` | for personal: the sole member; for shared: initial owner |
| `theme` | jsonb | shared tier-1 theme tokens/override CSS (D18) |
| `created_at` / `updated_at` | timestamptz | |

Relationships: `memberships`, `docs`, `folders`, `tasks`, `per_user_state` all FK `vault_id → vaults(id) ON DELETE CASCADE`.

### `memberships`
The ACL on a vault (D7). Personal vaults have exactly one row (owner).

| column | type | notes |
|---|---|---|
| `vault_id` | uuid → `vaults(id)` | |
| `user_id` | uuid → `users(id)` | |
| `role` | text NOT NULL | `'owner' \| 'member'` |
| `invited_by` | uuid → `users(id)` | nullable |
| `created_at` | timestamptz | |
| PK | `(vault_id, user_id)` | |

Index on `(user_id)` for "list my vaults". Role semantics (D7): **member** = read + write all content (notes, tasks); **owner** = member + vault administration (membership management, transfer, delete, theme/settings). **No viewer/read-only role** — everyone with access can edit, so there is no read-only connection tier.

### `docs`
Metadata for a note. CRDT bytes live in `yjs_docs`; this row carries identity, path, and kind. Doc **identity is the `id`** — path is mutable (rename preserves `id`, D12).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | stable Doc identity |
| `vault_id` | uuid NOT NULL → `vaults(id)` | |
| `path` | text NOT NULL | vault-relative, e.g. `projects/q2/roadmap.md` |
| `kind` | text NOT NULL | `'note' \| 'daily'` |
| `created_at` / `updated_at` | timestamptz | |
| UNIQUE | `(vault_id, path)` | one doc per path |

Folders are **not** implicit in `path` — they have their own identity rows (see [`folders`](#folders)) because `tasks.area` references a folder by stable id (D27). The file tree is derived from `folders` + `docs.path`. `kind='daily'` marks `DD-MM-YYYY.md` daily notes (the daily-note stub heuristic and archival live client/agent-side; the row just tags kind).

### `folders`
Stable identity for folders (D27) — required because `tasks.area` and folder-typed refs store a **folder id**, never a path. Renaming a folder updates `path` here (plus contained `docs.path` prefixes and prose-link rewrites via the rename machinery); every task whose `area` points at it follows automatically, with zero task-record writes.

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
Point-in-time CRDT states forming the history timeline (D3 — snapshots replace git commits) **and the merge-safety net** (D26).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `doc_id` | uuid NOT NULL → `docs(id) ON DELETE CASCADE` | |
| `state` | bytea NOT NULL | Yjs snapshot bytes |
| `taken_at` | timestamptz NOT NULL | |
| `reason` | text | `'interval' \| 'manual' \| 'pre-rename' \| 'pre-agent-write' \| 'pre-offline-merge' \| 'pre-reconcile'` etc. |
| `label` | text | human-readable auto-label for risky-op snapshots, e.g. *"before Claude edited"*, *"before your offline changes merged"* (D26) |
| `author_id` | uuid → `users(id)` | best-effort last editor at snapshot time |

Index on `(doc_id, taken_at DESC)` for timeline reads and restore.

**Auto-labeled snapshots (D26):** before risky operations — an agent bulk-write, reconciling a long-offline session, an agent reconcile itself — the server appends a snapshot with `reason` + `label` set, so the timeline offers one-click restore points at exactly the moments merges can garble. These snapshots are also what the **agent-reconcile 3-way is reconstructed from**: base / mine / theirs for the one-click reconcile flow come from the snapshot timeline, not from any separate merge store (D26).

### `tasks`
The full Task record (D4) — the authoritative shape mirrors `packages/shared`'s `Task`.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `vault_id` | uuid NOT NULL → `vaults(id)` | |
| `title` | text NOT NULL | |
| `status` | text NOT NULL | `'todo' \| 'doing' \| 'done'` (D-glossary) |
| `area` | uuid → `folders(id)` | **stable folder id** — settable, drives swim lanes; rendered as the folder's current path client-side (D4a, D27) |
| `due` | date | `YYYY-MM-DD` |
| `priority` | text | `'low' \| 'medium' \| 'high'` |
| `tags` | text[] | |
| `reminder` | text | `Nd` \| `Nw` \| absolute `YYYY-MM-DDTHH:MM` (D19) |
| `reminded_at` | timestamptz | server-written; last fire time (re-arm bookkeeping) |
| `recurrence` | jsonb | `Recurrence` rule (`frequency, interval, weekdays[], endDate`) |
| `related` | jsonb | `RelatedRef[]` — unified `note \| task \| email \| event`, each holding a **stable id** (doc id / task id / email id / event id), never a path; rendered as the current path/title client-side (D4, D27) |
| `completed_at` | timestamptz | set on transition to `done` (drives roll-forward) |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(vault_id, status)` for the board; `(vault_id, area)` for swim lanes. Note `related` is one unified list (replaces the old four arrays + `source_file`). Because `area` and `related[]` hold stable IDs, **renames never touch task rows** (display just re-resolves), and **deletes never cascade through refs** — a dangling id renders as a tombstone ("[deleted note]") client-side (D27).

### `reminders`
Derived/scheduled fire times the server-side evaluator consumes (D19). Kept as a materialized projection of `tasks.reminder` so the scheduler queries a small, indexed table instead of scanning tasks.

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
**UI prefs only** (D6): per-user, per-vault, synced across that user's devices, invisible to the team. A generic key→value store.

| column | type | notes |
|---|---|---|
| `user_id` | uuid → `users(id)` | |
| `vault_id` | uuid → `vaults(id)` | |
| `key` | text | e.g. `ui/prefs`, `ui/color-mode` |
| `value` | jsonb (or text) | |
| `updated_at` | timestamptz | |
| PK | `(user_id, vault_id, key)` | |

Holds **UI prefs** (incl. per-user light/dark, D18) and nothing else. **Personal agent config — USER.md, personal skills — is machine-local and never synced** (Claude Code's native `~/.claude` / `CLAUDE.local.md` layering, D6); it does not live in this table or anywhere on the server. **No chat-history pointers here either** — conversation history is client-local via native `--resume` (D9).

### Conversation history — *not a server table* (D9)

**There is no server-side conversation store — and no Holi conversation subsystem at all** (D9). Chat history *is* Claude Code's native `--resume` session picker: conversations stay local to the machine that ran them, never synced, replayed at full fidelity in the terminal. The old `history_summaries` table, the JSONL reconstruction parser, the local summarizer job, `conversations.jsonl`, and the `conversation_search`/`session_search` ops are all deleted outright. (Document version history — Yjs snapshots — is a separate, server-side concern; see [`yjs_snapshots`](#yjs_snapshots).)

### `link_index` *(optional / derived)*
Denormalized `[[link]]` edges for O(1) backrefs and rename without scanning every Doc's CRDT text (D12).

| column | type | notes |
|---|---|---|
| `vault_id` | uuid → `vaults(id)` | |
| `src_doc_id` | uuid → `docs(id) ON DELETE CASCADE` | doc containing the link |
| `target_path` | text | the `[[folder/note.md]]` target (may dangle) |
| `occurrences` | int | count within the source doc |
| PK | `(src_doc_id, target_path)` | |

Rebuilt incrementally on `onStoreDocument` (parse the doc's text via the shared wiki-link grammar). Backed by an index on `(vault_id, target_path)`. If dropped, backrefs/rename fall back to scanning materialized CRDT text — correctness-equivalent, just slower.

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
- `vaults.setTheme({ vaultId, theme })` — owner; tier-1 (D18).
- `vaults.delete({ vaultId })` — owner; cascades.
- `vaults.listDocs({ vaultId })` → doc + folder metadata (the file tree source; folders are identity rows, D27).
- **(S)** `vaults.watchDocs({ vaultId })` → live doc-metadata changes (create/rename/delete) so the file tree updates without polling.

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
- `tasks.update({ taskId, patch })` — last-writer-wins per field (D4; tasks are not CRDTs).
- `tasks.complete({ taskId })` — transitions to `done`, triggers server-side recurrence roll-forward (D19).
- `tasks.link({ taskId, related })` / `tasks.unlink(...)` — mutate the unified `related[]`.
- `tasks.delete({ taskId })`.
- **(S)** `tasks.watch({ vaultId })` → live task upserts/deletes to every member so boards stay live (architecture §5).

The agent's MCP task ops (create/list/set/complete/link) proxy directly to these procedures, role-gated (D10). Together with `notes.rename`, they are the **entire v1 MCP op surface** (D10); calendar/mail ops join in phase 2 with the Google integration (D17). There are no conversation/session-search procedures anywhere — that subsystem is deleted (D9).

### `reminders`
- `reminders.listPending({ vaultId })` — introspection/debug.
- **(S)** `reminders.subscribe({ vaultId })` → **fire events pushed** to the client, which raises a native Electron notification (D19). This replaces the old client-side scheduler loop entirely.

### `notes` / `docs` (metadata; content is Yjs)
- `notes.create({ vaultId, path, kind })` → creates the `docs` row + an empty `yjs_doc`. Content editing happens over Hocuspocus, not here.
- `notes.rename({ vaultId, docId, newPath })` → **atomic, docs-only** server-side path change + `[[link]]` rewrite (see [Atomic note rename](#atomic-note-rename-docs-only)). Preserves `docId`; task records are untouched (D27).
- `notes.renameFolder({ vaultId, folderId, newPath })` → updates `folders.path` + contained `docs.path` prefixes + prose-link rewrites; `tasks.area` display follows automatically because it stores the folder **id** (D27).
- `notes.delete({ vaultId, docId })` — no ref cascades; dangling `related[]` ids render tombstones client-side (D27).
- `notes.backrefs({ vaultId, path })` → docs referencing this path (via `link_index`) — surfaced before delete.
- These are the metadata operations; the CRDT text itself is never sent through tRPC.

### `snapshots` (document version history, D3/D26)
- `snapshots.list({ docId })` → the timeline: `taken_at`, `reason`, **`label`**, `author_id` (labels surface the D26 auto-snapshot restore points: *"before Claude edited"* etc.).
- `snapshots.restore({ docId, snapshotId })` → materializes the snapshot as the current Yjs state (applied as a normal update so it merges/propagates) — the D26 one-click restore.
This is **document** history only; conversation history has no server surface (D9).

### `userState` (UI prefs)
- `userState.get({ vaultId, key })` / `userState.getAll({ vaultId })`.
- `userState.set({ vaultId, key, value })`.
- `userState.delete({ vaultId, key })`.
Backs **UI prefs only** (D6). USER.md and personal skills are machine-local, never synced (D6); chat/session pointers are client-local too (D9).

## Yjs persistence & history (Hocuspocus hooks, snapshots, restore)

Hocuspocus wires four hooks into this server:

- **`onAuthenticate(token, documentName)`** → resolves the session → user, resolves the Doc's `vault_id` (from `docs.id = documentName`), checks `memberships`. **Non-member ⇒ reject; member/owner ⇒ read-write connection** (D7, D20). No read-only connection tier — there is no viewer role, so every accepted connection can edit. Returns a **connection context** carrying `role` (owner vs member) for downstream vault-admin gating. The authoritative authz for every editing connection.
- **`onLoadDocument(documentName)`** → hydrate the Yjs doc from `yjs_docs.state`; if absent, initialize empty (paired with `notes.create`). Loads the awareness-free document; awareness is transient.
- **`onStoreDocument(documentName, document)`** → debounced write of the merged state back to `yjs_docs.state`; opportunistically refresh `link_index` for that doc (parse text via shared grammar) and bump `docs.updated_at`. **Snapshot policy:** append a `yjs_snapshots` row on an interval, on significant boundaries (e.g. `reason='pre-rename'` before a rename touches the doc), and — **auto-labeled** — before risky operations: agent bulk-writes and long-offline reconciles (`reason='pre-agent-write'` / `'pre-offline-merge'` with a human `label`, D26).
- **Awareness fan-out** — standard Hocuspocus awareness channel carries cursors/selections + doc-viewer presence (D20); ephemeral, never persisted.

**History timeline & restore.** `yjs_snapshots` ordered by `taken_at` is a Doc's version history (D3). A restore materializes a chosen snapshot as the current Yjs state (applied as a normal update so it merges/propagates, not a hard overwrite) — exposed via `snapshots.list` / `snapshots.restore`, with `label` surfacing the D26 restore points. Snapshots + object-storage exports are the backup story (no git, D3).

**Overlap detection & agent reconcile (D26).** When two concurrent edits that touched **overlapping ranges** merge (or a long-offline session reconciles), the doc gets a **non-blocking flag** — *"this merge may need a look — let Claude reconcile?"* Whether the server detects this during merge or the client does is an implementation choice (*open*). Accepting the prompt hands a git-style 3-way — **base / mine / theirs, reconstructed from `yjs_snapshots`** — to the user's local agent, which writes a clean reconciled version back through the bridge (taking its own `reason='pre-reconcile'` snapshot first). No conflict dialogs, ever (D21); this is recoverability + opt-in semantic repair, never a blocking UI.

## Reminders & recurrence (server-side eval/push)

**Reminder rules are pure functions in `packages/shared`** (ported from the old `services/reminder.rs` math): resolve `Nd`/`Nw` relative-to-`due` (09:00 anchor) or absolute `YYYY-MM-DDTHH:MM` into a concrete fire time; the pending predicate (open task ∧ reminder resolves ∧ `reminded_at < fire time`). The server is the *only* evaluator (D19) — no client scheduler.

**Evaluation loop** (successor to `reminder_scheduler.rs`):
1. On any task mutation touching `reminder`/`due`/`status`/`recurrence`, recompute that task's next `fire_at` and upsert/clear its `reminders` row.
2. A single loop sleeps until the earliest `fire_at WHERE NOT fired` across all vaults (indexed query), woken early by a change signal on mutation.
3. On fire: mark `fired`, write `tasks.reminded_at`, and **push** a fire event to that vault's members via `reminders.subscribe` (S). Clients raise the native notification.
4. First iteration doubles as the missed-reminder pass on boot (fire times already past → coalesced; a large backlog can collapse into one summary event, matching the old >5-missed behavior).
5. Invalid/due-less-relative reminders are inert, never errors (ported semantic).

**Recurrence roll-forward** runs **server-side on `tasks.complete`** (D19, replaces `services/recurrence.rs`): compute the next occurrence from the `Recurrence` rule (shared pure function), advance `due`, shift any absolute reminder by the due delta, clear `reminded_at`, reset `status` to `todo`, and recompute the `reminders` row. Because the pending predicate re-arms naturally, nothing is ever explicitly cleared beyond `reminded_at` on re-set (ported invariant).

## Atomic note rename (docs-only)

`notes.rename({ vaultId, docId, newPath })` is a single server operation (D12) — the reason rename is an MCP op, not a native `mv` — and it is **docs-only** (D27): it touches `docs.path` and CRDT link spans, nothing else. In one Postgres transaction:

1. **Authz + validation** — role ≥ member; validate `newPath` through the shared **path-safety** module (reject `..`/absolute/NUL; reassert vault containment); ensure `(vault_id, newPath)` is free.
2. **Identify affected docs** — query `link_index WHERE vault_id AND target_path = oldPath` (fallback: scan). These are the docs whose `[[oldPath]]` must become `[[newPath]]`.
3. **Rewrite links in CRDT space** — for each affected Doc, load its Yjs state, apply a **targeted Yjs update** that replaces the link occurrences (via the shared wiki-link grammar), and persist the new state. Concurrent edits to unaffected regions of those docs still merge (CRDT); this touches only the link spans.
4. **Move the doc** — update `docs.path = newPath` for `docId` (**identity `docId` preserved** — no new Doc, no lost history/snapshots).
5. **Update `link_index`** and take a `reason='pre-rename'` snapshot of touched docs for the timeline.

Live Hocuspocus rooms for the touched docs receive the update through the normal relay path, so open editors reflect the rewrite. **No task-record rewrite** — `tasks.related[]` and `tasks.area` store stable IDs, so their rendered paths simply re-resolve; the scary cross-subsystem (Yjs + SQL) atomic transaction evaporates (D27).

**Folder rename** (`notes.renameFolder`) is the same shape one level up: update `folders.path` (id preserved), update contained `docs.path` prefixes, rewrite prose links to the moved docs via the same machinery. Every task whose `area` points at the folder id follows automatically for display — zero task writes (D27).

**Deletes** don't cascade through refs: a deleted doc/task leaves dangling stable ids in `related[]`, which the client renders as tombstones ("[deleted note]") (D27).

## Authorization (where every check lives)

Authorization is **server-side and total** (D7, architecture §9). Two enforcement points, one source of truth:

- **tRPC middleware** — a vault-scoped middleware resolves `{ user, vault, role }` from the session + `memberships` and gates per procedure: **any member reads and writes content procedures** (notes, tasks); **owner-only** for membership management / transfer / delete / theme (D18). No procedure trusts a client-supplied role.
- **Hocuspocus `onAuthenticate`** — the *same* membership resolution for every WebSocket; members and owners get read-write connections; non-members are rejected. No read-only tier.

The **agent's MCP ops are gated by the identical boundary** (D10): the MCP server in Electron main holds a per-run bearer token, but it calls these tRPC procedures as an authenticated user — so it can never grant itself more than the user's role. There is no second permission system (safe/power_user is gone, D10). `memberships` is the one ACL; every path funnels through it.

## packages/shared (what's shared, no codegen)

The security- and correctness-critical domain, imported verbatim by **both** server and client (D14, D15) — types are the source, no ts-rs / no codegen:

- **`Task`, `Recurrence`, `Reminder`, `RelatedRef`, `Status`, `Role`, `Doc`/`DocKind`, `Folder`, `Vault`/`VaultKind`** — the record shapes the tables mirror and the tRPC procedures accept/return. `RelatedRef` carries a **stable id** per kind (D27).
- **Wiki-link grammar** — one parser (ports `vaultRefs.ts`); used by the editor renderer, the agent's link authoring, `link_index` construction, and the rename rewrite. Single source, thin renderers.
- **Path-safety** — reimplement `resolve_relative` / `VaultPath` containment **test-first** (reject `..`/absolute/NUL, canonicalize through the closest existing ancestor, reassert vault containment). Guards `notes.rename`, `notes.create`, the file bridge, and any agent-supplied path. First-class module, security-critical (architecture §9).
- **Recurrence + reminder pure functions** — the `Nd`/`Nw`/absolute resolution and roll-forward math (ported from the well-tested Rust). The server's evaluator and the client's display both call these; identical results by construction.
- **Prompt content / memory budgets** — the `agent_context` strings, USER.md (4000) / MEMORY.md (5000) char budgets and fill-indicator logic, consumed by the `UserPromptSubmit` hook (D8). (USER.md itself is machine-local, D6 — only the budget/fill logic is shared.)

## Scaling & backup

- **Snapshots** are the version history, part of backup (D3), *and* the merge-safety net (D26): `yjs_snapshots` interval + boundary + auto-labeled risky-op snapshots per Doc; prune policy TBD (keep recent dense, thin older; labeled risky-op snapshots likely outlive interval ones — *open*).
- **Object storage (Hetzner, D28)** holds **archived original binaries** from import conversion (phase 2 — the vault is markdown-first: PDFs/Word files convert to markdown on entry, the original is archived and fetchable on demand, never a working format) and **backup exports** (periodic Postgres dumps + Yjs state exports). Archived originals referenced by object key; served via signed URLs.
- **Postgres** is the transactional core; `yjs_docs.state` (bytea) can grow — large docs may warrant TOAST tuning or moving cold state to object storage (*open*).
- **WebSocket scaling** *(flag: open)* — a single Hocuspocus process caps at one node's connections. Horizontal scale needs a shared awareness/broadcast layer (Hocuspocus + Redis pub/sub extension, or a room-affinity load balancer) so clients in the same Doc room reach the same authority. Not needed at Syv's initial headcount; called out as the first scaling wall.
- **tRPC subscriptions** (tasks/reminders/doc-metadata) fan out per-vault; at multi-node they need the same shared pub/sub as awareness (*open*).

## Edge cases & risks

- **Snapshot growth vs restore fidelity** — too-sparse snapshots lose granular history; too-dense bloats storage. Policy is *open*. (The D26 auto-labeled snapshots add rows only at risky-op boundaries, so they don't move the growth needle much — but the 3-way reconcile depends on the pre-op snapshot existing, so risky-op snapshotting must be unconditional.)
- **`link_index` drift** — if incremental updates miss an edit, backrefs/rename under-match. Mitigate with a periodic reconcile scan; correctness fallback is full-text scan of CRDT state.
- **Rename vs concurrent edit of a link span** — if a user is mid-typing exactly over a `[[link]]` while rename rewrites it, the CRDT converges with both edits surviving adjacently (acceptable, same as any co-edit; D2/D12, spike-verified) — with the D26 overlap flag + snapshot restore as the net.
- **Reminder timezone anchoring** — the 09:00 anchor and absolute local times must resolve against a consistent tz; server must know the user/vault timezone (*open* — likely per-user in `per_user_state`).
- **Task last-writer-wins** — two members editing the same task field concurrently: last write wins per field (accepted for small structured records, D4); no CRDT merge for tasks.
- **Offline reminders** — a client offline at fire time gets the event on reconnect via the subscription replay of `fired`-but-unacked events (*open*: ack/dedup semantics).

## Dependencies (all other PRDs depend on this)

This PRD is the reference; the key downstream dependencies:

- **Tasks / board PRD** → `tasks` table (stable-ID `area`/`related[]`, D27), `folders` for lane identity, `tasks.*` procedures + `tasks.watch` (S), reminders/recurrence eval (D4, D4a, D4b, D19, D27).
- **Editor / notes PRD** → `docs`/`folders`/`yjs_docs`/`yjs_snapshots` (+ labels), Hocuspocus hooks + awareness, `notes.rename`/`notes.renameFolder` atomicity, `snapshots.list`/`restore`, the overlap-detection flag + agent reconcile, `link_index`, wiki-link grammar (D1, D12, D20, D26, D27).
- **Agent PRD** → MCP ops proxying to `tasks`/`notes.rename` (the whole v1 surface, D10), role gating, per-turn context content, the D26 reconcile flow. `per_user_state` is UI prefs only — USER.md/personal skills are machine-local (D6); conversation history is native `--resume`, client-local, no server table or search ops (D5, D8, D9, D10, D26).
- **Client shell / sync PRD** → `auth`/`session`, `vaults`/`membership`, the WebSocket + tRPC transports, sync-status semantics, offline replay (D7, D13, D21).
- **`packages/shared`** → consumed by every PRD; changes here ripple to both apps (D15).

## Open questions

- **Snapshot retention/pruning** policy (dense-recent, thin-old vs fixed cadence; how long labeled risky-op snapshots outlive interval ones).
- **Overlap detection placement** (D26) — does the server detect overlapping-range concurrent merges during Yjs merge, or does the client flag them? Implementation open.
- **WebSocket horizontal scaling** — Redis pub/sub extension vs room-affinity LB; when to build (post-v1 likely).
- **Timezone source** for reminder anchoring — per-user vs per-vault, stored where.
- **Archived-original lifecycle** (D28, phase 2) — import upload path, GC of unreferenced objects, size limits.
- **Offline reminder delivery** — ack/dedup so a client offline across a fire doesn't miss or double-fire.
- **`link_index` as source of truth vs pure derived cache** — do we ever trust it without a reconcile pass?
- **Session-token lifetime / refresh** and revocation on membership removal (immediate vs TTL).
