# Glossary

Canonical terms for the rebuild. When a word is ambiguous, this file wins. Kept to definitions only — no specs.

### Vault
A **GitHub repository**, cloned locally, containing a folder hierarchy of markdown documents, tasks, and agent config. There is no server-side vault object and no client-minted vault id — the repo *is* the vault, and its identity is its remote.

- **Personal vault** — a private repo with one collaborator: you.
- **Shared vault** — a private repo with several collaborators.

### Membership / Role
The repo's **GitHub collaborator list**. Holi defines no roles of its own and enforces no access control: GitHub does, at the git layer. If you can clone and push, you are a member.

### Document (Doc)
A single note: a plain `.md` **file in the repo**, at a vault-relative path (e.g. `projects/q2/roadmap.md`). The file is the document — there is no separate record, no CRDT, and no materialization step.

### Task
A markdown file named **`task.<name>.md`**, living in the vault folder it is about (e.g. `projects/q2/task.fix-login.md`). YAML frontmatter carries `status`, `due`, `priority`, `tags`, `reminder`, `recurrence`; the body is the description. The file is the task — no record, no projection, no version token.

- **Identity is the path.** A link to a task is an ordinary wiki-link, `[[projects/q2/task.fix-login.md]]`. There are no opaque task ids.
- **The filename prefix is the marker.** One glob (`**/task.*.md`) finds every task, and no note can accidentally become one.

### Area / Lane
A task's **containing folder** — derived, never stored. It is what the board groups swim lanes by. Moving a task between lanes moves the file.

### Status
A task's state: **todo | doing | done**.

### Autosave commit
A local git commit made automatically when editing goes idle, or on ⌘S. Its purpose is to keep the working tree **clean** so an incoming pull can always merge, and to give the vault a free undo history. Local only until you publish.

### Publish
The explicit act of pushing your local commits to the repo. Pull is automatic; push never is.

### Reconcile
The conflict path. An automatic pull that hits a textual conflict is **aborted immediately** (`git merge --abort`), leaving a clean tree, and surfaces a banner. Pressing **Ask Claude to reconcile** pauses autosave, re-runs the merge for real, and hands it to the agent in the drawer. If you ignore the banner you keep working on an unbroken vault.

### 3-way reload
What the editor does when a file changes underneath it — because Claude wrote it, or because auto-pull landed it. A clean buffer reloads silently; a dirty buffer takes a plain text 3-way merge (base = last loaded text, mine = buffer, theirs = disk). An unmergeable overlap falls into the same **Reconcile** path as a git conflict.

### Wiki-link
A path-based reference between files: **`[[folder/note.md]]`** (optional `[[path|Label]]`). The only link grammar — notes and tasks alike. Human- and agent-readable. Renaming a file rewrites inbound links.

### Reminder
A rule in a task's frontmatter that fires a notification: relative (**`Nd`** / **`Nw`** before due, at a 09:00 anchor) or absolute (`YYYY-MM-DDTHH:MM`). Evaluated **locally**, by a tray-resident Holi; missed fires catch up on next launch. A reminder on a shared task notifies every member — tasks have no assignee. The delivered-watermark is machine-local and never committed: a fire must never produce a commit.

### Recurrence
A rule that rolls a completed recurring task forward to its next occurrence: `frequency (daily|weekly|monthly|yearly), interval, weekdays[], endDate`. Rolls forward locally, on completion, by rewriting the file.

### Agent / Vault assistant
The in-app **Claude Code** instance. Runs as an interactive `claude` process in a **PTY**, shown in the **xterm drawer**, with the vault clone as its cwd. It reads and writes vault files with its native tools — there is nothing to bridge, because the files are the truth.

### xterm drawer
The popup terminal drawer that renders the live interactive `claude` session — the chat surface, including history (via native `--resume`).

### Persona
The shared vault-assistant identity: **SOUL.md** / **IDENTITY.md** + shared **AGENTS.md** + shared skills. Ordinary vault content, committed to the repo.

### Config layering
Claude Code's native layering, unmodified:
1. **Shared** — the repo's `.claude/`, `AGENTS.md`, `MEMORY.md`. CC picks them up from the cwd; they travel because they are committed.
2. **Personal** — the user's own `~/.claude` + `CLAUDE.local.md` + `USER.md`: machine-local, never touched by Holi.
3. **Holi app settings** — `.holi/settings.json` (committed, vault-wide) + `.holi/settings.local.json` (gitignored, machine-local) — the same shared/local convention CC itself uses.

Chat history is machine-local, never committed.

### USER.md / MEMORY.md / AGENTS.md
- **AGENTS.md** — the user-authored "System" instructions for the vault assistant. Committed.
- **MEMORY.md** — the vault's shared scratchpad memory. Committed.
- **USER.md** — the agent's model of an individual user. **Personal, machine-local** (never committed).

### Per-turn context
The fresh context (active note, linked tasks, memory fill-state) injected into every agent turn via a **`UserPromptSubmit` hook**.

### History (chat)
Claude Code's **native session resume**: the drawer relaunches `claude --resume`, CC's own session picker, replaying the full transcript in the terminal. No custom reconstruction, no summaries, no sync.

### Client / Shared (code)
- **Client** = `apps/desktop` (Electron + React) — the whole product.
- **Shared** = `packages/shared` (types, task file grammar, wiki-link grammar, path-safety, recurrence/reminder rules, text 3-way merge).

*(There is no server.)*
