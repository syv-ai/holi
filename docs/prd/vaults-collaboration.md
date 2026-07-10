# PRD — Vaults, Collaboration, Sync & Offline

Owns the vault as a collaborative container: what it is, its lifecycle, the folder hierarchy, how working copies materialize, and how real-time collaboration, offline, history, and backup work end-to-end. Decisions cited as **D#** live in [`../decisions.md`](../decisions.md). This PRD leans on sibling PRDs for the mechanics it doesn't own — see [Dependencies](#dependencies).

---

## Summary

A **vault** is a server-owned container of documents, tasks, and agent config (glossary). Every vault — **personal** or **shared** — is backed by the same Syv relay + Postgres (D13); there is no local-only vault kind. Notes are **Yjs CRDTs** synced through a Hocuspocus relay (D1); tasks are structured server records synced via tRPC (D4, owned by server-data PRD). Clients hold a local Yjs cache for **offline** work that auto-merges on reconnect (D21). The agent edits **materialized `.md` working copies** on disk, reconciled to the CRDT through a **file↔CRDT bridge** running a frozen-base **turn protocol** (D2, D25). **Presence** (remote cursors + doc-viewer avatars) rides the Yjs awareness channel (D20). History is a **Yjs snapshot timeline** with restore; backup is Postgres + object storage (D3). Garbled-but-converged merges are covered by the **merge safety net** — auto-labeled snapshots + one-click agent reconcile (D26).

This replaces the old model wholesale: **no git sync, no local SQLite vault registry, no client-minted UUIDs, no whole-vault link-rewrite conflicts** (D3, §10 architecture). Sign-in is required to use Holi; offline is served from cache (D13).

---

## Goals / Non-goals

**Goals**
- Google-Docs-style concurrent editing of notes with live presence, per vault (D1, D20).
- One sync engine for personal and shared vaults; single code path (D13).
- Full active-vault materialization so the agent's native `Grep`/`Glob`/`Read` and the editor get real files across the whole vault (D23, §2 architecture).
- A file tree driven by **server metadata** (paths), not by scanning disk.
- Offline-first: edit while disconnected, auto-merge on reconnect, no manual conflict resolution (D21).
- Server-authoritative history (snapshots + restore) and durable backup, replacing git (D3).
- Vault-level membership that **sync respects**: members & owners get read-WRITE Yjs, non-members are rejected — no read-only tier (D7, §3 architecture).

**Non-goals**
- Auth mechanics, role definitions, and membership-management UI — deferred to the **auth-identity** PRD (this PRD only states how sync *honors* roles).
- The editor/CRDT binding internals, remote-cursor rendering, wiki-link grammar — **notes-editor** PRD.
- Task records, task sync, reminders, board — **server-data** PRD.
- The agent runtime, PTY, MCP ops, chat history — **agent** PRD.
- Content **import/migration** — none in v1 (D16); a "import a markdown folder" path is deferred. When import lands (phase 2), it follows **markdown-first ingestion** (D28): binaries convert to markdown on entry, originals archive to object storage.
- A git *export* mirror (D3, deferred).
- Per-user theme overrides; agent theme proposals (D18, deferred).

---

## User stories

- As an employee, I sign in with my Google Workspace account and see the vaults I'm a member of, plus my personal vault (D7, D13).
- As a member, I open a shared note and see who else is viewing it (avatars) and where their cursors are, and my edits and theirs merge live without conflicts (D20, D1).
- As a user on a plane, I keep editing my notes offline; when I reconnect, everything merges automatically and the status indicator flips from *offline* to *synced* — I'm never shown a conflict dialog (D21).
- As a user, I switch between my laptop and desktop and my personal vault is already in sync on both (D13).
- As a vault owner, I create, rename, and delete a vault, and add/remove members (membership UI in auth-identity PRD).
- As a member, I **leave** a shared vault I no longer need without deleting it for others.
- As a user, I browse a doc's history timeline and restore an earlier version (D3).
- As a user, my agent edits a note file directly and other people's concurrent edits to other parts of that note survive (D2).

---

## Functional requirements

