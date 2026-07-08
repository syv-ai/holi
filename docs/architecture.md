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
- **Backup:** Postgres snapshots + object storage. No git (D3).

### Working copies and the file↔CRDT bridge (D2)
The agent uses **native file tools**, so every Doc a client cares about is **materialized** as a `.md` **working copy** on disk (under a per-vault working dir the agent's `claude` process is pointed at).

The **bridge** (in Electron main) runs both directions:
- **CRDT → file:** on remote update, re-materialize the working copy (debounced; skip if the agent has an in-flight write).
- **file → CRDT:** watch working copies (chokidar). On change, **diff** the new file text against the current CRDT text and apply the minimal set of Yjs ops. **Never blind-replace** — that's what preserves concurrent edits to other regions.

Staleness is handled by Claude Code itself: its `Edit`/`Write` require a prior `Read` and fail if the file changed since — so an agent write can't silently clobber a fresh remote edit; Claude re-reads and retries.

> **Tasks are NOT documents.** They're structured records (D4), synced via tRPC + server push, not Yjs. Only prose notes are CRDTs.

### Materialization scope
A client materializes working copies lazily (open docs + recently-touched + anything the agent is pointed at), not the whole vault, to keep disk and watchers bounded. The file tree itself is driven by server metadata (paths), not by scanning disk.

---

## 3. Identity, auth, access (D7)

- **Sign-in:** Google Workspace SSO (OAuth). Identity = Google account. The desktop app obtains a session token used for tRPC and to authenticate the Yjs WebSocket (Hocuspocus `onAuthenticate`).
- **Vaults & membership:** a vault has an owner and a membership list with roles **owner / member / viewer**. Personal vaults have a single member (the owner).
- **Authorization is server-side and total:** every tRPC call and every Yjs connection is checked against membership + role. Read-only viewers get read-only Yjs connections. The **agent's MCP ops are gated by the same role** (D10) — the client can't grant itself more than the user has.

---

## 4. The agent (D5, D6, D8, D9, D10)

### Runtime: interactive Claude in a PTY
Electron main spawns **`claude`** in a **node-pty** PTY, pointed at the vault's working-copy dir with the user's own Claude auth. Bytes stream to an **xterm.js** drawer in the renderer (write/resize/kill over IPC). This is the **live** surface — native Claude UX at full fidelity. (The old `login_pty` flow is the working template.)

### Config layering (D6)
The `claude` process sees a composed config directory:
- **Shared (tier-1):** the vault's `.claude/` (persona SOUL/IDENTITY, shared skills, shared commands), `AGENTS.md` (→ imported by a managed `CLAUDE.md` shim), `MEMORY.md`, theme.
- **Per-user (tier-2):** the user's personal overrides (`CLAUDE.local.md`-style), personal skills, `USER.md`.
- **Local (tier-3):** working-copy cache, offline queue.

Tiers 1 and 2 are **synced** (server-scoped: shared to the vault, or private to the user); tier 3 is machine-local. The client composes them into the config dir the PTY is launched with.

### Per-turn context (D8)
A **`UserPromptSubmit` hook** (configured in the composed `.claude/settings`) runs on every prompt and emits Holi's fresh context — active note, linked tasks, `USER.md`/`MEMORY.md` fill indicators. Claude appends it to context automatically. The base system prompt ships once via `--append-system-prompt` at launch. (Ports the old `build_system_prompt` / `build_per_turn_prefix` content.)

### MCP ops (D10)
A **local MCP server in Electron main** exposes only the non-file ops: **tasks, calendar, mail, `note_rename`, conversation/session search**. Per-run bearer token (as before); structured ops proxy to the Syv tRPC API. Everything else is Claude's native `Read/Write/Edit/Bash/Glob/Grep` on working copies.

- **Permissions:** Claude's native interactive prompts for file/bash + **server-side role gating** on MCP ops. No bespoke safe/power_user modes.
- **`note_rename`** is an op (not a native `mv`) because a rename must (a) preserve the CRDT Doc identity and (b) atomically rewrite `[[links]]` across affected docs — a server operation (D12).

### History (D9)
Two surfaces:
- **Live** = the xterm drawer.
- **History** = a structured, browsable, searchable view **reconstructed from Claude's session JSONLs**, with summaries from a **headless summarizer job**. Stored per-user (tier-2). The reconstruction parser and the JSONL-format coupling are re-implemented in TS and isolated behind one module (it's the most brittle dependency — contain it).

