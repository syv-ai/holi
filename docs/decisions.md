# Design Decisions

The load-bearing decisions that fixed the rebuild's architecture, with the rationale and the alternatives rejected. Every non-obvious choice in `vision.md` / `architecture.md` / the PRDs traces back to a decision here. Format is lightweight ADR.

Status legend: **Decided** (locked for v1) · **Deferred** (post-v1) · **Open** (needs revisiting).

---

## D1 — Storage & sync backbone: CRDT over a Syv-hosted relay
**Decided.** Documents are **Yjs CRDTs**. A **Syv-hosted relay** (Hocuspocus-style) is the durable source of truth per vault; clients keep a local offline cache and reconcile on reconnect.

- **Why:** The headline requirement is Google-Docs-style **concurrent editing with presence** ("who else is in this doc"). The old model — local files + git auto-commit every 30 s + never pull — guarantees divergence and whole-file merge conflicts the moment two people share a vault. Plain git (even with pull/merge) can't give live co-editing or presence. CRDTs give automatic character-level merge, offline-first, and awareness (cursors/presence) natively.
- **Rejected:** *Git with real pull/merge* (no live collab, constant markdown/YAML conflicts). *Peer-to-peer CRDT* (no durable truth when everyone's offline; NAT/discovery pain; unfit for a company DMS).
- **Cost accepted:** Syv must host and scale a WebSocket relay + persistence.

## D2 — Agent ↔ CRDT: native file tools + a file↔CRDT bridge
**Decided.** The Claude agent keeps its **native `Read`/`Edit`/`Write`** tools. The on-disk `.md` is a **bidirectional working copy**; a per-client **file↔CRDT bridge** reconciles: agent writes → diff old→new → apply as CRDT ops (so other people's edits to other regions survive); CRDT changes → re-materialize the file. We rely on **Claude Code's read-before-edit + modification-detection** guard for staleness.

- **Why:** The rebuild runs Claude Code interactively (D5). Forcing every note write through an MCP gateway ("never use Edit, call `note_write`") fights the grain of the interactive agent and is exactly the prompt-bolting we avoid. An agent write is functionally no different from a human typing; Claude's `Edit` already fails if the file changed since it was read, so it can't silently clobber.
- **Rule:** the bridge must **diff**, never blind-replace the CRDT. A full-document `Write` becomes a diff-merge; overlapping simultaneous edits to the same characters resolve last-writer (same as two Google-Docs cursors), non-overlapping edits merge cleanly.
- **Rejected:** *CRDT-is-truth, agent edits only via gateway ops* (loses native tools, fights the model). *Files-are-truth, CRDT ephemeral* (races between agent file-writes and live sessions; fragile presence).

## D3 — Git is dropped as the sync mechanism
**Decided.** No git. **History** = Yjs snapshots (server-side per-doc timeline). **Backup** = server persistence (Postgres + object storage). Disk files are working copies, not tracked.

- **Why:** Git's sync role is the exact thing that caused multi-user pain. With the server as truth, git is redundant and its whole apparatus (auto-commit, never-pull, `.gitignore` sync-filter, GitHub repo creation, whole-vault link-rewrite-as-commit) disappears.
- **Cost accepted:** lose GitHub-as-backup and plain-git portability. (A git *export* mirror could return later; not v1.)

## D4 — Tasks are structured server records, not files
**Decided.** Tasks become first-class **structured records on the Syv server** (queryable, shareable, real-time). No `.md` task files.

- **Model (trimmed):** `title, status (todo | doing | done), due, priority, tags, reminder, recurrence, related[], area`.
- **Kills:** the derived **`area` phantom**, **orphan rescue**, **`source_file`-as-home**, dual roll-forward persistence paths, full-vault file scans, two frontend persistence paths.
- **`area` reborn as a real field (see D4a).** `related[]` is one unified list (notes/tasks/emails/events), replacing the four separate relation arrays.
- **Why:** tasks are inherently structured; the file representation was the *source* of the complexity the user wants gone, and the agent already manipulates tasks via ops, not file edits. Server records make shared task boards and real-time updates trivial.
- **Rejected:** *keep markdown-file tasks* (carries forward all the complexity). *Structured + inline-note-checkbox sync* (reintroduces note↔task coupling).

## D4a — `area` is a settable folder reference driving swim lanes
**Decided.** Keep **areas and swim lanes** as the organizing concept, but `area` becomes a **real, settable folder reference**, not a derivation of `source_file`.

- **Why:** the *only* problem with the old `area` was that it was a phantom (parent folder of the source note) — you couldn't set it, couldn't drag a task between lanes (cross-lane drop was a silent no-op), and "moving" a task's area meant re-pointing its source note. Making it a settable folder ref fixes all of that while keeping the doc-centric organization the user values.
- **Consequence:** the vault keeps a real **folder/path hierarchy** (needed anyway for wiki-links and the file tree). Swim lanes = folders; dragging across lanes re-sets `area`; creating a task from a note defaults `area` to that note's folder (but is freely changeable).
- **Rejected:** *per-vault defined area list* and *free-text area* — user chose the folder-reference model to preserve doc-centric organizing.

## D4b — Primary task surface: stripped board
**Decided.** Default surface is a **stripped kanban board** (Todo / Doing / Done columns), **swim lanes by area/folder** with a lane-depth control, plus a simple filter bar. **No** time-bucket view mode, **no** 10-bucket date system, **no** "N tasks excluded" band-aid in v1.

- **Why:** the old board's config space (2 view modes × 10 date buckets × swim lanes × 5 filters) is the interaction-level source of "not simple/intuitive enough." A single default layout with lanes is the biggest intuitiveness win.
- **Deferred:** a time-grouped ("Today / This week / Later") secondary view can return post-v1 as an option.

## D5 — Agent runtime: interactive Claude Code in an xterm drawer, client-side, per-user auth
**Decided.** Each employee's Electron app spawns its **own `claude`** in a local **PTY**, rendered in an **xterm popup drawer**, authenticated with **their** Claude account, operating on **their** materialized vault files. Not a headless streaming session.

- **Why:** native Claude Code UX (permission prompts, plan mode, thinking, todos) at full fidelity, native file tools (D2), no brittle stream-json parsing for the live view. Per-user cost attribution.
- **Consequences:** deletes the entire headless pipeline — `AgentStreamEvent`/delta reducer/`applyDelta`, most of the runtime, the `agents:message:<run_id>` IPC. See D8/D9 for what replaces the features that pipeline provided.
- **Rejected:** *server-side agent* (contradicts the interactive-drawer decision; remote TTY streaming; mixes per-user actions).

## D6 — Layered agent config: three tiers
**Decided.** Agent config/state has three tiers:

1. **Shared** (synced to everyone in the vault): notes, tasks, vault-assistant **persona** (SOUL/IDENTITY), shared **skills**, shared instructions (**AGENTS.md**), shared memory (**MEMORY.md**), **theme**.
2. **Per-user, synced** (just you, across your devices, invisible to the team): personal tweaks, personal skills, **USER.md** (the agent's model of you), **chat history**, your UI prefs.
3. **Local** (one machine): materialized file cache, offline queue.

- **Why:** the user wants both a **configurable shared vault-assistant persona** and **personal overrides that don't propagate to the team** (the old "gitignored" layer). Maps cleanly onto Claude Code's existing layering (project `.claude/` + `CLAUDE.md` = shared; user-level + `CLAUDE.local.md` = personal).
- **Consequence:** requires per-user identity + server-side scoping (D7).

## D7 — Auth: Google Workspace SSO + per-vault membership
**Decided.** Employees sign in with their **Syv Google Workspace** account (identity = Google account). Each shared vault has an explicit **membership list with roles** (owner / member / viewer). Personal vaults are owned solely by their user.

- **Why:** Syv is a Google shop (already uses Google Drive); low-friction, standard company SSO. The per-user tier (D6) needs a real identity to scope to.
- **Note:** this is entirely new surface — the old app had zero auth.
- **Rejected:** *Syv-native accounts* (build/maintain auth; another login). *Defer auth* (undercuts the per-user tier).

## D8 — Per-turn context injection via a UserPromptSubmit hook
**Decided.** Holi's fresh per-turn context (active note, linked tasks, memory fill-state) is injected through a **Claude Code `UserPromptSubmit` hook** configured in the vault's `.claude/settings`. The base **system prompt** ships once via `--append-system-prompt` at PTY launch.

- **Why:** you can't transparently prepend a `<system>` block to what a user types into an interactive TUI. The `UserPromptSubmit` hook is the native mechanism — it runs on every prompt and Claude appends its output to context. Exactly matches the old `build_per_turn_prefix`.
- **Rejected:** *system-prompt-only* (goes stale within a session as the user switches notes — loses "fresh focus every turn"). *MCP resource pulled on demand* (not guaranteed present; model may forget).

## D9 — Chat history: full structured history, reconstructed
**Decided.** Keep the **full structured chat-history system**. Two distinct surfaces:
- **Live** = the xterm drawer (native Claude TUI, full fidelity).
- **History** = a browsable, searchable structured view **reconstructed from Claude's session JSONLs**, with AI **summaries** generated by a headless job. Per-user (tier-2, D6).

- **Why:** the user explicitly wants the browsable/searchable history + summaries + conversation recall. Terminal scrollback alone is ephemeral.
- **Cost accepted (flagged):** re-inherits the **JSONL-format coupling** (the most brittle part of the old codebase; lossy on attachment chips; breaks if Anthropic changes the format) and some duplication vs the live drawer. Conscious trade.
- **Rejected:** *native resume + session picker only* (drops the structured history the user wants). *summaries+search but no live reconstruction* (partial).

## D10 — MCP surface: minimal, native-first
**Decided.** The MCP ops server exists **only** for what isn't a plain file: **task ops**, **calendar**, **mail**, **`note_rename`** (vault-wide link rewrite + CRDT identity), and **conversation/session search**. Everything else — notes, memory, skills, theme, daily notes, imports, asking the user — uses **Claude's native tools** + Holi's bridge/watchers.

- **Where:** the MCP server runs in **Electron main** (per-run bearer token, as before); structured ops proxy to the **Syv API**.
- **Permissions:** Claude's **native** interactive prompts for file/bash + **server-side MCP gating by vault role** (viewer = read, member = write, owner = all). The bespoke **safe/power_user** modes are **dropped**.
- **Why:** an interactive Claude Code already has `Read/Write/Edit/Bash/Glob/Grep`, so any vault action that's "just a file op" needs no custom tool. The old 44-op surface collapses ~80%. This is the "single largest surviving piece" — now small.
- **Rejected:** *keep broad op surface for audit* (fights native grain, re-bloats). *rename via bridge heuristic instead of an op* (content-similarity rename detection can misfire) — kept as a possible later optimization.

## D11 — Self-improvement / curator loop dropped for v1
**Decided.** No automatic memory/skill curation loop in v1. Memory and skills change only when the user or agent edits them explicitly in a normal turn.

- **Why:** built for the headless world (background forks), unproven value, and in a shared vault one person's background agent auto-editing **shared** team skills/memory is a real "why did the assistant change for everyone" hazard. Removing it also deletes `activity.jsonl`, review counters, the curator cron, fork permission allow-lists, and most of the threat scanner.
- **Deferred:** if revived, scope auto-edits to the **personal** tier only; shared changes become **proposals** requiring approval.

## D12 — Wiki-links stay path-based; server rewrites atomically
**Decided.** Links remain human-readable **`[[folder/note.md]]`**. Rename is a **single atomic server-side operation** over the affected CRDT docs.

- **Why:** path-based links are readable in raw markdown so Claude can follow *and author* them naturally, and they match Obsidian mental models. The old rename-conflict problem came from the *distributed* rewrite (N git clients colliding), not the links themselves — a central server authority removes it. Concurrent edits to unaffected parts of those docs still merge via CRDT.
- **Rejected:** *stable doc IDs rendered as paths* (opaque `[[doc:a1b2]]` in raw md; harder for the agent to read/author). *hybrid id+slug* (uglier markdown, more normalization).

## D13 — Personal vaults are server-backed too
**Decided.** Personal vaults use the **same** Yjs server + per-user scoping as shared vaults. One sync engine for everything. Sign-in required to use Holi (offline works via local cache).

- **Why:** cross-device sync + server history/backup for personal notes, and a single code path (no second local-only sync engine).
- **Rejected:** *local-only personal vaults* (no cross-device sync; two storage models).

## D14 — Server stack: self-hosted TS monolith
**Decided.** One Node/TypeScript service: **Hocuspocus** (Yjs sync + presence) + **tRPC** API (tasks, membership, auth) + **Postgres** (Yjs snapshots, task records, vault/membership, per-user state). All OSS, Syv-hosted, shared types with the client.

- **Why:** all-TypeScript with a shared types package (no codegen), full control, no vendor lock-in, aligns with the OSS preference.
- **Rejected:** *managed CRDT platform* (Liveblocks/PartyKit — vendor holds core company doc data; some closed-source; against OSS preference).

## D15 — Repo: fresh pnpm monorepo
**Decided.** New repo, pnpm workspace: `apps/desktop` (Electron + React), `apps/server` (Hocuspocus + tRPC), `packages/shared` (domain types, task model, wiki-link grammar, path-safety — the security-critical bits shared by both). Clean break from the Tauri repo.

- **Location:** `~/repos/syv/better-holi-final`.
- **Rejected:** *rebuild in-place* (churn vs Tauri history). *separate repos* (no atomic cross-cutting changes; premature versioning overhead).

## D16 — Migration: clean slate for v1
**Decided.** Start empty. No content import in v1.

- **Deferred:** a generic **"import a markdown folder"** path (→ CRDT docs preserving paths/links; `.holi/tasks/*.md` → task records) that doubles as Obsidian/markdown onboarding.
- **Rejected:** *bespoke one-time migration script* (throwaway).

## D17 — v1 scope & roadmap
**Decided.**
- **v1 core:** multiplayer notes + editor (CodeMirror + Yjs), stripped task board, Claude xterm drawer, shared + personal vaults with Google SSO + presence, structured chat history, **daily notes**.
- **Phase 2 (in order):** PDF/docx preview → **Google Gmail + Calendar** sync (on Google APIs, under the same OAuth) → **Typst export** (render a markdown doc into a branded syv.ai Typst template).
- **Deferred:** agent-authored HTML apps/widgets; self-improvement loop.
- **Killed:** **Mailspring** (only ever chosen for OSS/extensibility; being abandoned) — replaced by Google APIs.

## D22 — Editor rollback: keep simple live-preview, cut the animation layer
**Decided.** The CodeMirror editor is **trimmed**, not preserved verbatim. The old editor grew a large, fragile animation/custom-logic layer that had "grown out of shape"; we roll it back.

- **Keep:** live-preview with **reveal-raw-on-click** (rendered line → raw markdown when the caret enters it, re-render on leave) as a **plain decoration swap — no animation**; markdown **formatting hotkeys** (⌘B/⌘I/⌘E/⌘K/strikethrough, toggle-aware); **wiki-links + markdown links** (chips, hover, click-to-open); **`[[task:<id>]]`** task chips in prose (resolved against records, D4); **`@`-mentions**; **slash commands**; the **table widget + its package** (`codemirror-markdown-tables`); frontmatter hiding; the Yjs binding + remote cursors. Also keep the **tight vertical rhythm** refinement — rendered blocks (dividers/HR, headings, blockquotes, code, images) get **no excessive top/bottom padding**, so lines don't jump as they render/un-render.
- **Cut:** the **View-Transitions source↔rendered morph** (`startViewTransition` dispatcher, three-tier trigger), the **frozen-caret `StateField`** (`caretTransitionField`), **gap-marks**, and **`view-transition-name` plumbing** (`viewTransitionNaming`). The active-line reveal is derived **directly from the current selection**, not a frozen caret.
- **Why:** the animation layer was fragile and heavy, and animating CM decorations pegs CodeMirror's measure loop on the main thread (a lesson already learned — [[feedback_codemirror_layout_animations]]). Cutting it also **erases the biggest risk in the plan**: the morph-vs-remote-edits interaction under multiplayer simply ceases to exist (a remote edit just re-decorates; there's no animation path to guard).
- **Rejected:** *keep live-preview AND the morph, hardened* (re-inherits the exact fragility we're removing). *Go fully conventional source↔rendered toggle* (loses the reveal-raw-on-caret feel the user wants to keep).

---

## Smaller decisions (author's call, flagged for review)

- **D18 — Theme is a shared (tier-1) vault property.** One vault-wide brand/theme everyone sees; agent theme-proposal deferred. **Light/dark mode** is a per-user local preference. *Open to per-user theme overrides later.*
- **D19 — Reminders evaluate server-side.** Since tasks are server records, the server evaluates pending reminders and **pushes** fire events to clients, which raise native Electron notifications. Removes the client-side scheduler loop. (Recurrence/reminder *rules* — the pure `Nd`/`Nw`/absolute grammar and roll-forward math — port to `packages/shared`.)
- **D20 — Presence = Yjs awareness.** Remote **cursors/selections** in the editor + **doc-viewer avatars** ("who's here"). Standard Hocuspocus awareness channel.
- **D21 — Offline = CRDT auto-merge, no manual conflict UI.** Offline edits queue locally and replay on reconnect; CRDT merges automatically. UI shows only a **sync-status indicator** (synced / offline / syncing), never a conflict-resolution dialog.

---

## Carried forward from the old codebase (keep, don't reinvent)

Worth preserving (mostly ports cleanly to TS/Electron):
- **CodeMirror 6 editor** with **simple live-preview** (reveal-raw-on-caret, no animation — see **D22**) — plus a Yjs binding (`y-codemirror.next`) and remote-cursor presence. Keep: formatting hotkeys, wiki-links + markdown links, `@`-mentions, the table widget + package. Cut: the View-Transition morph and its machinery (D22).
- **UI primitive system** — the `tone`/`variant`/`shape`/`size` cva model, Button/Pressable/Badge/Input/Field, the `--tone`/`--tone-fg` formula, `tokens.css` + the five-tier typography system. Ports verbatim.
- **Jotai state architecture** — single store, action atoms for multi-atom side effects, mount-hooks-once-in-App.
- **Path-safety** (`resolve_relative` / `VaultPath` newtype) — reimplement **test-first** in `packages/shared`; security-critical.
- **Single-source wiki-link grammar** (`vaultRefs.ts`) — one parser, thin renderers.
- **Prompt content** (`agent_context` strings), memory budgets, USER/MEMORY fill indicators.
- **Recurrence + reminder pure functions** — port the well-tested math.
- **Daily-note untouched-stub heuristic** (don't archive empty dailies).
