# PRD — The Vault Assistant (agent)

The in-app Claude Code instance. This PRD covers its runtime, config, context injection, tool surface, permissions, collaboration behaviour, and history. The system spine is [`../architecture.md`](../architecture.md).

**Standing principle: build only what Claude Code doesn't already do, and work with CC as-is.** No adapter layers, no version-pinning ceremony — if a CC release breaks something, fix forward. Native Claude Code already provides the interactive UX, the file tools, the config layering, and the history; every subsystem below exists only because it clears that bar.

**What Holi builds is now essentially one thing: the PTY runtime and its drawer.** No MCP op surface, no file↔CRDT bridge, and — sharpened in the 2026-07-26 revision — **no prompt content**: Holi injects nothing into `--append-system-prompt`, and the per-turn hook injects only the *current focused file*. Claude Code stays pure; everything it needs to know lives in `AGENTS.md`/`CLAUDE.md` (read natively from the cwd) and in `.claude/skills/`, and the agent discovers vault state (tasks, backrefs, sync) with its own native tools. The agent edits the vault the same way you do, with the tools it already has.

---

## Summary

Each employee's Electron app spawns **their own `claude`** in a **node-pty** PTY, authenticated with **their** Claude account, pointed at the vault's **clone directory**, rendered live in an **xterm.js drawer**. The agent works the vault with its native `Read/Write/Edit/Bash/Glob/Grep` tools, and that is the entire integration: its writes are file writes, picked up by the editor's watcher and the sync engine like any other.

Holi builds **no prompt content**. `--append-system-prompt` is empty; vault conventions live in `AGENTS.md` (which CC reads natively via a `CLAUDE.md` shim) and capabilities are `.claude/skills/`. The only per-turn injection, through a **`UserPromptSubmit` hook**, is **the current focused note/file** — the one piece of state the agent cannot discover itself; it gets tasks, backrefs, and sync-state with native `Glob`/`grep`/`git`. Config layering is **pure CC-native** — the repo's `.claude/` is the shared layer and Holi composes and syncs nothing — but it is layered over **Holi's own config directory rather than the machine's `~/.claude`**, so a vault agent inherits the vault and not the laptop. History is **`claude --resume`** — CC's own session picker, full-fidelity replay in the terminal; conversations stay machine-local.

It renders in a **right-hand resizable drawer** (`AgentPanel`), toggled with **⌘J** and opened automatically by the reconcile flow. The agent also gains one role it did not have before: it is the **conflict resolver**. When a pull cannot merge, Holi hands the merge to the agent rather than to a three-pane diff UI.

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
- **Zero prompt engineering**: no built system prompt, no per-turn context beyond the current focused file. Conventions live in `AGENTS.md`; capabilities are skills.
- **Zero tool surface**: no MCP server, no ops, no bearer token.
- The agent can render a note to PDF via the bundled Typst (`$TYPST_BIN`) and the seeded `md-to-pdf` skill.

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
- *As any user*, my `CLAUDE.local.md` tweaks work in Holi exactly as they do in my shell, and my `~/.claude` is never written to. **It is also never read** — a vault agent runs on Holi's own config directory, so my personal skills and plugins are not in the vault (Config layering).

---

## Runtime (PTY + xterm drawer)

The agent is **interactive Claude Code in a real terminal**, spawned client-side per user. **Why:** native Claude Code UX at full fidelity, native file tools, no brittle stream-json parsing for the live view, and per-user cost attribution. **Rejected:** a headless streaming session rendered in a custom chat panel (re-implements block assembly and the TUI), and a server-side agent (there is no server, and it would forfeit the native interactive UX regardless).

**Template.** The old `services/agents/login_pty.rs` is the working reference — it already spawns `claude` in a pseudo-terminal and streams bytes to an xterm.js modal. Generalize that to the **main interactive session**, in TypeScript with **node-pty** replacing `portable-pty`.