### Vault model & identity
- A vault has a server-assigned id (**not** client-minted — kills the old `crypto.randomUUID()` in `useVaults.ts`), a `name`, a `kind` (`personal | shared`), an `owner`, a `theme` (shared vault-wide, **owner-only edit** — D18), and timestamps.
- **Personal vault:** single member (the owner); same Yjs + tRPC backing as shared (D13). Auto-provisioned for a user on first sign-in.
- **Shared vault:** a membership list with two roles `owner | member` — both read+write all content; owner adds vault admin. **No viewer/read-only role** (D7; managed in auth-identity PRD).
- A vault carries a real **folder/path hierarchy** — needed for wiki-links, the file tree, and task `area` (D4a, D12). Folder structure is **server metadata**, not derived from disk. Machine references into that hierarchy (task `area`, task `related[]`) store **stable IDs**, resolved to the current path only for display, so folder renames cascade automatically (D27).

### Vault lifecycle
- **Create:** owner names a vault → server allocates the id, creates the vault + owner membership + an empty root. No git init, no remote creation (contrast old `createVault`: slug → path → `gitInit` → `gitCreateGithubRepo`/`gitSetRemote` → `gitSyncStart`, all deleted).
- **Rename:** updates vault `name` (server metadata). Distinct from `note_rename` — a **docs-only** operation that rewrites prose `[[…]]` links inside CRDT docs; task records reference notes/folders by stable ID and need no rewrite (D12, D27, notes-editor PRD).
- **Delete:** owner-only; removes the vault, its docs/snapshots, task records, and memberships server-side, and tears down local caches/working copies on every member's next sync.
- **Leave:** a member removes their own membership; the vault persists for others. (Owner must transfer ownership first — mechanics in auth-identity PRD.)
- No local registry to keep coherent: the client's vault list is a server query (replaces the old SQLite registry + `getVaults` local read).

### Folder hierarchy & file tree
- The file tree is rendered from **server metadata** (doc paths + folder structure), not by walking disk. This replaces the old `scanVaultMetadata` / `listDirectoryTree` disk walks and the `collectVaultPaths` tree-flatten in `vault.ts`.
- Holi-managed root files (`.claude/`, `AGENTS.md`, `MEMORY.md`, the `CLAUDE.md` shim, theme, `.holi/settings.json`) are **shared, synced vault content**, hidden from the tree by default (D6); ports the old `VAULT_MANAGED_FILES` filter concept into the metadata layer. **`USER.md` is no longer synced vault content** — the agent's model of you is personal and machine-local, alongside `~/.claude` and `CLAUDE.local.md` (D6). `.holi/settings.local.json` is likewise machine-local and **excluded from sync**.
- Task files are gone: **no `.holi/tasks/` directory**, no `is_task_path`, no task-count-per-file badges derived from wiki-links (D4). The `.holi/tasks/*.md` layout in `vault_layout.rs` is deleted.

### Documents & materialization (working copies)
- Each note is a **Yjs Doc** with a vault-relative path (glossary). Server is the durable source of truth.
- A client **materializes** Docs as plain `.md` **working copies** on disk under a per-vault working dir the agent's `claude` process is pointed at (§2 architecture).
- Materialization is **full for v1**: the client materializes the **whole active vault** to disk so the agent's native `Grep`/`Glob`/`Read` see every doc and the file tree reflects real files (D23). This holds **permanently** because the vault is **text by construction** (D28): binaries (PDF/docx) convert to markdown on entry, and the original binaries archive to Hetzner object storage — fetched on demand, **never eagerly synced or materialized**. Markdown vaults are tiny (MBs), so this is cheap. **Lazy/partial materialization** (open docs + recently-touched + agent-pointed only) is a **deferred optimization** for very large vaults.
- Working copies are **not authoritative and not version-controlled** (glossary). No `.git`, no `.gitignore` sync-filter.

### Real-time collaboration
- Clients connect to the relay over WebSocket, authenticated with the session token (Hocuspocus `onAuthenticate`), and exchange Yjs updates for the docs they have open (D1).
- **Awareness/presence (D20):** remote **cursors/selections** in the editor and **doc-viewer avatars** ("who's here") over the standard Hocuspocus awareness channel. (Rendering owned by notes-editor PRD.)
- **File↔CRDT bridge (D2, D25):** runs in Electron main and mediates **agent↔CRDT only** — human↔human editing is pure Yjs and never touches the filesystem. Reconciliation is the **turn protocol** (D25):
  1. Agent starts writing a doc → the bridge takes a **soft lock**: presence shows *"Claude is editing…"* and **CRDT→file re-materialization is paused** for that doc, freezing the **base** (the last-materialized text) so remote edits arriving mid-turn can't poison the diff.
  2. The agent edits the stable file freely — Claude Code's read-before-edit guard stays satisfied because the file doesn't move under it.
  3. On turn end/idle: compute `diff(base, file)` and apply the patch as **positioned Yjs ops** onto the *live* CRDT (which may now contain buffered remote edits) — a 3-way merge, like git. **Never blind-replace**; a full-document agent `Write` becomes a diff-merge.
  4. New base = merge result; re-materialize; release the lock.
