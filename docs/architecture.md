# Architecture

How Holi fits together. This is the technical spine — the map; each PRD in [`prd/`](prd) drills into one pillar and carries the deep rationale.

---

## 1. System shape

**One deployable: a desktop app.** There is no server, no database, and no hosted service.

```
┌──────────────────────────── apps/desktop (Electron) ─────────────────────────────┐
│  Renderer (React + Jotai + CodeMirror)          Main (Node)                       │
│  ┌───────────────┐  ┌──────────────┐            ┌───────────────────────────┐     │
│  │ Editor (CM6,  │  │ Task board,  │            │ Sync engine               │     │
│  │ file-backed)  │  │ drawers, UI  │            │  auto-pull · autosave     │     │
│  └──────┬────────┘  └──────┬───────┘            │  commits · publish        │     │
│         │                  │  tRPC over IPC     │  · reconcile              │     │
│  ┌──────▼──────────────────▼───────┐            ├───────────────────────────┤     │
│  │ preload / contextBridge          │◄──────────┤ Vault store               │     │
│  └──────────────────────────────────┘           │  fs walk + watcher        │     │
│                                                 ├───────────────────────────┤     │
│                                                 │ PTY host → `claude`       │     │
│                                                 │  (xterm drawer)           │     │
│                                                 ├───────────────────────────┤     │
│                                                 │ GitHub client (device     │     │
│                                                 │  flow, repos, collabs)    │     │
│                                                 └─────────────┬─────────────┘     │
└───────────────────────────────────────────────────────────────┼──────────────────┘
                                                                │ git over HTTPS
                                                                │ + GitHub REST
                                                                ▼
                                  ┌──────────────────────────────────────┐
                                  │  GitHub                              │
                                  │   the vault repo · collaborators      │
                                  │   · auth · history · durability       │
                                  └──────────────────────────────────────┘

         ~/Holi/<owner>/<repo>          packages/shared
         the vault: a git clone         types · task file grammar · wiki-links
         of markdown files              · path-safety · recurrence/reminders
                                        · 3-way text merge
```

**Key property: the truth is the filesystem.** Everything in the app — the editor, the board, the file tree, the agent — reads and writes the same `.md` files in one directory. Nothing derives from anything else, so nothing can disagree.

`packages/shared` is no longer a client↔server seam; it is the vocabulary the app uses with itself and with the files on disk. It stays a separate package because its contents are pure, testable rules — the task file grammar, the wiki-link grammar, path containment, recurrence math — and keeping them free of Electron is what keeps them testable.

**What was deleted, and why it isn't missed.** The previous architecture had a Hocuspocus relay, Postgres, Google SSO, memberships, a tasks table, a reminder evaluator, snapshot history, an SSE fan-out, a server-side git mirror, and a file↔CRDT bridge on every client. All of it existed to serve one premise — that shared vaults require real-time co-editing, and co-editing requires CRDTs over a hosted relay. [`vision.md`](vision.md) withdraws that premise for v1. Each subsystem's replacement is named in the section that used to own it.

---

## 2. Operating principle: cater to Claude Code as-is

**Build only what Claude Code doesn't already do; work with CC as-is.** No adapter layers, no version-pinning ceremony — if a CC release breaks something, fix forward. Standing assumptions:

