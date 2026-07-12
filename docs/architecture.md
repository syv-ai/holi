# Architecture

How the rebuilt Holi fits together. This is the technical spine; each PRD in [`prd/`](prd) drills into one pillar. Decisions referenced as **D#** live in [`decisions.md`](decisions.md).

---

## 1. System shape

Three deployable/importable pieces in one pnpm monorepo (D15):

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

Key property: **the client is not thin, and the server is not thin.** The client owns the live editing experience, the agent runtime, and the file bridge. The server owns truth, auth, structured data, and durability. `packages/shared` is the seam that keeps them honest — one definition of a task, a link, a path rule, used on both sides with no codegen.

---

## 2. Sync & storage (D1, D2, D3)

### Documents are CRDTs
Each note is a **Yjs document**. The **Syv relay** (Hocuspocus) is the durable source of truth and the fan-out point. Clients connect over WebSocket, receive/send Yjs updates, and participate in the **awareness** channel for presence.

- **Persistence:** Hocuspocus's `onStoreDocument` writes Yjs state (and periodic **snapshots** for the history timeline) to Postgres. `onLoadDocument` hydrates.
- **Offline:** each client persists the Yjs doc to a local store (e.g. `y-indexeddb` in the renderer, or a leveldb-backed store in main). Edits made offline are standard Yjs updates that replay and auto-merge on reconnect (D21). UI shows only a **sync-status indicator** — never a conflict dialog.
- **Backup:** Postgres snapshots + object storage. Git is not part of backup or client sync (D3) — but a vault can opt into a server-side **git mirror** for remote sessions (D32, below).