---

## 5. Tasks (D4, D4a, D4b, D19)

Structured records on the server, not files. Shape (`packages/shared`):

```ts
type Task = {
  id: string
  vaultId: string
  title: string
  status: 'todo' | 'doing' | 'done'
  area?: string            // vault folder path (drives swim lanes) — settable
  due?: string             // YYYY-MM-DD
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  reminder?: string        // Nd | Nw | YYYY-MM-DDTHH:MM
  recurrence?: Recurrence
  related: RelatedRef[]    // unified: note | task | email | event
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
- **Rename:** `note_rename` op → server rewrites the path + all referencing `[[links]]` in one atomic pass over the affected CRDT docs (D12). Backrefs and delete-with-references surfacing are server queries over doc content + the link index.
- **Folder hierarchy:** vaults have real paths/folders (needed for links, the file tree, and task `area`). Folder structure is server metadata.

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
- `per_user_state` — (user, vault, key) → value: USER.md, personal skills index, chat-history pointers, UI prefs (tier-2).
- `history_summaries` — per-user conversation summaries.
- `link_index` *(optional/derived)* — for fast backrefs/rename without full scans.

Object storage: attachments, doc snapshots/backups.

---

## 8. Client architecture (ports from old frontend)

- **State:** Jotai single-store, action atoms for multi-atom side effects, hooks mounted once in the app shell. Ports directly (renderer-only).
- **IPC seam:** the old app funneled all IPC through two files (`_invoke.ts`, `events.ts`). Same discipline here: one **preload/contextBridge** module wraps `ipcRenderer.invoke`/events; tRPC client for server calls. Swappable seam, untouched call sites.
- **UI system:** the `tone`/`variant`/`shape`/`size` cva primitives, `tokens.css` typography tiers, `cn()`/tailwind-merge — port verbatim (platform-agnostic React).
- **App shell:** single-window, atom-driven view model (board ↔ editor), drawers/dialogs as summoned modals, hosts at root. Decompose the old 647-line `App.tsx`.

---

## 9. Security boundaries

- **Path safety** (`packages/shared`): reimplement the `resolve_relative` / `VaultPath` containment logic **test-first** — reject `..`/absolute/NUL, canonicalize through the closest existing ancestor, reassert containment. Guards the file bridge and any path from the agent/renderer. Security-critical; treat as a first-class module, not an afterthought.
- **Renderer isolation:** `contextIsolation: true`, no `nodeIntegration`; the renderer reaches main only through the preload bridge.
- **Agent sandbox:** `claude` runs pointed at the vault working-copy dir; MCP ops are role-gated server-side (the authoritative boundary). The composed config dir isolates the agent from the user's global `~/.claude`.
- **Theme injection:** if per-vault theme CSS is injected into a privileged context, validate it (parse, not substring-blocklist) or inject into a sandboxed context — the old substring validator was the weak point.
- **Server authz:** every tRPC + Yjs connection checked against membership/role; viewers get read-only Yjs.

---

## 10. What's gone vs the old app

Deleted wholesale: git sync (auto-commit/push/pull, `.gitignore` sync-filter, GitHub repo creation), the local SQLite vault registry, client-minted vault UUIDs, the headless agent stream pipeline (`AgentStreamEvent`/delta reducer/`applyDelta`/`agents:message` IPC), file-based tasks (+ `area` phantom, orphan rescue, `source_file`), the 44-op MCP surface (→ ~5 ops), safe/power_user modes, the self-improvement/curator loop (+ `activity.jsonl`, review counters, threat scanner), the Mailspring bridge, and ts-rs codegen.

Also cut: the editor's View-Transition morph + frozen-caret/gap-mark/VT-naming machinery (D22).

Kept (ported to TS): the CodeMirror editor + **simplified** live-preview (no morph, D22), the UI primitive system + tokens, the Jotai patterns, path-safety, the wiki-link grammar, prompt content + memory budgets, recurrence/reminder rules, the daily-note stub heuristic, the PTY/xterm template.

---

## 11. Build & deploy (indicative)

- **Client:** Electron + Vite + React; packaged with electron-builder (dmg/nsis/AppImage).
- **Server:** Node/TS service (Hocuspocus + tRPC + Postgres), Syv-hosted (containerized).
- **Shared:** `packages/shared` consumed by both; no codegen — types are the source.
- **Dev:** `pnpm dev` runs the server + the desktop app; one install for the workspace.
