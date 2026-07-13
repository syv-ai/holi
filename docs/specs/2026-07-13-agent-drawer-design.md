# Agent drawer — design

**Date:** 2026-07-13 · **Status:** approved by Nicolai (brainstorming session) · **Owning PRD:** [`../prd/agent.md`](../prd/agent.md)

## Why

The agent drawer is the second of the two hard things v1 exists to prove: an interactive Claude Code session inside the vault, editing shared content like a teammate through the file↔CRDT bridge. The PRD settles the rationale (native CC in a PTY, minimal MCP surface, CC-native config/history); this spec settles the design choices the PRD left open and the one hard precondition that does not exist yet — **working-copy materialization**. Today the desktop editor binds Yjs directly per open doc; nothing writes vault files to disk.

## Decisions made in this session

| Question | Decision |
|---|---|
| Scope | Everything except agent-reconcile + overlap-flag UX (they ride the later history/restore pillar). |
| Materialization | **Full live Yjs mirror in Electron main** — a live Y.Doc per doc for the whole active vault, one multiplexed WebSocket. Rejected: fetch-based files with on-demand live docs (two content paths, stale files, needs new server surface first); hybrid hot/cold (the deferred lazy-materialization optimization, pulled forward for no present need). |
| Turn signals | **CC hooks primary, watcher fallback** — PreToolUse (`Write\|Edit\|MultiEdit`) opens the turn, Stop ends it; chokidar idle-debounce + disk-recheck stays as defense and catches Bash-caused writes. Rejected: watcher-only (leaves the spike's race windows as-is); PTY busy/idle (fuzzy boundaries). |
| File lifecycle | **Full symmetry with the git-mirror ingress** — agent-created files become docs, agent-deleted files delete docs, raw `mv` = delete+create (identity lost; the system prompt steers to `note_rename`). Rejected: creates-only or content-only bridges (asymmetric with remote sessions; "create a note" silently failing to sync). |
| Doc-list sync | **Build the SSE endpoint now** — per-vault event stream off the existing bus (docs/tasks/reminders); also unblocks the live task board. Rejected: polling (throwaway); own-mutations-only (foreign renames never reach the agent's disk). |
| Panel geometry | **Right side panel** (Nicolai's pick over the recommended bottom drawer) — docked right, drag-resizable, min-width pinned to ~80 terminal columns so CC's TUI renders acceptably; editor stays visible alongside. |
| Session lifecycle | **One live session per active vault; vault switch kills it** (confirm first if mid-turn). Coherent with active-vault-only materialization; `--resume` restores the conversation on return. |
| Hook transport | **Snapshot file** — main keeps `.holi/context.local.json` fresh on focus/task changes (fetching related tasks + backrefs at change time); the UserPromptSubmit hook is pure local reads, nothing to auth or fail. |

## Scope

- **In:** VaultMirror (full-vault materialization in main), Bridge (turn protocol, per-doc), AgentRuntime (node-pty + `claude`), AgentPanel (xterm right dock), McpServer (7 ops + hook-signal routes), ContextSnapshot + hook scripts, base-system-prompt port, server SSE endpoint, managed-file seeding.
- **Out (this spec):** agent reconcile + overlap-flag UX (later history/restore work); vault apps; calendar/mail ops; self-improvement loop; custom history; per-turn dedup marker (`PER_TURN_UNCHANGED_MARKER` — measure first); persistent post-turn attribution markers.

## Architecture

New code lives in `apps/desktop` (main + renderer), one endpoint in `apps/server`, one promotion into `packages/shared`.

### VaultMirror (Electron main)

Owns the working dir for the **active vault**: `app.getPath('userData')/working-copies/<vaultId>/`.

- **Connections:** one `HocuspocusProviderWebsocket` to the relay; a multiplexed provider per doc (room = docId), for every doc in the vault. Doc list from tRPC at vault open; structural changes (create/rename/delete) via the SSE stream → open/close providers, move/remove files.
- **CRDT→disk:** debounced re-materialization on remote updates; **all writes tmp+rename** (atomic — the agent's `Read` never sees a torn file); paused per-doc while a bridge turn holds the lock. Base `{text, yjsState}` captured atomically with every write (spike invariant).
- **Managed seeding (idempotent, create-if-missing only):** the `CLAUDE.md` shim (imports `AGENTS.md`), `AGENTS.md`, `MEMORY.md`, `.claude/settings.json` (hook config + seeded permission defaults, e.g. gated network egress), and `.claude/hooks/*.mjs` — created as vault docs via `notes.create` on first materialization if absent, so they sync to every member like any content.
- **Local-only exclusion:** `USER.md`, `CLAUDE.local.md`, `*.local.*` (incl. `.holi/settings.local.json`, `.holi/context.local.json`) are never synced, never watched as vault content, and survive re-materialization untouched (`isLocalOnlyPath` in shared).
- **Teardown:** vault switch/delete stops providers and (on delete) removes the working dir.

### Bridge (Electron main)

Per-doc turn protocol, promoting the spike's `merge.ts` into `packages/shared` as `applyAgentTurn` (shadow-fork from frozen base → diff as positioned `Y.Text` ops → SV-delta merge into the live doc; never blind-replace).

- **Turn open** (per doc): freeze base, pause re-materialization for that doc, set awareness *"Claude is editing…"*, take the auto-labeled *"before Claude edited"* snapshot via the existing snapshots API (once per doc per turn). Primary signal: PreToolUse hook (payload carries `file_path`). Fallback: watcher disk≠base + the one-shot disk-recheck (spike finding 3 — mandatory regardless of signal source).
- **Turn end:** Stop hook (short settle delay) or watcher idle-debounce. Merge → **base = merge result, persisted, before the lock releases**; if the agent wrote again mid-merge, continue the turn on the agent-lineage base (frozen file text + shadow state), not the merge result (spike finding 2).
- **Base persistence:** per-doc `{text, yjsState}` written atomically to a machine-local store under `userData` at every advancement. On vault open, disk≠persisted-base ⇒ crash-time divergence, reconciled through a normal turn merge — never clobbered.
- **Lifecycle at turn end (git-ingress symmetry):** new files → `vaultRelPath` guard → `notes.create` + content applied as ops + provider opened; unlinked files → `notes.delete` (dangling refs render tombstones, no cascades). Paths failing the safety check are ignored and logged.
- **Presence:** the mirror's awareness state per doc during turns, attributed to the user + agent flag; renderer editors render the label on the existing remote-presence plumbing.
- Human↔human editing remains pure Yjs and never touches this path.

### AgentRuntime (Electron main)

Port of the old `login_pty.rs` shape to node-pty:

- Resolve `claude` on PATH; clear "Claude CLI not found" error if absent. Auth probe against `~/.claude`; login-PTY fallback flow if unauthenticated (edge case, not a funnel).
- Spawn: cwd = working dir; env hygiene (strip `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`, inherit usable PATH+HOME, `TERM=xterm-256color`); args `--append-system-prompt <base prompt>`, `--mcp-config <blob>`, `--strict-mcp-config`; **never** `--dangerously-skip-permissions`. History affordance relaunches with `--resume` (native picker in the terminal).
- Reader loop forwards chunks to the renderer; EOF/EIO = normal hangup; child-wait clears session state before emitting exit. One session per vault; starting a new one (or switching vaults) kills the prior **process group** (SIGTERM→SIGKILL).
- IPC wire shape (through the one preload seam): `agent-pty:start {vaultId, resume?}` / `write` / `resize` / `kill` renderer→main; `agent-pty:data (Uint8Array)` / `exit {code}` main→renderer.

### McpServer (Electron main)

Localhost HTTP server, port picked at spawn, **per-run bearer token** embedded in the `--mcp-config` blob (`alwaysLoad: true`). Two jobs:

1. **7 MCP ops** — `task_new/list/get/set/link/delete` + `note_rename` — proxied through the existing main-process ServerClient with the **user's session token**, so membership gating stays server-side and the agent can never outrank the user.
2. **Hook-signal routes** — `/hook/pre-tool-use`, `/hook/stop` — same bearer, feeding the Bridge's turn boundaries.

The PTY env carries `HOLI_AGENT_ENDPOINT` + `HOLI_AGENT_TOKEN` for the hook scripts.

### Context injection

- **Base system prompt** (once, at spawn): port of the old `build_system_prompt` — identity layers (IDENTITY then SOUL), tools note, asking-the-user note, agenda heuristics, memory guidance (retargeted to native edits on `USER.md`/`MEMORY.md`), skills guidance, vault-system section, output formatting, scripting, vault top-level tree. ~48k-char cap with truncation marker. Dropped: permission-mode section, apps section; task/note guidance retargeted to the 7 ops + native tools.
- **Per-turn** (`UserPromptSubmit` hook): emits `USER.md`/`MEMORY.md` fill indicators (budgets 4,000/5,000 chars, `fill_indicator` port), focused + open notes, related non-complete tasks, backreferencing notes — read from `.holi/context.local.json`. **ContextSnapshot** in main rewrites that file on renderer focus changes and task SSE events, fetching tasks/backrefs at change time. Hook budget <50 ms; degrades to "context unavailable" rather than blocking.
- **Hook scripts are vault content** (`.claude/hooks/*.mjs`, synced): they read the env-provided endpoint/token and **no-op cleanly** when absent (bare `claude` in the working dir outside Holi) or when the endpoint is unreachable.

### AgentPanel (renderer)

Right-docked panel in the shell; xterm.js + fit addon over the `agent-pty:*` IPC. Drag-resizable; min-width pinned to ~80 terminal columns. `⌘J` toggles (default, configurable later). The panel stays mounted when hidden — scrollback survives; the PTY runs regardless. Header: status dot (idle/working, driven by turn state), **history** (`--resume` relaunch), **restart**, **close** (=hide). Vault switch prompts if a turn is live, then kills the session. A non-blocking "restart session to pick up config changes" hint appears when synced `.claude/**` content changes during a live session.

### Server: SSE endpoint

`GET /events/<vaultId>` on the existing HTTP server — bearer-authenticated, membership-checked, streaming the bus's `docs`/`tasks`/`reminders` events per vault (the subscription surface the bus was built for). Consumed by VaultMirror (docs) and ContextSnapshot (tasks); later by the task board. Reconnect triggers a full doc-list refetch to resync structure.

## Error handling

- **Relay drop:** providers auto-reconnect; turn-end merges apply to the local live doc and sync on reconnect (standard Yjs offline semantics) — the bridge never blocks on the network.
- **Hook delivery failure:** the watcher path handles the whole turn; hooks only sharpen boundaries.
- **Crash mid-turn:** persisted base → normal turn merge on next vault open.
- **Membership revoked mid-session:** every MCP op re-checks server-side and fails cleanly; the PTY keeps running.
- **Path safety:** every path from the agent/watcher/hooks passes `vaultRelPath`; failures are ignored and logged, never partially applied.
- **`claude` missing/unauthenticated:** clear panel error / login-PTY fallback.

## Testing

Vitest throughout, matching the workspace harness style:

- **shared:** `applyAgentTurn` promoted with the spike's 13 tests adapted; the two invariants (atomic base capture, base-advances-before-release) as explicit tests.
- **Bridge:** spike-style in-process Hocuspocus harness — hook-signaled turns, watcher-fallback turns, create/delete lifecycle round-trips, crash recovery from persisted base, local-only exclusion, mid-merge agent-write continuation, and the randomized hammer test re-run against the real bridge.
- **VaultMirror:** materialization, SSE-driven create/rename/delete, atomic writes, idempotent seeding, teardown.
- **McpServer:** bearer rejection, op proxying against the test server, hook routes.
- **ContextSnapshot + hook scripts:** fixture-driven unit tests.
- **Server:** SSE endpoint (bus → stream, membership gate, reconnect refetch).
- **E2E:** CDP smoke with a **fake `claude`** (a script that reads/writes working-copy files and calls the hook endpoints) driving drawer → edit → live editor update; manual real-`claude` smoke at the end (as with the git mirror).

## Build order

Two natural plan-sized slices with a clean seam: **(1) foundations** — SSE endpoint, VaultMirror, Bridge, `applyAgentTurn` promotion (fully testable headless, no PTY involved); **(2) the drawer** — AgentRuntime, AgentPanel, McpServer, context injection, seeding (rides on 1). The fake-`claude` e2e closes slice 2.

## Open items (deliberately deferred)

- `--resume` picker ergonomics inside xterm — verify during build; add `--resume <id>` shortcuts only if the native picker feels wrong.
- Per-turn dedup marker — measure before porting.
- Bridge diff cost on very large docs — measure at build time; vaults are small text by construction.
- Persistent post-turn attribution marker — fast follow if post-turn "who changed this" confuses.
