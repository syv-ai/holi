# PRD — The Vault Assistant (agent)

The in-app Claude Code instance. This PRD covers its runtime, config, context injection, tool surface, permissions, collaboration behaviour, and history. The system spine is [`../architecture.md`](../architecture.md).

**Standing principle: build only what Claude Code doesn't already do, and work with CC as-is.** No adapter layers, no version-pinning ceremony — if a CC release breaks something, fix forward. Native Claude Code already provides the interactive UX, the file tools, the config layering, and the history; every subsystem below exists only because it clears that bar.

**What Holi builds is now essentially one thing: the PTY runtime and the tabs it shows in.** No MCP op surface, no file↔CRDT bridge, and — sharpened in the 2026-07-26 revision — **no prompt content**: Holi injects nothing into `--append-system-prompt`, and the per-turn hook injects only the *current focused file*. Claude Code stays pure; everything it needs to know lives in `AGENTS.md`/`CLAUDE.md` (read natively from the cwd) and in `.claude/skills/`, and the agent discovers vault state (tasks, backrefs, sync) with its own native tools. The agent edits the vault the same way you do, with the tools it already has.

---

## Summary

Each employee's Electron app spawns **their own `claude`** in a **node-pty** PTY, authenticated with **their** Claude account, pointed at the vault's **clone directory**, rendered live in an **xterm.js terminal**. The agent works the vault with its native `Read/Write/Edit/Bash/Glob/Grep` tools, and that is the entire integration: its writes are file writes, picked up by the editor's watcher and the sync engine like any other.

Holi builds **no prompt content**. `--append-system-prompt` is empty; vault conventions live in `AGENTS.md` (which CC reads natively via a `CLAUDE.md` shim) and capabilities are `.claude/skills/`. The only per-turn injection, through a **`UserPromptSubmit` hook**, is **the current focused note/file** — the one piece of state the agent cannot discover itself; it gets tasks, backrefs, and sync-state with native `Glob`/`grep`/`git`. Config layering is **pure CC-native** — the repo's `.claude/` is the shared layer and Holi composes and syncs nothing — but it is layered over **Holi's own config directory rather than the machine's `~/.claude`**, so a vault agent inherits the vault and not the laptop. History is **`claude --resume`** — CC's own session picker, full-fidelity replay in the terminal; conversations stay machine-local.

Each session renders in an **ordinary tab** beside notes, apps and the board (D101), opened with **⌘J**, from the sidebar's sessions list, or by the reconcile flow. It used to be a right-hand drawer; a tab can be split beside the note it is about, and several can be on screen at once. The agent also gains one role it did not have before: it is the **conflict resolver**. When a pull cannot merge, Holi hands the merge to the agent rather than to a three-pane diff UI.

## Assumptions

These are load-bearing — they dissolved several risks outright:

- **Every employee is a developer.** The raw TUI is the natural interface, not a liability to soften.
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
- No self-improvement / curator loop, no `activity.jsonl`, no threat scanner ([`../not-built.md`](../not-built.md)).
- No multi-adapter runtime abstraction — Holi targets Claude Code directly.
- No vault apps in v1 — post-v1, design in [`vault-apps.md`](vault-apps.md), status in [`../not-built.md`](../not-built.md).
- **The agent does not propose a theme.** It authors one directly ([`../architecture.md`](../architecture.md) §9); a propose-and-approve flow is deferred ([`../not-built.md`](../not-built.md)).

## User stories

- *As a member*, I open a session tab, type into a real Claude session, and watch it read my notes, run commands, and edit files with the native TUI I already know.
- *As a member*, when I ask the assistant to "add a task for the Q2 review," it writes a file and the task appears on my board.
- *As a member*, when the assistant edits `projects/q2/roadmap.md` while I have it open with unsaved changes, both survive — the editor merges its write into my buffer.
- *As a member*, when a pull can't merge, I click **"Ask Claude to reconcile"** and my local agent resolves the conflict in a session tab, where I can watch it and answer if it asks.
- *As any user*, I pick up an old conversation from `claude --resume`'s session picker in a new tab — the full transcript replays right there in the terminal.
- *As any user*, my `CLAUDE.local.md` tweaks work in Holi exactly as they do in my shell, and my `~/.claude` is never written to. **It is also never read** — a vault agent runs on Holi's own config directory, so my personal skills and plugins are not in the vault (Config layering).

---

## Runtime (PTY + xterm tabs)

The agent is **interactive Claude Code in a real terminal**, spawned client-side per user. **Why:** native Claude Code UX at full fidelity, native file tools, no brittle stream-json parsing for the live view, and per-user cost attribution. **Rejected:** a headless streaming session rendered in a custom chat panel (re-implements block assembly and the TUI), and a server-side agent (there is no server, and it would forfeit the native interactive UX regardless).

**Template.** The old `services/agents/login_pty.rs` is the working reference — it already spawns `claude` in a pseudo-terminal and streams bytes to an xterm.js modal. Generalize that to the **main interactive session**, in TypeScript with **node-pty** replacing `portable-pty`.

**Spawn (Electron main).**
- Binary: resolve `claude` on `PATH`; surface a clear "Claude CLI not found" error if absent.
- Working directory: **the vault's clone directory** — a real git repo, which is also why the agent can run git commands against it directly.
- **`CLAUDE_CONFIG_DIR` → `userData/agent-config/<owner>-<repo>/`** — Holi's own, **one directory per vault** (D86), so the machine's `~/.claude` is out of play and one vault's sessions, transcripts and sign-in are not another's (see Config layering). It is also what makes the session listing in §Several sessions per vault answer for one vault: `claude agents --json` reads the config directory it is pointed at. Reserved like the `HOLI_*` keys: any inherited value is stripped before ours is set, since an inherited one would silently put the agent back on the config this exists to exclude.
- **No `--append-system-prompt` content** (empty) — conventions come from `AGENTS.md`/`CLAUDE.md`, which CC reads natively (see Per-turn context).
- **`TYPST_BIN`** in the env when a typst binary is resolvable (find-only at spawn, non-blocking; see Rendering PDFs).
- Env hygiene, ported from the template: strip `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` (so a Holi launched from a Claude shell doesn't refuse), inherit a usable `PATH` + `HOME` (GUI-launched Electron ships a stripped PATH and can't find node/ripgrep otherwise), set `TERM=xterm-256color`.
- **No `--mcp-config` and no `--strict-mcp-config`.** There is no Holi MCP server to declare. A vault may still configure its own MCP servers in `.claude/`, natively, and Holi does not interfere.
- **Never `--dangerously-skip-permissions`** — native prompts are the permission UX.

