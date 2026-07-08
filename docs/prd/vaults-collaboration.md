# PRD — Vaults, Collaboration, Sync & Offline

Owns the vault as a collaborative container: what it is, its lifecycle, the folder hierarchy, how working copies materialize, and how real-time collaboration, offline, history, and backup work end-to-end. Decisions cited as **D#** live in [`../decisions.md`](../decisions.md). This PRD leans on sibling PRDs for the mechanics it doesn't own — see [Dependencies](#dependencies).

---

## Summary

A **vault** is a server-owned container of documents, tasks, and agent config (glossary). Every vault — **personal** or **shared** — is backed by the same Syv relay + Postgres (D13); there is no local-only vault kind. Notes are **Yjs CRDTs** synced through a Hocuspocus relay (D1); tasks are structured server records synced via tRPC (D4, owned by server-data PRD). Clients hold a local Yjs cache for **offline** work that auto-merges on reconnect (D21). The agent edits **materialized `.md` working copies** on disk, reconciled to the CRDT through a diff-based **file↔CRDT bridge** (D2). **Presence** (remote cursors + doc-viewer avatars) rides the Yjs awareness channel (D20). History is a **Yjs snapshot timeline** with restore; backup is Postgres + object storage (D3).

This replaces the old model wholesale: **no git sync, no local SQLite vault registry, no client-minted UUIDs, no whole-vault link-rewrite conflicts** (D3, §10 architecture). Sign-in is required to use Holi; offline is served from cache (D13).

---

## Goals / Non-goals

**Goals**
- Google-Docs-style concurrent editing of notes with live presence, per vault (D1, D20).
- One sync engine for personal and shared vaults; single code path (D13).
- Lazy materialization of working copies so the agent and editor get native files without scanning or syncing the whole vault (§2 architecture).
- A file tree driven by **server metadata** (paths), not by scanning disk.
- Offline-first: edit while disconnected, auto-merge on reconnect, no manual conflict resolution (D21).
- Server-authoritative history (snapshots + restore) and durable backup, replacing git (D3).
- Vault-level membership that **sync respects**: viewers get read-only Yjs (D7, §3 architecture).

**Non-goals**
- Auth mechanics, role definitions, and membership-management UI — deferred to the **auth-identity** PRD (this PRD only states how sync *honors* roles).
- The editor/CRDT binding internals, remote-cursor rendering, wiki-link grammar — **notes-editor** PRD.
- Task records, task sync, reminders, board — **server-data** PRD.
- The agent runtime, PTY, MCP ops, chat history — **agent** PRD.
- Content **import/migration** — none in v1 (D16); a "import a markdown folder" path is deferred.
- A git *export* mirror (D3, deferred).
- Per-user theme overrides; agent theme proposals (D18, deferred).

---

## User stories

- As an employee, I sign in with my Google Workspace account and see the vaults I'm a member of, plus my personal vault (D7, D13).
- As a member, I open a shared note and see who else is viewing it (avatars) and where their cursors are, and my edits and theirs merge live without conflicts (D20, D1).
- As a viewer, I can open and read any doc in the vault but the editor is read-only and my agent cannot write (D7, D10).
- As a user on a plane, I keep editing my notes offline; when I reconnect, everything merges automatically and the status indicator flips from *offline* to *synced* — I'm never shown a conflict dialog (D21).
- As a user, I switch between my laptop and desktop and my personal vault is already in sync on both (D13).
- As a vault owner, I create, rename, and delete a vault, and add/remove members (membership UI in auth-identity PRD).
- As a member, I **leave** a shared vault I no longer need without deleting it for others.
- As a user, I browse a doc's history timeline and restore an earlier version (D3).
- As a user, my agent edits a note file directly and other people's concurrent edits to other parts of that note survive (D2).

---

## Functional requirements

### Vault model & identity
- A vault has a server-assigned id (**not** client-minted — kills the old `crypto.randomUUID()` in `useVaults.ts`), a `name`, a `kind` (`personal | shared`), an `owner`, a `theme`, and timestamps.
- **Personal vault:** single member (the owner); same Yjs + tRPC backing as shared (D13). Auto-provisioned for a user on first sign-in.
- **Shared vault:** a membership list with roles `owner | member | viewer` (D7; managed in auth-identity PRD).
- A vault carries a real **folder/path hierarchy** — needed for wiki-links, the file tree, and task `area` (D4a, D12). Folder structure is **server metadata**, not derived from disk.

