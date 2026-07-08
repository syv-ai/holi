# PRD — The Vault Assistant (agent)

The in-app Claude Code instance. This PRD covers its runtime, config, context injection, tool surface, permissions, collaboration behaviour, and history. Decisions referenced as **D#** live in [`../decisions.md`](../decisions.md); the system spine is [`../architecture.md`](../architecture.md) §4.

The through-line: the old agent was a **headless streaming pipeline** that Holi assembled block-by-block and rendered in a custom chat panel. The rebuild runs **interactive Claude Code in a real terminal** and gets out of its way. Almost everything the old pipeline did by hand — block assembly, delta reducing, a 44-op MCP surface, bespoke permission modes, a self-improvement loop — is deleted because native Claude Code already does it. What survives is the **prompt content**, the **PTY template**, a **~5-op MCP surface** for the things that aren't files, and the **structured history** (reconstructed, not stored).

---

## Summary

Each employee's Electron app spawns **their own `claude`** in a **node-pty** PTY, authenticated with **their** Claude account, pointed at the vault's **materialized working-copy dir**, rendered live in an **xterm.js drawer** (D5). The agent works the vault with its native `Read/Write/Edit/Bash/Glob/Grep` tools; a per-client **file↔CRDT bridge** propagates its edits into the shared documents exactly as if the user had typed them (D2). A small **local MCP server** in Electron main exposes only the non-file operations — tasks, calendar, mail, `note_rename`, history search — proxying structured ops to the Syv API, gated by the user's vault role (D10). Fresh per-turn context (active note, linked tasks, memory fill-state) is injected through a **`UserPromptSubmit` hook**; the base system prompt ships once via `--append-system-prompt` at launch (D8). The live surface is the terminal; a separate **history** view is reconstructed from Claude's session JSONLs with headless AI summaries, stored per-user (D9).

## Goals / Non-goals

**Goals**
- Native Claude Code UX at full fidelity in-app: permission prompts, plan mode, thinking, todos, streaming — none of it re-implemented (D5).
- Per-employee cost attribution and per-user auth (D5, D7).
- The agent edits shared documents through the same CRDT path as a human, showing up in presence as that user (D2, D20).
- Port the old prompt content, memory budgets, and fill-indicator UX verbatim (D8; carried-forward list in `decisions.md`).
- Keep the browsable/searchable structured chat history + summaries + conversation recall (D9).
- Collapse the MCP surface ~80% (44 → ~5 ops) by leaning on native file tools (D10).

**Non-goals (v1)**
- No headless/server-side agent, no stream-json parsing for the live view (D5).
- No bespoke `safe`/`power_user` permission modes (D10).
- No self-improvement / curator loop, no `activity.jsonl`, no threat scanner (D11).
- No agent-authored HTML apps/widgets (deferred, D17).
- No agent theme proposals in v1 — theme is a shared property edited by the user (D18).
- Mail/calendar ops are the **op slots** in the minimal surface; they light up with the Phase-2 Google integration (D17), not in the v1 core.

## User stories

- *As a member*, I open the assistant drawer, type into a real Claude session, and watch it read my notes, run commands, and edit files with the native TUI I already know.
- *As a member*, when I ask the assistant to "add a task for the Q2 review," it calls one tool and the task appears live on my board and my teammates' boards.
- *As a viewer* (read-only role), the assistant can read and answer but the server refuses its task/note-mutating ops — I can't accidentally get write access through the agent (D7).
- *As any user*, when the assistant edits `roadmap.md` while a teammate is also editing a different paragraph, both our changes survive (D2).
- *As any user*, I browse past conversations in a structured history view with AI summaries and search across them, separate from the live terminal (D9).
- *As any user*, my personal `USER.md` and personal skills follow me across devices and stay invisible to the team (D6).

---

## Runtime (PTY + xterm drawer)

**Template.** The old `services/agents/login_pty.rs` is the working reference — it already spawns `claude` in a pseudo-terminal and streams bytes to an xterm.js modal. The rebuild generalizes that from the one-off `claude auth login` flow to the **main interactive session**, in TypeScript with **node-pty** replacing `portable-pty`.

