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
- **Rule:** the bridge must **diff**, never blind-replace the CRDT. A full-document `Write` becomes a diff-merge; overlapping simultaneous edits to the same characters resolve last-writer (same as two Google-Docs cursors), non-overlapping edits merge cleanly. *(The full turn protocol — frozen base + soft turn-taking — is **D25**.)*
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

## D6 — Agent config: pure Claude-Code-native layering *(simplified — supersedes the composed three-tier design)*
**Decided.** Holi builds **no config composition and no per-user config sync**. The layering is exactly Claude Code's own:

1. **Shared** (syncs because vault content syncs): the vault working dir carries `.claude/` (persona SOUL/IDENTITY, shared skills/commands, `settings.json` with seeded permission defaults — D29), `AGENTS.md` (via the managed `CLAUDE.md` shim), and `MEMORY.md`. CC picks these up from the cwd natively — **zero extra machinery**.
2. **Personal** (machine-local, untouched by Holi): the user's own **`~/.claude`** (global config, personal skills) and **`CLAUDE.local.md`** in the vault working dir — CC's native personal-per-project layer. **USER.md** (the agent's model of you) is personal and machine-local too. Holi never syncs any of this; your setup travels the way every developer's does.
3. **Holi app settings** (same shared/local convention, mirroring CC's own): **`.holi/settings.json`** — vault-wide settings, synced as vault content — plus **`.holi/settings.local.json`** — machine-local override, never synced.

- **Why:** the earlier design had Holi *composing* a config dir per launch and running a per-user config-sync subsystem (tier-2). Under **D30** ("cater to CC's natural strengths"), both are machinery CC already provides. The original ask — a configurable shared persona + "gitignored" personal tweaks — is satisfied natively.
- **Cost accepted:** personal agent config does **not** follow you across devices (the assistant's model of *you* is per-machine). Deliberate — same trade as D9.
- **Superseded:** the composed three-tier config dir; the tier-2 per-user config-sync subsystem. `per_user_state` on the server shrinks to UI prefs.

## D7 — Auth: Google Workspace SSO + per-vault membership
**Decided.** Employees sign in with their **Syv Google Workspace** account (identity = Google account). Each shared vault has an explicit **membership list with two roles: owner and member.** Personal vaults are owned solely by their user.

- **Roles:** **member** = read + write all content (notes, tasks); **owner** = member + vault administration (manage membership, transfer ownership, delete vault, edit theme/settings). **No viewer/read-only role** — everyone with access can edit. (This removes a whole class of complexity: the agent's native file writes can't be role-blocked cleanly, so a read-only role was an awkward fit.)
- **Offline session:** a short-lived access token is refreshed silently while online; the cached session permits offline work for **~30 days since last successful server contact**, then re-auth is required. Sign-in is required at least once (D13).
- **Why:** Syv is a Google shop (already uses Google Drive); low-friction, standard company SSO. The per-user tier (D6) needs a real identity to scope to.
- **Note:** this is entirely new surface — the old app had zero auth.
- **Rejected:** *a viewer/read-only role* (awkward vs the agent's native file writes; not wanted). *Syv-native accounts* (build/maintain auth; another login). *Defer auth* (undercuts the per-user tier).

## D8 — Per-turn context injection via a UserPromptSubmit hook
**Decided.** Holi's fresh per-turn context (active note, linked tasks, memory fill-state) is injected through a **Claude Code `UserPromptSubmit` hook** configured in the vault's `.claude/settings`. The base **system prompt** ships once via `--append-system-prompt` at PTY launch.

- **Why:** you can't transparently prepend a `<system>` block to what a user types into an interactive TUI. The `UserPromptSubmit` hook is the native mechanism — it runs on every prompt and Claude appends its output to context. Exactly matches the old `build_per_turn_prefix`.
- **Rejected:** *system-prompt-only* (goes stale within a session as the user switches notes — loses "fresh focus every turn"). *MCP resource pulled on demand* (not guaranteed present; model may forget).

## D9 — Chat history: native `--resume` IS the history *(reversed — was: full structured reconstruction)*
**Decided.** No custom history system. The drawer's history affordance relaunches `claude --resume`: **Claude Code's own session picker**, and picking a session replays the full transcript **in the terminal itself**, at perfect fidelity, for free. Conversations remain local to the machine that ran them and are never synced.

- **Deleted outright:** the JSONL parser, the transcript-reconstruction module, the local headless summarizer job, `conversations.jsonl`, and the `conversation_search`/`session_search` MCP ops. There is no server-side conversation store either.
- **Why:** this was the **single most brittle subsystem** in the plan (undocumented JSONL-format coupling — flagged as the top strategic risk) and it duplicated what CC does natively. Under **D30**, it's the standout violation: cut it and the brittleest coupling in the whole architecture disappears.
- **Cost accepted:** no rich browse/search view outside the terminal — history lives where the chat lives. No cross-device history (unchanged; conversations were already local-only).
- **Rejected:** *full structured reconstruction* (the earlier decision — brittle, duplicative). *A thin Holi-rendered session list reading session-file metadata* (still a coupling touchpoint; native picker suffices).

## D10 — MCP surface: minimal, native-first
**Decided.** The MCP ops server exists **only** for what isn't a plain file. In v1 that is just **task ops** and **`note_rename`** (vault-wide link rewrite + CRDT identity); **calendar** and **mail** ops join in phase 2 with the Google integration. Everything else — notes, memory, skills, theme, daily notes, imports, asking the user — uses **Claude's native tools** + Holi's bridge/watchers. *(The conversation/session-search ops were deleted with the custom history system, D9.)*

- **Where:** the MCP server runs in **Electron main** (per-run bearer token, as before); structured ops proxy to the **Syv API**.
- **Permissions:** Claude's **native** interactive prompts for file/bash + **server-side MCP gating by vault role** (member = read + write; owner = + vault admin). No viewer role (D7), so there's no read-only agent case. The bespoke **safe/power_user** modes are **dropped**.
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
- **v1 core:** multiplayer notes + editor (CodeMirror + Yjs), stripped task board, Claude xterm drawer (history via native `--resume`, D9), shared + personal vaults with Google SSO + presence, **daily notes**.
- **Phase 2 (in order):** import conversion + attachment-original viewing (PDF/docx → markdown on entry, originals archived — D28) → **Google Gmail + Calendar** sync (on Google APIs, under the same OAuth) → **Typst export** (render a markdown doc into a branded syv.ai Typst template).
- **Post-v1, designed:** **vault apps** (agent-authored in-vault apps, D31) — supersedes the old "agent-authored HTML apps/widgets" deferral with a full design.
- **Deferred:** self-improvement loop; note-embedded app widgets (D31 keeps apps out of the editor).
- **Killed:** **Mailspring** (only ever chosen for OSS/extensibility; being abandoned) — replaced by Google APIs.

## D22 — Editor rollback: keep simple live-preview, cut the animation layer
**Decided.** The CodeMirror editor is **trimmed**, not preserved verbatim. The old editor grew a large, fragile animation/custom-logic layer that had "grown out of shape"; we roll it back.

- **Keep:** live-preview with **reveal-raw-on-click** (rendered line → raw markdown when the caret enters it, re-render on leave) as a **plain decoration swap — no animation**; markdown **formatting hotkeys** (⌘B/⌘I/⌘E/⌘K/strikethrough, toggle-aware); **wiki-links + markdown links** (chips, hover, click-to-open); **`[[task:<id>]]`** task chips in prose (resolved against records, D4); **`@`-mentions**; **slash commands**; the **table widget + its package** (`codemirror-markdown-tables`); frontmatter hiding; the Yjs binding + remote cursors. Also keep the **tight vertical rhythm** refinement — rendered blocks (dividers/HR, headings, blockquotes, code, images) get **no excessive top/bottom padding**, so lines don't jump as they render/un-render.
- **Cut:** the **View-Transitions source↔rendered morph** (`startViewTransition` dispatcher, three-tier trigger), the **frozen-caret `StateField`** (`caretTransitionField`), **gap-marks**, and **`view-transition-name` plumbing** (`viewTransitionNaming`). The active-line reveal is derived **directly from the current selection**, not a frozen caret.
- **Why:** the animation layer was fragile and heavy, and animating CM decorations pegs CodeMirror's measure loop on the main thread (a lesson already learned — [[feedback_codemirror_layout_animations]]). Cutting it also **erases the biggest risk in the plan**: the morph-vs-remote-edits interaction under multiplayer simply ceases to exist (a remote edit just re-decorates; there's no animation path to guard).
- **Rejected:** *keep live-preview AND the morph, hardened* (re-inherits the exact fragility we're removing). *Go fully conventional source↔rendered toggle* (loses the reveal-raw-on-caret feel the user wants to keep).

## D25 — Bridge protocol: 3-way merge vs frozen base + soft turn-taking
**Decided.** The file↔CRDT bridge (D2) reconciles agent writes with this turn protocol. Human↔human editing is **pure Yjs and never touches the bridge** — the bridge only mediates agent↔CRDT, which shrinks the race surface to one rare case.

1. When the agent starts writing a doc, the bridge takes a **soft lock**: the agent appears in presence as *"Claude is editing…"*, and **CRDT→file re-materialization is paused for that doc**, freezing the **base** (the last-materialized text) so remote edits arriving mid-turn can't poison the diff.
2. The agent edits the stable file freely (CC's read-before-edit guard is satisfied — the file doesn't move under it).
3. On turn end/idle: compute `diff(base, file)` and apply the patch as **positioned Yjs ops** onto the *live* CRDT (which may now contain buffered remote edits) — a 3-way merge, like git. **Never blind-replace.**
4. New base = merge result; re-materialize; release the lock.

- **Why:** a blind whole-file replace would revert teammates' concurrent edits; diffing against a *frozen* base is what makes the patch mean "what the agent changed" and nothing more. Soft turn-taking makes human-vs-agent same-region collisions rare in practice; when they do overlap, character-level last-writer resolves it (same as two Google-Docs cursors) with D26 as the safety net.
- **De-risk:** the bridge is the **only genuinely novel component left in the plan → Spike 1**, before any other code (two clients + an agent hammering one doc).
- **Rejected:** *intercept CC's `Edit` via PreToolUse to capture intent* (couples to tool internals; `Write` still needs the diff fallback). *Hard per-doc checkout locks* (blocks simultaneous human+agent editing entirely).

## D26 — Merge safety net: history + auto-snapshots + one-click agent reconcile
**Decided.** D21 stands — **no conflict dialogs, ever** (the Google Docs model). Convergence-but-garbled merges are handled by recoverability plus semantic repair:

- **Auto-labeled snapshots** before risky operations: an agent bulk-write, or reconciling a long-offline session ("before Claude edited", "before your offline changes merged"). One-click restore from the Yjs snapshot timeline (D3).
- **Overlap detection:** when Yjs merges two concurrent edits that touched **overlapping ranges** (or reconciles a long-offline session), the doc gets a **non-blocking** flag — *"this merge may need a look — let Claude reconcile?"*
- **One-click agent reconcile:** accepting hands a git-style 3-way (**base / mine / theirs**, reconstructed from snapshots) to the user's **local** agent, which writes a clean reconciled version back through the bridge (with its own pre-snapshot).

- **Why:** CRDTs guarantee *same* text, not *sensible* text. Git surfaced conflicts explicitly and let an intelligent resolver fix them — this recreates that at the semantic layer, using the in-vault LLM. A differentiator no plain-CRDT app (Google Docs, Notion) has. User-triggered, so no spooky silent rewrites and no token spend without opt-in.
- **Rejected:** *auto-run reconciliation on every overlap* (unattended rewrites; tokens per collision; per-user divergence). *A real conflict-resolution UI* (large build; fights the CRDT's point; undoes D21).

## D27 — Cross-references: stable IDs for machines, paths for prose
**Decided.** The docs-are-CRDT / tasks-are-records seam is kept honest by one principle: **machine references use stable IDs; human prose uses paths.**

- Task `related[]` note-refs and task `area` store **stable IDs** (doc id / folder id), resolved to the current path only for display. `[[task:<id>]]` chips are already ID-based (D22).
- Prose wiki-links stay path-based `[[folder/note.md]]` — D12 unchanged.
- **Consequence:** `note_rename` becomes a **docs-only** operation (rewrite prose links inside CRDT docs); task records need **no rewrite** — the scary cross-subsystem atomic transaction evaporates. Folder renames cascade `area` display automatically (IDs don't change).
- Deletes render **tombstones** ("[deleted note]") on dangling refs instead of atomic cascades.
- **Rejected:** *paths everywhere + a saga/outbox coordinator across Yjs + SQL* (distributed-transaction machinery — the exact fragile seam). *paths + background reconciler* (transient dangling refs).

## D28 — Markdown-first ingestion; binary originals to object storage
**Decided.** The vault is **text by construction**: PDFs / Word files / other documents are **converted to markdown on entry** (the import pipeline). The **original binary is archived to object storage** (Hetzner) and fetchable on demand — an archival escape hatch, not a working format. Actual binaries in vaults are expected to be rare.

- **Why:** this is what makes D23 (full materialization) hold permanently — the working set is always small text. It also fits the product: a DMS where everything is editable, linkable, agent-readable markdown rather than opaque blobs.
- **Consequence:** phase-2 "PDF/docx preview" reframes as *import conversion + viewing archived originals*. Hosting note: the server stack (D14) targets **Hetzner** (+ its object storage).
- **Rejected:** *sync all binaries to every disk* (GB-scale vaults hurt everyone). *eager/lazy threshold mechanics now* (phase-2 detail, premature).

## D29 — Agent security posture: trust the team + CC-native guardrails
**Decided.** The trust boundary is **vault membership** (a small all-developer company; members are trusted colleagues — and a member's agent has no authority the member lacks).

- CC's **native permission prompts** stay on — Holi never launches with skip-permissions.
- The vault's shared **`.claude/settings.json` seeds permission defaults** (e.g. network-egress commands like `curl` gated behind approval) — configuration, not machinery; editable per vault.
- **Snapshots/history (D26)** are the recovery story for destructive edits; server truth means local wreckage always re-materializes.
- **Prompt injection via shared vault content** (a doc steering a member's agent) is a documented, accepted **residual risk** for v1 — no bespoke sandboxing.
- **Rejected:** *sandboxed-bash by default* (friction on legit dev tasks; gets turned off). *treat shared vaults as hostile input* (heavy machinery against a threat the team shape doesn't have).

## D30 — Operating principle & assumptions: cater to Claude Code as-is
**Decided.** The old vault assistant was vastly overcomplicated. The rebuild's standing principle: **build only what Claude Code doesn't already do; work with CC as-is.** No adapter layers, no version-pinning ceremony — if a CC release breaks something, fix forward.

Standing assumptions (they dissolved several risks outright):
- **Every employee is a developer.** The raw TUI drawer is the natural interface, not a liability.
- **CC is already installed and authenticated** on every machine (each employee's own account, native auth). Holi does no provisioning, metering, or credential management; the old login-PTY flow is at most an edge-case fallback.
- Applications of the principle this round: D9 reversed (native `--resume`), D6 simplified (native config layering), D8 kept (hooks are native), D29 (settings-seeded permissions, not machinery).

## D31 — Vault apps: agent-authored, in-vault, multiplayer via the existing relay *(post-v1, designed)*
**Decided (design locked; ships post-v1).** The vault assistant can create **just-in-time interactive apps** that live in the vault and open inside Holi. Full design in [`prd/vault-apps.md`](prd/vault-apps.md).

- **No shipped runtime:** Chromium (sandboxed webview) renders app UIs; an app that declares a backend gets an Electron **`utilityProcess`** — the Node already bundled. "Each vault ships with Node" is satisfied with zero installs.
- **Anatomy:** an app = a directory `.holi/apps/<name>/` with `manifest.json` + `index.html` (+ assets, + optional `server.mjs`). Synced as vault content — every member gets every app. The agent authors apps with native `Write` (D30); the contract is documented by a skill in the vault's `.claude/`.
- **Surface:** apps open as **first-class tabs** in the pane system; launched from the command palette, a sidebar Apps section, or by the agent. **Note-embedding stays deferred** (keeps the editor lean, D22).
- **`holi.*` bridge** (postMessage): `holi.data` — the app's **shared Yjs doc** on the existing relay, making **every app live-multiplayer, offline-capable, and snapshot-covered (D26) for free**; `holi.tasks`/`holi.docs` (read/write/subscribe, membership-gated server-side); `holi.awareness` (presence in the app); `holi.open` (navigate Holi); theme tokens injected.
- **Trust:** manifest capabilities are transparency, not gates — full employee trust (D29); backends get Node as-is. Revisit if external code ever enters vaults.
- **Reuse:** copy the directory; an org-wide "apps" shared vault as convention. No registry/versioning machinery.
- **Agent inspection:** app state optionally materializes as read-only `data.json` so the assistant can `Read` and act on it (e.g. summarize a retro board into a note).
- **Rejected:** *Deno/Bun sidecar runtime* (a second runtime to ship; Electron's built-ins suffice). *single-file apps first* (chose dir+manifest for uniform contract and room to grow). *note-embedded apps in v1 of the feature* (editor complexity, D22). *server KV / vault-text-file app state* (worse than the Yjs doc we already have).

---

## Smaller decisions (author's call, flagged for review)

- **D18 — Theme is a shared (tier-1) vault property, owner-only edit.** One vault-wide brand/theme everyone sees; **only the owner can edit it** (members can't restyle the team's vault). Agent theme-proposal deferred. **Light/dark mode** is a per-user local preference. *Open to per-user theme overrides later.*
- **D23 — Full active-vault materialization (v1).** A client materializes the **whole active vault** to disk as working copies, so the agent's native `Grep`/`Glob`/`Read` see every doc and the file tree is real. Holds permanently because the vault is text by construction (**D28** — binaries convert to markdown on entry; originals live in object storage, never eagerly synced). **Lazy/partial materialization is a deferred optimization** for very large vaults.
- **D24 — Daily notes are personal-vault-only.** The daily note is a personal-journaling feature: auto-created only in your **personal** vault, never in shared vaults. This sidesteps shared-vault duplicate-creation, cross-timezone "today" disagreement, and visibility entirely. "Today's note" is always yours. (Refines D17.)
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
