# Architecture

How Holi fits together. This is the technical spine — the map; each PRD in [`prd/`](prd) drills into one pillar and carries the deep rationale.

---

## 1. System shape

Three deployable/importable pieces in one pnpm monorepo (one repo keeps cross-cutting changes atomic and lets client and server share types with no codegen):

```
┌─────────────────────────── apps/desktop (Electron) ───────────────────────────┐
│  Renderer (React + Jotai + CodeMirror)          Main (Node)                     │
│  ┌───────────────┐  ┌──────────────┐            ┌──────────────────────────┐    │
│  │ Editor (CM6 + │  │ Task board,  │            │ MCP ops server (local,   │    │
│  │ Yjs binding)  │  │ drawers, UI  │            │ per-run bearer token)    │    │
│  └──────┬────────┘  └──────┬───────┘            │  → proxies to Syv API    │    │
│         │  presence/edits  │  tRPC calls        ├──────────────────────────┤    │
│  ┌──────▼──────────────────▼───────┐            │ PTY host → `claude`      │    │
│  │ Sync client (Yjs doc store,     │            │  (xterm drawer)          │    │
│  │ offline cache, awareness)       │            ├──────────────────────────┤    │
│  └──────┬──────────────────────────┘            │ File↔CRDT bridge         │    │
│         │                                       │  (materialize working    │    │
│  preload/IPC bridge  ───────────────────────────┤   copies on disk)        │    │
│         │                                       └───────────┬──────────────┘    │
└─────────┼───────────────────────────────────────────────────┼──────────────────┘
          │ WebSocket (Yjs sync + awareness)                   │ HTTPS (tRPC)
          ▼                                                    ▼
┌───────────────────────────── apps/server (Node/TS) ─────────────────────────────┐
│  Hocuspocus (Yjs relay + persistence hooks)   tRPC API (auth, vaults, tasks,    │
│  Awareness fan-out                            membership, reminders, history)    │
│                         ┌──────────────────────────────┐                         │
│                         │ Postgres                     │                         │
│                         │  yjs_snapshots, docs, tasks, │                         │
│                         │  vaults, memberships, users, │                         │
│                         │  per_user_state, reminders   │                         │
│                         └──────────────────────────────┘                         │
│  Google OAuth (Workspace SSO)      Object storage (attachments/backups)          │
└──────────────────────────────────────────────────────────────────────────────────┘

              packages/shared  (imported by desktop AND server)
   types · task model · wiki-link grammar · path-safety · recurrence/reminder rules
```