- **Overlaps:** soft turn-taking makes human-vs-agent same-region collisions rare; when they do overlap, character-level last-writer resolves them (like two Google-Docs cursors), with the merge safety net (D26) as backstop.
- **De-risk:** the bridge is the **only genuinely novel component in the plan → Spike 1**, built and hammered (two clients + an agent on one doc) before any other code (D25).

### Offline
- Each client persists its Yjs docs to a **local store** (e.g. `y-indexeddb` in renderer, or leveldb-backed in main) (§2 architecture).
- Offline edits are ordinary Yjs updates queued locally; on reconnect they **replay and auto-merge** with no user intervention (D21).
- The only offline UI is a **sync-status indicator**: `synced | offline | syncing`. **Never a conflict-resolution dialog** (D21) — garbled-merge recovery is the merge safety net (D26), below.
- Sign-in is required to *use* Holi, but a signed-in user works offline from cache; a first-ever launch with no cache and no network can't materialize a vault (see Edge cases).

### Merge safety net (D26)
- **D21 holds — no conflict dialogs, ever.** Convergence-but-garbled merges are handled by recoverability plus semantic repair.
- **Auto-labeled snapshots** before risky operations — an agent bulk-write ("before Claude edited") or a long-offline reconcile ("before your offline changes merged") — one-click restorable from the history timeline (D3).
- **Overlap detection:** when Yjs merges concurrent edits that touched **overlapping ranges** (or reconciles a long-offline session), the doc gets a **non-blocking** flag — *"this merge may need a look — let Claude reconcile?"*
- **One-click agent reconcile:** accepting hands a git-style 3-way (**base / mine / theirs**, reconstructed from snapshots) to the user's **local** agent, which writes a clean reconciled version back through the bridge (with its own pre-snapshot). User-triggered — no silent rewrites, no token spend without opt-in.
- **History restore** (D3) is the always-on backstop.

### History & backup
- **History = Yjs snapshots (D3):** Hocuspocus `onStoreDocument` writes CRDT state and periodic snapshots to Postgres, forming a per-doc timeline (§2 architecture). `onLoadDocument` hydrates.
- **Restore:** a user can browse the timeline and restore an earlier snapshot; restore is a server-side operation that produces a new CRDT state (not a destructive rewind of shared truth — exact restore semantics in Open questions).
- **Backup = server persistence:** Postgres (snapshots, doc state) + Hetzner object storage (archived binary originals from import conversion — D28 — plus backups). No GitHub-as-backup (D3, cost accepted).
- The snapshot timeline also carries the **auto-labeled pre-risk snapshots** of the merge safety net (D26).

### Membership & sync authorization
- Authorization is **server-side and total**: every tRPC call and every Yjs WebSocket connection is checked against membership (§3, §9 architecture).
- **Members & owners get read-WRITE Yjs connections; non-members are rejected** by the relay. There is **no read-only tier** — everyone with access can edit (D7).
- The **agent's MCP ops are gated by the same membership** — members/owners read+write, non-members rejected; owner-only ops (vault admin) gated to owners — so the client can't grant itself more than the user has (D10). Enforcement point is server-side; detailed in agent PRD.
- Role definitions and the membership-management surface live in the **auth-identity** PRD; this PRD only asserts that sync respects them.

---

## Data & types

Types live in `packages/shared` (imported by desktop and server, no codegen — D14/D15). Server tables are **owned by the server-data PRD**; referenced here, not redefined.

- **`Vault`** (shared type): `{ id, name, kind: 'personal' | 'shared', ownerId, theme, createdAt, updatedAt }`. Server-assigned `id`.
- **`Membership`** (auth-identity/server-data): `{ vaultId, userId, role: 'owner' | 'member' }`.
- **`DocMeta`** (server metadata driving the file tree): `{ id, vaultId, path, kind: 'note' | 'daily', createdAt, updatedAt }`.
- **Path-safety** (`packages/shared`): the `VaultPath` newtype + `resolve_relative` containment logic, reimplemented **test-first** in TS (reject `..`/absolute/NUL, canonicalize through closest existing ancestor, reassert containment). Security-critical — guards the file bridge and any path from agent/renderer (§9 architecture).
- **Sync-status** (renderer state, Jotai): `'synced' | 'offline' | 'syncing'` per vault/connection.

