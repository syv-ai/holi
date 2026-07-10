# PRD — The Vault Assistant (agent)

The in-app Claude Code instance. This PRD covers its runtime, config, context injection, tool surface, permissions, collaboration behaviour, and history. Decisions referenced as **D#** live in [`../decisions.md`](../decisions.md); the system spine is [`../architecture.md`](../architecture.md) §4.

The through-line is **D30**: the old vault assistant was vastly overcomplicated — **build only what Claude Code doesn't already do, and work with CC as-is.** The old agent was a headless streaming pipeline that Holi assembled block-by-block and rendered in a custom chat panel. The rebuild runs **interactive Claude Code in a real terminal** and gets out of its way. Almost everything the old pipeline did by hand — block assembly, delta reducing, a 44-op MCP surface, bespoke permission modes, a self-improvement loop, JSONL transcript reconstruction, config composition — is deleted because native Claude Code already does it (or it never earned its keep). What survives is the **prompt content**, the **PTY template**, a **7-op MCP surface** (tasks + `note_rename`), and the **file↔CRDT bridge** that makes the agent a real collaborator.

---

## Summary

Each employee's Electron app spawns **their own `claude`** in a **node-pty** PTY, authenticated with **their** Claude account, pointed at the vault's **materialized working-copy dir**, rendered live in an **xterm.js drawer** (D5). The agent works the vault with its native `Read/Write/Edit/Bash/Glob/Grep` tools; a per-client **file↔CRDT bridge** propagates its edits into the shared documents via a turn protocol — soft lock, frozen base, diff → positioned Yjs ops (D2, D25) — with auto-snapshots and a one-click **agent reconcile** as the merge safety net (D26). A small **local MCP server** in Electron main exposes only the non-file operations — in v1 just **task ops** and **`note_rename`** — proxying to the Syv API, gated by vault membership (D10). Fresh per-turn context (active note, linked tasks, memory fill-state) is injected through a **`UserPromptSubmit` hook**; the base system prompt ships once via `--append-system-prompt` at launch (D8). Config layering is **pure CC-native** — the vault working dir's `.claude/` is the shared layer, the user's own `~/.claude` is the personal layer, Holi composes and syncs nothing (D6). History is **`claude --resume`** — CC's own session picker, full-fidelity replay in the terminal; conversations stay machine-local (D9).

## Assumptions (D30)

These are load-bearing — they dissolved several risks outright:

