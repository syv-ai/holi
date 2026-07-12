# PRD — Vaults, Collaboration, Sync & Offline

Owns the vault as a collaborative container: what it is, its lifecycle, the folder hierarchy, how working copies materialize, and how real-time collaboration, offline, history, and backup work end-to-end. This PRD leans on sibling PRDs for the mechanics it doesn't own — see [Dependencies](#dependencies).

---

## Summary

A **vault** is a server-owned container of documents, tasks, and agent config (glossary). Every vault — **personal** or **shared** — is backed by the same Syv relay + Postgres; there is no local-only vault kind. Notes are **Yjs CRDTs** synced through a Hocuspocus relay; tasks are structured server records synced via tRPC (owned by the server-data PRD). Clients hold a local Yjs cache for **offline** work that auto-merges on reconnect. The agent edits **materialized `.md` working copies** on disk, reconciled to the CRDT through a **file↔CRDT bridge** running a frozen-base **turn protocol**. **Presence** (remote cursors + doc-viewer avatars) rides the Yjs awareness channel. History is a **Yjs snapshot timeline** with restore; backup is Postgres + object storage. Garbled-but-converged merges are covered by the **merge safety net** — auto-labeled snapshots + one-click agent reconcile.

**Why CRDTs over a Syv-hosted relay:** the headline requirement is Google-Docs-style **concurrent editing with presence**, and CRDTs give automatic character-level merge, offline-first, and awareness (cursors/presence) natively. **Rejected:** *git-based sync with pull/merge* — no live co-editing or presence, and whole-file markdown/YAML merge conflicts the moment two people share a vault; *peer-to-peer CRDT* — no durable truth when everyone's offline, NAT/discovery pain, unfit for a company DMS. **Cost accepted:** Syv hosts and scales the WebSocket relay + persistence.

