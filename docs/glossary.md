# Glossary

Canonical terms for the rebuild. When a word is ambiguous, this file wins. Kept to definitions only — no specs.

### Vault
A collaborative container of documents + tasks + agent config, owned by the Syv server. Two kinds:
- **Personal vault** — owned by one user; only they have access. Still server-backed (D13).
- **Shared vault** — has a **membership** list with **roles**; multiple employees collaborate in real time.

A vault has a **folder hierarchy** (paths), a **task collection**, a **theme**, and an agent **persona** + shared config. Identity is server-assigned (not client-minted).

### Membership / Role
The access-control list on a shared vault. Roles: **owner** (full control + membership management), **member** (read + write), **viewer** (read-only). Enforced server-side, including on agent MCP ops.

### Document (Doc)
A single note. Internally a **Yjs CRDT**; the source of truth lives on the server. On each client it is **materialized** as a plain `.md` **working copy** on disk so the agent and editor can use it. Has a vault-relative **path** (e.g. `projects/q2/roadmap.md`).

### Working copy
The on-disk `.md` file that materializes a Doc on one client. Bridged bidirectionally to the CRDT (D2). Not authoritative, not version-controlled.

### File↔CRDT bridge
The per-client component that keeps a working copy and its Doc in sync: file change → diff → CRDT ops; CRDT change → re-materialize file. Must **diff**, never blind-replace.

### Relay
The Syv-hosted Yjs sync server (Hocuspocus). Holds durable CRDT truth, fans out updates, and carries the **awareness** (presence) channel.

### Snapshot
A server-side point-in-time state of a Doc's CRDT, forming its **history** timeline. Replaces git commits for versioning (D3).

### Task
A **structured server record** (not a file): `title, status, due, priority, tags, reminder, recurrence, related[], area`. Lives in a vault's task collection.

### Status
A task's state: **todo | doing | done**. (Old model's `todo | in_progress | done`, renamed for the stripped board.)

### Area
A **settable folder reference** on a task, naming the vault folder the task organizes under. Drives **swim lanes** on the board. A real field you can set/drag — **not** derived from a note (that was the old "phantom" `area`).

### Swim lane
A horizontal grouping of the task board by **area** (folder), with a configurable **lane depth** (how many path segments to group by).

### Related
The single unified list of a task's links (notes, other tasks, emails, events). Replaces the old four separate arrays (`related_tasks`/`related_nodes`/`related_emails`/`related_events`) and the special `source_file`.

### Reminder
A rule on a task that fires a notification: relative (**`Nd`** / **`Nw`** before due, at a 09:00 anchor) or absolute (`YYYY-MM-DDTHH:MM`). Evaluated **server-side** (D19), pushed to clients.

### Recurrence
A rule that rolls a completed recurring task forward to its next occurrence: `frequency (daily|weekly|monthly|yearly), interval, weekdays[], endDate`.

### Wiki-link
A path-based reference between docs: **`[[folder/note.md]]`** (optional `[[path|Label]]`). Human- and agent-readable. Rename rewrites them atomically server-side (D12).

### Agent / Vault assistant
The in-app **Claude Code** instance. Runs **client-side** as an interactive `claude` process in a **PTY**, shown in the **xterm drawer**. Operates on the local working copies with its native tools.

### xterm drawer
The popup terminal drawer in the client that renders the live interactive `claude` session. The **live** chat surface (vs the reconstructed **history** view).

### Persona
The shared vault-assistant identity: **SOUL.md** / **IDENTITY.md** + shared **AGENTS.md** (the user's "System") + shared skills. Tier-1 (D6).

### Config tiers
1. **Shared** — synced to all vault members (persona, skills, AGENTS.md, MEMORY.md, theme, notes, tasks).
2. **Per-user** — synced to one user across their devices, invisible to the team (personal tweaks, personal skills, USER.md, chat history, UI prefs).
3. **Local** — one machine (working-copy cache, offline queue).

### USER.md / MEMORY.md / AGENTS.md
- **AGENTS.md** — the user-authored "System" instructions for the vault assistant. Shared (tier-1).
- **MEMORY.md** — the vault's shared scratchpad memory. Shared (tier-1).
- **USER.md** — the agent's model of an individual user. **Per-user** (tier-2).

### MCP op
A typed tool the agent calls over the in-app MCP server for things that aren't plain files: **tasks, calendar, mail, note_rename, history search** (D10). Everything else is native Claude tools.

### Per-turn context
The fresh context (active note, linked tasks, memory fill-state) injected into every agent turn via a **`UserPromptSubmit` hook** (D8).

### History (chat)
The browsable, searchable record of past agent conversations, **reconstructed** from Claude's session JSONLs with AI **summaries**. Per-user (D9). Distinct from the live xterm drawer.

### Awareness / Presence
The Yjs channel carrying live per-user state: **cursors/selections** in the editor and **doc-viewer avatars** ("who's here").

### Typst export *(phase 2)*
Rendering a markdown doc into a branded **syv.ai Typst template** to produce a company-styled document.

### Client / Server / Shared (code)
- **Client** = `apps/desktop` (Electron + React).
- **Server** = `apps/server` (Hocuspocus + tRPC + Postgres).
- **Shared** = `packages/shared` (types, task model, wiki-link grammar, path-safety), imported by both.