- **Every employee is a developer.** The raw TUI drawer is the natural interface, not a liability to soften.
- **Claude Code is already installed and authenticated on every machine**, each employee on their own account with native auth. Holi does **no provisioning, no metering, no credential management**. The old login-PTY flow shrinks to an **edge-case fallback** (surface a hint if `claude` is missing or unauthenticated; don't build an onboarding funnel around it).
- **Work with CC as-is.** No adapter layers, no version-pinning ceremony — if a CC release breaks something, fix forward.

## Goals / Non-goals

**Goals**
- Native Claude Code UX at full fidelity in-app: permission prompts, plan mode, thinking, todos, streaming, session resume — none of it re-implemented (D5, D9).
- Per-employee cost attribution via per-user auth (D5, D7).
- The agent edits shared documents through the same CRDT path as a human, showing up in presence as that user — including a *"Claude is editing…"* presence state during its turn (D2, D20, D25).
- The agent is the **semantic merge repair tool**: one click hands a garbled concurrent merge to the local agent to reconcile (D26).
- Port the old prompt content, memory budgets, and fill-indicator UX (D8; carried-forward list in `decisions.md`).
- Collapse the MCP surface ~85% (44 → 7 ops) by leaning on native file tools (D10).
- Zero config machinery: CC's own layering does shared-vs-personal (D6, D30).

**Non-goals (v1)**
- No headless/server-side agent, no stream-json parsing for the live view (D5).
- No custom history system — no JSONL parsing, no transcript reconstruction, no summarizer, no conversation store, no history search ops (D9).
- No config composition and no per-user config sync — personal agent config is machine-local, full stop (D6).
- No bespoke `safe`/`power_user` permission modes, no sandbox machinery (D10, D29).
- No self-improvement / curator loop, no `activity.jsonl`, no threat scanner (D11).
- No agent-authored HTML apps/widgets (deferred, D17).
- No agent theme proposals (`theme_propose` deferred) — theme is a shared vault property edited only by the owner (D18).
- Calendar/mail ops are **phase-2**, arriving with the Google integration (D17) — not stubbed in v1.

## User stories

- *As a member*, I open the assistant drawer, type into a real Claude session, and watch it read my notes, run commands, and edit files with the native TUI I already know.
- *As a member*, when I ask the assistant to "add a task for the Q2 review," it calls one tool and the task appears live on my board and my teammates' boards.
- *As any member or owner*, the assistant reads and writes freely — the server gates its ops on **vault membership**, not a read-only tier; there is no viewer role, so no "the agent could sneak in write access" case exists (D7, D29).
- *As any user*, when the assistant edits `roadmap.md` while a teammate is also editing a different paragraph, both changes survive — and while it works, teammates see *"Claude is editing…"* on the doc (D25).
- *As any user*, when a merge flag says "this merge may need a look," I click **"let Claude reconcile"** and my local agent writes back a clean version — with a snapshot taken first, so nothing is unrecoverable (D26).
- *As any user*, I pick up an old conversation by choosing it from `claude --resume`'s session picker in the drawer — the full transcript replays right there in the terminal (D9).
- *As any user*, my `~/.claude` setup and `CLAUDE.local.md` tweaks work in Holi exactly as they do in my shell — Holi never touches them (D6).

---

## Runtime (PTY + xterm drawer)

**Template.** The old `services/agents/login_pty.rs` is the working reference — it already spawns `claude` in a pseudo-terminal and streams bytes to an xterm.js modal. The rebuild generalizes that to the **main interactive session**, in TypeScript with **node-pty** replacing `portable-pty`.

**Spawn (Electron main).**
- Binary: resolve `claude` on `PATH` (the old `which::which`); surface a clear "Claude CLI not found" error if absent (per the D30 assumptions this is an edge case, not a flow).
- Working directory: the vault's **materialized working-copy dir** (the dir the file↔CRDT bridge writes into). This is the agent's working root (architecture §9).
- **No `CLAUDE_CONFIG_DIR` override** — the agent runs against the user's own `~/.claude` (D6). Auth, plugins, and personal skills are whatever the user already has.
- `--append-system-prompt <base prompt>` at launch (see Per-turn context).
- Env hygiene, ported from the template: strip `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` (so a Holi launched from a Claude shell doesn't refuse), inherit a usable `PATH` + `HOME` (GUI-launched Electron ships a stripped PATH and can't find node/ripgrep otherwise), set `TERM=xterm-256color`.
- `--mcp-config <blob>` + `--strict-mcp-config` so the local ops server (and only it, plus enabled vault MCP servers) is the complete MCP surface Claude sees.
- **Never `--dangerously-skip-permissions`** — native prompts are the permission UX (D29).

**Wire shape (IPC, ported from the template's event names).**
| Direction | Channel | Payload |
|---|---|---|
| main → renderer | `agent-pty:data` | `Uint8Array` chunk (xterm decodes) |
| main → renderer | `agent-pty:exit` | `{ code }` |
| renderer → main | `agent-pty:start` | `{ vaultId, resume? }` |
| renderer → main | `agent-pty:write` | keystroke bytes |
| renderer → main | `agent-pty:resize` | `{ cols, rows }` |
| renderer → main | `agent-pty:kill` | — |

- A **reader loop** on the PTY master forwards each chunk to the renderer; **EOF/EIO** ends the session (the template treats `EIO`/errno 5 as normal remote-hangup).
- A **child-wait** task parks on the child, clears session state, then emits `exit` — clearing before emitting so a renderer that kills-on-exit doesn't race a dead child.
- **One live session per vault** (the template's single-global-session rule, scoped per vault). Starting a new one kills the prior child (SIGTERM → SIGKILL of the process **group** so Claude's helper subprocesses die too — from the old `runtime.rs` cancellation).
- Drawer lifecycle: opening the drawer starts (or re-attaches to) the session; the terminal is the **live** surface. The drawer's **history affordance** relaunches the session with `--resume` (see History). Scrollback is ephemeral; durable history is CC's own sessions (D9).

**Auth.** Per-user Claude account (D5), already present per the D30 assumptions. If the probe finds no auth (ported `claude_config::is_authenticated` against `~/.claude`), the drawer falls back to the old `claude auth login` PTY flow — an edge case, kept because it's already written, not a product surface.

## Config layering (pure CC-native — D6)

Holi builds **no config composition and no per-user config sync**. The layering is exactly Claude Code's own; Holi's only job is that the shared files exist in the working dir, which they do because **vault content syncs** (D1, D23).

**Shared (syncs because vault content syncs).** The vault working dir carries:
- `.claude/` — persona (`SOUL.md`/`IDENTITY.md`), shared **skills** and **commands**, and `settings.json` with **seeded permission defaults** (e.g. network-egress commands gated behind approval — D29) plus the `UserPromptSubmit` hook config (D8).
- `AGENTS.md` (the user's "System"), imported by a Holi-managed `CLAUDE.md` shim.
- `MEMORY.md` (the shared vault scratchpad).

CC reads all of this from the cwd natively — **zero extra machinery**. A teammate updating a shared skill is just a doc edit that materializes like any other file.

**Personal (machine-local, untouched by Holi).**
- The user's own **`~/.claude`** — global config, personal skills, plugins, auth.
- **`CLAUDE.local.md`** in the vault working dir — CC's native personal-per-project layer.
- **`USER.md`** (the agent's model of *you*) — personal and machine-local.

Holi never reads, writes, or syncs any of these; your setup travels the way every developer's does. **Cost accepted (D6):** personal agent config does not follow you across devices — the assistant's model of *you* is per-machine, the same deliberate trade as machine-local history (D9).

**Holi app settings (mirroring CC's own shared/local convention).**
- **`.holi/settings.json`** — vault-wide app settings, synced as vault content.
- **`.holi/settings.local.json`** — machine-local override, never synced.

Because these are real files on disk, native `Read/Edit/Write` on `MEMORY.md` / `USER.md` / a skill file *is* the edit path — no memory/skill ops (D10, D11); the bridge/watcher syncs shared-file changes back like any doc edit, and personal files simply stay local.

## Per-turn context & system prompt

Two prompt payloads, both porting `services/agent_context.rs` content (D8 — hooks are CC-native, so this passes the D30 filter):

**1. Base system prompt — once, at launch, via `--append-system-prompt`.** Built by the port of `build_system_prompt`. Ordered blocks: identity layers (**IDENTITY then SOUL**), a Tools note, an "asking the user" note, agenda heuristics, then the Holi base — memory guidance (USER.md/MEMORY.md, when-to-save), skills guidance, the vault-system section (daily notes, recurrence, wiki-link rename, managed root files), output formatting, scripting, and the vault top-level directory tree. Capped at ~48k tokens (`TOTAL_CHAR_CAP`) with a truncation marker. **Adjust for the rebuild:** drop the `safe`/`power_user` permission-mode section (D10); retarget memory/skill guidance from `mcp__holi__memory_*` / `skill_*` tools to **native file edits** on `USER.md` / `MEMORY.md` / skill files (D10, D11); drop the `apps` section (deferred, D17); retarget task/note guidance to the surviving ops + native tools.

**2. Per-turn context — every prompt, via a `UserPromptSubmit` hook** configured in the shared `.claude/settings.json`. You can't transparently prepend a `<system>` block to what a user types into an interactive TUI, so the old `build_per_turn_prefix` moves into the hook — a small Node/TS script that emits (Claude appends its stdout to context automatically):
- **USER.md / MEMORY.md fill indicators** — `[31% — 1,240/4,000 chars]`, the port of `fill_indicator`. A low percentage is the every-turn signal that the model of the user/vault is thin; hard budgets **USER.md 4,000 / MEMORY.md 5,000 chars**.
- **Active + open notes** — "Focused note: `path` (use `Read` to view)."
- **Related non-complete tasks** for the focused note (queried from the server) and **backreferencing notes** (`[[links]]` into the focused note).
- Optionally attached email threads (Phase 2).

**Hook data source (design point).** The hook process needs the current focus + memory state. Recommended: Electron main keeps a **focus snapshot file** fresh on every note switch / task change; the hook reads that file + reads `USER.md`/`MEMORY.md` for the fill counts + queries tasks/backrefs via the local endpoint. A file snapshot is chosen over an authenticated call because D8's whole point is that the context is **guaranteed present** every turn — no bearer handshake to fail. (Exact transport is an open question, below.)

**Dedup.** Port the `PER_TURN_UNCHANGED_MARKER` optimization only if it proves worth it: when nothing changed since the previous turn, the hook emits a one-line "context unchanged" marker instead of re-emitting multi-KB. In the interactive model the win is smaller (one long-lived session, prompt-cached) — treat as a nice-to-have, not required.

## MCP ops (the minimal surface; why; the proxy; permissions)

**Why it shrinks ~85% (44 → 7).** An interactive Claude Code already has `Read/Write/Edit/Bash/Glob/Grep`. Any vault action that is "just a file op" needs **no custom tool** (D10, D30). The MCP server survives only for what is genuinely **not a plain file**: structured server records and one operation that must be atomic + identity-preserving.

**The v1 surface — task ops + `note_rename`, nothing else.**
| Op family | Why it can't be native | Notes |
|---|---|---|
| **Tasks** — `task_new` / `task_list` / `task_get` / `task_set` / `task_link` / `task_delete` | Tasks are structured **server records**, not `.md` files (D4). | The old `task_link_email`/`task_unlink_email` collapse into the unified `related[]` (D4). |
| **`note_rename`** | Must (a) preserve the CRDT **Doc identity** and (b) atomically rewrite `[[links]]` across affected docs — a **server** operation (D12, D27). A native `mv` would orphan the CRDT and the links. | |

**Phase 2 (with the Google integration, D17):** calendar ops (`calendar_list` / `calendar_events`) and mail ops (read/search/compose on Gmail APIs) — external Google data, not vault files. Not stubbed in v1.

**What's cut from the old 44 and where it goes:** note read/write/append/open/backrefs → native `Read/Write/Edit/Grep`; `memory_*` → native edits on `USER.md`/`MEMORY.md` (D11); `skill_*` → native edits on skill files (D11); `ask_user` → native `AskUserQuestion`; `daily_archive` + `vault_import` → server-side automation / a later import path (D16); `theme_get`/`theme_propose` → deferred, theme is user-edited (D18); `conversation_search` / `session_search` → **deleted with the custom history system** (D9) — recall is `--resume`.

**The proxy.** The MCP server runs in **Electron main** (architecture §1) with a **per-run bearer token** — ported from `mcp_server.rs` / `mcp_handshake.rs`: mint a token bound to the run, embed it in the `--mcp-config` blob's `Authorization: Bearer` header, keep `--strict-mcp-config` so Holi is authoritative and Claude never reads any other MCP config, and keep `alwaysLoad: true` so the ops load up front (no `ToolSearch` deferral race). The ops themselves **proxy to the Syv tRPC API** (tasks, rename) rather than touching a local DB; the token/vault binding scopes every call to one vault.

**Permissions.** Two boundaries, no bespoke modes (D10, D29):
1. **File + Bash:** Claude's **native interactive permission prompts** in the terminal, with defaults seeded by the shared `.claude/settings.json` (D29). The user approves edits/commands exactly as in standalone Claude Code. (The old `permission.rs` allow-list machinery + `safe`/`power_user` split is deleted.)
2. **MCP ops:** **server-side gating by vault membership** — the authoritative boundary (architecture §3, §9). **Any member or owner can call every read + write op; non-members are rejected.** There is **no viewer/read-only role, so no read-only agent case** (D7). Enforced at the tRPC layer the ops proxy into, so the client cannot grant the agent more than the user has.

## Agent-as-collaborator (bridge, turn protocol, presence, reconcile)

The agent is a **first-class collaborator**, not a special writer (D2). It edits **working copies** with native tools; the per-client **file↔CRDT bridge** (Electron main, architecture §2) mediates **agent↔CRDT only** — human↔human editing is pure Yjs and never touches the filesystem, which shrinks the race surface to one rare case (D25).

**The turn protocol (D25).**
1. When the agent starts writing a doc, the bridge takes a **soft lock**: the agent appears in presence as *"Claude is editing…"*, and **CRDT→file re-materialization is paused for that doc**, freezing the **base** (the last-materialized text) so remote edits arriving mid-turn can't poison the diff.
2. The agent edits the stable file freely — CC's read-before-edit guard is satisfied because the file doesn't move under it.
3. On turn end/idle: compute `diff(base, file)` and apply the patch as **positioned Yjs ops** onto the *live* CRDT (which may now contain buffered remote edits) — a 3-way merge, like git. **Never blind-replace**; a full-document `Write` becomes a diff-merge, so a teammate's concurrent edit to another region survives.
4. New base = merge result; re-materialize; release the lock.

Soft turn-taking makes human-vs-agent same-region collisions rare; when they do overlap, the CRDT converges with both texts surviving adjacently (deterministic order; spike-verified — see [../spikes/2026-07-10-bridge-turn-protocol.md](../spikes/2026-07-10-bridge-turn-protocol.md)), with the safety net below. **Staleness** within a turn is handled by Claude Code itself: `Edit`/`Write` require a prior `Read` and fail if the file changed since (D2). The bridge is the **only genuinely novel component left in the plan → Spike 1**, before any other code (D25) — **done, holds** (same report).

**Merge safety net (D26).** No conflict dialogs, ever (D21). Instead:
- **Auto-labeled snapshots** before risky operations — an agent bulk-write ("before Claude edited"), or reconciling a long-offline session. One-click restore from the Yjs snapshot timeline (D3). Snapshots are also the recovery story for destructive agent edits generally (D29).
- **Overlap detection:** when Yjs merges concurrent edits that touched **overlapping ranges**, the doc gets a **non-blocking** flag — *"this merge may need a look — let Claude reconcile?"*

**Agent reconcile — a new agent responsibility.** Accepting the flag hands a git-style 3-way (**base / mine / theirs**, reconstructed from snapshots) to the user's **local** agent, which writes a clean reconciled version back **through the bridge** (with its own pre-snapshot). CRDTs guarantee *same* text, not *sensible* text; this recreates git's intelligent-resolver step at the semantic layer, using the in-vault LLM — a differentiator no plain-CRDT app has. **User-triggered only** — no unattended rewrites, no token spend without opt-in (D26).

**Presence.** Because the agent runs under **the user's** auth and session, its edits land in the CRDT as **that user's** changes and appear in Yjs **awareness** as that user (D20) — plus the *"Claude is editing…"* state during a turn (D25). `note_rename` is the one exception that goes through the server (atomic link rewrite), still attributed to the user.

## Security posture (D29)

- **Trust boundary = vault membership.** A small all-developer company; members are trusted colleagues, and a member's agent has no authority the member lacks. MCP ops are membership-gated server-side; file access is scoped to the materialized vault.
- **Native prompts stay on.** Holi **never** launches `claude` with skip-permissions.
- **Seeded permission defaults.** The vault's shared `.claude/settings.json` ships sensible defaults — e.g. network-egress commands like `curl` gated behind approval. Configuration, not machinery; editable per vault.
- **Snapshots are the recovery story** (D26) — destructive edits restore from the Yjs timeline, and server truth means local wreckage always re-materializes.
- **Prompt injection via shared vault content** (a doc steering a member's agent) is a documented, accepted **residual risk** for v1. No bespoke sandboxing, no threat scanner (rejected in D29 as heavy machinery against a threat the team shape doesn't have).

## History (native `--resume` — D9)

No custom history system. The drawer's **history affordance relaunches `claude --resume`** — Claude Code's own session picker, in the same PTY/xterm surface. Picking a session replays the full transcript **in the terminal itself**, at perfect fidelity, for free, and continues it as a live session. Conversations remain **local to the machine that ran them** and are never synced. That's the whole story.

What this deletes (the reversed D9): the JSONL parser and transcript-reconstruction module, the local headless summarizer job, `ConversationSummary` / `conversations.jsonl`, the structured history view, and the `conversation_search` / `session_search` ops. That subsystem was the **single most brittle** in the plan — an undocumented coupling to Anthropic's session-file format, flagged as the top strategic risk — and it duplicated what CC does natively. Under D30 it was the standout violation; cutting it removes the brittlest coupling in the whole architecture. **Cost accepted:** no rich browse/search view outside the terminal, no cross-device history (conversations were already local-only).

## What's removed vs the old agent

Deleted wholesale (architecture §10):
- **Headless stream pipeline:** `AgentStreamEvent`, the delta reducer, `apply_stream_event` block-assembly-in-Rust, the frontend `applyDelta` dispatcher, `AgentMessageDelta`, the `agents:message:<run_id>` IPC, and most of `runtime.rs`'s spawn-and-stream loop. Replaced by raw PTY bytes → xterm (D5).
- **The custom history system** (D9): the JSONL parser, `transcript::reconstruct_session`, the headless summarizer (`summarize.rs`), `conversations.jsonl`, the structured history UI, and the `conversation_search`/`session_search` ops. Replaced by `claude --resume`.
- **Config composition + per-user config sync** (D6): the composed `CLAUDE_CONFIG_DIR`, tier materialization, the tier-2 sync subsystem, `per_user_state` for agent config (shrinks to UI prefs). Replaced by CC's native layering.
- **The 44-op MCP surface** → 7 ops. Gone: `note_read/write/append/open/backrefs`, `memory_*`, `skill_*`, `ask_user`, `daily_archive`, `vault_import`, `theme_get/theme_propose`, `task_link_email/unlink_email`, `conversation_search`/`session_search` (D10).
- **`safe` / `power_user` modes** and the whole `permission.rs` allow-list derivation (`allowed_tools`, `builtin_tools`, `fork_allowed_tools`, app-bridge lists). Replaced by native prompts + seeded settings + server membership-gating (D10, D29).
- **Self-improvement / curator loop** (D11): `review.rs`, `curator.rs`, `activity.rs` + `activity.jsonl`, review counters, the fork permission allow-lists, and the **threat scanner** (`threat_scan.rs`) — it only existed to guard the writable-in-safe-mode `memory_*`/`skill_*` ops, which are gone.
- **`opencode` adapter** and the multi-adapter runtime abstraction — the rebuild targets Claude Code directly (D30; matching the cross-agent convention: design for the standard, implement against Claude).
- **App bridge** (`.app.html` + `dispatch_app_op` + `HoliAppFrame`) — agent HTML apps deferred (D17).
- **Login-PTY as a product flow** — CC is assumed installed + authed (D30); the flow survives only as an edge-case fallback.

Kept (ported to TS): the **PTY/xterm template**, the **prompt content** + memory budgets + fill indicators (base prompt + `UserPromptSubmit` hook, D8), the per-run **bearer-token MCP handshake** shape, the **task ops** (reshaped to server records), **`note_rename`**.

## Edge cases & risks

- **Bridge vs agent write races** — the headline engineering risk now (with the JSONL coupling gone). Mitigated by the D25 turn protocol (frozen base, diff-merge, never blind-replace) + Claude's read-before-edit guard; backstopped by D26 snapshots + reconcile. **Spike 1:** two clients + an agent hammering one doc, before any other code.
- **Prompt injection via shared content** — accepted residual risk, documented (D29). Native permission prompts + seeded egress gating + snapshots bound the blast radius.
- **Hook latency** — the `UserPromptSubmit` hook runs on *every* prompt; a slow query stalls the user's turn. The snapshot-file approach keeps it to local reads. Budget it (target < ~50 ms); degrade to "context unavailable" rather than block.
- **Removed from the vault mid-session** — server-side gating re-checks membership per op call, so the next op fails cleanly; the live PTY doesn't need to restart. (The only *role* change is member↔owner — vault-admin capability that doesn't alter content read/write — so it never affects the agent's file/task path.)
- **Working-copy / CRDT divergence on crash** — if the app dies with an un-synced file edit, the bridge reconciles on next materialize by diffing against the frozen base. Path safety (`packages/shared`) guards every path the agent hands the bridge (architecture §9).
- **`claude` missing or unauthenticated** — clear error + the fallback login PTY flow; an edge case by assumption (D30), not a designed funnel.
- **Shared config drift mid-session** — a teammate's edit to a shared skill or `settings.json` materializes into the working dir, but some CC config is read at launch only; may need a "restart session to pick up config changes" nudge (open question).
- **Terminal resize / reflow** — xterm + node-pty resize wiring must stay in sync (ported `resize` path); test drawer resize under active output.
- **Presence attribution** — agent edits appear as the user, plus the "Claude is editing…" state during turns (D25). If post-turn attribution ("the doc changed but the person says they didn't touch it") confuses, a persistent per-edit assistant marker is a fast follow (not v1).

## Dependencies

- **server-data** — `tasks`, `memberships`, the tRPC endpoints the MCP ops proxy into (tasks + rename). The ops are thin; the server is the authority (D14, architecture §7). **Shrunk by D6/D9:** no `history_summaries` table, no per-user agent-config state — `per_user_state` is down to UI prefs.
- **auth-identity** — Google Workspace SSO + per-vault membership (D7); the session token authenticates tRPC and scopes MCP ops. Membership-gating is the agent's only server-side permission boundary (D29).
- **tasks** — the task record shape + board (D4/D4a/D4b); the task ops are the agent's write path into it, and per-turn context reads related tasks.
- **notes-editor** — the file↔CRDT bridge with the D25 turn protocol, wiki-link grammar, and `note_rename` server op (D2, D12, D27); the agent's whole file-editing story rides on the bridge. D26 reconcile also depends on the snapshot timeline (D3).
- **vaults-collaboration** — Yjs relay + awareness/presence (D1, D20); the agent shows up as the user (+ "Claude is editing…") in presence, and its edits fan out through the relay.

## Open questions

- **Hook transport.** Snapshot file vs a tiny authenticated localhost endpoint for the `UserPromptSubmit` hook to read focus/tasks/memory. Recommendation: snapshot file (no auth to fail, always present). Confirm it can carry live task/backref queries or whether the hook needs a read-only local endpoint for those.
- **`--resume` drawer UX.** Does relaunching the PTY with `--resume` inside the drawer feel native (picker renders fine in xterm, resume continues the session cleanly), or does the affordance need `--resume <id>` shortcuts for recent sessions? (Pure CC behaviour either way — no Holi parsing.)
- **Per-turn dedup value.** Is `PER_TURN_UNCHANGED_MARKER` worth porting given one long-lived, prompt-cached session? Measure before building.
- **Shared-config pickup.** Which of the shared `.claude/` files does CC read at launch only vs per-use (settings/hooks vs skills)? Determines whether a synced config change needs a restart-session nudge.
- **Presence for the agent.** The D25 "Claude is editing…" state covers in-turn presence; is a persistent per-edit attribution marker needed post-turn? (Leaning v1 = no.)
- **Bridge diff granularity** on a large agent `Write` — does character-level diff scale, or do we need a line/block pre-pass? (Shared with notes-editor; part of Spike 1.)

## Deferred

- **Self-improvement / curator loop** (D11). If revived: scope auto-edits to the **personal** layer only; shared-layer changes become **proposals requiring approval** (no silent "why did the assistant change for everyone"). Would re-introduce a bounded activity log + a substantiality/ceiling gate, not raw counters.
- **Agent-authored HTML apps/widgets** (D17) — the old `.app.html` + `holi` bridge + sandboxed frames. Out of v1; the `apps`/`html-widget` prompt sections and the app-bridge op subset stay deleted until then.
- **Agent theme proposals** (D18) — `theme_propose` is deferred; in v1 theme is a shared vault property that **only the owner** edits. The approval flow can return if agent-authored theming proves wanted.
- **Calendar + mail ops** (D17) — phase 2, with the Google integration (Gmail/Calendar APIs under the same OAuth; Mailspring killed).