Sign-in is required to use Holi; offline is served from cache. Git exists in exactly one place: an opt-in, relay-owned **server-side mirror + remote-edit ingress** so Claude Code cloud sessions can work a vault as a GitHub repo (see [Git mirror & remote-edit ingress](#git-mirror--remote-edit-ingress)) — never as part of client↔client sync.

---

## Goals / Non-goals

**Goals**
- Google-Docs-style concurrent editing of notes with live presence, per vault.
- One sync engine for personal and shared vaults; single code path.
- Full active-vault materialization so the agent's native `Grep`/`Glob`/`Read` and the editor get real files across the whole vault (§2 architecture).
- A file tree driven by **server metadata** (paths), not by scanning disk.
- Offline-first: edit while disconnected, auto-merge on reconnect, no manual conflict resolution.
- Server-authoritative history (snapshots + restore) and durable backup.
- Vault-level membership that **sync respects**: members & owners get read-WRITE Yjs, non-members are rejected — no read-only tier (§3 architecture).

**Non-goals**
- Auth mechanics, role definitions, and membership-management UI — deferred to the **auth-identity** PRD (this PRD only states how sync *honors* roles).
- The editor/CRDT binding internals, remote-cursor rendering, wiki-link grammar — **notes-editor** PRD.
- Task records, task sync, reminders, board — **server-data** PRD.
- The agent runtime, PTY, MCP ops, chat history — **agent** PRD.
- Content **import/migration** — none in v1; an "import a markdown folder" path is deferred. When import lands (phase 2), it follows **markdown-first ingestion**: binaries convert to markdown on entry, originals archive to object storage.
- Per-user theme overrides; agent theme proposals (deferred).

---

## User stories

- As an employee, I sign in with my Google Workspace account and see the vaults I'm a member of, plus my personal vault.
- As a member, I open a shared note and see who else is viewing it (avatars) and where their cursors are, and my edits and theirs merge live without conflicts.
- As a user on a plane, I keep editing my notes offline; when I reconnect, everything merges automatically and the status indicator flips from *offline* to *synced* — I'm never shown a conflict dialog.
- As a user, I switch between my laptop and desktop and my personal vault is already in sync on both.
- As a vault owner, I create, rename, and delete a vault, and add/remove members (membership UI in auth-identity PRD).
- As a member, I **leave** a shared vault I no longer need without deleting it for others.
- As a user, I browse a doc's history timeline and restore an earlier version.
- As a user, my agent edits a note file directly and other people's concurrent edits to other parts of that note survive.

---

## Functional requirements

### Vault model & identity
- A vault has a **server-assigned id** (never minted client-side), a `name`, a `kind` (`personal | shared`), an `owner`, a `theme` (shared vault-wide, **owner-only edit** — members can't restyle the team's vault), and timestamps.
- **Personal vault:** single member (the owner); same Yjs + tRPC backing as shared. Auto-provisioned for a user on first sign-in. **Why server-backed:** cross-device sync plus server history/backup for personal notes, and a single sync engine/code path. **Rejected:** *local-only personal vaults* — no cross-device sync, and a second storage model to maintain.
- **Shared vault:** a membership list with two roles `owner | member` — both read+write all content; owner adds vault admin. **No viewer/read-only role** (managed in the auth-identity PRD).
- A vault carries a real **folder/path hierarchy** — needed for wiki-links, the file tree, and task `area`. Folder structure is **server metadata**, not derived from disk. Machine references into that hierarchy (task `area`, task `related[]`) store **stable IDs**, resolved to the current path only for display, so folder renames cascade automatically.

### Vault lifecycle
- **Create:** owner names a vault → server allocates the id, creates the vault + owner membership + an empty root. No git surface is involved (the opt-in mirror is connected separately by the owner, below).
- **Rename:** updates vault `name` (server metadata). Distinct from `note_rename` — a **docs-only** operation that rewrites prose `[[…]]` links inside CRDT docs in one atomic server-side pass; task records reference notes/folders by stable ID and need no rewrite (notes-editor PRD).
- **Delete:** owner-only; removes the vault, its docs/snapshots, task records, and memberships server-side, and tears down local caches/working copies on every member's next sync.
- **Leave:** a member removes their own membership; the vault persists for others. (Owner must transfer ownership first — mechanics in auth-identity PRD.)
- The client keeps **no local vault registry**: the vault list is a server query.

### Folder hierarchy & file tree
- The file tree is rendered from **server metadata** (doc paths + folder structure), never by walking disk.
- Holi-managed root files (`.claude/`, `AGENTS.md`, `MEMORY.md`, the `CLAUDE.md` shim, theme, `.holi/settings.json`) are **shared, synced vault content**, hidden from the tree by default. **`USER.md` is not vault content** — the agent's model of you is personal and machine-local, alongside `~/.claude` and `CLAUDE.local.md` (agent PRD). `.holi/settings.local.json` is likewise machine-local and **excluded from sync**.
- Tasks are structured server records, not files (server-data PRD): there is **no `.holi/tasks/` directory**, no task-path special-casing, no task-count-per-file badges derived from wiki-links.

### Documents & materialization (working copies)
- Each note is a **Yjs Doc** with a vault-relative path (glossary). Server is the durable source of truth.
- A client **materializes** Docs as plain `.md` **working copies** on disk under a per-vault working dir the agent's `claude` process is pointed at (§2 architecture).
- Materialization is **full for v1**: the client materializes the **whole active vault** to disk so the agent's native `Grep`/`Glob`/`Read` see every doc and the file tree reflects real files. This holds **permanently** because the vault is **text by construction**: binaries (PDF/docx) convert to markdown on entry, and the original binaries archive to Hetzner object storage — fetched on demand, **never eagerly synced or materialized**. (Rejected: *syncing all binaries to every disk* — GB-scale vaults hurt everyone.) Markdown vaults are tiny (MBs), so full materialization is cheap. **Lazy/partial materialization** (open docs + recently-touched + agent-pointed only) is a **deferred optimization** for very large vaults.
- Working copies are **not authoritative and not version-controlled** (glossary). No `.git`, no sync-filtering dotfiles. (The only git surface anywhere is the relay's server-side mirror clone, below — never the client.)

### Real-time collaboration
- Clients connect to the relay over WebSocket, authenticated with the session token (Hocuspocus `onAuthenticate`), and exchange Yjs updates for the docs they have open.
- **Awareness/presence:** remote **cursors/selections** in the editor and **doc-viewer avatars** ("who's here") over the standard Hocuspocus awareness channel. (Rendering owned by notes-editor PRD.)
- **File↔CRDT bridge:** runs in Electron main and mediates **agent↔CRDT only** — human↔human editing is pure Yjs and never touches the filesystem, which shrinks the race surface to one rare case. The bridge exists so the agent keeps its **native `Read`/`Edit`/`Write`** tools on real files — an agent write is functionally no different from a human typing, and Claude Code's read-before-edit modification-detection guard prevents silent clobbering. **Rejected:** *CRDT-is-truth with agent edits only via a gateway op* ("never use Edit, call `note_write`") — loses native tools and fights the interactive agent's grain; *files-are-truth with an ephemeral CRDT* — races between agent file-writes and live sessions, fragile presence.
- Reconciliation is the **turn protocol**:
  1. Agent starts writing a doc → the bridge takes a **soft lock**: presence shows *"Claude is editing…"* and **CRDT→file re-materialization is paused** for that doc, freezing the **base** (the last-materialized text) so remote edits arriving mid-turn can't poison the diff.
  2. The agent edits the stable file freely — Claude Code's read-before-edit guard stays satisfied because the file doesn't move under it.
  3. On turn end/idle: compute `diff(base, file)` and apply the patch as **positioned Yjs ops** onto the *live* CRDT (which may now contain buffered remote edits) — a 3-way merge, like git. **Never blind-replace**; a full-document agent `Write` becomes a diff-merge.
  4. New base = merge result; re-materialize; release the lock.
- **Why frozen base + diff:** a blind whole-file replace would revert teammates' concurrent edits; diffing against a *frozen* base is what makes the patch mean "what the agent changed" and nothing more. Soft turn-taking makes human-vs-agent same-region collisions rare in practice. **Rejected:** *intercepting Claude Code's `Edit` via a PreToolUse hook to capture intent* — couples to tool internals, and `Write` still needs the diff fallback; *hard per-doc checkout locks* — blocks simultaneous human+agent editing entirely.
- **Overlaps:** when human and agent do touch the same region, the CRDT converges with both texts surviving adjacently (deterministic order; spike-verified: [../spikes/2026-07-10-bridge-turn-protocol.md](../spikes/2026-07-10-bridge-turn-protocol.md)), with the merge safety net as backstop.
- **De-risk:** the bridge was the only genuinely novel component in the plan, so it was built and hammered first (two clients + an agent on one doc) — **spike completed, verdict: holds**, with hardening findings the real bridge must carry (atomic base advancement at turn end, disk-recheck against watcher coalescing, agent-side turn signals preferred): [../spikes/2026-07-10-bridge-turn-protocol.md](../spikes/2026-07-10-bridge-turn-protocol.md).

### Offline
- Each client persists its Yjs docs to a **local store** (e.g. `y-indexeddb` in renderer, or leveldb-backed in main) (§2 architecture).
- Offline edits are ordinary Yjs updates queued locally; on reconnect they **replay and auto-merge** with no user intervention.
- The only offline UI is a **sync-status indicator**: `synced | offline | syncing`. **Never a conflict-resolution dialog** — garbled-merge recovery is the merge safety net, below.
- Sign-in is required to *use* Holi, but a signed-in user works offline from cache; a first-ever launch with no cache and no network can't materialize a vault (see Edge cases).

### Merge safety net
- **No conflict dialogs, ever** — the Google Docs model. Convergence-but-garbled merges are handled by recoverability plus semantic repair.
- **Auto-labeled snapshots** before risky operations — an agent bulk-write ("before Claude edited") or a long-offline reconcile ("before your offline changes merged") — one-click restorable from the history timeline.
- **Overlap detection:** when Yjs merges concurrent edits that touched **overlapping ranges** (or reconciles a long-offline session), the doc gets a **non-blocking** flag — *"this merge may need a look — let Claude reconcile?"*
- **One-click agent reconcile:** accepting hands a git-style 3-way (**base / mine / theirs**, reconstructed from snapshots) to the user's **local** agent, which writes a clean reconciled version back through the bridge (with its own pre-snapshot). User-triggered — no silent rewrites, no token spend without opt-in.
- **History restore** is the always-on backstop.
- **Why:** CRDTs guarantee the *same* text, not *sensible* text. Explicit conflicts plus an intelligent resolver are recreated here at the semantic layer, using the in-vault LLM — a differentiator no plain-CRDT app (Google Docs, Notion) has. **Rejected:** *auto-running reconciliation on every overlap* — unattended rewrites, token spend per collision, per-user divergence; *a real conflict-resolution UI* — a large build that fights the CRDT's point and reintroduces the dialogs this design bans.

### History & backup
- **History = Yjs snapshots:** Hocuspocus `onStoreDocument` writes CRDT state and periodic snapshots to Postgres, forming a per-doc timeline (§2 architecture). `onLoadDocument` hydrates.
- **Restore:** a user can browse the timeline and restore an earlier snapshot; restore is a server-side operation that produces a new CRDT state (not a destructive rewind of shared truth — exact restore semantics in Open questions).
- **Backup = server persistence:** Postgres (snapshots, doc state) + Hetzner object storage (archived binary originals from import conversion, plus backups). GitHub is not the backup.
- Git plays **no role in history, backup, or sync between clients**: with the server as durable truth it is redundant there, and git-as-client-sync was rejected outright — N clients auto-committing and pushing independently guarantees divergence and whole-file merge conflicts. Client working copies carry no `.git`. The one git surface that does exist — the relay-owned mirror, next section — has exactly one writer for this reason.
- The snapshot timeline also carries the **auto-labeled pre-risk snapshots** of the merge safety net.

### Git mirror & remote-edit ingress
An opt-in, per-vault integration whose purpose is to let **Claude Code web/cloud sessions** operate on vault content: a vault-as-GitHub-repo that remote sessions reach via the Claude GitHub App. Detailed design: [../specs/2026-07-13-vault-git-mirror-design.md](../specs/2026-07-13-vault-git-mirror-design.md).

- **Owner-provided repo:** the vault owner connects an existing GitHub repository they provide. (Rejected: *Holi auto-creating repos in a Syv org* — the owner-provided URL keeps the GitHub surface minimal and the opt-in explicit.)
- **The relay is the only git writer.** It maintains a server-side mirror clone and serializes all git I/O per vault behind one lock. **Why one writer:** many clients pushing independently (and whole-vault link-rewrite commits colliding) is structurally excluded when a single writer owns the repo.
- **Exporter:** debounced continuous commits of vault content to the **default branch**. Exported set: docs + `.claude/**` + `.holi/settings.json`. **Tasks never appear in the repo** — remote sessions can't see or edit tasks in v1, accepted. (Rejected: *a task-file round-trip* — re-opens the file↔record complexity that structured task records removed.)
- **Ingester:** webhook-driven. Foreign commits on the **default branch only** are ingested by diffing each changed file against the last-exported base and applying the patch as **positioned Yjs ops** — the same spike-proven frozen-base diff-merge shape as the bridge turn protocol, run server-side, guarded by merge-safety-net pre-snapshots and overlap flags.
- **Auth:** sign-in stays Google (auth-identity PRD). The owner **links a GitHub account** (OAuth) once; that token wires the repo (writes a **deploy key** + pushes a **webhook** via the API) and is never used for background operations — day-to-day runs on the deploy key. (Rejected: *switching sign-in to GitHub* — loses Workspace-managed offboarding, and the Google integrations need Google OAuth anyway.)
- **Edge policy:** binaries ignored (the vault is text by construction); renames ingest as identity-preserving path moves with no auto link-rewrite; a force-push pauses the mirror until the owner resolves; every ingested path goes through `VaultPath`.
- **Boundaries:** the relay stays the source of truth; git is never client↔client sync; client working copies still carry no `.git`. (Rejected: *full git-as-sync* — reintroduces exactly the divergence the CRDT backbone exists to prevent; *explicit pull-from-git instead of auto-ingest* — repo and vault drift.)

### Membership & sync authorization
- Authorization is **server-side and total**: every tRPC call and every Yjs WebSocket connection is checked against membership (§3, §9 architecture).
- **Members & owners get read-WRITE Yjs connections; non-members are rejected** by the relay. There is **no read-only tier** — everyone with access can edit.
- The **agent's MCP ops are gated by the same membership** — members/owners read+write, non-members rejected; owner-only ops (vault admin) gated to owners — so the client can't grant itself more than the user has. Enforcement point is server-side; detailed in agent PRD.
- Role definitions and the membership-management surface live in the **auth-identity** PRD; this PRD only asserts that sync respects them.

---

## Data & types

Types live in `packages/shared` (imported by desktop and server, no codegen). Server tables are **owned by the server-data PRD**; referenced here, not redefined.

- **`Vault`** (shared type): `{ id, name, kind: 'personal' | 'shared', ownerId, theme, createdAt, updatedAt }`. Server-assigned `id`.
- **`Membership`** (auth-identity/server-data): `{ vaultId, userId, role: 'owner' | 'member' }`.
- **`DocMeta`** (server metadata driving the file tree): `{ id, vaultId, path, kind: 'note' | 'daily', createdAt, updatedAt }`.
- **Path-safety** (`packages/shared`): the `VaultPath` newtype + `resolve_relative` containment logic — reimplement from the old repo **test-first** in TS (reject `..`/absolute/NUL, canonicalize through closest existing ancestor, reassert containment). Security-critical — guards the file bridge, the mirror ingester, and any path from agent/renderer (§9 architecture).
- **Sync-status** (renderer state, Jotai): `'synced' | 'offline' | 'syncing'` per vault/connection.

Server tables (see **server-data** PRD): `vaults`, `memberships`, `docs`, `yjs_docs` / `yjs_snapshots`, `users`. Object storage (Hetzner): archived binary originals + doc snapshots/backups.

---

## UX / flows

**Sign-in → vault list.** User signs in (Google SSO, auth-identity PRD) → client queries the server for memberships → renders the vault list (personal + shared). No local registry; no repo/remote fields at creation (the git mirror is a separate owner-driven connect flow).

**Open a note.**
1. User clicks a doc in the (server-metadata-driven) file tree.
2. Client opens the Yjs Doc (from local cache immediately if present, syncing in background), materializes the working copy on disk.
3. Editor binds to the Doc; awareness shows co-viewers' avatars and cursors.
4. Sync-status indicator reflects connection state.

**Concurrent edit.** Two members type in the same doc → CRDT merges character-level; non-overlapping edits merge cleanly, overlapping same-character edits converge with both texts surviving adjacently (deterministic order; spike-verified). No dialog — an overlapping-range merge at most raises the non-blocking *"let Claude reconcile?"* flag.

**Agent edit.** Agent starts writing → bridge takes the soft lock (presence shows *"Claude is editing…"*, CRDT→file re-materialization pauses, base freezes) → agent `Read`s/`Edit`s the stable file → on turn end the bridge applies `diff(base, file)` as positioned Yjs ops onto the live CRDT → relay fans out to other clients → new base, lock released. Other members' concurrent edits to other regions survive.

**Go offline → reconnect.** Connection drops → indicator flips to *offline* → edits queue locally → on reconnect indicator shows *syncing* → queued updates replay and auto-merge → *synced*. Zero user interaction. A long-offline reconcile takes an auto-labeled snapshot first, and overlapping-range merges surface the non-blocking *"let Claude reconcile?"* flag.

**History / restore.** User opens a doc's history → sees the snapshot timeline → selects a version → previews → restores. Restore updates the CRDT (semantics: Open questions).

**Leave / delete.** Member picks "Leave vault" → membership removed → vault disappears from their list, caches torn down. Owner picks "Delete vault" → confirm → server deletes; other members lose it on next sync.

---

## Client / server responsibilities

**Client (`apps/desktop`)**
- Owns the **live editing experience**: Yjs doc store, offline cache, awareness, sync-status indicator.
- Runs the **file↔CRDT bridge** and **full active-vault materialization** in Electron main (agent↔CRDT only; soft locks, frozen bases, `diff(base, file)` → positioned Yjs ops — the turn protocol).
- Renders the **file tree from server metadata** (not disk scan).
- Composes and points the agent's `claude` at the working-copy dir (agent PRD).
- Vault list, lifecycle actions (create/rename/delete/leave) are tRPC calls; no local vault DB.

**Server (`apps/server`)**
- **Hocuspocus relay:** durable CRDT truth, update fan-out, awareness channel, `onStoreDocument`/`onLoadDocument` persistence, snapshot timeline (including the auto-labeled pre-risk snapshots).
- **tRPC API:** vault CRUD, membership, doc metadata/path operations, history/restore.
- **Git mirror (opt-in per vault):** the server-side mirror clone, exporter, and webhook ingester — the relay is the only git writer ([../specs/2026-07-13-vault-git-mirror-design.md](../specs/2026-07-13-vault-git-mirror-design.md)).
- **Authorization:** every tRPC + Yjs connection checked against membership; members/owners → read-write Yjs, non-members rejected (no read-only tier); agent MCP ops membership-gated (§9 architecture).
- **Persistence/backup:** Postgres (Yjs state + snapshots + metadata) + object storage.

**Shared (`packages/shared`)**: `Vault`/`Membership`/`DocMeta` types, path-safety, wiki-link grammar — the seam that keeps both sides honest (§1 architecture).

---

## Edge cases & risks

- **Cold offline start.** Signed-in but no local cache and no network → can't hydrate a vault. Show an explicit "can't reach Syv, no cached copy" state, not an empty/broken tree. (Offline works *via cache* — first-touch of a doc requires having synced it once.)
- **Bridge race: agent write vs incoming remote update.** Subsumed by the turn protocol — the frozen base + paused CRDT→file re-materialization *is* the mitigation. Remote edits arriving mid-turn buffer in the live CRDT and merge when the turn-end `diff(base, file)` lands as positioned ops; no watcher-event-ordering gymnastics. The residual risk is a same-region human+agent overlap, which converges with both texts surviving adjacently, with the merge safety net as backstop. The whole protocol is spike-verified — **holds**: [../spikes/2026-07-10-bridge-turn-protocol.md](../spikes/2026-07-10-bridge-turn-protocol.md).
- **Full-document `Write`.** Handled by the same protocol: `diff(base, file)` against the frozen base means even a whole-file `Write` lands as a minimal positioned patch — "what the agent changed" and nothing more. **Never blind-replace** stays load-bearing.
- **Live-preview under a remote-edit stream.** Not a risk with the simple live-preview editor (no animation layer): a remote `docChanged` just re-decorates, and the active-line reveal follows the `yCollab`-mapped caret. No origin-sensitive animation path to guard (owned by notes-editor PRD).
- **Non-member connection.** A non-member's Yjs connection and tRPC calls must be rejected server-side, not just hidden in the UI; the agent's write ops fail server-side for non-members.
- **Watcher fan-out at scale (future).** Full active-vault materialization is fine for v1 and holds permanently — the vault is text by construction, binaries never materialize. Only if lazy/partial materialization returns for very large vaults does an eviction policy for working copies/watchers become a concern (deferred — see Open questions).
- **Deleted-vault teardown.** A member offline when a vault is deleted must have local caches/working copies safely torn down on reconnect without data-loss surprises.
- **Snapshot volume.** Snapshot cadence trades history granularity against Postgres/object-storage growth; needs a retention policy (Open questions).
- **Path-safety regressions.** Any path from the agent/renderer flows through the bridge, and every mirror-ingested path flows through `VaultPath`; a containment bug is a vault-escape. Treat `packages/shared` path-safety as first-class, test-first (§9 architecture).

---

## Dependencies

- **auth-identity** — sign-in (Google SSO), the `Membership`/role model, membership-management UI, ownership transfer, GitHub account linking for mirror owners. This PRD consumes roles but doesn't define them.
- **server-data** — Postgres tables (`vaults`, `memberships`, `docs`, `yjs_docs`/`yjs_snapshots`), task records, the tRPC surface. Owns the schema this PRD references.
- **notes-editor** — the CodeMirror + `y-codemirror.next` binding, remote-cursor/awareness rendering, wiki-link grammar + `note_rename` (docs-only).
- **agent** — the PTY/`claude` runtime pointed at working copies, MCP op role-gating, config layering.

---

## Open questions

- **Restore semantics.** Does restoring a snapshot append a new CRDT state (non-destructive, preferred) or rewind? How is it reconciled with clients currently editing that doc?
- **Materialization eviction policy (deferred).** Only relevant if lazy/partial materialization returns for very large vaults — what's the concrete rule for evicting working copies/watchers (LRU by open/touch time? explicit close?)? Not a v1 concern (v1 materializes the whole active vault).
- **Snapshot cadence & retention.** How often does `onStoreDocument` snapshot, and what's the retention/compaction policy for the timeline vs storage growth?
- **Local Yjs store location.** Renderer `y-indexeddb` vs main-process leveldb — where does the offline cache live, given the bridge and agent run in main? (Architecture lists both as options.)
- **Personal-vault provisioning.** Exact trigger and default contents (empty? seeded persona/theme?) when a user's personal vault is auto-created on first sign-in.
- **Offline task edits.** Tasks aren't CRDTs — is offline task mutation queued and last-writer-merged, or read-only while offline? (Coordinate with server-data PRD.)