Key property: **the client is not thin, and the server is not thin.** The client owns the live editing experience, the agent runtime, and the file bridge. The server owns truth, auth, structured data, and durability. `packages/shared` is the seam that keeps them honest — one definition of a task, a link, a path rule, used on both sides with no codegen. (The server's *internal* DB layer is the one codegen exception: Drizzle defines the Postgres schema in TS and drizzle-kit generates SQL migrations; `packages/shared` remains the only client↔server type seam.)

The server stack is a **self-hosted TypeScript monolith** — all-TS with shared types, full control, no vendor lock-in, in line with the OSS preference. Rejected: managed CRDT platforms (Liveblocks/PartyKit) — a vendor holding core company doc data, partly closed-source.

---

## 2. Operating principle: cater to Claude Code as-is

**Build only what Claude Code doesn't already do; work with CC as-is.** No adapter layers, no version-pinning ceremony — if a CC release breaks something, fix forward. Standing assumptions:

- **Every employee is a developer.** The raw TUI drawer is the natural interface, not a liability.
- **CC is already installed and authenticated** on every machine (each employee's own account, native auth). Holi does no provisioning, metering, or credential management; the old login-PTY flow is at most an edge-case fallback.

This principle governs the whole agent surface (§5): native `--resume` *is* the chat history, config layering is CC's own, per-turn context rides a supported hook, and permissions are settings-seeded configuration rather than bespoke machinery.

---

## 3. Sync & storage

### Documents are CRDTs
Each note is a **Yjs document**. The **Syv relay** (Hocuspocus) is the durable source of truth and the fan-out point. Clients connect over WebSocket, receive/send Yjs updates, and participate in the **awareness** channel for presence.

**Why:** the headline requirement is Google-Docs-style concurrent editing with presence, and CRDTs give character-level auto-merge, offline-first, and awareness natively. **Rejected:** git with real pull/merge (no live co-editing, whole-file markdown/YAML conflicts) and peer-to-peer CRDT (no durable truth when everyone's offline; NAT/discovery pain). Deep rationale: [`prd/vaults-collaboration.md`](prd/vaults-collaboration.md).

- **Persistence:** Hocuspocus's `onStoreDocument` writes Yjs state (and periodic **snapshots** for the history timeline) to Postgres. `onLoadDocument` hydrates.
- **Offline:** each client persists the Yjs doc to a local store (e.g. `y-indexeddb` in the renderer, or a leveldb-backed store in main). Edits made offline are standard Yjs updates that replay and auto-merge on reconnect. UI shows only a **sync-status indicator** — never a conflict dialog.
- **Backup:** Postgres snapshots + object storage. Git is not part of backup or client sync — but a vault can opt into a server-side **git mirror** for remote sessions (below).

### Working copies and the file↔CRDT bridge
The agent keeps its **native file tools** — forcing every note write through a gateway op would fight the grain of the interactive agent — so every Doc is **materialized** as a `.md` **working copy** on disk (under a per-vault working dir the agent's `claude` process is pointed at).

The **bridge** (in Electron main) mediates **agent↔CRDT only** — human↔human editing is pure Yjs and never touches the filesystem. Turn protocol (spike-verified: [spikes/2026-07-10-bridge-turn-protocol.md](spikes/2026-07-10-bridge-turn-protocol.md)):
1. Agent starts writing a doc → **soft lock**: presence shows *"Claude is editing…"* and **CRDT→file re-materialization pauses** for that doc, freezing the **base**.
2. Agent edits the stable file freely (CC's read-before-edit guard is satisfied).
3. On turn end: `diff(base, file)` applies as **positioned Yjs ops** onto the live CRDT (3-way merge). **Never blind-replace** — a blind whole-file replace would revert teammates' concurrent edits; diffing against a *frozen* base makes the patch mean "what the agent changed" and nothing more.
4. New base = merge result; re-materialize; release.

Staleness is handled by Claude Code itself: its `Edit`/`Write` require a prior `Read` and fail if the file changed since. The bridge is the only genuinely novel component in the system — everything else is standard practice (stock Hocuspocus + Postgres, Electron + node-pty + xterm, tRPC CRUD).

**Merge safety net:** no conflict dialogs, ever (the Google Docs model) — instead, auto-labeled snapshots before risky operations (agent bulk-writes, long-offline reconciles), Yjs **overlap detection** flagging risky merges, and a non-blocking **"let Claude reconcile?"** that hands base/mine/theirs to the local agent for a semantic repair written back through the bridge.

> **Tasks are NOT documents.** They're structured records (§6), synced via tRPC + server push, not Yjs. Only prose notes are CRDTs.

### Materialization scope
A client materializes the **whole active vault** to disk as working copies, so the agent's native `Grep`/`Glob`/`Read` see every doc — not just opened ones — and the file tree reflects real files. This holds permanently because the vault is **text by construction**: PDFs/docx convert to markdown on entry; original binaries archive to object storage (Hetzner) and fetch on demand — never eagerly synced. **Lazy/partial materialization is a deferred optimization** for very large vaults. The file tree is still driven by server metadata (paths) as the authority; the working copies are the agent's substrate.

### Git mirror + remote-edit ingress
A vault owner can connect an **owner-provided GitHub repo**; the relay then maintains a **server-side mirror clone** and is the **only git writer** (clients still have no `.git`). Outbound, an **exporter** debounces vault edits and commits to the default branch (bot-authored) from **two sources** — the `docs` ⋈ `yjs_docs` join **and** the `tasks` table (revised 2026-07-14) — plus `.claude/**` + `.holi/settings.json`. Inbound, a webhook-driven **ingester** applies foreign commits (e.g. from **Claude Code cloud sessions** working the repo via the Claude GitHub App). It **branches on the path before its A/M/D/R dispatch**: a `tasks/**.md` path is patched into the **record** (§6), and everything else is diffed against the **last-exported base** and applied as positioned Yjs ops — the same spike-proven frozen-base shape as the local bridge, guarded by a pre-snapshot + overlap flags (the merge safety net above). The branch is load-bearing: the doc path's `createDoc` hardcodes `kind: 'note'`, so without it a remotely-edited task file would silently become a **CRDT note**. Wiring uses the owner's linked GitHub OAuth once (installs a write deploy key + webhook); background operations run on the deploy key.

**Tasks *do* ride the mirror** — this reverses the earlier "tasks never appear in the repo; remote sessions can't see or edit tasks in v1" limitation, which the task file projection (§6) removed. Full design: [specs/2026-07-13-vault-git-mirror-design.md](specs/2026-07-13-vault-git-mirror-design.md).

**Why one writer:** the old app's git failure modes (N clients auto-pushing; whole-vault link-rewrite commits colliding) are structurally excluded when the relay serializes all git I/O per vault behind one lock. Git never returns as client↔client sync — the relay stays the source of truth.

---

## 4. Identity, auth, access

- **Sign-in:** Google Workspace SSO (OAuth) — Syv is a Google shop, so this is the low-friction, standard company SSO with Workspace-managed offboarding. Identity = Google account. The desktop app obtains a session token used for tRPC and to authenticate the Yjs WebSocket (Hocuspocus `onAuthenticate`). A user may additionally **link a GitHub account** (OAuth) — required only for vault owners enabling the git mirror (§3); sign-in itself stays Google-only. Deep rationale: [`prd/auth-identity.md`](prd/auth-identity.md).
- **Vaults & membership:** a vault has a membership list with **two roles — owner and member**. **member** = read + write all content; **owner** = member + vault admin (membership, transfer, delete, theme/settings). **No viewer/read-only role** — the agent's native file writes can't be role-blocked cleanly, and everyone with access should edit. Personal vaults have a single member (the owner).
- **Authorization is server-side and total:** every tRPC call and every Yjs connection is checked against membership. Non-members are rejected; owner-only actions (membership, delete, theme) are gated to owners. The **agent's MCP ops are gated by the same membership** — the client can't grant itself access the user doesn't have.

---

## 5. The agent

### Runtime: interactive Claude in a PTY
Electron main spawns **`claude`** in a **node-pty** PTY, pointed at the vault's working-copy dir with the user's own Claude auth (per-user cost attribution). Bytes stream to an **xterm.js** drawer in the renderer (write/resize/kill over IPC). This is the **live** surface — native Claude UX (permission prompts, plan mode, thinking, todos) at full fidelity, with no brittle stream-json parsing. (The old `login_pty` flow is the working template.) Rejected: a server-side/headless agent — remote TTY streaming, mixed per-user actions, and it forfeits the native interactive UX. Deep rationale: [`prd/agent.md`](prd/agent.md).

### Config layering
**Pure CC-native layering — Holi composes nothing and syncs no personal config:**
- **Shared:** the vault working dir carries `.claude/` (persona SOUL/IDENTITY, shared skills/commands, `settings.json` with seeded permission defaults — §10), `AGENTS.md` (→ imported by a managed `CLAUDE.md` shim), and `MEMORY.md`. They sync because vault content syncs; CC picks them up from the cwd natively.
- **Personal (machine-local, untouched):** the user's own `~/.claude` + `CLAUDE.local.md` + `USER.md`. Holi never reads, writes, or syncs these.
- **Holi app settings:** `.holi/settings.json` (vault-wide, synced) + `.holi/settings.local.json` (machine-local override) — mirroring CC's own shared/local convention.

**Why:** an earlier design *composed* a config dir per launch and ran a per-user config-sync subsystem — machinery CC already provides (§2). Cost accepted: personal agent config (the assistant's model of *you*) is per-machine and doesn't follow you across devices — deliberate; your setup travels the way every developer's does.

### Per-turn context
A **`UserPromptSubmit` hook** (configured in the vault's `.claude/settings`) runs on every prompt and emits Holi's fresh context — active note, linked tasks, `USER.md`/`MEMORY.md` fill indicators. Claude appends it to context automatically. The base system prompt ships once via `--append-system-prompt` at launch. A hook rather than system-prompt-only because launch-time context goes stale as the user switches notes mid-session — and you can't transparently prepend text to what a user types into an interactive TUI; the hook is the native mechanism. (Ports the old `build_system_prompt` / `build_per_turn_prefix` content and the memory budgets/fill indicators.)

### MCP ops
A **local MCP server in Electron main** exposes only the non-file ops — in v1 exactly **3**: **`task_set`**, **`task_list`**, **`note_rename`** (calendar/mail join in phase 2). Per-run bearer token (as before); ops proxy to the Syv tRPC API. Everything else is Claude's native `Read/Write/Edit/Bash/Glob/Grep` on working copies — any vault action that's "just a file op" needs no custom tool.

- **Permissions:** Claude's native interactive prompts for file/bash + **server-side membership gating** on MCP ops (never skip-permissions; the vault `settings.json` seeds defaults like gated network egress). No bespoke safe/power_user modes.
- **`note_rename`** is an op (not a native `mv`) because a rename must (a) preserve the CRDT Doc identity and (b) atomically rewrite `[[links]]` across affected docs — a server operation (§7).

### History: native `--resume`
No custom history system. The drawer's history affordance relaunches **`claude --resume`** — CC's own session picker, replaying the full transcript in the terminal at perfect fidelity. No JSONL parsing, no reconstruction, no summarizer, no sync. Conversations stay on the machine that ran them. **Why:** a custom reconstruction would couple to CC's undocumented JSONL session format — the single most brittle subsystem in the earlier plan — while duplicating what CC does natively (§2). Cost accepted: no rich browse/search outside the terminal, no cross-device history.

---

## 6. Tasks

**Structured records on the server, projected into the vault as files** (revised 2026-07-14). The record is the truth — reminders must fire while every client is closed, recurrence rolls server-side, and boards need live cross-member queries, all of which force an authoritative structured record regardless of what sits on disk. Given the record exists anyway, a file projection is purely additive, and it buys the agent native `Read`/`Edit` (instead of an op surface), git-mirror presence, and remote-agent access.

The old file-based complexity (the derived `area` phantom, orphan rescue, `source_file`-as-home) came from coupling task identity to a note's *path*, not from files as such — stable-ID refs already design it out. Deep rationale, the projection contract, and the presence-not-locks decision: [`prd/tasks.md`](prd/tasks.md). Shape (`packages/shared`):

```ts
type Task = {
  id: string
  vaultId: string
  title: string
  status: 'todo' | 'doing' | 'done'
  area?: string            // stable folder ID (drives swim lanes) — settable; shown as path
  due?: string             // YYYY-MM-DD
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  reminder?: string        // Nd | Nw | YYYY-MM-DDTHH:MM
  recurrence?: Recurrence
  related: RelatedRef[]    // unified: note | task | email | event — by STABLE ID, shown as path
  createdAt: string; updatedAt: string
}
```

- **Sync:** tasks change via tRPC mutations; the server pushes updates to vault members so boards are live. **No CRDT** — tasks are small structured records, last-writer-wins per field is fine, and character-merging YAML frontmatter can converge on invalid syntax with no writer able to reject it. Task files are therefore materialized from the record and **excluded from the CRDT/DocBridge path**.
- **Server push — one SSE connection per signed-in *user*, carrying every vault they are in** (`GET /events`, `apps/server/src/events.ts`). Five channels: **`docs`**, **`tasks`**, **`reminders`**, **`presence`**, and **`membership`**. It was one connection per *vault* (`/events/<vaultId>`), and that shape was the cause of three bugs rather than a detail of them — the connection's identity was a vaultId, so anything about **you** rather than about one vault had nowhere to arrive: a stale file tree, a switcher that needed a restart to see a vault you were invited to, and undeliverable cross-vault reminders.
  - **Every frame is an envelope, `{ vaultId, event }`.** No bus payload carries a vaultId — the key `docs:<vaultId>` always supplied it — and each shape is hand-mirrored in up to three client files, so widening them would spring the `presence` trap below. Multiplexing is a *transport* concern: the payload says **what** happened, the envelope says **where**.
  - **Membership is the re-keying signal** (`user:<userId>`, the only user-keyed channel). A stream that resolved your vaults at connect would be stale the moment you were invited — the new vault's frames would go to a key nobody is listening on. It is also the one channel whose *payload* carries a vaultId, because its key names a user, so the vault is not in the key.
  - **Auth is a subscription set, not an admission check.** No vault in the URL means no role to check: 401 is the only rejection. Authorization is unchanged everywhere else — `vaultProcedure`, `requireDocAccess` and the relay's `onAuthenticate` still gate per vault.
  - **Main owns the one connection and the renderer never opens its own.** It filters `docs`/`tasks`/`presence` to the active vault and never filters `reminders`/`membership` — the latter two crossing vault boundaries is the entire point.
  - `presence` is a *sibling* frame, deliberately **not** a `TasksEvent` variant: the desktop's `TaskProjector.applyTasksEvent` reads that union as `if (upserted) … else remove(taskId)`, so a third variant would fall into the `else` and **delete the task's file**. The same trap is why a frame for a non-active vault must never reach the projector.
  - **No resume cursor** (no `id:` on the wire). Gap recovery is reconnect-then-reconcile: the mirror and projector re-read themselves, and the renderer refetches the tree and vault list on a `stream:resync` push.
- **Every task mutation goes through one module** — `apps/server/src/tasks/mutations.ts` — called by both the tRPC router and the git ingester. It is where `recomputeReminder` + `bus.emitTasks` + `wakeEvaluator` live; a writer that touched the `tasks` table directly would fire no reminder and push no SSE, so no client would rewrite the file.
- **File projection:** every task is also `tasks/<slug>-<id>.md` in the working copy (YAML frontmatter + markdown body = the `description`, a plain column). Record → file is a **rewrite** on any change; file → record is a **per-field patch**. Stale or unparseable writes lose and the file is rewritten from truth — no conflict UI. `rm` deletes the task (the same symmetry the vault mirror gives notes). Task files ride the git mirror, so remote agents read *and* write tasks. Concurrency safety is per-field LWW + a version check; concurrent *awareness* is **presence**, not locks.
- **The `version` token is out-of-band** — never in the file. The desktop holds the version each file was rendered from in its `ProjectionStore`; git ingress needs no token at all, because a commit carries its own base blob and *is* its own diff base. In the frontmatter it would have made every reminder fire rewrite — and, once mirrored, **commit** — a file to change one integer.
- **Board:** default **Todo/Doing/Done** with **swim lanes by `area`** (folder) and lane-depth; simple filter bar. No time-bucket mode / 10-bucket system in v1 — the old config space was the interaction-level source of "not intuitive enough"; a time-grouped secondary view may return post-v1 as an option.
- **Recurrence & reminders:** the **rules** (grammar + roll-forward math) are pure functions in `packages/shared` — port the old, well-tested math. The **server** evaluates reminders and pushes fire events; clients raise native notifications. Roll-forward runs server-side on completion.
- **Agent:** works tasks as **files** with its native tools (`Read`/`Edit`/`Glob`/`rm`). Only the two things a file write cannot express stay MCP ops — **`task_set`** (`status: done` is ambiguous for a recurring task: roll it forward, or end the series?) and **`task_list`** (filtering is a server query; no full-vault file scans). `task_new`/`task_get`/`task_link`/`task_delete` are retired. Membership-gated.

---

## 7. Notes, links, editor

- **Editor:** CodeMirror 6 with **simple live-preview** (reveal-raw-on-caret, **no animation** — the View-Transition morph and its frozen-caret/gap-mark machinery are cut: the animation layer was fragile, and animating CM decorations pegs CodeMirror's measure loop on the main thread), plus a **`y-codemirror.next`** binding to the Doc's Yjs text and **remote cursors** from awareness. Keeps formatting hotkeys, wiki/markdown links, `@`-mentions, and the table widget + package. Cutting the morph erases the old "morph-vs-remote-edits" risk entirely — a remote edit just re-decorates. Deep rationale: [`prd/notes-editor.md`](prd/notes-editor.md).
- **Wiki-links:** path-based `[[folder/note.md]]` — readable in raw markdown, so Claude can follow *and* author them naturally (opaque stable-ID links like `[[doc:…]]` were rejected for this reason). One parser in `packages/shared` (ports `vaultRefs.ts`); thin renderers in editor/chat.
- **Rename:** `note_rename` op → server rewrites the path + all referencing `[[links]]` in one atomic pass over the affected CRDT docs. The seam principle — **machine references use stable IDs; human prose uses paths** — makes this a **docs-only** operation: task records reference docs by stable ID, so they need no rewrite. Backrefs and delete-with-references surfacing are server queries over doc content + the link index. Deletes render **tombstones** on dangling refs, no cascades.
- **Folder hierarchy:** vaults have real paths/folders (needed for links, the file tree, and task `area`). Folder structure is server metadata; folders carry stable IDs.
- **Daily notes:** keep the old **untouched-stub heuristic** (an empty daily is not archived) — port it. Details: [`prd/daily-notes.md`](prd/daily-notes.md).

---

## 8. Data model (server, Postgres)

Indicative tables (detailed in [`prd/server-data.md`](prd/server-data.md)):

- `users` — Google identity, profile.
- `vaults` — id, name, kind (personal|shared), owner, theme, created/updated.
- `memberships` — (vault, user, role).
- `docs` — id, vault, path, kind (note|daily), timestamps. (CRDT state in `yjs_docs`/snapshots.)
- `yjs_docs` / `yjs_snapshots` — Yjs binary state + history timeline.
- `tasks` — the Task record (§6).
- `reminders` — derived/scheduled fire times for server-side evaluation.
- `per_user_state` — (user, vault, key) → value: **UI prefs only** (personal agent config — USER.md, personal skills — is machine-local, never synced).
- `link_index` *(optional/derived)* — for fast backrefs/rename without full scans.

*(No conversation store: chat history is local/per-machine — never in Postgres.)*

Object storage (Hetzner): archived original binaries from import conversion, doc snapshots/backups.

---

## 9. Client architecture (ports from old frontend)

- **State:** Jotai single-store, action atoms for multi-atom side effects, hooks mounted once in the app shell. Ports directly (renderer-only).
- **IPC seam:** the old app funneled all IPC through two files (`_invoke.ts`, `events.ts`). Same discipline here: one **preload/contextBridge** module wraps `ipcRenderer.invoke`/events; tRPC client for server calls. Swappable seam, untouched call sites.
- **UI system:** the `tone`/`variant`/`shape`/`size` cva primitives, `tokens.css` typography tiers, `cn()`/tailwind-merge — port verbatim (platform-agnostic React).
- **App shell:** single-window, atom-driven view model (board ↔ editor), drawers/dialogs as summoned modals, hosts at root. Decompose the old 647-line `App.tsx`. **One forward-looking constraint:** the pane/tab system must not assume tabs are notes — post-v1 **vault apps** ([`prd/vault-apps.md`](prd/vault-apps.md)) open as first-class app tabs (sandboxed webviews with a `holi.*` bridge and Yjs-backed multiplayer state).

---

## 10. Security boundaries

- **Path safety** (`packages/shared`): reimplement the `resolve_relative` / `VaultPath` containment logic **test-first** — reject `..`/absolute/NUL, canonicalize through the closest existing ancestor, reassert containment. Guards the file bridge and any path from the agent/renderer. Security-critical; treat as a first-class module, not an afterthought.
- **Renderer isolation:** `contextIsolation: true`, no `nodeIntegration`; the renderer reaches main only through the preload bridge.
- **Agent posture:** trust boundary = vault membership (a small all-developer company; members are trusted colleagues — and a member's agent has no authority the member lacks). CC's native permission prompts stay on (never skip-permissions); the vault's shared `.claude/settings.json` seeds permission defaults (network-egress commands gated); MCP ops are membership-gated server-side (the authoritative boundary); snapshots/history (§3) are the recovery story — server truth means local wreckage always re-materializes. Prompt injection via shared content is a documented residual risk — no bespoke sandboxing in v1 (rejected: sandboxed-bash by default — friction on legit dev tasks; it gets turned off).
- **Theme injection:** if per-vault theme CSS is injected into a privileged context, validate it (parse, not substring-blocklist) or inject into a sandboxed context — the old substring validator was the weak point.
- **Server authz:** every tRPC + Yjs connection checked against membership; non-members rejected, owner-only actions gated to owners. No read-only role — every member connection is read-write.

---

## 11. Build & deploy (indicative)

- **Client:** Electron + Vite + React; packaged with electron-builder (dmg/nsis/AppImage).
- **Server:** Node/TS service (Hocuspocus + tRPC + Postgres), Syv-hosted on **Hetzner** (containerized; Hetzner object storage for archives/backups).
- **Shared:** `packages/shared` consumed by both; no codegen — types are the source.
- **Dev:** `pnpm dev` runs the server + the desktop app; one install for the workspace.