**Spawn (Electron main).**
- Binary: resolve `claude` on `PATH` (the old `which::which`); surface a clear "Claude CLI not found" error if absent.
- Working directory: the vault's **materialized working-copy dir** (the dir the file↔CRDT bridge writes into). This is the agent's sandbox root (architecture §9).
- `CLAUDE_CONFIG_DIR`: the **composed config dir** (see next section), which also isolates the agent from the user's global `~/.claude`.
- `--append-system-prompt <base prompt>` at launch (see Per-turn context).
- Env hygiene, ported from the template: strip `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` (so a Holi launched from a Claude shell doesn't refuse), inherit a usable `PATH` + `HOME` (GUI-launched Electron ships a stripped PATH and can't find node/ripgrep otherwise), set `TERM=xterm-256color`.
- `--mcp-config <blob>` + `--strict-mcp-config` so the local ops server (and only it, plus enabled vault MCP servers) is the complete MCP surface Claude sees.

**Wire shape (IPC, ported from the template's event names).**
| Direction | Channel | Payload |
|---|---|---|
| main → renderer | `agent-pty:data` | `Uint8Array` chunk (xterm decodes) |
| main → renderer | `agent-pty:exit` | `{ code }` |
| renderer → main | `agent-pty:start` | `{ vaultId }` |
| renderer → main | `agent-pty:write` | keystroke bytes |
| renderer → main | `agent-pty:resize` | `{ cols, rows }` |
| renderer → main | `agent-pty:kill` | — |

- A **reader loop** on the PTY master forwards each chunk to the renderer; **EOF/EIO** ends the session (the template treats `EIO`/errno 5 as normal remote-hangup).
- A **child-wait** task parks on the child, clears session state, then emits `exit` — clearing before emitting so a renderer that kills-on-exit doesn't race a dead child.
- **One live session per vault** (the template's single-global-session rule, scoped per vault). Starting a new one kills the prior child (SIGTERM → SIGKILL of the process **group** so Claude's helper subprocesses die too — from the old `runtime.rs` cancellation).
- Drawer lifecycle: opening the drawer starts (or re-attaches to) the session; the terminal is the **live** surface. Scrollback is ephemeral — durable history is the reconstructed view (D9).

**Auth.** Per-user Claude account (D5). Login reuses the existing `claude auth login` PTY flow verbatim (needs a real TTY; the headless `--print` path just says "Not logged in"). Login state is probed per config dir via `.claude.json`'s `oauthAccount` (ported `claude_config::is_authenticated`); on macOS the OAuth token lives in the Keychain (keyed on `CLAUDE_CONFIG_DIR`), on Linux via a `.credentials.json` symlink. If unauthenticated, the drawer surfaces the login flow instead of a session.

## Config layering (the three tiers; how composed & synced)

Claude Code's own layering (project `.claude/` + `CLAUDE.md` = shared; user-level + `CLAUDE.local.md` = personal) maps onto Holi's three tiers (D6). Before launching the PTY, the client **composes** one `CLAUDE_CONFIG_DIR` + working-dir `.claude/` from:

**Tier 1 — Shared (synced to every vault member).**
- Persona: `SOUL.md` / `IDENTITY.md`, shared **AGENTS.md** (the user's "System"), imported by a Holi-managed `CLAUDE.md` shim.
- Shared `MEMORY.md` (the vault scratchpad).
- Shared **skills** (`.claude/skills/<name>/SKILL.md`) and shared **commands**.
- Theme (tier-1 vault property, D18).
- Notes + tasks are shared vault data, not config, but conceptually tier-1.

**Tier 2 — Per-user, synced (just you, across your devices, invisible to the team).**
- Personal overrides in `CLAUDE.local.md` style.
- Personal skills.
- **USER.md** (the agent's model of *you*).
- Chat history pointers + summaries (see History), UI prefs.

**Tier 3 — Local (one machine).**
- Materialized working-copy cache, offline queue.
- The Holi-managed `CLAUDE_CONFIG_DIR` itself (ported `claude_config.rs`): isolated from `~/.claude`, seeded with a blank `installed_plugins.json` so no user-global plugins/skills/hooks bleed in, credentials symlinked/keychain-resolved per config dir.

**How composition works.** On drawer open / vault switch, Electron main **materializes** tiers 1 and 2 into the working dir's `.claude/` and the vault-root managed files (`CLAUDE.md` shim → AGENTS.md, `USER.md`, `MEMORY.md`), then points the PTY at them. Tier-1 content comes from the server scoped to the vault; tier-2 content comes from the server scoped to the **user** (`per_user_state`, architecture §7). Tier-3 stays machine-local. Because these are real files on disk, native `Read/Edit/Write` on `USER.md` / `MEMORY.md` / a skill file *is* the edit path — no memory/skill ops (D10, D11); the bridge/watcher syncs the change back to the right tier by which file changed.

> **One config dir, not per-vault.** Claude's OAuth keychain lookup is keyed on `CLAUDE_CONFIG_DIR`; a per-vault dir would force a re-login per vault (ported rationale from `claude_config.rs`). The single Holi-managed dir holds auth + plugins; per-vault/per-user *content* is composed into the working dir and vault-root files, not the config dir's global scope.

## Per-turn context & system prompt

Two prompt payloads, both porting `services/agent_context.rs` content (D8):

**1. Base system prompt — once, at launch, via `--append-system-prompt`.** Built by the port of `build_system_prompt`. Ordered blocks: identity layers (**IDENTITY then SOUL**), a Tools note, an "asking the user" note, agenda heuristics, then the Holi base — memory guidance (USER.md/MEMORY.md, when-to-save), skills guidance, the vault-system section (daily notes, recurrence, wiki-link rename, managed root files), output formatting, scripting, and the vault top-level directory tree. Capped at ~48k tokens (`TOTAL_CHAR_CAP`) with a truncation marker. **Adjust for the rebuild:** drop the `safe`/`power_user` permission-mode section (D10); retarget memory/skill guidance from `mcp__holi__memory_*` / `skill_*` tools to **native file edits** on `USER.md` / `MEMORY.md` / skill files (D10, D11); drop the `apps` section (deferred, D17); retarget task/note guidance to the surviving ops + native tools.

**2. Per-turn context — every prompt, via a `UserPromptSubmit` hook.** You can't transparently prepend a `<system>` block to what a user types into an interactive TUI, so the old `build_per_turn_prefix` moves into a Claude Code **`UserPromptSubmit` hook** configured in the composed `.claude/settings`. The hook is a small Node/TS script that emits (Claude appends its stdout to context automatically):
- **USER.md / MEMORY.md fill indicators** — `[31% — 1,240/4,000 chars]`, the port of `fill_indicator`. A low percentage is the every-turn signal that the model of the user/vault is thin; hard budgets **USER.md 4,000 / MEMORY.md 5,000 chars**.
- **Active + open notes** — "Focused note: `path` (use `Read` to view)."
- **Related non-complete tasks** for the focused note (queried from the server) and **backreferencing notes** (`[[links]]` into the focused note).
- Optionally attached email threads (Phase 2).

**Hook data source (design point).** The hook process needs the current focus + memory state. Recommended: Electron main keeps a **focus snapshot file** (e.g. `<config>/holi-turn-context.json`) fresh on every note switch / task change; the hook reads that file + reads `USER.md`/`MEMORY.md` for the fill counts + queries tasks/backrefs via the local endpoint. A file snapshot is chosen over an authenticated call because D8's whole point is that the context is **guaranteed present** every turn — no bearer handshake to fail. (Exact transport is an open question, below.)

**Dedup.** Port the `PER_TURN_UNCHANGED_MARKER` optimization only if it proves worth it: when nothing changed since the previous turn, the hook emits a one-line "context unchanged" marker instead of re-emitting multi-KB. In the interactive model the win is smaller (one long-lived session, prompt-cached) — treat as a nice-to-have, not required.

## MCP ops (the minimal surface; why; the proxy; permissions/role-gating)

**Why it shrinks ~80% (44 → ~5).** An interactive Claude Code already has `Read/Write/Edit/Bash/Glob/Grep`. Any vault action that is "just a file op" needs **no custom tool** (D10). The MCP server survives only for what is genuinely **not a plain file**: structured server records and one operation that must be atomic + identity-preserving.

**The surviving surface.**
| Op family | Why it can't be native | Notes |
|---|---|---|
| **Tasks** — `task_new` / `task_list` / `task_get` / `task_set` / `task_link` / `task_delete` | Tasks are structured **server records**, not `.md` files (D4). | The old `task_link_email`/`task_unlink_email` collapse into the unified `related[]` (D4). |
| **Calendar** — `calendar_list` / `calendar_events` | External Google data, not vault files. | Lights up in Phase 2 (D17). |
| **Mail** — read/search/compose/… | External Gmail data, not vault files. | Lights up in Phase 2 on Google APIs (D17); Mailspring killed (D17). Trim to what Gmail needs. |
| **`note_rename`** | Must (a) preserve the CRDT **Doc identity** and (b) atomically rewrite `[[links]]` across affected docs — a **server** operation (D12). A native `mv` would orphan the CRDT and the links. |  |
| **History search** — `session_search` + `conversation_search` | Recall over Claude's session JSONLs and the summary registry — not vault content. | See History. |

**What's cut from the old 44 and where it goes:** note read/write/append/open/backrefs → native `Read/Write/Edit/Grep`; `memory_*` → native edits on `USER.md`/`MEMORY.md` (D11); `skill_*` → native edits on skill files (D11); `ask_user` → native `AskUserQuestion`; `daily_archive` + `vault_import` → server-side automation / a later import path (D16); `theme_get`/`theme_propose` → deferred, theme is user-edited (D18).

**The proxy.** The MCP server runs in **Electron main** (architecture §1) with a **per-run bearer token** — ported from `mcp_server.rs` / `mcp_handshake.rs`: mint a token bound to the run, embed it in the `--mcp-config` blob's `Authorization: Bearer` header, keep `--strict-mcp-config` so Holi is authoritative and Claude never reads any other MCP config, and keep `alwaysLoad: true` so the ops load up front (no `ToolSearch` deferral race — and `ToolSearch` stays out of the builtin set). The ops themselves **proxy to the Syv tRPC API** (tasks, calendar, mail, rename) rather than touching a local DB; the token/vault binding scopes every call to one vault.

**Permissions / role-gating.** Two boundaries, no bespoke modes (D10):
1. **File + Bash:** Claude's **native interactive permission prompts** in the terminal. The user approves edits/commands exactly as in standalone Claude Code. (The old `permission.rs` allow-list machinery + `safe`/`power_user` split is deleted — the interactive prompts replace it.)
2. **MCP ops:** **server-side gating by vault role** — the authoritative boundary (architecture §3, §9). The old dispatcher gated `Op::REQUIRES_POWER_USER`; the rebuild gates on **membership role** instead: **viewer = read ops only, member = read + write, owner = all** (D7). Enforced at the tRPC layer the ops proxy into, so the client cannot grant the agent more than the user has.

## Agent-as-collaborator (bridge, presence)

The agent is a **first-class collaborator**, not a special writer (D2). It edits **working copies** with native tools; the per-client **file↔CRDT bridge** (Electron main, architecture §2) reconciles:
- **agent write → CRDT:** the bridge **diffs** old→new file text and applies the minimal Yjs ops. Never blind-replace — so a teammate's concurrent edit to another region survives. A full-document `Write` becomes a diff-merge.
- **CRDT → file:** remote updates re-materialize the working copy (debounced, skipped while the agent has an in-flight write).

**Staleness** is handled by Claude Code itself: `Edit`/`Write` require a prior `Read` and fail if the file changed since — so an agent write can't silently clobber a fresh remote edit; Claude re-reads and retries (D2).

**Presence.** Because the agent runs under **the user's** auth and session, its edits land in the CRDT as **that user's** changes and appear in Yjs **awareness** as that user (D20) — no separate "bot" identity in v1. Teammates see the doc changing under that person's avatar, same as manual typing. `note_rename` is the one exception that goes through the server (atomic link rewrite), still attributed to the user.

## History (live vs reconstructed; the JSONL coupling to isolate)

Two distinct surfaces (D9):

**Live = the xterm drawer.** Full-fidelity native Claude TUI. Ephemeral scrollback.

**History = reconstructed structured view.** Browsable, searchable, per-user (tier-2, D6). Holi keeps **no transcript store** — Claude owns the session JSONLs. The history view is **reconstructed** by replaying those JSONLs:
- **Reconstruction** ports `transcript::reconstruct_session` — replay each line through the same parser + reducer, group everything between two real user turns into one assistant message, strip the injected per-turn `<system>` block from user turns. **Lossy by design:** frontend-only attachment chips don't survive (accepted, D9).
- **Summaries** port `summarize.rs`: a **headless one-shot `claude`** job (not the interactive session) folds a finished thread into a `ConversationSummary` `{ significance: brief|full, title, summary, highlights }` and appends it to a per-user registry (the old portable `.holi/conversations.jsonl`, now `history_summaries` server-side, architecture §7). It runs **persona-free in a neutral cwd** so the vault identity doesn't derail it into *continuing* the conversation, injected with `USER.md`+`MEMORY.md`+a Holi explainer so it can judge relevance.
- **Search ops** (the two surviving history ops): `session_search` greps raw turns across session JSONLs (episodic "when did we discuss X"); `conversation_search` reads the summary registry (coarse "what have we worked on"). Never auto-injected — the agent pulls them on demand.

**The JSONL coupling — isolate it.** This is flagged as the **most brittle** dependency in the whole codebase (D9): it re-inherits a hard coupling to Anthropic's session-file format (lossy chips; breaks if the format changes). **Requirement:** the reconstruction parser (JSONL line → normalized message events) lives behind **one TypeScript module** with a narrow interface and its own fixtures/tests — the single place that knows the JSONL shape. Everything else (history UI, search ops, summarizer) consumes normalized events, so a format change is a one-module fix. Do not let JSONL-shape knowledge leak into the UI or the ops.

## What's removed vs the old agent

Deleted wholesale (architecture §10):
- **Headless stream pipeline:** `AgentStreamEvent`, the delta reducer, `apply_stream_event` block-assembly-in-Rust, the frontend `applyDelta` dispatcher, `AgentMessageDelta`, the `agents:message:<run_id>` IPC, and most of `runtime.rs`'s spawn-and-stream loop. Replaced by raw PTY bytes → xterm (D5).
- **The 44-op MCP surface** → ~5 ops. Gone: `note_read/write/append/open/backrefs`, `memory_*`, `skill_*`, `ask_user`, `daily_archive`, `vault_import`, `theme_get/theme_propose`, `task_link_email/unlink_email` (D10).
- **`safe` / `power_user` modes** and the whole `permission.rs` allow-list derivation (`allowed_tools`, `builtin_tools`, `fork_allowed_tools`, app-bridge lists). Replaced by native prompts + server role-gating (D10).
- **Self-improvement / curator loop** (D11): `review.rs`, `curator.rs`, `activity.rs` + `activity.jsonl`, review counters, the fork permission allow-lists, and most of the **threat scanner** (`threat_scan.rs`) — the scanner only existed to guard the writable-in-safe-mode `memory_*`/`skill_*` ops, which are gone.
- **`opencode` adapter** and the multi-adapter runtime abstraction — the rebuild targets Claude Code directly (matching the cross-agent convention: design for the standard, implement against Claude).
- **App bridge** (`.app.html` + `dispatch_app_op` + `HoliAppFrame`) — agent HTML apps deferred (D17).

Kept (ported to TS): the **PTY/xterm template**, the **prompt content** + memory budgets + fill indicators, the **transcript reconstruction** + summarizer + the two search ops, the per-run **bearer-token MCP handshake** shape, the **task ops** (reshaped to server records), **`note_rename`**.

## Edge cases & risks

- **JSONL format drift** (D9) — the headline risk. Mitigated by the single-module isolation above; add a fixture corpus and a canary test that fails loudly when a new Claude version changes the shape.
- **Bridge vs agent write races** — an agent `Write` mid-remote-update. Mitigated by the bridge's diff-merge (never blind-replace) + Claude's read-before-edit guard (D2). Test with two clients editing the same doc, one via agent.
- **Hook latency** — the `UserPromptSubmit` hook runs on *every* prompt; a slow query stalls the user's turn. The snapshot-file approach keeps it to local reads. Budget it (target < ~50 ms); degrade to "context unavailable" rather than block.
- **Role change mid-session** — a user demoted from member to viewer while a session is live. Server role-gating re-checks per op call, so the next mutating op fails cleanly; the live PTY doesn't need restart.
- **Working-copy / CRDT divergence on crash** — if the app dies with an un-synced file edit, the bridge reconciles on next materialize by diffing. Path safety (`packages/shared`) guards every path the agent hands the bridge (architecture §9).
- **Auth not present** — drawer surfaces the login PTY flow instead of a dead session (ported `is_authenticated` probe).
- **Terminal resize / reflow** — xterm + node-pty resize wiring must stay in sync (ported `resize` path); test drawer resize under active output.
- **Presence attribution** — agent edits appear as the user (§Agent-as-collaborator). If teammates find "the doc changed but the person says they didn't touch it" confusing, a lightweight "assistant editing" awareness flag is a fast follow (not v1).

## Dependencies

- **server-data** — `tasks`, `memberships`/roles, `per_user_state` (USER.md, personal skills, history pointers), `history_summaries`, the tRPC endpoints the MCP ops proxy into. The ops are thin; the server is the authority (D14, architecture §7).
- **auth-identity** — Google Workspace SSO + per-vault role (D7); the session token authenticates tRPC and scopes MCP ops. The tier-2 sync + role-gating both need it.
- **tasks** — the task record shape + board (D4/D4a/D4b); the task ops are the agent's write path into it, and per-turn context reads related tasks.
- **notes-editor** — the file↔CRDT bridge, wiki-link grammar, and `note_rename` server op (D2, D12); the agent's whole file-editing story rides on the bridge.
- **vaults-collaboration** — Yjs relay + awareness/presence (D1, D20); the agent shows up as the user in presence, and its edits fan out through the relay.

## Open questions

- **Hook transport.** Snapshot file vs a tiny authenticated localhost endpoint for the `UserPromptSubmit` hook to read focus/tasks/memory. Recommendation: snapshot file (no auth to fail, always present). Confirm it can carry live task/backref queries or whether the hook needs a read-only local endpoint for those.
- **Per-turn dedup value.** Is `PER_TURN_UNCHANGED_MARKER` worth porting given one long-lived, prompt-cached session? Measure before building.
- **Composed-config sync granularity.** How fast must tier-1/tier-2 edits (a teammate updating a shared skill, you updating `USER.md`) re-materialize into a *running* session's config dir? Some Claude config is read at launch only — may require a session note or restart-on-change for certain files.
- **Session ↔ vault mapping in JSONL search.** `session_search` scans `<config>/projects/<encoded-vault-path>/`; confirm the encoded-path scheme is stable across the new working-dir layout, and that per-user history stays isolated when config dirs are shared.
- **Presence for the agent.** Ship as pure user-attribution in v1, or add an "assistant is editing" awareness flag? (Leaning v1 = user-attribution only.)
- **Bridge diff granularity** on a large agent `Write` — does character-level diff scale, or do we need a line/block pre-pass? (Shared with notes-editor.)

## Deferred

- **Self-improvement / curator loop** (D11). If revived: scope auto-edits to the **personal** tier only; shared-tier changes become **proposals requiring approval** (no silent "why did the assistant change for everyone"). Would re-introduce a bounded activity log + a substantiality/ceiling gate, not raw counters.
- **Agent-authored HTML apps/widgets** (D17) — the old `.app.html` + `holi` bridge + sandboxed frames. Out of v1; the `apps`/`html-widget` prompt sections and the app-bridge op subset stay deleted until then.
- **Agent theme proposals** (D18) — theme is a shared, user-edited vault property in v1; the `theme_propose` approval flow can return if agent-authored theming proves wanted.