**Spawn (Electron main).**
- Binary: resolve `claude` on `PATH`; surface a clear "Claude CLI not found" error if absent.
- Working directory: **the vault's clone directory** — a real git repo, which is also why the agent can run git commands against it directly.
- **`CLAUDE_CONFIG_DIR` → `userData/agent-config/`** — Holi's own, shared by every vault, so the machine's `~/.claude` is out of play (see Config layering). Reserved like the `HOLI_*` keys: any inherited value is stripped before ours is set, since an inherited one would silently put the agent back on the config this exists to exclude.
- **No `--append-system-prompt` content** (empty) — conventions come from `AGENTS.md`/`CLAUDE.md`, which CC reads natively (see Per-turn context).
- **`TYPST_BIN`** in the env when a typst binary is resolvable (find-only at spawn, non-blocking; see Rendering PDFs).
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

**Auth.** Per-user Claude account, already present per the Assumptions — but a login **in Holi's config directory**, which the machine's own Claude Code being logged in says nothing about. So the first launch after the relocation is logged out, once, ever.

**Holi says nothing about it, and that is the decision.** Claude Code prints `Not logged in · Please run /login` in the terminal the drawer is already showing, and `/login` is typed into that same terminal. A notice in Holi's header would be a **second copy of state Holi does not own** — and duplicate state has to be kept honest: `/login` spawns nothing, opens no turn and exits nothing, so it fires none of the events Holi has to refresh on, and the header's copy is wrong from the moment the user acts on it. The fix for a stale mirror is not a fresher mirror. There is **no login probe at all** — no `authenticated` field on agent status, and nothing reading `<configDir>/.claude.json`.

## Config layering (pure CC-native)

Holi builds **no config composition and no per-user config sync**. The layering is exactly Claude Code's own; Holi's only job is that the shared files exist in the working dir — and now they simply *are* in the repo.

**Why:** a composed per-launch config dir and a per-user config-sync subsystem are machinery CC already provides for free. **Rejected:** the composed three-tier config dir and the per-user config-sync subsystem.

**Holi does own a config *directory*, and that is not a walk-back of the sentence above.** What was rejected was Holi *composing* config — merging tiers into a directory each launch, which is CC's job. What ships is a **relocation**: `CLAUDE_CONFIG_DIR` points the agent at `userData/agent-config/`, and the layering inside it is still exactly Claude Code's own. Holi builds nothing there; it creates the directory and asserts one key in a settings file it merges rather than owns.

