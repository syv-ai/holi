# PRD — The Vault Assistant (agent)

The in-app Claude Code instance. This PRD covers its runtime, config, context injection, tool surface, permissions, collaboration behaviour, and history. The system spine is [`../architecture.md`](../architecture.md).

**Standing principle: build only what Claude Code doesn't already do, and work with CC as-is.** No adapter layers, no version-pinning ceremony — if a CC release breaks something, fix forward. Native Claude Code already provides the interactive UX, the file tools, the config layering, and the history; every subsystem below exists only because it clears that bar.

**What Holi builds is now exactly two things: the prompt content and the PTY runtime.** The MCP op surface is gone, and so is the file↔CRDT bridge. Both existed because the vault's truth was not the files the agent was editing. It is now, so the agent needs no adapter to be a full participant — it edits the vault the same way you do, with the tools it already has.

---

## Summary

Each employee's Electron app spawns **their own `claude`** in a **node-pty** PTY, authenticated with **their** Claude account, pointed at the vault's **clone directory**, rendered live in an **xterm.js drawer**. The agent works the vault with its native `Read/Write/Edit/Bash/Glob/Grep` tools, and that is the entire integration: its writes are file writes, picked up by the editor's watcher and the sync engine like any other.

Fresh per-turn context (active note, linked tasks, memory fill-state) is injected through a **`UserPromptSubmit` hook**; the base system prompt ships once via `--append-system-prompt` at launch. Config layering is **pure CC-native** — the repo's `.claude/` is the shared layer, the user's own `~/.claude` is the personal layer, Holi composes and syncs nothing. History is **`claude --resume`** — CC's own session picker, full-fidelity replay in the terminal; conversations stay machine-local.

The agent also gains one role it did not have before: it is the **conflict resolver**. When a pull cannot merge, Holi hands the merge to the agent rather than to a three-pane diff UI.

## Assumptions

These are load-bearing — they dissolved several risks outright:

- **Every employee is a developer.** The raw TUI drawer is the natural interface, not a liability to soften.
- **Claude Code is already installed and authenticated on every machine**, each employee on their own account with native auth. Holi does **no provisioning, no metering, no credential management**. The old login-PTY flow is at most an **edge-case fallback**.
- **Work with CC as-is.** No adapter layers, no version-pinning ceremony.
- **The agent is git-literate.** This is new, and the reconcile flow depends on it: resolving a merge conflict is a task Claude Code does well with the tools it already has, in a repo it is already sitting in.

## Goals / Non-goals

**Goals**
- Native Claude Code UX at full fidelity in-app: permission prompts, plan mode, thinking, todos, streaming, session resume — none of it re-implemented.
- Per-employee cost attribution via per-user auth.
- The agent edits vault files with native tools and **nothing mediates it**.
- The agent is the **merge repair tool**: one click hands a failed merge to the local agent to reconcile in the terminal.
- Port the old prompt content (the `agent_context` strings), memory budgets, and fill-indicator UX.
- **Zero tool surface**: no MCP server, no ops, no bearer token.

**Non-goals (v1)**
- No headless/server-side agent, no stream-json parsing for the live view.
- No custom history system — no JSONL parsing, no transcript reconstruction, no summarizer, no conversation store, no history search ops.
- No config composition and no per-user config sync — personal agent config is machine-local, full stop.
- No bespoke `safe`/`power_user` permission modes, no sandbox machinery.
- No self-improvement / curator loop, no `activity.jsonl`, no threat scanner.
- No multi-adapter runtime abstraction — Holi targets Claude Code directly.
- No vault apps in v1 — post-v1, design locked in [`vault-apps.md`](vault-apps.md).
- Calendar/mail integration is **phase-2**.

## User stories

- *As a member*, I open the assistant drawer, type into a real Claude session, and watch it read my notes, run commands, and edit files with the native TUI I already know.
- *As a member*, when I ask the assistant to "add a task for the Q2 review," it writes a file and the task appears on my board.
- *As a member*, when the assistant edits `roadmap.md` while I have it open with unsaved changes, both survive — the editor merges its write into my buffer.
- *As a member*, when a pull can't merge, I click **"Ask Claude to reconcile"** and my local agent resolves the conflict in the drawer, where I can watch it and answer if it asks.
- *As any user*, I pick up an old conversation from `claude --resume`'s session picker in the drawer — the full transcript replays right there in the terminal.
- *As any user*, my `~/.claude` setup and `CLAUDE.local.md` tweaks work in Holi exactly as they do in my shell — Holi never touches them.