### Vault lifecycle
- **Create:** owner names a vault → server allocates the id, creates the vault + owner membership + an empty root. No git init, no remote creation (contrast old `createVault`: slug → path → `gitInit` → `gitCreateGithubRepo`/`gitSetRemote` → `gitSyncStart`, all deleted).
- **Rename:** updates vault `name` (server metadata). Distinct from `note_rename` (a doc-path operation, D12, notes-editor PRD).
- **Delete:** owner-only; removes the vault, its docs/snapshots, task records, and memberships server-side, and tears down local caches/working copies on every member's next sync.
- **Leave:** a member/viewer removes their own membership; the vault persists for others. (Owner can't leave without transferring ownership — mechanics in auth-identity PRD.)
- No local registry to keep coherent: the client's vault list is a server query (replaces the old SQLite registry + `getVaults` local read).

### Folder hierarchy & file tree
- The file tree is rendered from **server metadata** (doc paths + folder structure), not by walking disk. This replaces the old `scanVaultMetadata` / `listDirectoryTree` disk walks and the `collectVaultPaths` tree-flatten in `vault.ts`.
- Holi-managed root files (`AGENTS.md`, `MEMORY.md`, `USER.md`, the `CLAUDE.md` shim, theme) are hidden from the tree by default, per tier (D6); ports the old `VAULT_MANAGED_FILES` filter concept into the metadata layer.
- Task files are gone: **no `.holi/tasks/` directory**, no `is_task_path`, no task-count-per-file badges derived from wiki-links (D4). The `.holi/tasks/*.md` layout in `vault_layout.rs` is deleted.

### Documents & materialization (working copies)
- Each note is a **Yjs Doc** with a vault-relative path (glossary). Server is the durable source of truth.
- A client **materializes** a Doc as a plain `.md` **working copy** on disk under a per-vault working dir the agent's `claude` process is pointed at (§2 architecture).
- Materialization is **lazy (scoped)**: open docs + recently-touched + anything the agent is pointed at — never the whole vault — to bound disk and watcher count.
- Working copies are **not authoritative and not version-controlled** (glossary). No `.git`, no `.gitignore` sync-filter.

### Real-time collaboration
- Clients connect to the relay over WebSocket, authenticated with the session token (Hocuspocus `onAuthenticate`), and exchange Yjs updates for the docs they have open (D1).
- **Awareness/presence (D20):** remote **cursors/selections** in the editor and **doc-viewer avatars** ("who's here") over the standard Hocuspocus awareness channel. (Rendering owned by notes-editor PRD.)
- **File↔CRDT bridge (D2):** runs in Electron main, both directions —
  - *CRDT → file:* on remote update, re-materialize the working copy (debounced; skip while the agent has an in-flight write).
  - *file → CRDT:* watch working copies (chokidar); on change, **diff** new text against current CRDT text and apply the minimal Yjs ops. **Never blind-replace** — this is what preserves concurrent edits to other regions. A full-document agent `Write` becomes a diff-merge.
- **Staleness** is handled by Claude Code's native read-before-edit guard: `Edit`/`Write` require a prior `Read` and fail if the file changed since, so an agent write can't silently clobber a fresh remote edit — Claude re-reads and retries (D2).

### Offline
- Each client persists its Yjs docs to a **local store** (e.g. `y-indexeddb` in renderer, or leveldb-backed in main) (§2 architecture).
- Offline edits are ordinary Yjs updates queued locally; on reconnect they **replay and auto-merge** with no user intervention (D21).
- The only offline UI is a **sync-status indicator**: `synced | offline | syncing`. **Never a conflict-resolution dialog** (D21).
- Sign-in is required to *use* Holi, but a signed-in user works offline from cache; a first-ever launch with no cache and no network can't materialize a vault (see Edge cases).

### History & backup
- **History = Yjs snapshots (D3):** Hocuspocus `onStoreDocument` writes CRDT state and periodic snapshots to Postgres, forming a per-doc timeline (§2 architecture). `onLoadDocument` hydrates.
- **Restore:** a user can browse the timeline and restore an earlier snapshot; restore is a server-side operation that produces a new CRDT state (not a destructive rewind of shared truth — exact restore semantics in Open questions).
- **Backup = server persistence:** Postgres (snapshots, doc state) + object storage (attachments, backups). No GitHub-as-backup (D3, cost accepted).

### Membership & sync authorization
- Authorization is **server-side and total**: every tRPC call and every Yjs WebSocket connection is checked against membership + role (§3, §9 architecture).
- **Viewers get read-only Yjs connections** — the relay rejects/ignores their updates; the editor is read-only (D7).
- The **agent's MCP ops are gated by the same role** (viewer = read, member = write, owner = all) — the client can't grant itself more than the user has (D10). Enforcement point is server-side; detailed in agent PRD.
- Role definitions and the membership-management surface live in the **auth-identity** PRD; this PRD only asserts that sync respects them.

---

## Data & types

Types live in `packages/shared` (imported by desktop and server, no codegen — D14/D15). Server tables are **owned by the server-data PRD**; referenced here, not redefined.

- **`Vault`** (shared type): `{ id, name, kind: 'personal' | 'shared', ownerId, theme, createdAt, updatedAt }`. Server-assigned `id`.
- **`Membership`** (auth-identity/server-data): `{ vaultId, userId, role: 'owner' | 'member' | 'viewer' }`.
- **`DocMeta`** (server metadata driving the file tree): `{ id, vaultId, path, kind: 'note' | 'daily', createdAt, updatedAt }`.
- **Path-safety** (`packages/shared`): the `VaultPath` newtype + `resolve_relative` containment logic, reimplemented **test-first** in TS (reject `..`/absolute/NUL, canonicalize through closest existing ancestor, reassert containment). Security-critical — guards the file bridge and any path from agent/renderer (§9 architecture).
- **Sync-status** (renderer state, Jotai): `'synced' | 'offline' | 'syncing'` per vault/connection.

Server tables (see **server-data** PRD): `vaults`, `memberships`, `docs`, `yjs_docs` / `yjs_snapshots`, `users`. Object storage: attachments + doc snapshots/backups.

---

## UX / flows

**Sign-in → vault list.** User signs in (Google SSO, auth-identity PRD) → client queries the server for memberships → renders the vault list (personal + shared). No local registry read; no onboarding "git remote" field (deleted).

**Open a note.**
1. User clicks a doc in the (server-metadata-driven) file tree.
2. Client opens the Yjs Doc (from local cache immediately if present, syncing in background), materializes the working copy on disk.
3. Editor binds to the Doc; awareness shows co-viewers' avatars and cursors.
4. Sync-status indicator reflects connection state.

**Concurrent edit.** Two members type in the same doc → CRDT merges character-level; non-overlapping edits merge cleanly, overlapping same-character edits resolve last-writer (like two Google-Docs cursors, D2). No dialog.

**Agent edit.** Agent `Read`s then `Edit`s a working copy → chokidar sees the change → bridge diffs → applies minimal Yjs ops → relay fans out to other clients. Other members' concurrent edits to other regions survive (D2).

**Go offline → reconnect.** Connection drops → indicator flips to *offline* → edits queue locally → on reconnect indicator shows *syncing* → queued updates replay and auto-merge → *synced*. Zero user interaction (D21).

**History / restore.** User opens a doc's history → sees the snapshot timeline → selects a version → previews → restores. Restore updates the CRDT (semantics: Open questions).

**Leave / delete.** Member picks "Leave vault" → membership removed → vault disappears from their list, caches torn down. Owner picks "Delete vault" → confirm → server deletes; other members lose it on next sync.

---

## Client / server responsibilities

**Client (`apps/desktop`)**
- Owns the **live editing experience**: Yjs doc store, offline cache, awareness, sync-status indicator.
- Runs the **file↔CRDT bridge** and lazy **materialization** in Electron main (chokidar watchers, debounced re-materialize, diff-to-CRDT).
- Renders the **file tree from server metadata** (not disk scan).
- Composes and points the agent's `claude` at the working-copy dir (agent PRD).
- Vault list, lifecycle actions (create/rename/delete/leave) are tRPC calls; no local vault DB.

**Server (`apps/server`)**
- **Hocuspocus relay:** durable CRDT truth, update fan-out, awareness channel, `onStoreDocument`/`onLoadDocument` persistence, snapshot timeline.
- **tRPC API:** vault CRUD, membership, doc metadata/path operations, history/restore.
- **Authorization:** every tRPC + Yjs connection checked against membership/role; viewers → read-only Yjs; agent MCP ops role-gated (§9 architecture).
- **Persistence/backup:** Postgres (Yjs state + snapshots + metadata) + object storage.

**Shared (`packages/shared`)**: `Vault`/`Membership`/`DocMeta` types, path-safety, wiki-link grammar — the seam that keeps both sides honest (§1 architecture).

---

## Edge cases & risks

- **Cold offline start.** Signed-in but no local cache and no network → can't hydrate a vault. Show an explicit "can't reach Syv, no cached copy" state, not an empty/broken tree. (D13: offline works *via cache* — first-touch of a doc requires having synced it once.)
- **Bridge race: agent write vs incoming remote update.** CRDT→file re-materialize must be suppressed while an agent write is in-flight; file→CRDT must diff (not replace) so a remote edit landing mid-agent-edit survives. Debounce + in-flight guard (§2 architecture). Risk: watcher event ordering; needs careful sequencing.
- **Full-document `Write`.** Agent replacing an entire file must become a diff-merge against current CRDT, or it clobbers concurrent edits. The bridge's "never blind-replace" rule is load-bearing (D2).
- **Live-preview under a remote-edit stream.** With the animation morph removed (**D22**), this is no longer a risk: a remote `docChanged` just re-decorates, and the active-line reveal follows the `yCollab`-mapped caret. No origin-sensitive animation path to guard (owned by notes-editor PRD).
- **Viewer trying to write.** Read-only Yjs must reject at the relay, not just gray out the UI; the agent's write ops must fail server-side for viewers (D7, D10).
- **Materialization eviction.** Lazy scope needs an eviction policy so working copies/watchers don't grow unbounded across a long session (see Open questions).
- **Deleted-vault teardown.** A member offline when a vault is deleted must have local caches/working copies safely torn down on reconnect without data-loss surprises.
- **JSONL / snapshot volume.** Snapshot cadence trades history granularity against Postgres/object-storage growth; needs a retention policy (Open questions).
- **Path-safety regressions.** Any path from the agent/renderer flows through the bridge; a containment bug is a vault-escape. Treat `packages/shared` path-safety as first-class, test-first (§9 architecture).

## What's explicitly deleted from the old model
- **Git sync** entirely: `git_sync.rs` auto-commit (30 s) / auto-push (5 min) / never-pull, `.gitignore` sync-filter, `gh repo create`, `gitInit`/`gitSetRemote`/`gitCreateGithubRepo`/`gitSyncStart` in `useVaults.createVault` (D3).
- **Local SQLite vault registry** and the local `getVaults`/`saveVault` path — vault list is now a server query.
- **Client-minted vault UUIDs** (`crypto.randomUUID()` in `useVaults.ts`) — ids are server-assigned.
- **Whole-vault link-rewrite conflicts** — rename is one atomic server-side pass over affected CRDT docs (D12), not N git clients colliding.
- **Disk-scan file tree** (`scanVaultMetadata`, `listDirectoryTree`, `collectVaultPaths`, `vault_layout.rs`'s `.holi/tasks/` machinery) — replaced by server metadata.
- **Local-only personal vaults** — all vaults are server-backed (D13).

---

## Dependencies

- **auth-identity** — sign-in (Google SSO), the `Membership`/role model, membership-management UI, ownership transfer. This PRD consumes roles but doesn't define them (D7).
- **server-data** — Postgres tables (`vaults`, `memberships`, `docs`, `yjs_docs`/`yjs_snapshots`), task records, the tRPC surface. Owns the schema this PRD references (D4, D14).
- **notes-editor** — the CodeMirror + `y-codemirror.next` binding, remote-cursor/awareness rendering, wiki-link grammar + `note_rename` (D12, D20).
- **agent** — the PTY/`claude` runtime pointed at working copies, MCP op role-gating, config tiers (D5, D6, D10).

---

## Open questions

- **Restore semantics.** Does restoring a snapshot append a new CRDT state (non-destructive, preferred) or rewind? How is it reconciled with clients currently editing that doc?
- **Materialization eviction policy.** What's the concrete rule for evicting working copies/watchers (LRU by open/touch time? explicit close?) to keep disk + chokidar bounded?
- **Snapshot cadence & retention.** How often does `onStoreDocument` snapshot, and what's the retention/compaction policy for the timeline vs storage growth?
- **Local Yjs store location.** Renderer `y-indexeddb` vs main-process leveldb — where does the offline cache live, given the bridge and agent run in main? (Architecture lists both as options.)
- **Personal-vault provisioning.** Exact trigger and default contents (empty? seeded persona/theme?) when a user's personal vault is auto-created on first sign-in.
- **Presence granularity for viewers.** Do read-only viewers broadcast awareness (appear as avatars/cursors) or observe silently? (D20 implies they're "here"; confirm.)
- **Offline task edits.** Tasks aren't CRDTs (D4) — is offline task mutation queued and last-writer-merged, or read-only while offline? (Coordinate with server-data PRD.)