**Shared (committed to the repo).**
- `.claude/` — shared **skills** and **commands**, and `settings.json` with **seeded permission defaults** plus the `UserPromptSubmit` hook config (which emits only the focused-note line). (Persona files are deferred — see Per-turn context.)
- `AGENTS.md` (the user's "System"), imported by a Holi-managed `CLAUDE.md` shim.
- `MEMORY.md` (the shared vault scratchpad).

CC reads all of this from the cwd natively — **zero extra machinery**. A teammate updating a shared skill is an ordinary commit.

**This got strictly simpler.** The shared layer used to sync because a mirror materialized it out of a CRDT store; it now syncs because it is committed, which is also how every developer already ships shared Claude config.

**Personal (machine-local).**
- **The machine's `~/.claude` is not in play at all.** A vault agent runs on `userData/agent-config/`, so the user's global settings, personal skills, plugins, marketplaces and MCP servers are excluded **by construction** rather than by a list of things to switch off — a list needs extending every time Claude Code grows a new kind of user-level content, and fails open when it hasn't been. The agent sees Holi's config and the vault's; whose laptop it is running on stops being an input.
  - **This was found, not foreseen.** The agent drafted an email through a **claude.ai Gmail connector** instead of `holi-google`, routing around the token authority, the send gate and the cache in one call — because the connector was simply *there*, inherited from an account the vault never mentioned. The connector was the symptom; the inheritance was the fault.
  - **It costs one `/login`, once, ever.** Credentials are keyed to the config directory (measured — a symlinked `~/.claude.json` does not restore them), so the first launch after this shipped is logged out and the panel says so. One shared directory for every vault, because per-vault would charge that per vault while buying separate settings nothing needs — and **per-vault session history comes free regardless**, since Claude Code keys transcripts by working directory.
  - **What is lost, deliberately:** transcripts already under `~/.claude/projects/` are invisible to the relocated agent, so `--resume` starts empty once. Copying them across would mean rewriting another program's internal state store, which is a worse bet than a sentence in a release note.
  - **The vault's own `.claude/` is untouched and still outranks everything.** Isolation is from the machine, not from the vault: a vault may declare its own skills and MCP servers, which is why `--strict-mcp-config` stays off.
- **`CLAUDE.local.md`** in the clone — CC's native personal-per-project layer.
- **`USER.local.md`** (the agent's model of *you*) — personal and machine-local, and therefore **gitignored** by the vault template. This is a real requirement now, not a property of the sync engine: nothing stops `git add -A` from committing it, so `.gitignore` is what enforces the privacy the old design got from a server boundary.

**Holi app settings.**
- **`.holi/settings.json`** — vault-wide app settings, committed.
- **`.holi/settings.local.json`** — machine-local, gitignored (sync watermarks, reminder delivery state, UI prefs).

Because these are real files, native `Read/Edit/Write` on `MEMORY.md` / `USER.local.md` / a skill file *is* the edit path — no memory or skill ops.

## Per-turn context & system prompt

**Holi builds no prompt content.** This is the sharpest application of the standing principle, decided in the 2026-07-26 revision after the old repo over-engineered the agent on top of Claude Code. CC already reads `CLAUDE.md` (→ `@AGENTS.md`) from the cwd, already has native file/git/web tools, and already supports skills and `--resume`. So Holi builds none of it.

**1. Base system prompt — none.** `--append-system-prompt` is **empty**; there is no `build_system_prompt` port. Everything the old prompt carried moves to a place CC already reads or the agent already discovers:
- **Vault conventions** — the task-file convention (`task.<name>.md`, frontmatter keys, folder-is-the-lane, `done`-rolls-a-recurring-task), wiki-link rename, daily notes/recurrence, managed root files, the sync model, and **memory guidance** (USER.local.md/MEMORY.md, budgets, when-to-save) — live in **`AGENTS.md`** (read natively via the `CLAUDE.md` shim).
- **Capabilities** are **`.claude/skills/`**, not prompt prose.
- **The vault tree** is not injected; the agent `Glob`s it when it needs it.
- **Persona** (the old IDENTITY/SOUL injection) is dropped for v1; if wanted later it goes in a CC-native file (`CLAUDE.md`/`CLAUDE.local.md`), not a Holi injection.

**2. Per-turn context — one line, via a `UserPromptSubmit` hook.** The hook injects exactly one thing: **the current focused note/file** — "Focused note: `path`." That is the single piece of state the agent genuinely cannot get itself (it is editor-UI focus, which only Holi holds). Everything else the agent discovers with native tools on demand: **tasks** via `Glob **/task.*.md`, **backreferences** via `grep [[focused]]`, **sync-state** via `git status`/`git log` (it can run git — see below). No fill-indicators, no related-tasks list, no backref list, no sync-state block.

**Why so little:** every injected block is bespoke surface that duplicates a native capability and drifts from it. The focused file is the sole exception because it is UI state only Holi holds.

**Hook data source.** Electron main keeps a tiny **focus snapshot file** (`.holi/context.local.json`) fresh on every note switch, carrying just the focused note path; the hook reads it and emits the one line. No grep, no memory-counting, no server — sub-millisecond, so it never stalls a turn.

**Rejected:** the old rich system prompt + per-turn prefix (`build_system_prompt`/`build_per_turn_prefix`, fill-indicators, related tasks, backrefs, sync-state injection). This is precisely the "agent engineering on top of Claude Code" the old repo overdid; it is deleted, not ported.

## Tool surface: native only

**"No MCP server" was a statement about what Holi declares, and for a long time it was not a statement about what the agent could reach.** The session inherited the machine's `~/.claude` and the user's claude.ai account, so an `azure-devops` server and a set of cloud connectors were in the tool list of every vault agent — none of them declared here, and one of them used to send mail. Since the agent moved to Holi's own config directory (§Config layering) the sentence below describes the agent's actual surface, and not merely Holi's contribution to it.

**There is no MCP server.** The three v1 ops are gone, each for a reason that survives scrutiny:

| Retired op | Why it existed | Why it doesn't now |
|---|---|---|
| **`task_list`** | Filtering was a server query; full-vault file scans were forbidden. | Tasks are `task.*.md` files. One `Glob` finds them; the naming convention exists to make exactly this cheap. |
| **`task_set`** | `status: done` was ambiguous for a recurring task — roll forward, or end the series? | Resolved by convention, and the convention is safe: `done` rolls forward (Holi's watcher does the roll whoever wrote the file), and ending a series means deleting `recurrence` from the frontmatter. The conservative reading is the default one. |
| **`note_rename`** | Had to preserve CRDT Doc identity and rewrite `[[links]]` atomically — a server operation. | There is no Doc identity to preserve; a rename is `git mv` plus a link rewrite. It ships as a **vault skill** in `.claude/`, which is a text operation Claude is good at. |

**The cost, stated plainly.** A skill-driven rename is not atomic and can miss a link. That is a real regression against a server op, and it is accepted because the alternative is keeping an MCP server, its lifecycle, and its per-run bearer token alive for one tool. If misses prove common, the answer is to move rename into the app (where the file tree already implements it) and expose it to the agent as a **slash command** the user runs, not to resurrect the op surface.

**Everything else is native:** note read/write/append/backrefs → `Read/Write/Edit/Grep`; tasks → file ops; memory → edits on `USER.local.md`/`MEMORY.md`; skills → edits on skill files; asking the user → native `AskUserQuestion`; git → `Bash`; conversation recall → `claude --resume`.

**Phase 2 brought calendar and mail — and did *not* need an MCP server after all.** This document long predicted that external Google data would be the one category to justify reintroducing one. Building it (D67) showed the prediction was wrong, and the reason is worth keeping: what the agent actually needs is *a documented command that returns JSON*, and `Bash` already runs commands. An MCP server would have added a process lifecycle and a handshake to deliver something a shell script delivers.

So the tool surface is still **zero ops**, and it now holds for external data too:

- **`holi-google`** — a generated `/bin/sh` script (same shape as `$TYPST_BIN`), on the agent's `PATH`, with `$HOLI_GOOGLE_BIN` still pointing at it absolutely. Everything prints JSON. Reads: `agenda`, `search <query>`, `read <threadId>`. Writes: `mark-read`, `star`, `archive`, `trash`, `draft`, `send`, `reply`, `schedule`, `reschedule`, `unschedule`. **`send` takes either a composed message or `--draft <id>`**, and the second form is the one to use after `draft`: composing again delivers one message and orphans the draft (found in real use, 2026-08-14). **It is on `PATH` for the gate's benefit, not the agent's** — see below.
- It talks to a **loopback ops server in main** (`main/google/ops-server.ts`), modelled on this PRD's own hook server: ephemeral port, per-instance token, `127.0.0.1` only, reaching the child as `$HOLI_GOOGLE_PORT`/`$HOLI_GOOGLE_TOKEN`. All three keys are stripped from the inherited env before being set, so a vault's own env cannot redirect the agent at someone else's mailbox.
- **Main makes the Google calls and holds the tokens.** The agent receives results, never a credential — main is the sole token authority, so there is one refresher and a disconnect takes effect everywhere at once.
- Capability is documented as a **seeded skill** (`.claude/skills/gmail-calendar/`), which is where capability has lived since this PRD was written.
- **The boundary is policy, not scope — and it must be described that way.** The grant is `gmail.modify` plus `calendar.events`, so "the agent cannot send" is a fact about what is built and gated, never about what Google would refuse. Saying otherwise is the single most repeated error in this area: the read-only claim outlived its truth in this PRD, in the seeded skill, and in the generated CLI's own header, each time reading as an architectural guarantee. **The line is reversibility, not write-ness** — *the agent may do anything the user can undo, and nothing that reaches another human.* Three tiers, three deliberately different mechanisms:
  - **Impossible** — permanent deletion (the scope is not requested and will not be), and any calendar event carrying **attendees** (main refuses it inside the function it hands over, because inviting or cancelling emails people).
  - **Always asks** — `send` and `reply`, via a seeded `PreToolUse` hook. See §Permissions.
  - **Undoable** — everything else, gated by ordinary `permissions.ask` rules that a user may allow-always, because each has a one-click undo in Gmail or Google Calendar.
- **The writes go through the same functions the UI's router calls**, so a thread the agent archives leaves the list Holi is painting at the moment it leaves Gmail. The ops server is handed those functions and never the cache object — the reads still cannot see a cached anything, which is what keeps "ask again rather than reuse an old answer" true.

## Permissions & security posture

- **Trust boundary = repo access.** GitHub decides who can clone and push; a member's agent has no authority the member lacks. There is no server-side gate because there is no server — **the boundary moved to git**, and it is enforced at push time rather than per operation.
- **Native prompts stay on.** Holi **never** launches `claude` with skip-permissions.
- **Seeded permission defaults.** The repo's shared `.claude/settings.json` ships sensible defaults — e.g. network-egress commands like `curl` gated behind approval. Configuration, not machinery.
- **One exception, and it is machinery: the send gate** (D70). `send`/`reply` reach a person and cannot be recalled, so a permission rule is not enough — a rule is defeated by one *don't ask again* click, six weeks before the send that mattered. A seeded `PreToolUse` hook returns `permissionDecision: "ask"`, which **overrides `permissions.allow` and a prior "don't ask again"**. That override is the entire reason it is a hook and not a rule. The user still decides; they just always get to.
  - **It matches `Bash` broadly and decides in the script**, with no `if` condition. The agent can spell the command three ways — the bare name via `PATH`, `$HOLI_GOOGLE_BIN`, an absolute path — and a condition matching one of them fails **open** while still reading like protection. That is not hypothetical: D67 specified `Bash(holi-google send:*)` while the skill invoked `"$HOLI_GOOGLE_BIN" send`, so the gate as designed could never have fired. **A gate specified against a command string nobody checked against the invocation fails open, silently.**
  - **It fails closed.** Unparseable input, an unexpected shape, any internal error → `ask`. A gate that crashes into "no opinion" is a gate that opens.
  - **It names the recipients** it can read from the command, and says plainly when it cannot — a reply's recipients are derived from the thread and are *not* in the command. The message body is on stdin and is never shown, which is why the skill requires the agent to say what it is about to send before sending it.
  - **A `Bash` matcher sees only Bash, and that hole was found in real use.** The agent sent through a claude.ai **Gmail connector**; an MCP tool call is not a shell command, so the gate deferred and a message could have reached a person unasked. The honest limit recorded below said *cooperative, not adversarial* — this was worse than that admits, because a **cooperative** agent walked around the gate without trying, by reaching for the more convenient of two tools it could see. The gate now also matches `mcp__.*[Gg]mail.*`, but a matcher chasing tool names is belt: **the braces are that the agent no longer inherits tools nobody in this app declared** (§Config layering), plus `disableClaudeAiConnectors: true` asserted in both the vault's settings and Holi's own config dir, so a vault whose settings regress still gets no cloud connectors. **The lesson generalises past Gmail:** a gate that enumerates *how* a capability is reached is only ever as complete as the last inventory of tools; the durable control is over which tools exist.
  - **The honest limit:** this gates a *cooperative* agent, not an adversarial one. No string match survives `eval` or `sh -c`. The supported claim is "the agent never sends without you seeing it", not "the agent cannot send".
- **A managed file that only lands at vault creation is a migration that never happens** (D70). `ensureSeeded` was write-if-absent and ran only on clone/adopt, so the gate would have been absent from every vault that already existed — the hook file unwritten, `PreToolUse` unwired, and `send` reaching a real mailbox with nothing asking. `.claude/settings.json` is now **merged** key-wise (as `.gitignore` already was line-wise: add what Holi requires, keep the user's own hooks and rules, leave malformed JSON alone), and seeding runs on **every vault open**. Any future managed file inherits this or repeats the bug.
- **Git history is the recovery story.** This is *better* than the snapshot timeline it replaces: every autosave commit is a restore point, `git revert` and `git checkout` are the restore mechanism, and an agent that wrecks the working tree is undone by a command the user already knows. Destructive edits are recoverable as long as the last autosave commit predates them — which is the argument for the autosave debounce being short.
- **The blast radius grew in one specific way, and it should be named.** The agent has always had native `Bash`, but the vault directory is now a git repo with a push credential reachable from it. A destructive git command (`reset --hard`, `push --force`) is expressible where before the client had no `.git` at all. Mitigations: the clone is Holi-managed and contains nothing else, `git` is subject to the same native permission prompts as any command, and the remote's default branch can be protected on GitHub. **Not mitigated by:** trying to block git commands from the agent — it needs them for reconcile, and a blocklist that the reconcile flow must punch through is not a boundary.
- **Prompt injection via shared vault content** is a documented, accepted **residual risk** for v1. **Rejected:** sandboxed-bash by default (friction on legitimate dev tasks; it gets turned off), and treating shared vaults as hostile input.

## Git coexistence — Holi pauses while the agent works

The vault is a **regular git repo** and the agent may run **any** git it likes — commit, push, pull, resolve a merge. The one hazard is two git actors on one repo: Holi's own sync loop (autosave-commit on a quiet timer, periodic pull, push) and the agent. They must not contend on `.git/index.lock`, and an agent rebase/branch-switch must not strand Holi's loop.

**Rule: while the agent is *working* (mid-turn), Holi suspends its sync loop; it resumes after the turn goes idle (with a short settle).** So at any moment there is a single active git actor. Holi keys this off the working/idle status it already tracks from PTY activity. The user's ordinary editor autosave keeps running whenever the agent is idle — even with the drawer open — so the pause is scoped to actual agent turns, not the whole session.

`AGENTS.md` states this to the agent plainly: *git is yours; Holi pauses its own sync while you work, and reconciles when you're done.* This **supersedes** the old AGENTS.md prohibition on the agent running git.

## The agent as merge resolver

This replaces the old bridge/turn-protocol/reconcile section, and is much smaller than what it replaces.

**Ordinary editing needs no protocol.** The agent writes files; the editor's watcher reloads or 3-way merges ([`notes-editor.md`](notes-editor.md)); the sync engine commits. There is no soft lock, no frozen base, no positioned-ops translation, and no "Claude is editing…" presence state — the last of which existed to tell *co-authors* something, and there are no live co-authors in v1. **Staleness is Claude Code's own guard:** `Edit`/`Write` require a prior `Read` and fail if the file changed since.

**Conflict resolution is where the agent earns its place.** When an auto-pull hits a textual conflict, Holi aborts the merge and offers **Ask Claude to reconcile**. Accepting it:

1. **Pauses autosave and auto-pull** for that vault (the same suspend as Git coexistence, held for the whole reconcile rather than just a turn), so nothing writes underneath the resolution.
2. **Re-runs the merge for real**, leaving the conflict in the working tree.
3. **Opens the drawer** and starts the session with a **seeded first message** (the `prompt` field on `agent-pty:start`) naming the conflicted paths and the two branches — the user does not type it.
4. The agent resolves the `<<<<<`/`=====`/`>>>>>` markers with native tools and **finishes the merge itself** (`git add` + commit), **in front of the user**, who can watch and answer if it asks.
5. On a clean tree, Holi resumes normal operation.

**Why this rather than a conflict UI:** a three-pane merge editor is a large build that resolves conflicts *positionally*, which is exactly the wrong level for prose and for YAML frontmatter. An agent resolves on meaning, in a surface the user already has open. **Why user-triggered only:** no unattended rewrites and no token spend without opt-in — and a merge the user did not ask anyone to touch is one they can still resolve themselves in the terminal.

**Why this is safe to hand to an agent at all:** it operates inside git, mid-merge, on a repo whose pre-merge state is a commit. The worst outcome is recoverable with `git merge --abort`.

## Rendering PDFs

The agent can turn a note into a PDF with the **same Typst engine** the UI's "Convert to PDF" uses — one env var and one skill, no new machinery.

- **`$TYPST_BIN`** — Holi resolves the typst binary at agent spawn (find-only: `TYPST_BIN` env → cached download → `PATH`; **non-blocking**, never downloads on the spawn path) and, when found, sets it in the agent's env. A fire-and-forget `ensureTypst` caches it for the next spawn if the machine has never rendered. If it is unset, the skill's fallback says to run one UI Convert (or retry) to install typst.
- **The seeded `md-to-pdf` skill** (`.claude/skills/md-to-pdf/`) documents the template model (`.holi/document-templates/<slug>/`), the six-type field schema, the `doc(notePath, meta, assets)` contract, and the render recipe: compose a wrapper that imports the template's `doc` and calls it, then `"$TYPST_BIN" compile wrapper.typ <out>.pdf --root /`. The agent writes typed `meta` literals directly.
- **PDFs are outputs, never committed** — the skill writes them to a non-tracked path and reports it.

This lands as a late slice, once the agent is live. The typed-template mechanism it builds on already exists (see `../specs/2026-07-26-typed-template-fields-design.md`).

## What ports from the old codebase

Port to TypeScript, adapted as noted above:

- The **PTY/xterm template** — `services/agents/login_pty.rs` (spawn, env hygiene, reader loop, child-wait, resize; process-group cancellation from `runtime.rs`).
- The auth probe (`claude_config::is_authenticated`) and the login-PTY fallback flow.

**Explicitly not ported:** the per-run bearer-token MCP handshake (`mcp_server.rs` / `mcp_handshake.rs`) and the ops (no MCP surface to hand-shake into); and **the prompt content** — `build_system_prompt`, `build_per_turn_prefix`, memory budgets, `fill_indicator`. Holi builds no prompt content now; vault conventions live in `AGENTS.md` and the per-turn hook emits only the focused-note line.

## Edge cases & risks

- **The agent commits or pushes on its own.** Resolved: this is allowed and expected — the vault is a regular repo. The race with autosave is prevented not by forbidding git but by the **Git coexistence** rule: Holi suspends its sync loop while the agent is working. The residual sharp edge is a mid-turn agent `git checkout <branch>`/rebase that outlives the turn; `AGENTS.md` notes that a branch switch pauses sync until undone.
- **Prompt injection via shared content** — accepted residual risk. Native permission prompts + seeded egress gating + git history bound the blast radius.
- **Hook latency** — the `UserPromptSubmit` hook runs on *every* prompt; a slow grep stalls the user's turn. Budget it (target < ~50 ms) and degrade to "context unavailable" rather than block. A vault-wide grep per turn is the thing to measure first.
- **`claude` missing or unauthenticated** — clear error + the fallback login PTY flow.
- **Shared config drift mid-session** — a pull can land a new `.claude/settings.json` mid-session, and some CC config is read at launch only; may need a "restart session to pick up config changes" nudge (open question).
- **Terminal resize / reflow** — xterm + node-pty resize wiring must stay in sync; test drawer resize under active output.
- **The agent editing during a reconcile** — the reconcile flow pauses autosave, but the *user* can still type. Decide whether the editor goes read-only while a reconcile is in progress (leaning: yes, for the conflicted files only).

## Wiring state & build order

The agent is **fully built but orphaned** — `createAgentManager` is never called, there is no `agent` IPC/preload surface, and `AgentPanel` is mounted nowhere. `main/index.ts` keeps it off the startup path because `agent-manager.ts` still imports the deleted `server-client` (an unresolvable import there stops the window opening).

Three modules are **pre-D60 stale**, and this revision decides their fate:
- **`system-prompt.ts`** (the 191-line `build_system_prompt`) — **deleted**. No prompt is built.
- **`context-snapshot.ts`** — **shrunk to a focus-writer**: it writes only the focused note path to `.holi/context.local.json`. The task-record / `docId` / `RelatedRef` / backref logic is deleted; the agent discovers those natively.
- **The `server-client` dependency** — **deleted, not reimplemented.** Under focus-only context the manager no longer needs `listTasks`/`backrefs`, so the two calls that blocked startup simply go away.

The renderer also imports a non-existent `activeVaultIdAtom`; replace with `activeRemoteAtom` (a vault's identity is its remote under D60).

**Build order (tracer-first):**
1. **Spine + strip stale machinery** — delete the `server-client` dep and the stale prompt/context code; add the `agent` IPC/preload bridge (`agent-pty:{data,exit,start,write,resize,kill}` + `agent:status`) and the typed `window.holi.agent`; mount `AgentPanel` + ⌘J; instantiate `createAgentManager` in `index.ts`; `activeVaultIdAtom`→`activeRemoteAtom`. Empty `--append-system-prompt`; focus-only hook. Result: a live session in the drawer that edits the vault.
2. **Git coexistence** — Holi pauses its sync loop while the agent works; update `AGENTS.md`.
3. **Merge resolver** — conflict detection → "Ask Claude to reconcile" → seeded `prompt` on `start`.
4. **PDF capability** — `$TYPST_BIN` + the seeded `md-to-pdf` skill.

Each slice gets its own plan.

## Dependencies

- **[`../architecture.md`](../architecture.md)** — the sync engine, and the reconcile flow this PRD's drawer is the surface for.
- **[`notes-editor.md`](notes-editor.md)** — the editor's external-write handling, which is what makes the agent's file writes safe against an open buffer.
- **[`tasks.md`](tasks.md)** — the task file convention, which is the agent's entire task interface and therefore belongs in the system prompt.
- **[`auth-identity.md`](auth-identity.md)** — GitHub access; the push credential the agent's repo can reach.

## Open questions

- **`--resume` drawer UX.** Does relaunching the PTY with `--resume` inside the drawer feel native, or does the affordance need `--resume <id>` shortcuts for recent sessions?
- **Shared-config pickup.** Which shared `.claude/` files does CC read at launch only vs per-use? Determines whether a pulled config change needs a restart nudge.
- **Rename misses.** Does the rename skill lose links often enough to justify moving rename into the app as a slash command?

## Deferred

- **Self-improvement / curator loop.** Not in v1: designed around headless background forks, unproven value, and in a shared vault one person's background agent auto-editing **shared** skills/memory is a real hazard. If revived: scope auto-edits to the **personal** layer only; shared-layer changes become **proposals requiring approval**.
- **Vault apps** — post-v1, design in [`vault-apps.md`](vault-apps.md).
- **Agent theme proposals** — deferred.
- **Calendar + mail** — **landed** (D67, 2026-08-04) as a skill + `holi-google` command over a loopback ops channel, and **made read-write** (D68–D70, 2026-08-05): mail triage, drafting, sending and replying, plus time-blocking on the user's own calendar. The long-standing expectation that it would bring back an MCP server did not survive the build; see §Tool surface. **Proven against a real account 2026-08-14** — drafting, sending and reply threading all ran, and the delivered headers were read rather than trusted (`References` carried the whole chain, and the reply threaded). The `events.*` calls have still only met fakes.