- **Every employee is a developer.** The raw TUI drawer is the natural interface, not a liability. Git is a tool they already have.
- **CC is already installed and authenticated** on every machine (each employee's own account, native auth). Holi does no provisioning, metering, or credential management.

This principle governs the whole agent surface (§5), and under the new shape it governs *more*: with the vault being plain files in a git repo, the set of things Claude Code cannot already do has shrunk to **zero**, so the MCP op surface is empty (§5).

---

## 3. The vault, and how it syncs

### A vault is a GitHub repo, cloned
A vault is a clone of a GitHub repository under a **Holi-managed root** (`~/Holi/<owner>/<repo>`). Its identity is its remote. Its documents are `.md` files. Its tasks are `task.*.md` files. Its agent config is `.claude/`. Its history is git history.

Holi never adopts a checkout you maintain yourself: it **auto-commits**, and pointing that at a working tree where you keep WIP branches and staged changes would be destructive. A managed clone makes that impossible by construction.

**Why git, when git was explicitly rejected before.** It was rejected as a *client↔client sync engine for live collaboration* — a judgement that stands, and is exactly why concurrent editing is deferred rather than attempted over git. What it is being used for here is different: durable, shared, asynchronous storage with history and access control, which is the thing git is best at. The old app's git failure modes came from **auto-committing every 30 s and never pulling**, not from git.

### Sync: automatic inbound, explicit outbound
Full design: [`prd/vaults-sync.md`](prd/vaults-sync.md).

- **Autosave commits.** Edits become local commits on an idle debounce or ⌘S. The working tree is therefore **always clean**, so a pull can always merge; a crash loses nothing; and the commit journal *is* the undo history.
- **Auto-pull, merging.** Holi fetches and merges on an interval and on focus. **Merge, never rebase** — with dozens of unpushed autosave commits, a rebase replays each and can conflict repeatedly on the same hunk, a failure mode manufactured entirely by autosave granularity.
- **Publish.** Push is explicit. Your work leaves the machine when you say so.
- **Reconcile.** A conflicting merge is **aborted immediately**, restoring a clean tree, and surfaces a banner offering **Ask Claude to reconcile** — which pauses autosave, re-runs the merge for real, and hands it to the agent in the drawer. *Ignore the banner and you keep working on an unbroken vault.*

### The file tree and the watcher
The tree is a filesystem walk plus a watcher — not server metadata. Folders are real directories, which deletes an entire class of problem the previous design had (orphan folder rows, vestigial empty folders, and the display-level workaround for them): git does not track empty directories, so an empty folder is a transient local state rather than a row that outlives its contents.

### External writes
A file can change under an open editor because the agent wrote it, a pull landed it, or another window touched it. All three are one event: a **clean buffer reloads**, a **dirty buffer takes a plain 3-way text merge** (base = last loaded text), and an **unmergeable overlap** falls into the same reconcile path as a git conflict.

**The 3-way merge is new work, not a survivor.** `packages/shared/agent-merge` looked like the merge and is not: it forks a shadow `Y.Doc` from the frozen base, replays the diff onto it, and lets **Yjs** do the positional reconciliation. Take away the CRDT and there is no merger left — only a 2-way diff (`fast-diff`, which does survive). A real diff3 has to be written or vendored, and it must report an unmergeable overlap rather than guessing, because that report is what routes the case to reconcile.

This is what remains of the **file↔CRDT bridge**: the soft lock, the frozen base, the turn protocol and the diff-to-positioned-ops translation are gone with the CRDT they translated into, and the merge core is replaced rather than reused.

### Durability
GitHub holds the vault. There are no snapshots to store, no object storage, and no backup subsystem — a vault that has been published is on GitHub, and a vault that hasn't is in a local git repo with its full history.

---

## 4. Identity, auth, access

Full design: [`prd/auth-identity.md`](prd/auth-identity.md).

- **Sign-in:** GitHub, via the **OAuth device flow** — the grant designed for clients that cannot hold a client secret. Token in the OS keychain (Electron `safeStorage`), held in main, never given to the renderer. Scopes: `repo` + `read:user`.
- **Vaults & membership:** a vault's members are **the repo's GitHub collaborators**. Holi defines no roles. The members panel is a read-only view of GitHub's truth, and "add someone" deep-links to GitHub.
- **Authorization is GitHub's, at push time.** Holi performs **no** authorization checks — and that is the honest version of the old rule "the client is never trusted for authorization". Without a server, the way to keep that rule is to put no authorization in the client at all; a permission check running on the machine of the person it restricts is not a boundary, and shipping one would manufacture a false sense of protection.

**What this costs:** Workspace-managed offboarding is gone, and removing someone stops future sync without reaching back to what they already cloned. Both were true of any git-backed system, and the second was true of the old design too the moment a working copy existed.

---

## 5. The agent

Full design: [`prd/agent.md`](prd/agent.md).

### Runtime: interactive Claude in a PTY
Electron main spawns **`claude`** in a **node-pty** PTY, with the **vault clone** as its cwd and the user's own Claude auth (per-user cost attribution). Bytes stream to an **xterm.js** drawer in the renderer. This is the **live** surface — native Claude UX (permission prompts, plan mode, thinking, todos) at full fidelity, with no stream-json parsing. Rejected: a server-side/headless agent — which now has nowhere to run anyway.

### Config layering
**Pure CC-native layering — Holi composes nothing and syncs no personal config:**
- **Shared:** the repo carries `.claude/` (persona, shared skills/commands, `settings.json` with seeded permission defaults and the `UserPromptSubmit` hook), `AGENTS.md`, and `MEMORY.md`. They travel because they are **committed** — which is also how every developer already ships shared Claude config.
- **Personal (machine-local):** the user's own `~/.claude` + `CLAUDE.local.md` + `USER.md`, plus `.holi/settings.local.json`. Holi never reads, writes, or syncs these.
- **`.gitignore` is now what enforces personal privacy.** It used to be a server boundary; it is now a file, and the vault seed must carry it.

### Per-turn context
A **`UserPromptSubmit` hook** runs on every prompt and emits Holi's fresh context — active note, linked tasks, memory fill indicators, and the vault's sync state. The base system prompt ships once via `--append-system-prompt` at launch. The hook now sources everything from the local filesystem, which removes the transport-and-auth question the old design carried: there is nothing to authenticate to.

### MCP ops: none
**The MCP server is deleted.** The three v1 ops each lost their reason:

- `task_list` was a server query because full-vault file scans were forbidden; it is now `Glob **/task.*.md`, which is what the `task.` filename prefix exists to make cheap.
- `task_set` existed because `status: done` was ambiguous for a recurring task; the ambiguity is resolved by convention, and the convention is safe — `done` rolls forward (Holi's watcher performs the roll whoever wrote the file), and ending a series means deleting `recurrence` from the frontmatter. The conservative reading is the default.
- `note_rename` had to preserve CRDT Doc identity and rewrite links atomically; there is no Doc identity, so it is `git mv` plus a link rewrite, shipped as a **vault skill** in `.claude/`.

**Cost accepted:** a skill-driven rename is not atomic and can miss a link. The fallback if that proves common is to expose the app's own rename as a slash command — not to resurrect an op surface.

Phase 2's calendar and mail are the one category expected to need an MCP server again, because that data is not in the repo.

### The agent as merge resolver
This is the agent's one *new* structural role. When a pull conflicts, Holi hands the merge to the agent rather than to a three-pane diff UI — because a merge editor resolves conflicts *positionally*, which is the wrong level for prose and for YAML frontmatter, while an agent resolves on meaning, in a surface already open, and can ask. It operates inside git, mid-merge, on a repo whose pre-merge state is a commit; the worst case is `git merge --abort`.

### History: native `--resume`
No custom history system. The drawer's history affordance relaunches **`claude --resume`** — CC's own session picker, replaying the transcript in the terminal at perfect fidelity. Conversations stay on the machine that ran them.

---

## 6. Tasks

**A task is a markdown file.** Full design: [`prd/tasks.md`](prd/tasks.md).

- **`task.<name>.md`**, living in the vault folder it is about. The **path is its identity**, its **folder is its swim lane**, and the filename prefix is what makes it a task — so one glob finds every task, and no note can accidentally become one.
- **Frontmatter** carries `title, status, due, priority, tags, reminder, recurrence`; the body is the description.

```ts
// packages/shared
type Task = {
  path: string           // vault-relative — the identity
  title: string          // frontmatter, falling back to the filename
  status: 'todo' | 'doing' | 'done'
  due?: string           // YYYY-MM-DD
  priority?: 'low' | 'medium' | 'high'
  tags: string[]
  reminder?: string      // Nd | Nw | YYYY-MM-DDTHH:MM
  recurrence?: Recurrence
  description: string    // the markdown body
}
```

- **What this deletes.** The record/projection split and everything it required: `ProjectionStore`, the version token, per-field patching, rewrite-from-truth, `RelatedRef`, `[[task:<id>]]` chips, task ids, `area` as a stored field, presence heartbeats, and the SSE `tasks` channel. All of it existed to reconcile a file with a record; there is no record.
- **Board:** default **Todo/Doing/Done** with **swim lanes by folder**; a three-control filter bar. Virtual labels (`overdue`, `p1`–`p3`) are computed at render, never stored — storing them would mean a write at midnight, which is now a commit.
- **Recurrence & reminders:** the **rules** stay pure functions in `packages/shared` (port the old, well-tested math). **A tray-resident Holi evaluates reminders locally**, catching up missed fires on launch. The delivered-watermark is machine-local and never committed — a fire that produced a commit is the same failure the old design kept the version token out of frontmatter to avoid.
- **Concurrency** is the vault's ordinary git semantics: different files merge, different frontmatter lines merge, the same line conflicts and goes to reconcile. The old design refused to merge task YAML because a CRDT can converge on invalid syntax *with no writer able to reject it*; git is not a CRDT — it refuses rather than guesses, and the refusal is what makes agent-assisted resolution possible.

---

## 7. Notes, links, editor

Full design: [`prd/notes-editor.md`](prd/notes-editor.md).

- **Editor:** CodeMirror 6 with **simple live-preview** (reveal-raw-on-caret, **no animation** — the View-Transition morph and its frozen-caret/gap-mark machinery stay cut: the layer was fragile, and animating CM decorations pegs CodeMirror's measure loop on the main thread). It is now **file-backed**: it reads the file, autosaves on idle or ⌘S, and handles external writes with a 3-way merge. The `y-codemirror.next` binding, remote cursors, and awareness are gone with the relay.
- **Wiki-links:** path-based `[[folder/note.md]]` — readable in raw markdown, so Claude can follow *and* author them naturally. One parser in `packages/shared`. This is now the **only** link grammar: `[[task:<id>]]` died with task ids, so a link to a task is a link to a file.
- **Rename:** move the file and rewrite inbound links in one local pass, rejecting an existing destination *before* moving anything. There is no transaction and there cannot be one — but every step is a file write inside a git repo, so the commit before the rename is a complete restore point and a half-finished rename shows up in `git status` rather than hiding in a database.
- **Backrefs:** a grep. The `link_index` existed to avoid a full-disk scan on a server holding many vaults; a local vault greps in milliseconds, and an index would be a second copy of the truth that can go stale.
- **Daily notes:** keep the untouched-stub heuristic and the `journal/` archive. Creation is now `if (!exists) write(seed)` — and because the path *and the seed bytes* are deterministic, two of your devices creating it offline produce an identical blob that git merges silently. Details: [`prd/daily-notes.md`](prd/daily-notes.md).

---

## 8. Data model

**There isn't one.** The vault is a directory of markdown files; there is no database, no schema, and no migrations.

What state exists outside the repo is machine-local and small:

- **OS keychain** — the GitHub token.
- **`.holi/settings.local.json`** (gitignored, per vault) — reminder delivery watermark, UI prefs, machine-local overrides.
- **`.holi/settings.json`** (committed, per vault) — vault-wide app settings.
- **App-level config** — the vault registry: which repos are added, and where they are cloned. A *machine* fact, not an account fact; a second laptop starts empty.

*(No conversation store: chat history is Claude Code's, local per machine.)*

---

## 9. Client architecture

- **State:** Jotai single-store, action atoms for multi-atom side effects, hooks mounted once in the app shell.
- **IPC seam:** one **preload/contextBridge** module wraps `ipcRenderer.invoke`/events; the renderer reaches main through a **tRPC-over-IPC** link. This seam survives the pivot intact and is what makes the rebuild tractable: the renderer keeps calling a typed router, and the router's *implementation* moves from "proxy to the Syv server" to "read and write the clone". The signatures change — identity moves from `docId`/`vaultId` to paths — but the shape does not.
- **A store loaded by whoever renders it will fail silently.** Vault-scoped stores (the tree, the task set) mount in the app shell with the lifetime of the active vault, never inside the surface that happens to read them first — a second consumer cannot tell an unloaded store from an empty one, and the failure looks like data loss.
- **UI system:** the `tone`/`variant`/`shape`/`size` cva primitives and `tokens.css` typography tiers port from the old frontend.
  - **NOT PORTED (verified 2026-07-16)** — there is no `ui/` directory and no `cva` in the renderer; it is raw Tailwind throughout. Deliberately deferred until the UI grows past what raw Tailwind carries comfortably, and still deferred.
- **App shell:** single-window, atom-driven view model, drawers/dialogs as summoned modals. **One forward-looking constraint:** the pane/tab system must not assume tabs are notes — post-v1 **vault apps** ([`prd/vault-apps.md`](prd/vault-apps.md)) open as first-class app tabs. Design in [`prd/notes-editor.md`](prd/notes-editor.md) §Panes & tabs.
- **Tray residency.** Holi launches at login and lives in the tray, because that is what makes local reminder evaluation a real feature rather than a promise.

---

## 10. Security boundaries

- **Path safety** (`packages/shared`): the `resolve_relative` / `VaultPath` containment logic — reject `..`/absolute/NUL, canonicalize through the closest existing ancestor, reassert containment. Implemented **test-first**. It is **more** load-bearing than before: it is now the only thing between a path and the user's filesystem, where server-side authorization used to be a second line.
- **Renderer isolation:** `contextIsolation: true`, no `nodeIntegration`; the renderer reaches main only through the preload bridge, and never holds the GitHub token.
- **Agent posture:** trust boundary = repo access (a small all-developer company; members are trusted colleagues, and a member's agent has no authority the member lacks). CC's native permission prompts stay on (never skip-permissions); the vault's shared `.claude/settings.json` seeds permission defaults. **Git history is the recovery story** — and a better one than the snapshot timeline it replaces, because `git revert` is a command the user already knows.
  - **The blast radius grew in one specific way and should be named:** the vault directory is now a git repo with a push credential reachable from it, so a destructive git command is expressible where the client previously had no `.git` at all. Bounded by native permission prompts, a Holi-managed clone containing nothing else, and branch protection on the remote. **Not** bounded by blocklisting git from the agent — it needs git for reconcile, and a blocklist the reconcile flow must punch through is not a boundary.
- **Token scope:** a `repo` grant reaches every repo the user has, not just their vaults — inherent to a desktop client acting as the user. Mitigated by keychain storage, main-process confinement, and documenting fine-grained PATs as the tighter option.
- **Prompt injection via shared content** is a documented residual risk — no bespoke sandboxing in v1 (rejected: sandboxed-bash by default — friction on legit dev tasks; it gets turned off).
- **Theme injection:** if per-vault theme CSS is injected into a privileged context, validate it (parse, not substring-blocklist) or inject into a sandboxed context — the old substring validator was the weak point.

---

## 11. Build & deploy

- **Client:** Electron + Vite + React; packaged with electron-builder (dmg/nsis/AppImage). **This is the entire deployment.**
- **Shared:** `packages/shared`, consumed by the desktop app; no codegen.
- **Dev:** `pnpm dev` runs the desktop app. No database, no Docker, no compose file.