---

## Runtime (PTY + xterm drawer)

The agent is **interactive Claude Code in a real terminal**, spawned client-side per user. **Why:** native Claude Code UX at full fidelity, native file tools, no brittle stream-json parsing for the live view, and per-user cost attribution. **Rejected:** a headless streaming session rendered in a custom chat panel (re-implements block assembly and the TUI), and a server-side agent (there is no server, and it would forfeit the native interactive UX regardless).

**Template.** The old `services/agents/login_pty.rs` is the working reference — it already spawns `claude` in a pseudo-terminal and streams bytes to an xterm.js modal. Generalize that to the **main interactive session**, in TypeScript with **node-pty** replacing `portable-pty`.

**Spawn (Electron main).**
- Binary: resolve `claude` on `PATH`; surface a clear "Claude CLI not found" error if absent.
- Working directory: **the vault's clone directory** — a real git repo, which is also why the agent can run git commands against it directly.
- **No `CLAUDE_CONFIG_DIR` override** — the agent runs against the user's own `~/.claude`.
- `--append-system-prompt <base prompt>` at launch (see Per-turn context).
- Env hygiene, ported from the template: strip `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` (so a Holi launched from a Claude shell doesn't refuse), inherit a usable `PATH` + `HOME` (GUI-launched Electron ships a stripped PATH and can't find node/ripgrep otherwise), set `TERM=xterm-256color`.
- **No `--mcp-config` and no `--strict-mcp-config`.** There is no Holi MCP server to declare. A vault may still configure its own MCP servers in `.claude/`, natively, and Holi does not interfere.
- **Never `--dangerously-skip-permissions`** — native prompts are the permission UX.