Server tables (see **server-data** PRD): `vaults`, `memberships`, `docs`, `yjs_docs` / `yjs_snapshots`, `users`. Object storage (Hetzner): archived binary originals (D28) + doc snapshots/backups.

---

## UX / flows

**Sign-in → vault list.** User signs in (Google SSO, auth-identity PRD) → client queries the server for memberships → renders the vault list (personal + shared). No local registry read; no onboarding "git remote" field (deleted).

**Open a note.**
1. User clicks a doc in the (server-metadata-driven) file tree.
2. Client opens the Yjs Doc (from local cache immediately if present, syncing in background), materializes the working copy on disk.
3. Editor binds to the Doc; awareness shows co-viewers' avatars and cursors.
4. Sync-status indicator reflects connection state.

**Concurrent edit.** Two members type in the same doc → CRDT merges character-level; non-overlapping edits merge cleanly, overlapping same-character edits resolve last-writer (like two Google-Docs cursors, D2). No dialog — an overlapping-range merge at most raises the non-blocking *"let Claude reconcile?"* flag (D26).

**Agent edit.** Agent starts writing → bridge takes the soft lock (presence shows *"Claude is editing…"*, CRDT→file re-materialization pauses, base freezes) → agent `Read`s/`Edit`s the stable file → on turn end the bridge applies `diff(base, file)` as positioned Yjs ops onto the live CRDT → relay fans out to other clients → new base, lock released. Other members' concurrent edits to other regions survive (D2, D25).

**Go offline → reconnect.** Connection drops → indicator flips to *offline* → edits queue locally → on reconnect indicator shows *syncing* → queued updates replay and auto-merge → *synced*. Zero user interaction (D21). A long-offline reconcile takes an auto-labeled snapshot first, and overlapping-range merges surface the non-blocking *"let Claude reconcile?"* flag (D26).

**History / restore.** User opens a doc's history → sees the snapshot timeline → selects a version → previews → restores. Restore updates the CRDT (semantics: Open questions).

**Leave / delete.** Member picks "Leave vault" → membership removed → vault disappears from their list, caches torn down. Owner picks "Delete vault" → confirm → server deletes; other members lose it on next sync.

---

## Client / server responsibilities

**Client (`apps/desktop`)**
- Owns the **live editing experience**: Yjs doc store, offline cache, awareness, sync-status indicator.
- Runs the **file↔CRDT bridge** and **full active-vault materialization** in Electron main (agent↔CRDT only; soft locks, frozen bases, `diff(base, file)` → positioned Yjs ops — the D25 turn protocol).
- Renders the **file tree from server metadata** (not disk scan).
- Composes and points the agent's `claude` at the working-copy dir (agent PRD).
- Vault list, lifecycle actions (create/rename/delete/leave) are tRPC calls; no local vault DB.

**Server (`apps/server`)**
- **Hocuspocus relay:** durable CRDT truth, update fan-out, awareness channel, `onStoreDocument`/`onLoadDocument` persistence, snapshot timeline (including the auto-labeled pre-risk snapshots, D26).
- **tRPC API:** vault CRUD, membership, doc metadata/path operations, history/restore.
- **Authorization:** every tRPC + Yjs connection checked against membership; members/owners → read-write Yjs, non-members rejected (no read-only tier); agent MCP ops membership-gated (§9 architecture).
- **Persistence/backup:** Postgres (Yjs state + snapshots + metadata) + object storage.

**Shared (`packages/shared`)**: `Vault`/`Membership`/`DocMeta` types, path-safety, wiki-link grammar — the seam that keeps both sides honest (§1 architecture).

---

## Edge cases & risks