### Working copies and the file↔CRDT bridge (D2, D25)
The agent uses **native file tools**, so every Doc is **materialized** as a `.md` **working copy** on disk (under a per-vault working dir the agent's `claude` process is pointed at).

The **bridge** (in Electron main) mediates **agent↔CRDT only** — human↔human editing is pure Yjs and never touches the filesystem. Turn protocol (**D25**):
1. Agent starts writing a doc → **soft lock**: presence shows *"Claude is editing…"* and **CRDT→file re-materialization pauses** for that doc, freezing the **base**.
2. Agent edits the stable file freely (CC's read-before-edit guard is satisfied).
3. On turn end: `diff(base, file)` applies as **positioned Yjs ops** onto the live CRDT (3-way merge). **Never blind-replace.**
4. New base = merge result; re-materialize; release.

Staleness is handled by Claude Code itself: its `Edit`/`Write` require a prior `Read` and fail if the file changed since.

**Merge safety net (D26):** no conflict dialogs (D21) — instead, auto-labeled snapshots before risky operations (agent bulk-writes, long-offline reconciles), Yjs **overlap detection** flagging risky merges, and a non-blocking **"let Claude reconcile?"** that hands base/mine/theirs to the local agent for a semantic repair written back through the bridge.

> **Tasks are NOT documents.** They're structured records (D4), synced via tRPC + server push, not Yjs. Only prose notes are CRDTs.

### Materialization scope
A client materializes the **whole active vault** to disk as working copies (D23), so the agent's native `Grep`/`Glob`/`Read` see every doc — not just opened ones — and the file tree reflects real files. This holds permanently because the vault is **text by construction** (**D28**): PDFs/docx convert to markdown on entry; original binaries archive to object storage (Hetzner) and fetch on demand — never eagerly synced. **Lazy/partial materialization is a deferred optimization** for very large vaults. The file tree is still driven by server metadata (paths) as the authority; the working copies are the agent's substrate.

### Git mirror + remote-edit ingress (D32)
A vault owner can connect an **owner-provided GitHub repo**; the relay then maintains a **server-side mirror clone** and is the **only git writer** (clients still have no `.git`). Outbound, an **exporter** debounces vault edits and commits docs + `.claude/**` + `.holi/settings.json` to the default branch (bot-authored). Inbound, a webhook-driven **ingester** applies foreign commits (e.g. from **Claude Code cloud sessions** working the repo via the Claude GitHub App) by diffing each changed file against the **last-exported base** and applying the patch as positioned Yjs ops — the same D25 shape as the local bridge, guarded by a D26 pre-snapshot + overlap flags. Wiring uses the owner's linked GitHub OAuth once (installs a write deploy key + webhook); background operations run on the deploy key. Tasks never appear in the repo (D4). Full design: [specs/2026-07-13-vault-git-mirror-design.md](specs/2026-07-13-vault-git-mirror-design.md).

---

## 3. Identity, auth, access (D7)

- **Sign-in:** Google Workspace SSO (OAuth). Identity = Google account. The desktop app obtains a session token used for tRPC and to authenticate the Yjs WebSocket (Hocuspocus `onAuthenticate`).
- **Vaults & membership:** a vault has a membership list with **two roles — owner and member** (D7). **member** = read + write all content; **owner** = member + vault admin (membership, transfer, delete, theme/settings). **No viewer/read-only role.** Personal vaults have a single member (the owner).
- **Authorization is server-side and total:** every tRPC call and every Yjs connection is checked against membership. Non-members are rejected; owner-only actions (membership, delete, theme) are gated to owners. The **agent's MCP ops are gated by the same membership** (D10) — the client can't grant itself access the user doesn't have.

---

## 4. The agent (D5, D6, D8, D9, D10)

### Runtime: interactive Claude in a PTY
Electron main spawns **`claude`** in a **node-pty** PTY, pointed at the vault's working-copy dir with the user's own Claude auth. Bytes stream to an **xterm.js** drawer in the renderer (write/resize/kill over IPC). This is the **live** surface — native Claude UX at full fidelity. (The old `login_pty` flow is the working template.)

### Config layering (D6, D30)
**Pure CC-native layering — Holi composes nothing and syncs no personal config:**
- **Shared:** the vault working dir carries `.claude/` (persona SOUL/IDENTITY, shared skills/commands, `settings.json` with seeded permission defaults — D29), `AGENTS.md` (→ imported by a managed `CLAUDE.md` shim), and `MEMORY.md`. They sync because vault content syncs; CC picks them up from the cwd natively.
- **Personal (machine-local, untouched):** the user's own `~/.claude` + `CLAUDE.local.md` + `USER.md`. Holi never reads, writes, or syncs these.
- **Holi app settings:** `.holi/settings.json` (vault-wide, synced) + `.holi/settings.local.json` (machine-local override) — mirroring CC's own shared/local convention.

### Per-turn context (D8)
A **`UserPromptSubmit` hook** (configured in the vault's `.claude/settings`) runs on every prompt and emits Holi's fresh context — active note, linked tasks, `USER.md`/`MEMORY.md` fill indicators. Claude appends it to context automatically. The base system prompt ships once via `--append-system-prompt` at launch. (Ports the old `build_system_prompt` / `build_per_turn_prefix` content. Hooks are a supported CC mechanism — this passes the D30 filter.)

### MCP ops (D10)
A **local MCP server in Electron main** exposes only the non-file ops — in v1 just **tasks** and **`note_rename`** (calendar/mail join in phase 2). Per-run bearer token (as before); ops proxy to the Syv tRPC API. Everything else is Claude's native `Read/Write/Edit/Bash/Glob/Grep` on working copies.

- **Permissions:** Claude's native interactive prompts for file/bash + **server-side membership gating** on MCP ops (D29: never skip-permissions; vault `settings.json` seeds defaults like gated network egress). No bespoke safe/power_user modes.
- **`note_rename`** is an op (not a native `mv`) because a rename must (a) preserve the CRDT Doc identity and (b) atomically rewrite `[[links]]` across affected docs — a server operation (D12, D27).

### History (D9 — native)
No custom history system. The drawer's history affordance relaunches **`claude --resume`** — CC's own session picker, replaying the full transcript in the terminal at perfect fidelity. No JSONL parsing, no reconstruction, no summarizer, no sync. Conversations stay on the machine that ran them.

---

## 5. Tasks (D4, D4a, D4b, D19)

Structured records on the server, not files. Shape (`packages/shared`):

```ts
type Task = {
  id: string
  vaultId: string
  title: string
  status: 'todo' | 'doing' | 'done'
  area?: string            // stable folder ID (drives swim lanes) — settable; shown as path (D27)
  due?: string             // YYYY-MM-DD
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  reminder?: string        // Nd | Nw | YYYY-MM-DDTHH:MM
  recurrence?: Recurrence
  related: RelatedRef[]    // unified: note | task | email | event — by STABLE ID, shown as path (D27)
  createdAt: string; updatedAt: string
}
```

- **Sync:** tasks change via tRPC mutations; the server pushes updates to vault members (WebSocket/subscription) so boards are live. No CRDT (tasks are small structured records; last-writer-wins per field is fine).
- **Board:** default **Todo/Doing/Done** with **swim lanes by `area`** (folder) and lane-depth; simple filter bar. No time-bucket mode / 10-bucket system in v1 (D4b).
- **Recurrence & reminders:** the **rules** (grammar + roll-forward math) are pure functions in `packages/shared`. The **server** evaluates reminders and pushes fire events; clients raise native notifications (D19). Roll-forward runs server-side on completion.
- **Agent:** manipulates tasks via MCP task ops (create/list/set/complete/link), role-gated.

---

## 6. Notes, links, editor (D12)

- **Editor:** CodeMirror 6 with **simple live-preview** (reveal-raw-on-caret, **no animation** — the View-Transition morph and its frozen-caret/gap-mark machinery are cut, **D22**), plus a **`y-codemirror.next`** binding to the Doc's Yjs text and **remote cursors** from awareness. Keeps formatting hotkeys, wiki/markdown links, `@`-mentions, and the table widget + package. Cutting the morph erases the old "morph-vs-remote-edits" risk entirely — a remote edit just re-decorates.
- **Wiki-links:** path-based `[[folder/note.md]]`. One parser in `packages/shared` (ports `vaultRefs.ts`); thin renderers in editor/chat.
- **Rename:** `note_rename` op → server rewrites the path + all referencing `[[links]]` in one atomic pass over the affected CRDT docs (D12) — a **docs-only** operation: task records reference docs by stable ID (D27), so they need no rewrite. Backrefs and delete-with-references surfacing are server queries over doc content + the link index. Deletes render **tombstones** on dangling refs, no cascades (D27).
- **Folder hierarchy:** vaults have real paths/folders (needed for links, the file tree, and task `area`). Folder structure is server metadata; folders carry stable IDs (D27).

---

## 7. Data model (server, Postgres)

Indicative tables (detailed in [`prd/server-data.md`](prd/server-data.md)):

- `users` — Google identity, profile.
- `vaults` — id, name, kind (personal|shared), owner, theme, created/updated.
- `memberships` — (vault, user, role).
- `docs` — id, vault, path, kind (note|daily), timestamps. (CRDT state in `yjs_docs`/snapshots.)
- `yjs_docs` / `yjs_snapshots` — Yjs binary state + history timeline.
- `tasks` — the Task record (§5).
- `reminders` — derived/scheduled fire times for server-side evaluation.
- `per_user_state` — (user, vault, key) → value: **UI prefs only** (personal agent config — USER.md, personal skills — is machine-local, never synced, D6).
- `link_index` *(optional/derived)* — for fast backrefs/rename without full scans.

*(No conversation store: chat history is local/per-machine, D9 — never in Postgres.)*

Object storage (Hetzner): archived original binaries from import conversion (D28), doc snapshots/backups.

---

## 8. Client architecture (ports from old frontend)

- **State:** Jotai single-store, action atoms for multi-atom side effects, hooks mounted once in the app shell. Ports directly (renderer-only).
- **IPC seam:** the old app funneled all IPC through two files (`_invoke.ts`, `events.ts`). Same discipline here: one **preload/contextBridge** module wraps `ipcRenderer.invoke`/events; tRPC client for server calls. Swappable seam, untouched call sites.
- **UI system:** the `tone`/`variant`/`shape`/`size` cva primitives, `tokens.css` typography tiers, `cn()`/tailwind-merge — port verbatim (platform-agnostic React).
- **App shell:** single-window, atom-driven view model (board ↔ editor), drawers/dialogs as summoned modals, hosts at root. Decompose the old 647-line `App.tsx`. **One forward-looking constraint:** the pane/tab system must not assume tabs are notes — post-v1 **vault apps** (D31, [`prd/vault-apps.md`](prd/vault-apps.md)) open as first-class app tabs (sandboxed webviews with a `holi.*` bridge and Yjs-backed multiplayer state).

---

## 9. Security boundaries

- **Path safety** (`packages/shared`): reimplement the `resolve_relative` / `VaultPath` containment logic **test-first** — reject `..`/absolute/NUL, canonicalize through the closest existing ancestor, reassert containment. Guards the file bridge and any path from the agent/renderer. Security-critical; treat as a first-class module, not an afterthought.
- **Renderer isolation:** `contextIsolation: true`, no `nodeIntegration`; the renderer reaches main only through the preload bridge.
- **Agent posture (D29):** trust boundary = vault membership. CC's native permission prompts stay on (never skip-permissions); the vault's shared `.claude/settings.json` seeds permission defaults (network-egress commands gated); MCP ops are membership-gated server-side (the authoritative boundary); snapshots/history (D26) are the recovery story. Prompt injection via shared content is a documented residual risk — no bespoke sandboxing in v1.
- **Theme injection:** if per-vault theme CSS is injected into a privileged context, validate it (parse, not substring-blocklist) or inject into a sandboxed context — the old substring validator was the weak point.
- **Server authz:** every tRPC + Yjs connection checked against membership; non-members rejected, owner-only actions gated to owners. No read-only role — every member connection is read-write (D7).

---

## 10. What's gone vs the old app

Deleted wholesale: **client-side** git sync (auto-commit/push/pull, `.gitignore` sync-filter, GitHub repo creation) — git returns only as a relay-owned server-side mirror/ingress for remote sessions (D32, §2), the local SQLite vault registry, client-minted vault UUIDs, the headless agent stream pipeline (`AgentStreamEvent`/delta reducer/`applyDelta`/`agents:message` IPC), file-based tasks (+ `area` phantom, orphan rescue, `source_file`), the 44-op MCP surface (→ **2 ops in v1**, D10), safe/power_user modes, the self-improvement/curator loop (+ `activity.jsonl`, review counters, threat scanner), the Mailspring bridge, and ts-rs codegen.

Also cut this rebuild's own early over-designs (D30): the structured chat-history reconstruction + summarizer (D9 → native `--resume`), the composed config dir + per-user config sync (D6 → CC-native layering), and the editor's View-Transition morph + frozen-caret/gap-mark/VT-naming machinery (D22).

Kept (ported to TS): the CodeMirror editor + **simplified** live-preview (no morph, D22), the UI primitive system + tokens, the Jotai patterns, path-safety, the wiki-link grammar, prompt content + memory budgets, recurrence/reminder rules, the daily-note stub heuristic, the PTY/xterm template.

**The only genuinely novel component remaining is the file↔CRDT bridge (D25) — it is Spike 1, before any other code.** Everything else is standard practice (stock Hocuspocus + Postgres, Electron + node-pty + xterm, tRPC CRUD).

---

## 11. Build & deploy (indicative)

- **Client:** Electron + Vite + React; packaged with electron-builder (dmg/nsis/AppImage).
- **Server:** Node/TS service (Hocuspocus + tRPC + Postgres), Syv-hosted on **Hetzner** (containerized; Hetzner object storage for archives/backups, D28).
- **Shared:** `packages/shared` consumed by both; no codegen — types are the source.
- **Dev:** `pnpm dev` runs the server + the desktop app; one install for the workspace.