**Wire shape (IPC, ported from the template's event names).**
| Direction | Channel | Payload |
|---|---|---|
| main → renderer | `agent-pty:data` | `{ id, data }` — a chunk for one session (xterm decodes) |
| main → renderer | `agent-pty:exit` | `{ id, code }` |
| main → renderer | `agent:sessions` | the whole list: `{ id, name, state, waitingFor?, configStale, exited }[]` |
| renderer → main | `agent-pty:start` | `{ vaultId, name?, resume?, cols?, rows?, prompt?, paste? }` → `{ ok, id?, message? }` |
| renderer → main | `agent:sessions` | — → the list, for a renderer that has just mounted |
| renderer → main | `agent:attach` | `id` → replayable terminal state, and opens that session's data tap |
| renderer → main | `agent:paste` | `{ id, text }` → `{ ok, message? }` |
| renderer → main | `agent:duplicate` | `id` → `{ ok, id?, message? }` — fork the conversation |
| session → main | `POST /statusline` | Claude Code's status JSON on the hook server, answered with the line to print |
| renderer → main | `agent-pty:write` | `{ id, data }` — keystroke bytes |
| renderer → main | `agent-pty:resize` | `{ id, cols, rows }` |
| renderer → main | `agent-pty:kill` | `id` |
| renderer → main | `agent:focus` | `{ focusedPath, openPaths }` |

**Every route but `agent:focus` names a session (D100).** A vault runs several, so
"write to the agent" is not an address. Focus is the exception because the focus file is
the **vault's**, one path in the clone, read by whichever session takes the next turn.

- A **reader loop** on the PTY master forwards each chunk to the renderer; **EOF/EIO** ends the session (the template treats `EIO`/errno 5 as normal remote-hangup).
- A **child-wait** task parks on the child, clears session state, then emits `exit` — clearing before emitting so a renderer that kills-on-exit doesn't race a dead child.
- **Any number of live sessions per vault (D100)**, an ordinary tab each (D101); see §Several sessions per vault. Ending one (SIGTERM → SIGKILL of the process **group**, so Claude's helper subprocesses die too) touches no other. A **vault switch** ends all of them, and asks first if any is mid-turn or waiting on you; so does adding a vault, which opens the one it creates.
- Lifecycle: **⌘J goes to the agent** — the current session's tab, or a new session when the vault has none. It does not toggle: a drawer was a thing to open and shut, a tab is a place to go. The sidebar's sessions list is the other way in, and the only one with a mouse. The sessions list's **resume affordance** opens **bare `--resume`** in a new tab and kills nothing, so Claude Code shows its own session picker there. Scrollback is ephemeral; durable history is CC's own sessions.
  - **No `--resume <id>` shortcuts for recent sessions**, which was the obvious next affordance and is deliberately absent: the CLI's picker is the surface the user already knows, and a Holi-drawn list of recent sessions would be a second index over another program's session store — the same bet §Config layering declines when it refuses to migrate transcripts.
- **The `prompt` field on `start` is what the reconcile flow uses** — it seeds the session with the conflict-resolution instruction rather than making the user type it. It is a positional argv, so Claude Code **submits** it as turn one, and reconcile is the only sender that does (D100).
- **The `paste` field on `start` is every other ask.** Main holds the text until Claude Code's own listing first carries that session — which it does because Claude Code writes the session file at `SessionStart`, measured 0.94 s after the spawn — and then writes it as a bracketed paste, with a backstop for a listing that never answers. A paste written at spawn would go into a TUI that is not reading stdin yet.

**The status line is Holi's** (D101). The vault's config directory carries a `statusLine`
command pointing at a generated `holi-statusline`, which **parses nothing**: Claude Code
writes its status JSON to the script's stdin, the script posts it to the hook server, and
Holi answers with the line to print — `Sonnet 4.5 · 42% context`. `jq` is not installed on
a stock macOS and `sed` over another program's JSON is a parser that breaks on the version
that adds a field, so the parsing happens where there is a real one. It also means main
sees the status, which is how a session's name reaches Holi (above).

**The cost, stated:** configuring any status line makes Claude Code drop most of its
footer's keyboard hints, `esc to interrupt` included. The key still works.

**Auth.** Per-user Claude account, already present per the Assumptions — but a login **in Holi's config directory**, which the machine's own Claude Code being logged in says nothing about. So the first launch after the relocation is logged out, once, ever.

**Holi says nothing about it, and that is the decision.** Claude Code prints `Not logged in · Please run /login` in the terminal the session tab is already showing, and `/login` is typed into that same terminal. A notice in Holi's header would be a **second copy of state Holi does not own** — and duplicate state has to be kept honest: `/login` spawns nothing, opens no turn and exits nothing, so it fires none of the events Holi has to refresh on, and the header's copy is wrong from the moment the user acts on it. The fix for a stale mirror is not a fresher mirror. There is **no login probe at all** — no `authenticated` field on agent status, and nothing reading `<configDir>/.claude.json`.

## Several sessions per vault (D100)

A vault runs **any number of `claude` sessions at once**. Design of record:
[`../specs/2026-09-14-agent-sessions-design.md`](../specs/2026-09-14-agent-sessions-design.md).

**Where they are.** An ordinary tab each (D101), so a session can sit beside the note it
is about, be split into its own pane, or be moved between panes like anything else. Every
session tab in a pane keeps its terminal **mounted** while another tab is showing, because
a terminal that unmounts throws away its scrollback and has to replay main's mirror to get
it back. **Closing a tab does not end the session**: a tab is a view, the PTY keeps
running, and the sidebar's sessions list is how you get back to it. That list is also
where a session is started, resumed, renamed, duplicated, restarted and ended. **It is
always present**, unlike the apps section, headed "chats", with the `+` beside the heading
as the way in when the vault has none: it is the only place a first session can be started
with the mouse.

**There is no Claude control in the footer.** There was, and it reduced every session to
one dot while a session's state had nowhere else to live — the drawer hid them and the
sidebar had no list. The list is there now, by name, with the same dot and the state in
words beside it, so the footer's version had become a second copy of a fuller answer three
feet away.

**Renaming goes through Claude Code, and stops short of sending.** There is no shell route
to a rename (`claude agents`, `attach`, `logs`, `stop`, `respawn`, `rm`, and nothing for a
name), so Holi writes `/rename ` into the session's box as a paste, brings that tab
forward, and leaves the name to be typed where it is going to be read. **No dialog and no
name field**: one would have collected a name only to paste it into a box the user is now
looking at anyway. Appending the Enter was the other alternative and is not safe either —
Holi cannot see the composer, so a half-written draft would be submitted along with the
command.

**Duplicating one forks the conversation**, `--resume <id> --fork-session`, where the id is
Claude Code's own — read out of the listing at the moment of the fork and never stored,
which is the difference between using that id and keying a session by it. The original
keeps running and neither copy sees the other's turns. **It needs a turn to copy.** A fresh
session is listed with an id from `SessionStart`, but Claude Code has no transcript under
it until a prompt goes in, and `--resume` of that id fails with "No conversation found"
inside the copy. So Holi refuses to duplicate a session that has not had a turn (the hook
bracket says; a fork counts as born with one) rather than spawn a copy that dies on
arrival.

**Restarting one ends it and starts a new one under its name.** A genuinely new session,
not the same one reborn: restarting a process is what this is, and the conversation does
not survive it. The name does, because it was chosen for the work and not for the process;
a placeholder is not carried over, for `deriveName`'s reason. Main does both halves, since
main is where the rule for which names are real lives.

**Escaping the resume picker leaves nothing behind.** Bare `--resume` puts Claude Code's
picker in the terminal, and ESC there exits the process non-zero. That is a cancel, not a
crash: no conversation was opened and none is lost. So a resume session that exits
non-zero before its first turn is dropped rather than kept as an exited record — no
"[session ended]" in a dead tab, and the tab closes with the session, the way any tab of a
session that has left the list does. A picker exited cleanly (`/exit`), or one whose pick
was then used, is an ordinary exit and stays to be read.

**Their names are Claude Code's own**, and Holi keeps none of its own beside them. A name
comes from `--name` at spawn, `/rename` inside, an accepted plan, or — for a session
nobody has named — the **title Claude Code writes itself**, a summary of the first prompt
"written by a background request to the small/fast model, normally a Haiku-class model".
That title does not reach `claude agents --json`, which carries the default display name
instead (`privat-d9`, the directory plus two characters, unique per session and not even a
resume handle). It reaches the **status line** as `session_name`, which is why Holi's own
status-line command reports it back: a value there is always a real name, so it outranks
the listing and needs none of the inference below. A session started for an ask is named
from the ask's first line, so its tab is named from the moment it exists.

**What a session is doing is read, not inferred.** Claude Code already tracks every live
session on the machine and lists them with `claude agents --json`; Holi joins that listing
to its own sessions **by pid** and derives one of `needs-you | working | idle`,
`waitingFor` first, then the listing's `busy`, then the turn bracket. The listing is
re-read on a watcher edge under `<configDir>/sessions/`, on every turn hook and when the
session tab opens — never on a timer — and the joined list is pushed only when something
derived actually changes.

**It degrades honestly.** If the CLI is missing, slow or fails, a session still reports
`working` from the turn bracket and simply never reports needs-you. The bracket is the
floor; the listing is the enrichment. The listing also closes a hole the bracket has
always had: escaping a permission prompt fires **no `Stop` hook at all**, and a session
the listing calls idle while Holi still has it mid-turn has demonstrably finished, so the
ten-minute safety cap goes back to being a backstop rather than the only way out.

**One working set per vault**, not one per session: the first turn to start pauses sync,
the last to end resumes it, and one settle commit covers the range. See §Git coexistence
and §Reviewing a turn.

**An ask is pasted, never submitted.** Text sent to a session — from the "Ask agent"
popover over a selection, from a task's description, from a mail thread — lands in its
input box as a bracketed paste with no Enter, and its tab comes forward. One rule
everywhere, and it cannot append a submit to a half-typed draft. The popover picks the
target: live sessions, then New session, defaulting to the session you are on. A
session that is **needs-you** is not offered, because it is blocked on a dialog and the
text would sit unread behind it; a target that ended between being picked and being sent
to is refused with a reason, and the text stays in the popover. **Reconcile is the
exception** and keeps its submitted first turn.

**A vault switch ends every session**, and asks first if any of them is mid-turn or
waiting on you. It is not a policy choice: `VaultHost` holds exactly one `ActiveVault`
and `open()` closes the current one first, so a session left running in the vault you
walked away from has no repo, no watcher and no sync loop behind it. The conversations
stay reachable through `--resume`. **Adding a vault asks the same question**, when the
ritual starts rather than when it finishes: creating a vault opens it, so it ends these
sessions just as picking another one does, and the moment to say so is before someone has
named a repo and waited for a clone. **The cost, stated:** you cannot leave a long task
running in one vault and go and work in another.

**Not decided here, deliberately:** a cap on how many sessions may run, splitting an
overlapped turn's changes by session, and adopting sessions Holi did not spawn (they
carry no `$HOLI_HOOK_PORT`, so their turns are invisible to the sync pause — the same
accepted gap as a bare `claude` in a terminal).

## Config layering (pure CC-native)

Holi builds **no config composition and no per-user config sync**. The layering is exactly Claude Code's own; Holi's only job is that the shared files exist in the working dir — and now they simply *are* in the repo.

**Why:** a composed per-launch config dir and a per-user config-sync subsystem are machinery CC already provides for free. **Rejected:** the composed three-tier config dir and the per-user config-sync subsystem.

**Holi does own a config *directory*, and that is not a walk-back of the sentence above.** What was rejected was Holi *composing* config — merging tiers into a directory each launch, which is CC's job. What ships is a **relocation**: `CLAUDE_CONFIG_DIR` points the agent at `userData/agent-config/<vault-slug>/`, resolved **per spawn**, and the layering inside it is still exactly Claude Code's own. Holi builds nothing there; it creates the directory and asserts two keys in a settings file it merges rather than owns.

**Shared (committed to the repo).**
- `.claude/` — shared **skills** and **commands**, and `settings.json` with **seeded permission defaults** plus the `UserPromptSubmit` hook config (which emits only the focused-note line). (Persona files are deferred — see Per-turn context.)
- `AGENTS.md` (the user's "System"), imported by a Holi-managed `CLAUDE.md` shim.
- `memory/` — the vault's memory, one fact per file (see §Memory below). `MEMORY.md` is the older shape and is still read.

CC reads all of this from the cwd natively — **zero extra machinery**. A teammate updating a shared skill is an ordinary commit.

**This got strictly simpler.** The shared layer used to sync because a mirror materialized it out of a CRDT store; it now syncs because it is committed, which is also how every developer already ships shared Claude config.

**Personal (machine-local).**
- **The machine's `~/.claude` is not in play at all.** A vault agent runs on `userData/agent-config/`, so the user's global settings, personal skills, plugins, marketplaces and MCP servers are excluded **by construction** rather than by a list of things to switch off — a list needs extending every time Claude Code grows a new kind of user-level content, and fails open when it hasn't been. The agent sees Holi's config and the vault's; whose laptop it is running on stops being an input.
  - **This was found, not foreseen.** The agent drafted an email through a **claude.ai Gmail connector** instead of `holi-google`, routing around the token authority, the send gate and the cache in one call — because the connector was simply *there*, inherited from an account the vault never mentioned. The connector was the symptom; the inheritance was the fault.
  - **One directory per vault (D86), and it costs a `/login` per vault.** Credentials are keyed to the config directory (measured — a symlinked `~/.claude.json` does not restore them, and the keychain entry is suffixed per directory), so this is one Claude *account* and several login ceremonies. D72 shipped a single shared directory to avoid exactly that, on the grounds that per-vault bought only separate session history, which **comes free regardless** since Claude Code keys transcripts by working directory. That was right about history and did not weigh **capability**: `plugins/` — marketplaces and installed plugins, 444 files on a real install — is keyed by nothing at all, and neither is user-scope `settings.json`. A plugin installed while working in one vault was reachable by the agent in every vault. A vault agent now gets nothing from another vault except the Claude Code binary.
    - **The login is lazy, and is not folded into onboarding.** The panel says the vault needs a Claude sign-in the first time the agent is opened *in that vault*, and not before, so vault creation stays as short as it is and a vault whose agent is never opened never asks. It is said in the **scrollback**, printed by main at spawn after reading `<configDir>/.claude.json` for an `oauthAccount` key — never by scraping the PTY, and never as a header badge, because `/login` fires none of the events that would keep a badge honest. A line printed at spawn is a log entry and stays true about that spawn.
    - **The directory name is `<sanitized remote>-<8 hex of sha1(remote)>`.** The readable half follows Claude Code's own `projects/` convention; the hash is there because that convention is not injective (`syv/better-holi` and `syv-better/holi` both sanitize to `syv-better-holi`), and two vaults quietly sharing a config directory is the exact leak this closes.
    - **Holi stamps the agent's theme** into that file, from the same resolved mode that stamps `data-theme` (D85's `colorScheme` + `resolveColorMode`), on **every** spawn rather than only when absent — unlike `disableClaudeAiConnectors`, it tracks a setting rather than seeding a default. Claude Code ships `"auto"`, meaning *detect the terminal background*, and inside Holi's embedded PTY there is nothing reliable to detect, so the agent stayed dark while D85 took the app light. **Known limit:** Claude Code reads settings at start, so a live session keeps its theme until restarted, and the panel says so rather than attempting to hot-swap another program's settings.
    - **On upgrade, the shared directory is renamed into the slot of the vault that actually ran the agent in it** — which the directory itself records, in `.claude.json`'s `projects{}` keys, and which is *not* the same as the most recently opened vault. A whole-directory rename, never a rewrite of the contents, which is why it is safe where copying transcripts was not. **What it carries is files** — transcripts and the plugin set. The credential is not in the directory at all: it is a macOS keychain entry Claude Code owns, so whether a login survives the rename is not Holi's to promise. It did on the install this was built against.
    - **The first-spawn notice does not read Claude Code's sign-in state**, because that state cannot be read honestly: a session was observed printing `Not logged in` in a directory whose `.claude.json` carried an `oauthAccount`. The key records **an account**, not whether the credential behind it is reachable — that lives in the keychain, which can be locked or re-keyed without the file changing. Holi writes its own `.holi-spawned` marker into the config directory instead. It is a proxy rather than a guess — credentials are keyed to the directory, so a directory Holi has never spawned in cannot be signed in — and it is the honest scope of the message, which is less "you are logged out" than "this vault is new, and that is why you are being asked again".
  - **A pulled config change nudges, and the split is known.** `AGENT_CONFIG_FILES` — `.claude/settings.json`, `CLAUDE.md`, and the `AGENTS.md` it shims to — are read **once at launch**, so a change arriving by pull only takes effect on a restart, and the session's dot says so (*"shared config changed; restart to pick it up"*, `AgentPanel.tsx`). **Hooks and skills are deliberately not in that set**: they are external scripts re-read per invocation, so a pulled skill works immediately and a nudge would be noise. `.holi/settings/app.yaml` is out because it is Holi's config, not the agent's, and `*.local.*` is out because it never syncs, so no collaborator's pull can change it.
  - **What is lost, deliberately:** transcripts already under `~/.claude/projects/` are invisible to the relocated agent, so `--resume` starts empty once. Copying them across would mean rewriting another program's internal state store, which is a worse bet than a sentence in a release note.
  - **The vault's own `.claude/` is untouched and still outranks everything.** Isolation is from the machine, not from the vault: a vault may declare its own skills and MCP servers, which is why `--strict-mcp-config` stays off.
- **`CLAUDE.local.md`** in the clone — CC's native personal-per-project layer.
- **`USER.local.md`** (the agent's model of *you*) — personal and machine-local, and therefore **gitignored** by the vault template. This is a real requirement now, not a property of the sync engine: nothing stops `git add -A` from committing it, so `.gitignore` is what enforces the privacy the old design got from a server boundary.

**Holi app settings.**
- **`.holi/settings/app.yaml`** — vault-wide app settings, committed.
- **`.holi/settings/app.local.yaml`** — machine-local, gitignored (sync watermarks, reminder delivery state, UI prefs).

Because these are real files, native `Read/Edit/Write` on a `memory/` file / `USER.local.md` / a skill file *is* the edit path — no memory or skill ops.

## Memory — a directory of typed files (D89)

**A memory is one fact in one file** under `memory/` at the vault root. Content, not plumbing, which is why it is at the root and not under `.holi/`: the thing the user most wants to read and correct should not be a file they have to unhide first.

Frontmatter carries `type` (a short free-form string), a one-line `description`, and an optional `title`. **`type` is free-form on purpose** — the session overview prints the *types in use* with counts, which makes the vocabulary self-documenting and self-converging with no registry for anyone to maintain. `AGENTS.md` suggests a starting set and nothing enforces it. The body is the fact, and memories link to each other with ordinary `[[memory/other.md]]` wiki-links, so `relink`, backlinks and the editor's chips work on them exactly as on any note.

**Personal memory is `memory/x.local.md`** and needed no new machinery: D65's `.local.` marker plus the seeded `*.local.*` ignore already do it.

**`memory/index.md` is generated** by the `memory-index` pre-commit transform ([`vaults-sync.md`](vaults-sync.md) FR-9), so the index lands in the *same commit* as the memory it describes — anywhere else and every commit is followed by an index commit, forever — and a burst of memory writes in one turn coalesces into one commit with its index already correct. **It lists shared memories only**: the index is committed, and a personal memory's title and description must appear in no committed file anywhere.

**The indexer maintains; it never enforces.** Missing `title` takes the H1 then the filename, missing `description` takes the body's first sentence, missing `type` is written as `note`, and frontmatter that is not valid YAML is treated exactly as if it were absent. Nothing in it can fail a commit, which is FR-9 and not a courtesy.

**One memory surface, not two.** Claude Code keeps its own auto-memory outside the vault, where it never syncs and no teammate sees it, and the agent reaches for it because it is the surface its own system prompt describes. The seeded `.claude/settings.json` sets **`autoMemoryEnabled: false`**, merged into vaults that already exist the way `disableClaudeAiConnectors` is and only when the key is absent. **Off rather than redirected:** `autoMemoryDirectory` would point Claude Code's memory at `memory/`, and is refused twice — Claude Code ignores it in checked-in project settings by its own rule, so Holi could only set it per clone; and its format is Anthropic's, whose `[[slug]]` links address memories by *name* where Holi's address vault *paths*, so Holi would be committing a format it does not control to every member of a shared repository.

**A `SessionStart` hook prints an overview** (`.claude/hooks/memory-overview.mjs`), capped at ~3,000 characters: the types in use with counts, the index lines verbatim, the personal memories the index cannot carry, and the last three commits touching `memory/`. `SessionStart` rather than `UserPromptSubmit` because memory is *session* state — and because it fires on `compact` as well as `startup` and `resume`, which is precisely the moment the agent has forgotten it has memory at all. Over the cap it drops **descriptions first and never titles**: a memory whose name the agent cannot see is one it will never `Read`. With memory files present but no index yet — a `memory/` filled in outside Holi, or an index somebody deleted — it says exactly that and points at the directory, rather than printing an overview that silently omits every shared memory. Deliberately not a fallback scan: reading and grouping the files in the hook would be a second copy of the indexer, kept in step by nobody.

**How the contract reaches a vault that already exists, and why it is a skill.** The seeded `AGENTS.md` is a `ONCE_FILE` — it becomes the user's the moment it exists — so rewriting its text reaches **new vaults only**. That is not a theoretical gap: a vault seeded before D65 still tells the agent that `USER.md` is machine-local and gitignored, a claim Holi made and then invalidated, and nothing had ever been able to correct it. So the file contract lives in a **`memory` skill** under `.claude/skills/`, which is a managed file: it lands in every vault on the next open and can be improved later. Prose in `AGENTS.md` is the wrong home for anything that will need changing.

**Nothing moves `MEMORY.md` or `USER.local.md`.** Both keep working and are still read. `USER.local.md` is no longer a destination, though: it is seeded by nothing, imported by nothing — the `CLAUDE.md` shim pulls in `AGENTS.md` and only that — and appears in no index and no overview, so a fact in it is one the agent has to remember to go looking for. A `memory/<name>.local.md` is printed to it at the start of every session, which is the whole difference. A new vault is seeded with `memory/index.md` in its empty form instead of a `MEMORY.md`; a vault that has one keeps it, `AGENTS.md` names it as the older shape, and the overview offers to split it. **The split is agent work the user asks for** — moving content the user wrote is exactly the unattended shared-layer edit [`not-built.md`](../not-built.md) rules against.

**`memory/` is on the agent surface**, so a vault app may neither read nor list it: what the user told the assistant does not become readable by being spread over more files. The same predicate is what keeps `scaffold-md` from prepending a `created:` block to a memory file.

## Per-turn context & system prompt

**Holi builds no prompt content.** This is the sharpest application of the standing principle, decided in the 2026-07-26 revision after the old repo over-engineered the agent on top of Claude Code. CC already reads `CLAUDE.md` (→ `@AGENTS.md`) from the cwd, already has native file/git/web tools, and already supports skills and `--resume`. So Holi builds none of it.

**1. Base system prompt — none.** `--append-system-prompt` is **empty**; there is no `build_system_prompt` port. Everything the old prompt carried moves to a place CC already reads or the agent already discovers:
- **Vault conventions** — the task-file convention (`task.<name>.md`, frontmatter keys, folder-is-the-lane, `done`-rolls-a-recurring-task), wiki-link rename, daily notes/recurrence, managed root files, the sync model, and **memory guidance** (USER.local.md/MEMORY.md, budgets, when-to-save) — live in **`AGENTS.md`** (read natively via the `CLAUDE.md` shim).
- **Capabilities** are **`.claude/skills/`**, not prompt prose.
- **The vault tree** is not injected; the agent `Glob`s it when it needs it.
- **Persona** (the old IDENTITY/SOUL injection) is dropped for v1; if wanted later it goes in a CC-native file (`CLAUDE.md`/`CLAUDE.local.md`), not a Holi injection.

**2. Per-turn context — one line, via a `UserPromptSubmit` hook.** The hook injects exactly one thing: **the current focused note/file** — "Focused note: `path`." That is the single piece of state the agent genuinely cannot get itself (it is editor-UI focus, which only Holi holds). Everything else the agent discovers with native tools on demand: **tasks** via `Glob **/task.*.md`, **backreferences** via `grep [[focused]]`, **sync-state** via `git status`/`git log` (it can run git — see below). No fill-indicators, no related-tasks list, no backref list, no sync-state block.

**Why so little:** every injected block is bespoke surface that duplicates a native capability and drifts from it. The focused file is the sole exception because it is UI state only Holi holds.

**Hook data source.** Electron main keeps a tiny **focus snapshot file** (`.holi/state/context.local.json`) fresh on every note switch, carrying just the focused note path; the hook reads it and emits the one line. No grep, no memory-counting, no server — sub-millisecond, so it never stalls a turn.

**Rejected:** the old rich system prompt + per-turn prefix (`build_system_prompt`/`build_per_turn_prefix`, fill-indicators, related tasks, backrefs, sync-state injection). This is precisely the "agent engineering on top of Claude Code" the old repo overdid; it is deleted, not ported.

## Tool surface: native only

**"No MCP server" was a statement about what Holi declares, and for a long time it was not a statement about what the agent could reach.** The session inherited the machine's `~/.claude` and the user's claude.ai account, so an `azure-devops` server and a set of cloud connectors were in the tool list of every vault agent — none of them declared here, and one of them used to send mail. Since the agent moved to Holi's own config directory (§Config layering) the sentence below describes the agent's actual surface, and not merely Holi's contribution to it.

**There is no MCP server.** The three v1 ops are gone, each for a reason that survives scrutiny:

| Retired op | Why it existed | Why it doesn't now |
|---|---|---|
| **`task_list`** | Filtering was a server query; full-vault file scans were forbidden. | Tasks are `task.*.md` files. One `Glob` finds them; the naming convention exists to make exactly this cheap. |
| **`task_set`** | `status: done` was ambiguous for a recurring task — roll forward, or end the series? | Resolved by convention, and the convention is safe: `done` rolls forward (Holi's watcher does the roll whoever wrote the file), and ending a series means deleting `recurrence` from the frontmatter. The conservative reading is the default one. |
| **`note_rename`** | Had to preserve CRDT Doc identity and rewrite `[[links]]` atomically — a server operation. | There is no Doc identity to preserve; a rename is `git mv` plus a link rewrite. It ships as a **vault skill** in `.claude/`, which is a text operation Claude is good at. |

**The cost, stated plainly.** A skill-driven rename is not atomic and can miss a link. That is a real regression against a server op, and it is accepted because the alternative is keeping an MCP server, its lifecycle, and its per-run bearer token alive for one tool. If misses prove common, the answer is to move rename into the app (where the file tree already implements it) and expose it to the agent as a **slash command** the user runs, not to resurrect the op surface. **The trigger is observed misses**, not the possibility of them.

**Everything else is native:** note read/write/append/backrefs → `Read/Write/Edit/Grep`; tasks → file ops; memory → edits on `USER.local.md`/`MEMORY.md`; skills → edits on skill files; asking the user → native `AskUserQuestion`; git → `Bash`; conversation recall → `claude --resume`.

**Phase 2 brought calendar and mail — and did *not* need an MCP server after all.** This document long predicted that external Google data would be the one category to justify reintroducing one. Building it (D67) showed the prediction was wrong, and the reason is worth keeping: what the agent actually needs is *a documented command that returns JSON*, and `Bash` already runs commands. An MCP server would have added a process lifecycle and a handshake to deliver something a shell script delivers.

So the tool surface is still **zero ops**, and it now holds for external data too:

- **`holi-google`** — a generated `/bin/sh` script (same shape as `$TYPST_BIN`), on the agent's `PATH`, with `$HOLI_GOOGLE_BIN` still pointing at it absolutely. Everything prints JSON. Reads: `agenda`, `search <query>`, `read <threadId>`. Writes: `mark-read`, `star`, `archive`, `trash`, `draft`, `send`, `reply`, `schedule`, `reschedule`, `unschedule`. **`send` takes either a composed message or `--draft <id>`**, and the second form is the one to use after `draft`: composing again delivers one message and orphans the draft (found in real use, 2026-08-14). **It is on `PATH` for the gate's benefit, not the agent's** — see below.
- It talks to a **loopback ops server in main** (`main/google/ops-server.ts`), modelled on this PRD's own hook server: ephemeral port, `127.0.0.1` only, reaching the child as `$HOLI_GOOGLE_PORT`/`$HOLI_GOOGLE_TOKEN`. All three keys are stripped from the inherited env before being set, so a vault's own env cannot redirect the agent at someone else's mailbox.
  - **The bearer is minted per session and names the vault it was minted for** (D87), rather than being one token for the life of the app. That is not tidiness: **an agent session outlives a vault switch** — it keeps running against its original vault's cwd while Holi shows another — so a server resolving "the active vault" would have a backgrounded agent reading and writing a *different* vault's mailbox. That is D87's own complaint arriving late, and harder to notice because nothing on screen is wrong. The token carries the answer instead, and main resolves the account from it. A second, free consequence: the bearer dies with its session, where the app-lifetime one stayed valid until quit. Verified by hand on 2026-08-24 — an agent started in `privat` still returned `privat`'s mail after the active vault was switched to one with no Google account at all, and got a 403 the moment its session was killed.
  - **The CLI needed no change for any of this.** `holi-google` resolves no credentials; it curls a port with a bearer and lets main answer. The design's worry that it "has no notion of which vault it is running for" was true of *main's answer*, not of the script.
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
- **A reply is sender-only; `--all` makes the widening explicit.** It used to copy the thread's `Cc`, so one instruction reached everyone on a six-person thread — on the single operation that reaches people at all, and the one whose recipients are *derived* and therefore absent from the command the user is being asked to approve. **A default that silently widens an audience nobody can check is the wrong default.** For the same reason the gate's prompt reads `--to`/`--cc` out of the command and names them, and for a `reply` says plainly that Holi derives the recipients and they are not visible there — an honest gap beats a reassuring sentence. It also states that the body is on stdin and not shown, which is why the skill requires the agent to say what it is about to send, in chat, first.
- **A managed file that only lands at vault creation is a migration that never happens** (D70). `ensureSeeded` was write-if-absent and ran only on clone/adopt, so the gate would have been absent from every vault that already existed — the hook file unwritten, `PreToolUse` unwired, and `send` reaching a real mailbox with nothing asking. `.claude/settings.json` is now **merged** key-wise (as `.gitignore` already was line-wise: add what Holi requires, keep the user's own hooks and rules, leave malformed JSON alone), and seeding runs on **every vault open**. Any future managed file inherits this or repeats the bug.
- **A managed file Holi wrote and nobody edited is refreshed, not frozen.** Create-if-missing is what makes seeding safe to run on every open — and it also means a managed file can never be improved. A skill shipped with four gaps in it stays wrong on every machine that ever opened the vault, and the authoring skill is the main lever a feature like vault apps has for being usable. So `SEED_FILES` splits by **who owns the file after it is written**:
  - **Holi-managed** — `.claude/skills/**` and `.claude/hooks/**`. Documentation and code Holi ships. **Refreshed on open**, but only when Holi can prove nobody touched the file: the sha256 of what it last wrote, per path, in `.holi/state/seed-state.local.json`. A hash that differs means a human or an agent changed it — leave it, and say so. `holi seed refresh [path] [--force]` does it on demand.
  - **Seeded once** — `AGENTS.md`, `CLAUDE.md`, `memory/index.md`, `.holi/settings/theme.css`, `.holi/document-templates/**`. (`memory/index.md` is here for a sharper reason than the others: *managed* means rewritten when the shipped version changes, and the `memory-index` transform rewrites that file on every commit touching a memory — since seeding runs on every vault **open**, the two would fight and the vault's real index would be replaced by the empty stub about once a session.) These become the user's the moment they exist, and **no flag changes that**: `--force` overrides an *edit check*, and a once-file was never Holi's to check.
  - `.claude/settings.json` keeps its own third rule, merged key-wise, above.

  **No record means no refresh**, and that is the load-bearing case rather than an edge one: every vault that existed when this shipped predates the hashes, so the other answer would rewrite everyone's edited skills once, silently, on the next open. The single exception is a file already byte-identical to what Holi ships — it *is* ours however it got there, so recording it is what lets the next version ever arrive.

  **A hash rather than a version marker in the file.** A `<!-- holi-seed: v2 -->` comment is visible in a document people read, can be edited around, and answers "which version" rather than "was this touched". **And the state file is machine-local** (the `.local.` in its name is the whole enforcement, D65): it is a fact about *this clone*, and a committed copy would travel to a teammate and claim their file was untouched when Holi has never written it on their machine — the one way this mechanism could destroy work. **Rejected: fetching the canonical copy from `syv-ai/holi`** — the vault's agent would need a token to the product repo, a far larger grant than it looks, and it is the wrong source anyway: seeded content is bundled into the binary, so the running app already has the canonical bytes on disk. Fetching would add an offline dependency and version skew against the build actually running.
- **The agent's own commits pass through Holi's `pre-commit` transforms** ([`vaults-sync.md`](vaults-sync.md) FR-9), and so do commits typed in a terminal. The one that matters to the agent is `relink`: `AGENTS.md` used to make rewriting inbound `[[links]]` on a rename entirely its job, an instruction followed inconsistently that silently produced dangling links. The hook does it now. Doing it by hand as well is harmless — the rewrite map is keyed on the *old* path, so after a hand-fix it matches nothing — and `AGENTS.md` says so rather than forbidding it, because inventing a hazard is the worse error. **A transform never blocks a commit**, and what each run did is in `.holi/state/hooks.local.log`.
- **Git history is the recovery story.** This is *better* than the snapshot timeline it replaces: every autosave commit is a restore point, `git revert` and `git checkout` are the restore mechanism, and an agent that wrecks the working tree is undone by a command the user already knows. Destructive edits are recoverable as long as the last autosave commit predates them — which is the argument for the autosave debounce being short.
- **The blast radius grew in one specific way, and it should be named.** The agent has always had native `Bash`, but the vault directory is now a git repo with a push credential reachable from it. A destructive git command (`reset --hard`, `push --force`) is expressible where before the client had no `.git` at all. Mitigations: the clone is Holi-managed and contains nothing else, `git` is subject to the same native permission prompts as any command, and the remote's default branch can be protected on GitHub. **Not mitigated by:** trying to block git commands from the agent — it needs them for reconcile, and a blocklist that the reconcile flow must punch through is not a boundary.
- **Prompt injection via shared vault content** is a documented, accepted **residual risk** for v1. **Rejected:** sandboxed-bash by default (friction on legitimate dev tasks; it gets turned off), and treating shared vaults as hostile input.

## Git coexistence — Holi pauses while the agent works

The vault is a **regular git repo** and the agent may run **any** git it likes — commit, push, pull, resolve a merge. The one hazard is two git actors on one repo: Holi's own sync loop (autosave-commit on a quiet timer, periodic pull, push) and the agent. They must not contend on `.git/index.lock`, and an agent rebase/branch-switch must not strand Holi's loop.

**Rule: while *any* session is working (mid-turn), Holi suspends its sync loop; it resumes after the last of them goes idle (with a short settle).** So Holi is never a second git actor. With several sessions the vault keeps **one** working set and one pause around it (D100): the first turn to start pauses, the last to end resumes, and the settle commit covers whatever the set wrote between those two moments. Holi keys this off Claude Code's own **hooks** (`UserPromptSubmit` starts the turn, `Stop` ends it) rather than inferring working/idle from PTY output — parsing a terminal to guess what another program is doing is a rabbit hole, and the hooks say it exactly. **`Stop` is not guaranteed** on an interrupt or a crash, so the pause is capped and a dead session resumes the vault rather than stranding it paused. The user's ordinary editor autosave keeps running whenever the agent is idle — even with the session tab open — so the pause is scoped to actual agent turns, not the whole session.

`AGENTS.md` states this to the agent plainly: *git is yours; Holi pauses its own sync while you work, and reconciles when you're done.* This **supersedes** the old AGENTS.md prohibition on the agent running git.

## Reviewing a turn — the footer says what it changed (D88)

The turn bracket above does a second job: it is also the boundary a **review** is drawn around. The review happens **after** the turn, never as a gate before the write. [`vaults-sync.md`](vaults-sync.md) §Non-goals rules out an outbound gate, and Claude Code's own permission prompts already ask; a second gate would ask twice and stop the agent working while you were away from the machine.

**A turn is a commit range.** `base` is HEAD when the turn starts, `end` is the sha of the settle commit at the end of it, and what the turn changed is `git diff base..end`. A range rather than a working-tree diff, because a working-tree diff keeps growing and would attribute a day of your own writing to the agent. A range rather than a record of the agent's tool calls, because git catches the files it changed through `Bash` — a `sed`, an `mv`, a script — that a `Write|Edit|MultiEdit` matcher never sees.

**Only the range is stored** (`.holi/state/turns.local.json`, capped at 50, `.local.` so it never syncs: a turn is a thing that happened on this machine, and a teammate pulling your agent's turn boundaries would be reading your session rather than the vault). The file list and every diff are asked of git when they are shown. Storing the paths as well would be a second copy of an answer git already holds, and one that goes stale the moment anything else touches the tree.

**The footer says `Claude changed 4 files`** and opens a panel beside history: each file with its `+N / −M`, and the selected file's diff as a merge view with per-hunk accept and reject. A hunk rejected is written back as a **new commit**, never a rewrite, the same rule [`vaults-sync.md`](vaults-sync.md) §History gives Restore. The resolutions are collected and written when you say so rather than as you make them, so a file's worth of them is one commit instead of a dozen.

**A turn that overlapped another says so** (D100). The range is taken across the vault's
working set, so when two sessions were mid-turn at once it contains both sessions' edits.
It is not split, and cannot honestly be: git cannot say which session wrote a line, and a
tool-level record would miss the edits made through `Bash` that the commit range exists to
catch. The chip on an overlapped turn reports that instead of claiming everything as its
own.

**A record outlives the commits it names.** After a reset or a re-clone the range is unreachable, and the panel says the turn's history is gone rather than showing a turn that appears to have changed nothing — which it cannot be, since a turn that changed nothing is never recorded.

The recording is a **passenger on the pause**. It is fire-and-forget with every failure swallowed, because it shares a hook handler with the sync resume, and losing a record is a much smaller failure than a vault left paused. For the same reason the turn's commit is taken *after* the resume: Holi's committer refuses to run while the vault reads as paused.

## The agent as merge resolver

This replaces the old bridge/turn-protocol/reconcile section, and is much smaller than what it replaces.

**Ordinary editing needs no protocol.** The agent writes files; the editor's watcher reloads or 3-way merges ([`notes-editor.md`](notes-editor.md)); the sync engine commits. There is no soft lock, no frozen base, no positioned-ops translation, and no "Claude is editing…" presence state — the last of which existed to tell *co-authors* something, and there are no live co-authors in v1. **Staleness is Claude Code's own guard:** `Edit`/`Write` require a prior `Read` and fail if the file changed since.

**Conflict resolution is where the agent earns its place.** When an auto-pull hits a textual conflict, Holi aborts the merge and offers **Ask Claude to reconcile** — a banner in the editor and a quiet affordance in the footer. Accepting it runs the sequence below (built 2026-07-27), and the reasoning is kept here because this pillar owns it:

1. **Autosave and auto-pull stop** for that vault, so nothing writes underneath the resolution. This needed no explicit call in the end: a merge in progress is already a `blockedReason`, so step 2 is what suspends the loops and the agent's merge commit is what releases them. The vault reads as paused throughout, for the reason it actually is.
2. **Re-runs the merge for real**, leaving the conflict in the working tree.
3. **Opens a session tab** and starts the session with a **seeded first message** (the `prompt` field on `agent-pty:start`) naming the conflicted paths — the user does not type it. It names the paths and not the branches: the marked-up files are the whole of what has to be resolved, and the branch names would be decoration in a prompt whose next instruction is to read them.
4. The agent resolves the `<<<<<`/`=====`/`>>>>>` markers with native tools and **finishes the merge itself** (`git add` + commit), **in front of the user**, who can watch and answer if it asks.
5. On a clean tree, Holi resumes normal operation.

**Why this rather than a conflict UI:** a three-pane merge editor is a large build that resolves conflicts *positionally*, which is exactly the wrong level for prose and for YAML frontmatter. An agent resolves on meaning, in a surface the user already has open. **Why user-triggered only:** no unattended rewrites and no token spend without opt-in — and a merge the user did not ask anyone to touch is one they can still resolve themselves in the terminal.

**Why this is safe to hand to an agent at all:** it operates inside git, mid-merge, on a repo whose pre-merge state is a commit. The worst outcome is recoverable with `git merge --abort`.

**A second producer of asks** ([`#5`](https://github.com/syv-ai/holi/issues/5), 2026-09-09): selecting a passage in a note and pressing **Ask agent** sends that note's path, the exact line range and the quoted text to a session you pick. It adds no transport — `sendToAgent`, the same one every other ask uses (§Several sessions per vault) — and the editor end of it knows nothing about an agent, only about an `askAgent` seam on `EditorDeps`. **The line numbers are exact**: the affordance is adopted from ailex, which recovers them by searching the markdown source for the selected substring, and CodeMirror simply holds the range. See [`notes-editor.md`](notes-editor.md) §Ask Claude about a selection.

**Where the wire runs.** `reconcileAtom` (`state/agent-send.ts`) is the whole of it: `sync.reconcile` re-runs the merge in main (`activeVault.reconcile()` over `repo.remerge()`, which unlike the auto-pull path deliberately does **not** abort), and the conflicted paths it returns become a new session's submitted first turn via `lib/reconcile-prompt.ts` and `start`'s `prompt`. **An empty path list is a real outcome, not an error**: the merge now applies cleanly, so the banner clears and no agent is handed anything.

**What surrounds it** is in [`vaults-sync.md`](vaults-sync.md): the conflicted files are read-only while the reconcile runs (FR-19), **Abandon** in the footer is the way out of it (FR-20), and the reconcile ends on the agent's merge commit rather than on anything the session reports — which is what lets the agent take as many turns over it as the merge needs.

## Rendering PDFs

The agent can turn a note into a PDF with the **same Typst engine** the UI's "Convert to PDF" uses — one env var and one skill, no new machinery.

- **`$TYPST_BIN`** — Holi resolves the typst binary at agent spawn (find-only: `TYPST_BIN` env → cached download → `PATH`; **non-blocking**, never downloads on the spawn path) and, when found, sets it in the agent's env. A fire-and-forget `ensureTypst` caches it for the next spawn if the machine has never rendered. If it is unset, the skill's fallback says to run one UI Convert (or retry) to install typst.
- **The seeded `md-to-pdf` skill** (`.claude/skills/md-to-pdf/`) documents the template model (`.holi/document-templates/<slug>/`), the six-type field schema, the `doc(notePath, meta, assets)` contract, and the render recipe: compose a wrapper that imports the template's `doc` and calls it, then `"$TYPST_BIN" compile wrapper.typ <out>.pdf --root /`. The agent writes typed `meta` literals directly.
- **PDFs are outputs, never committed** — the skill writes them to a non-tracked path and reports it.

This landed as a late slice, once the agent was live, on the typed-template mechanism that already existed (`../specs/2026-07-26-typed-template-fields-design.md`).

## What came from the old codebase

Ported to TypeScript, adapted as noted above:

- The **PTY/xterm template** — `services/agents/login_pty.rs` (spawn, env hygiene, reader loop, child-wait, resize; process-group cancellation from `runtime.rs`).
- The auth probe (`claude_config::is_authenticated`) and the login-PTY fallback flow.

**Explicitly not ported:** the per-run bearer-token MCP handshake (`mcp_server.rs` / `mcp_handshake.rs`) and the ops (no MCP surface to hand-shake into); and **the prompt content** — `build_system_prompt`, `build_per_turn_prefix`, memory budgets, `fill_indicator`. Holi builds no prompt content now; vault conventions live in `AGENTS.md` and the per-turn hook emits only the focused-note line.

## Edge cases & risks

- **The agent commits or pushes on its own.** Resolved: this is allowed and expected — the vault is a regular repo. The race with autosave is prevented not by forbidding git but by the **Git coexistence** rule: Holi suspends its sync loop while the agent is working. The residual sharp edge is a mid-turn agent `git checkout <branch>`/rebase that outlives the turn; `AGENTS.md` notes that a branch switch pauses sync until undone.
- **Prompt injection via shared content** — accepted residual risk. Native permission prompts + seeded egress gating + git history bound the blast radius.
- **Hook latency** — the `UserPromptSubmit` hook runs on *every* prompt; a slow grep stalls the user's turn. Budget it (target < ~50 ms) and degrade to "context unavailable" rather than block. A vault-wide grep per turn is the thing to measure first.
- **`claude` missing or unauthenticated** — clear error + the fallback login PTY flow.
- **Shared config drift mid-session** — a pull can land a new `.claude/settings.json` mid-session and CC reads it at launch only. Resolved: the session nudges (*"shared config changed; restart to pick it up"*), over the `AGENT_CONFIG_FILES` set described in §Config layering — hooks and skills are out of it, being re-read per invocation.
- **Terminal resize / reflow** — xterm + node-pty resize wiring must stay in sync; test tab resize under active output.
- **The agent editing during a reconcile** — the reconcile pauses autosave, but the *user* could still type into the file the agent was resolving. Settled and built: the conflicted files go read-only, everything else stays editable ([`vaults-sync.md`](vaults-sync.md) FR-19). A keystroke landing between the agent's read and its write is a resolution built on a file that moved, and Claude Code's own read-before-edit guard would have failed the write rather than caught the problem.

## Dependencies

- **[`../architecture.md`](../architecture.md)** — the sync engine, and the reconcile flow this PRD's agent is the surface for.
- **[`notes-editor.md`](notes-editor.md)** — the editor's external-write handling, which is what makes the agent's file writes safe against an open buffer.
- **[`tasks.md`](tasks.md)** — the task file convention, which is the agent's entire task interface and therefore belongs in the system prompt.
- **[`auth-identity.md`](auth-identity.md)** — GitHub access; the push credential the agent's repo can reach.