- **Cold offline start.** Signed-in but no local cache and no network → can't hydrate a vault. Show an explicit "can't reach Syv, no cached copy" state, not an empty/broken tree. (D13: offline works *via cache* — first-touch of a doc requires having synced it once.)
- **Bridge race: agent write vs incoming remote update.** Subsumed by the D25 turn protocol — the frozen base + paused CRDT→file re-materialization *is* the mitigation. Remote edits arriving mid-turn buffer in the live CRDT and merge when the turn-end `diff(base, file)` lands as positioned ops; no watcher-event-ordering gymnastics. The residual risk is a same-region human+agent overlap, which resolves character-level last-writer with the merge safety net (D26) as backstop. Because the bridge is the only genuinely novel component in the plan, it's **Spike 1** — proven before other code.
- **Full-document `Write`.** Handled by the same protocol: `diff(base, file)` against the frozen base means even a whole-file `Write` lands as a minimal positioned patch — "what the agent changed" and nothing more. **Never blind-replace** stays load-bearing (D2, D25).
- **Live-preview under a remote-edit stream.** With the animation morph removed (**D22**), this is no longer a risk: a remote `docChanged` just re-decorates, and the active-line reveal follows the `yCollab`-mapped caret. No origin-sensitive animation path to guard (owned by notes-editor PRD).
- **Non-member connection.** A non-member's Yjs connection and tRPC calls must be rejected server-side, not just hidden in the UI; the agent's write ops fail server-side for non-members (D7, D10).
- **Watcher fan-out at scale (future).** Full active-vault materialization is fine for v1 and holds permanently — the vault is text by construction, binaries never materialize (D23, D28). Only if lazy/partial materialization returns for very large vaults does an eviction policy for working copies/watchers become a concern (deferred — see Open questions).
- **Deleted-vault teardown.** A member offline when a vault is deleted must have local caches/working copies safely torn down on reconnect without data-loss surprises.
- **JSONL / snapshot volume.** Snapshot cadence trades history granularity against Postgres/object-storage growth; needs a retention policy (Open questions).
- **Path-safety regressions.** Any path from the agent/renderer flows through the bridge; a containment bug is a vault-escape. Treat `packages/shared` path-safety as first-class, test-first (§9 architecture).

## What's explicitly deleted from the old model
- **Git sync** entirely: `git_sync.rs` auto-commit (30 s) / auto-push (5 min) / never-pull, `.gitignore` sync-filter, `gh repo create`, `gitInit`/`gitSetRemote`/`gitCreateGithubRepo`/`gitSyncStart` in `useVaults.createVault` (D3).
- **Local SQLite vault registry** and the local `getVaults`/`saveVault` path — vault list is now a server query.
- **Client-minted vault UUIDs** (`crypto.randomUUID()` in `useVaults.ts`) — ids are server-assigned.
- **Whole-vault link-rewrite conflicts** — rename is one atomic server-side pass over affected CRDT docs (D12), not N git clients colliding — and it's **docs-only**: task refs are stable IDs untouched by rename (D27).
- **Disk-scan file tree** (`scanVaultMetadata`, `listDirectoryTree`, `collectVaultPaths`, `vault_layout.rs`'s `.holi/tasks/` machinery) — replaced by server metadata.
- **Local-only personal vaults** — all vaults are server-backed (D13).

---

## Dependencies

- **auth-identity** — sign-in (Google SSO), the `Membership`/role model, membership-management UI, ownership transfer. This PRD consumes roles but doesn't define them (D7).
- **server-data** — Postgres tables (`vaults`, `memberships`, `docs`, `yjs_docs`/`yjs_snapshots`), task records, the tRPC surface. Owns the schema this PRD references (D4, D14).
- **notes-editor** — the CodeMirror + `y-codemirror.next` binding, remote-cursor/awareness rendering, wiki-link grammar + `note_rename` (docs-only — D12, D27, D20).
- **agent** — the PTY/`claude` runtime pointed at working copies, MCP op role-gating, config tiers (D5, D6, D10).

---

## Open questions

- **Restore semantics.** Does restoring a snapshot append a new CRDT state (non-destructive, preferred) or rewind? How is it reconciled with clients currently editing that doc?
- **Materialization eviction policy (deferred).** Only relevant if lazy/partial materialization returns for very large vaults (D23) — what's the concrete rule for evicting working copies/watchers (LRU by open/touch time? explicit close?)? Not a v1 concern (v1 materializes the whole active vault).
- **Snapshot cadence & retention.** How often does `onStoreDocument` snapshot, and what's the retention/compaction policy for the timeline vs storage growth?
- **Local Yjs store location.** Renderer `y-indexeddb` vs main-process leveldb — where does the offline cache live, given the bridge and agent run in main? (Architecture lists both as options.)
- **Personal-vault provisioning.** Exact trigger and default contents (empty? seeded persona/theme?) when a user's personal vault is auto-created on first sign-in.
- **Offline task edits.** Tasks aren't CRDTs (D4) — is offline task mutation queued and last-writer-merged, or read-only while offline? (Coordinate with server-data PRD.)