**Wire shape (IPC, ported from the template's event names).**
| Direction | Channel | Payload |
|---|---|---|
| main → renderer | `agent-pty:data` | `Uint8Array` chunk (xterm decodes) |
| main → renderer | `agent-pty:exit` | `{ code }` |
| renderer → main | `agent-pty:start` | `{ vaultId, resume?, prompt? }` |
| renderer → main | `agent-pty:write` | keystroke bytes |
| renderer → main | `agent-pty:resize` | `{ cols, rows }` |
| renderer → main | `agent-pty:kill` | — |

- A **reader loop** on the PTY master forwards each chunk to the renderer; **EOF/EIO** ends the session (the template treats `EIO`/errno 5 as normal remote-hangup).
- A **child-wait** task parks on the child, clears session state, then emits `exit` — clearing before emitting so a renderer that kills-on-exit doesn't race a dead child.
- **One live session per vault.** Starting a new one kills the prior child (SIGTERM → SIGKILL of the process **group** so Claude's helper subprocesses die too).
- Drawer lifecycle: opening the drawer starts (or re-attaches to) the session; the terminal is the **live** surface. The drawer's **history affordance** relaunches the session with `--resume`. Scrollback is ephemeral; durable history is CC's own sessions.
- **The `prompt` field on `start` is what the reconcile flow uses** — it seeds the session with the conflict-resolution instruction rather than making the user type it.

**Auth.** Per-user Claude account, already present per the Assumptions. If the probe finds no auth (port `claude_config::is_authenticated` against `~/.claude`), the drawer falls back to the `claude auth login` PTY flow — an edge case, kept because it's already written.

## Config layering (pure CC-native)

Holi builds **no config composition and no per-user config sync**. The layering is exactly Claude Code's own; Holi's only job is that the shared files exist in the working dir — and now they simply *are* in the repo.

**Why:** a composed per-launch config dir and a per-user config-sync subsystem are machinery CC already provides for free. **Rejected:** the composed three-tier config dir and the per-user config-sync subsystem.

**Shared (committed to the repo).**
- `.claude/` — persona (`SOUL.md`/`IDENTITY.md`), shared **skills** and **commands**, and `settings.json` with **seeded permission defaults** plus the `UserPromptSubmit` hook config.
- `AGENTS.md` (the user's "System"), imported by a Holi-managed `CLAUDE.md` shim.
- `MEMORY.md` (the shared vault scratchpad).

CC reads all of this from the cwd natively — **zero extra machinery**. A teammate updating a shared skill is an ordinary commit.

**This got strictly simpler.** The shared layer used to sync because a mirror materialized it out of a CRDT store; it now syncs because it is committed, which is also how every developer already ships shared Claude config.

**Personal (machine-local, untouched by Holi).**
- The user's own **`~/.claude`** — global config, personal skills, plugins, auth.
- **`CLAUDE.local.md`** in the clone — CC's native personal-per-project layer.
- **`USER.md`** (the agent's model of *you*) — personal and machine-local, and therefore **gitignored** by the vault template. This is a real requirement now, not a property of the sync engine: nothing stops `git add -A` from committing it, so `.gitignore` is what enforces the privacy the old design got from a server boundary.

**Holi app settings.**
- **`.holi/settings.json`** — vault-wide app settings, committed.
- **`.holi/settings.local.json`** — machine-local, gitignored (sync watermarks, reminder delivery state, UI prefs).

Because these are real files, native `Read/Edit/Write` on `MEMORY.md` / `USER.md` / a skill file *is* the edit path — no memory or skill ops.

## Per-turn context & system prompt

Two prompt payloads, both porting `services/agent_context.rs` content (hooks are CC-native, so this passes the standing-principle filter):

**1. Base system prompt — once, at launch, via `--append-system-prompt`.** Built by the port of `build_system_prompt`. Ordered blocks: identity layers (**IDENTITY then SOUL**), a Tools note, an "asking the user" note, agenda heuristics, then the Holi base — memory guidance (USER.md/MEMORY.md, when-to-save), skills guidance, the vault-system section (daily notes, recurrence, wiki-link rename, managed root files), output formatting, scripting, and the vault top-level directory tree. Capped at ~48k tokens with a truncation marker.

**Adjust in the port:** drop the `safe`/`power_user` permission-mode section; retarget memory/skill guidance from `mcp__holi__memory_*` / `skill_*` tools to **native file edits**; drop the `apps` section (post-v1); and **replace the task-ops guidance with the task file convention** — `task.<name>.md`, its frontmatter keys, the folder-is-the-lane rule, and the `done`-rolls-a-recurring-task rule. That convention is now the *only* thing the agent needs to know about tasks, and it belongs in the prompt precisely because it is a convention rather than a tool signature.

**2. Per-turn context — every prompt, via a `UserPromptSubmit` hook** configured in the repo's `.claude/settings.json`. You can't transparently prepend a `<system>` block to what a user types into an interactive TUI; the hook is the native mechanism. The old `build_per_turn_prefix` moves into the hook — a small Node/TS script that emits:
- **USER.md / MEMORY.md fill indicators** — `[31% — 1,240/4,000 chars]`, the port of `fill_indicator`. Hard budgets **USER.md 4,000 / MEMORY.md 5,000 chars**.
- **Active + open notes** — "Focused note: `path` (use `Read` to view)."
- **Related non-complete tasks** for the focused note and **backreferencing notes** (`[[links]]` into the focused note).
- **The vault's sync state** — new, and worth the line: whether the vault has unpublished commits or is mid-reconcile changes what the agent should do next, and it is the kind of thing an agent will otherwise cheerfully make worse.

**Rejected:** system-prompt-only context (goes stale within a session as the user switches notes) and an MCP resource pulled on demand (not guaranteed present; the model may forget to fetch it).

**Hook data source.** The hook needs the current focus + memory state. Electron main keeps a **focus snapshot file** fresh on every note switch; the hook reads that file, reads `USER.md`/`MEMORY.md` for the fill counts, and — now that everything is local — simply **greps the vault** for related tasks and backrefs instead of querying a server. That removes the open question the old design carried about transport and auth: there is nothing to authenticate to.

**Dedup.** Port the `PER_TURN_UNCHANGED_MARKER` optimization only if it proves worth it; in one long-lived, prompt-cached session the win is small.

## Tool surface: native only

**There is no MCP server.** The three v1 ops are gone, each for a reason that survives scrutiny:

| Retired op | Why it existed | Why it doesn't now |
|---|---|---|
| **`task_list`** | Filtering was a server query; full-vault file scans were forbidden. | Tasks are `task.*.md` files. One `Glob` finds them; the naming convention exists to make exactly this cheap. |
| **`task_set`** | `status: done` was ambiguous for a recurring task — roll forward, or end the series? | Resolved by convention, and the convention is safe: `done` rolls forward (Holi's watcher does the roll whoever wrote the file), and ending a series means deleting `recurrence` from the frontmatter. The conservative reading is the default one. |
| **`note_rename`** | Had to preserve CRDT Doc identity and rewrite `[[links]]` atomically — a server operation. | There is no Doc identity to preserve; a rename is `git mv` plus a link rewrite. It ships as a **vault skill** in `.claude/`, which is a text operation Claude is good at. |

**The cost, stated plainly.** A skill-driven rename is not atomic and can miss a link. That is a real regression against a server op, and it is accepted because the alternative is keeping an MCP server, its lifecycle, and its per-run bearer token alive for one tool. If misses prove common, the answer is to move rename into the app (where the file tree already implements it) and expose it to the agent as a **slash command** the user runs, not to resurrect the op surface.

**Everything else is native:** note read/write/append/backrefs → `Read/Write/Edit/Grep`; tasks → file ops; memory → edits on `USER.md`/`MEMORY.md`; skills → edits on skill files; asking the user → native `AskUserQuestion`; git → `Bash`; conversation recall → `claude --resume`.

**Phase 2** brings calendar and mail — external Google data, not vault files, and therefore the one category that will genuinely need an MCP server again. Reintroducing one *then*, for data that is not in the repo, is consistent with the rule; keeping one *now* would not be.

## Permissions & security posture

- **Trust boundary = repo access.** GitHub decides who can clone and push; a member's agent has no authority the member lacks. There is no server-side gate because there is no server — **the boundary moved to git**, and it is enforced at push time rather than per operation.
- **Native prompts stay on.** Holi **never** launches `claude` with skip-permissions.
- **Seeded permission defaults.** The repo's shared `.claude/settings.json` ships sensible defaults — e.g. network-egress commands like `curl` gated behind approval. Configuration, not machinery.
- **Git history is the recovery story.** This is *better* than the snapshot timeline it replaces: every autosave commit is a restore point, `git revert` and `git checkout` are the restore mechanism, and an agent that wrecks the working tree is undone by a command the user already knows. Destructive edits are recoverable as long as the last autosave commit predates them — which is the argument for the autosave debounce being short.
- **The blast radius grew in one specific way, and it should be named.** The agent has always had native `Bash`, but the vault directory is now a git repo with a push credential reachable from it. A destructive git command (`reset --hard`, `push --force`) is expressible where before the client had no `.git` at all. Mitigations: the clone is Holi-managed and contains nothing else, `git` is subject to the same native permission prompts as any command, and the remote's default branch can be protected on GitHub. **Not mitigated by:** trying to block git commands from the agent — it needs them for reconcile, and a blocklist that the reconcile flow must punch through is not a boundary.
- **Prompt injection via shared vault content** is a documented, accepted **residual risk** for v1. **Rejected:** sandboxed-bash by default (friction on legitimate dev tasks; it gets turned off), and treating shared vaults as hostile input.

## The agent as merge resolver

This replaces the old bridge/turn-protocol/reconcile section, and is much smaller than what it replaces.

**Ordinary editing needs no protocol.** The agent writes files; the editor's watcher reloads or 3-way merges ([`notes-editor.md`](notes-editor.md)); the sync engine commits. There is no soft lock, no frozen base, no positioned-ops translation, and no "Claude is editing…" presence state — the last of which existed to tell *co-authors* something, and there are no live co-authors in v1. **Staleness is Claude Code's own guard:** `Edit`/`Write` require a prior `Read` and fail if the file changed since.

**Conflict resolution is where the agent earns its place.** When an auto-pull hits a textual conflict, Holi aborts the merge and offers **Ask Claude to reconcile**. Accepting it:

1. **Pauses autosave and auto-pull** for that vault, so nothing writes underneath the resolution.
2. **Re-runs the merge for real**, leaving the conflict in the working tree.
3. **Opens the drawer** with a seeded prompt naming the conflicted paths and the two branches.
4. The agent resolves with native tools and git, **in front of the user**, who can watch and answer if it asks.
5. On a clean tree, Holi resumes normal operation.

**Why this rather than a conflict UI:** a three-pane merge editor is a large build that resolves conflicts *positionally*, which is exactly the wrong level for prose and for YAML frontmatter. An agent resolves on meaning, in a surface the user already has open. **Why user-triggered only:** no unattended rewrites and no token spend without opt-in — and a merge the user did not ask anyone to touch is one they can still resolve themselves in the terminal.

**Why this is safe to hand to an agent at all:** it operates inside git, mid-merge, on a repo whose pre-merge state is a commit. The worst outcome is recoverable with `git merge --abort`.

## What ports from the old codebase

Port to TypeScript, adapted as noted above:

- The **PTY/xterm template** — `services/agents/login_pty.rs` (spawn, env hygiene, reader loop, child-wait, resize; process-group cancellation from `runtime.rs`).
- The **prompt content** — `services/agent_context.rs`: `build_system_prompt` and `build_per_turn_prefix` (→ the `UserPromptSubmit` hook), memory budgets, `fill_indicator`.
- The auth probe (`claude_config::is_authenticated`) and the login-PTY fallback flow.

**Explicitly not ported:** the per-run bearer-token MCP handshake (`mcp_server.rs` / `mcp_handshake.rs`) and the ops. There is no MCP surface to hand-shake into.

## Edge cases & risks

- **The agent commits or pushes on its own.** It has `Bash` and a repo, so it can. Decide whether the system prompt tells it to leave git to Holi (recommended: yes, except during reconcile) — otherwise autosave and the agent will race to author the same commit.
- **Prompt injection via shared content** — accepted residual risk. Native permission prompts + seeded egress gating + git history bound the blast radius.
- **Hook latency** — the `UserPromptSubmit` hook runs on *every* prompt; a slow grep stalls the user's turn. Budget it (target < ~50 ms) and degrade to "context unavailable" rather than block. A vault-wide grep per turn is the thing to measure first.
- **`claude` missing or unauthenticated** — clear error + the fallback login PTY flow.
- **Shared config drift mid-session** — a pull can land a new `.claude/settings.json` mid-session, and some CC config is read at launch only; may need a "restart session to pick up config changes" nudge (open question).
- **Terminal resize / reflow** — xterm + node-pty resize wiring must stay in sync; test drawer resize under active output.
- **The agent editing during a reconcile** — the reconcile flow pauses autosave, but the *user* can still type. Decide whether the editor goes read-only while a reconcile is in progress (leaning: yes, for the conflicted files only).

## Dependencies

- **[`../architecture.md`](../architecture.md)** — the sync engine, and the reconcile flow this PRD's drawer is the surface for.
- **[`notes-editor.md`](notes-editor.md)** — the editor's external-write handling, which is what makes the agent's file writes safe against an open buffer.
- **[`tasks.md`](tasks.md)** — the task file convention, which is the agent's entire task interface and therefore belongs in the system prompt.
- **[`auth-identity.md`](auth-identity.md)** — GitHub access; the push credential the agent's repo can reach.

## Open questions

- **Should the agent touch git at all outside reconcile?** Leaning: the system prompt tells it not to commit or push, because Holi owns that cadence — but it must stay free to *read* history (`git log`, `git show`), which is genuinely useful in a vault.
- **`--resume` drawer UX.** Does relaunching the PTY with `--resume` inside the drawer feel native, or does the affordance need `--resume <id>` shortcuts for recent sessions?
- **Per-turn dedup value.** Is `PER_TURN_UNCHANGED_MARKER` worth porting? Measure before building.
- **Shared-config pickup.** Which shared `.claude/` files does CC read at launch only vs per-use? Determines whether a pulled config change needs a restart nudge.
- **Rename misses.** Does the rename skill lose links often enough to justify moving rename into the app as a slash command?

## Deferred

- **Self-improvement / curator loop.** Not in v1: designed around headless background forks, unproven value, and in a shared vault one person's background agent auto-editing **shared** skills/memory is a real hazard. If revived: scope auto-edits to the **personal** layer only; shared-layer changes become **proposals requiring approval**.
- **Vault apps** — post-v1, design in [`vault-apps.md`](vault-apps.md).
- **Agent theme proposals** — deferred.
- **Calendar + mail** — phase 2, and the one place a Holi MCP server is expected to return, because that data is not in the repo.
