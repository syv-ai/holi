# Glossary

Canonical terms for the rebuild. When a word is ambiguous, this file wins. Kept to definitions only — no specs.

### Vault
A collaborative container of documents + tasks + agent config, owned by the Syv server. Two kinds:
- **Personal vault** — owned by one user; only they have access. Still server-backed.
- **Shared vault** — has a **membership** list with **roles**; multiple employees collaborate in real time.

A vault has a **folder hierarchy** (paths), a **task collection**, a **theme**, and an agent **persona** + shared config. Identity is server-assigned (not client-minted).

### Membership / Role
The access-control list on a shared vault. Two roles: **member** (read + write all content) and **owner** (member + vault administration: manage membership, transfer, delete, edit theme/settings). **No viewer/read-only role.** Enforced server-side, including on agent MCP ops.

### Document (Doc)
A single note. Internally a **Yjs CRDT**; the source of truth lives on the server. On each client it is **materialized** as a plain `.md` **working copy** on disk so the agent and editor can use it. Has a vault-relative **path** (e.g. `projects/q2/roadmap.md`).

### Working copy
The on-disk `.md` file that materializes a Doc on one client. Bridged bidirectionally to the CRDT. Not authoritative, not version-controlled.

### File↔CRDT bridge
The per-client component that reconciles **agent** file writes with a Doc's CRDT (human↔human editing is pure Yjs and never touches it). Turn protocol: soft lock + frozen **base** while the agent writes → `diff(base, file)` applied as positioned Yjs ops → re-materialize. Must **diff**, never blind-replace.

### Base
The last-materialized text of a Doc's working copy, frozen for the duration of an agent turn. The diff `base → file` is what the bridge merges into the live CRDT. (The git mirror uses the same concept server-side: its base is the last synced commit.)

### Relay
The Syv-hosted Yjs sync server (Hocuspocus). Holds durable CRDT truth, fans out updates, and carries the **awareness** (presence) channel.

### Snapshot
A server-side point-in-time state of a Doc's CRDT, forming its **history** timeline.

### Git mirror
The opt-in, server-side git clone of a vault, pushed to an **owner-provided GitHub repo** so Claude Code cloud sessions can work the vault remotely. The relay is the **only git writer**. It exports from **two sources** — notes (CRDT docs) and **tasks** (records) — and **ingests** foreign commits back, routing each path to the right store: a note becomes CRDT ops, a `tasks/**.md` file becomes a per-field patch on the record. Clients never carry `.git`.

### Task
A **structured server record** — `title, status, due, priority, tags, reminder, recurrence, related[], area` — living in a vault's task collection, and **projected into the vault as a file** (`tasks/<slug>-<id>.md`: YAML frontmatter + a markdown body that is the description). The record is the truth; the file is a live, writable view of it. See [`prd/tasks.md`](prd/tasks.md).

### Task file projection
The mechanism that makes a task look like a file. Record → file is a **rewrite** (the server rewrites the file on any change to the record, whoever caused it — so a task file *changes under you*, by design); file → record is a **per-field patch** (the same mutation the board calls). The file is never queried: nothing walks or parses `tasks/` to answer a question. Task files are **not CRDTs** — they are excluded from the doc path, because character-merging YAML can converge on invalid syntax with no writer able to reject it.

### ProjectionStore
The desktop's per-task record of *what it last rendered to disk* — the fields, and the **version token** of the record they came from. It is what an inbound file write is diffed against to produce a per-field patch, and it is where the concurrency token lives now that it is out of the file.

### Version token
A task's optimistic-concurrency integer, bumped on every mutation. It is **carried out-of-band, never in the file**: the desktop reads it from the [ProjectionStore](#projectionstore), and git ingress needs none at all (a commit carries its own base blob, which *is* its diff base). A stale token on a desktop file write means the write loses and the file is rewritten from truth. In the frontmatter it would have made every reminder fire rewrite — and, once mirrored, **commit** — a file just to change one integer.

### Status
A task's state: **todo | doing | done**.

### Area
A **settable folder reference** on a task, naming the vault folder the task organizes under. Drives **swim lanes** on the board. A real field you can set and drag between lanes.

### Swim lane
A horizontal grouping of the task board by **area** (folder), with a configurable **lane depth** (how many path segments to group by).

### Related
The single unified list of a task's links (notes, other tasks, emails, events).

### Reminder
A rule on a task that fires a notification: relative (**`Nd`** / **`Nw`** before due, at a 09:00 anchor) or absolute (`YYYY-MM-DDTHH:MM`). Evaluated **server-side**, pushed to clients.

### Recurrence
A rule that rolls a completed recurring task forward to its next occurrence: `frequency (daily|weekly|monthly|yearly), interval, weekdays[], endDate`.

### Wiki-link
A path-based reference between docs: **`[[folder/note.md]]`** (optional `[[path|Label]]`). Human- and agent-readable. Rename rewrites them atomically server-side.

### Agent / Vault assistant
The in-app **Claude Code** instance. Runs **client-side** as an interactive `claude` process in a **PTY**, shown in the **xterm drawer**. Operates on the local working copies with its native tools.

### xterm drawer
The popup terminal drawer in the client that renders the live interactive `claude` session — the chat surface, including history (via native `--resume`).

### Persona
The shared vault-assistant identity: **SOUL.md** / **IDENTITY.md** + shared **AGENTS.md** (the user's "System") + shared skills. Shared vault content.

### Config layering
Claude Code's native layering, unmodified:
1. **Shared** — the vault working dir's `.claude/`, `AGENTS.md`, `MEMORY.md`: sync because vault content syncs. CC picks them up from the cwd.
2. **Personal** — the user's own `~/.claude` + `CLAUDE.local.md` + `USER.md`: machine-local, never touched or synced by Holi.
3. **Holi app settings** — `.holi/settings.json` (vault-wide, synced) + `.holi/settings.local.json` (machine-local override) — the same shared/local convention CC itself uses.

Chat history and the working-copy cache are also machine-local, never synced.

### USER.md / MEMORY.md / AGENTS.md
- **AGENTS.md** — the user-authored "System" instructions for the vault assistant. Shared (vault content).
- **MEMORY.md** — the vault's shared scratchpad memory. Shared (vault content).
- **USER.md** — the agent's model of an individual user. **Personal, machine-local** (never synced).

### MCP op
A typed tool the agent calls over the in-app MCP server for things that aren't plain files. v1: **tasks + note_rename**; phase 2 adds **calendar + mail**. Everything else is native Claude tools.

### Per-turn context
The fresh context (active note, linked tasks, memory fill-state) injected into every agent turn via a **`UserPromptSubmit` hook**.

### History (chat)
Claude Code's **native session resume**: the drawer relaunches `claude --resume`, CC's own session picker, replaying the full transcript in the terminal. No custom reconstruction, no summaries, no sync — history lives on the machine that ran it, inside the terminal.

### Awareness *(notes)*
The **Yjs** channel carrying live per-user state on a CRDT doc: **cursors/selections** in the editor and **doc-viewer avatars** ("who's here").

### Presence *(tasks)*
A different mechanism for a different question: **"Nicolai is editing this task."** Tasks are records, not CRDTs, so they have no Yjs awareness. Presence is a short-TTL (10s) heartbeat delivered as a **`presence` frame on the vault's SSE connection** — a sibling of `docs`/`tasks`/`reminders`, deliberately **not** a `TasksEvent` variant (a third variant would fall into `TaskProjector`'s `else` branch and *delete the task's file*).

It is **fire-and-forget**: the server stores nothing, and **a heartbeat that stops arriving *is* the release** — which is exactly why tasks need no locks (no acquire, no TTL sweep, no stale holder, no steal path). **A user and their agent are one identity** — there is no `actor` field, because "Nicolai is editing this task" is true when Nicolai's Claude is editing it. (Contrast the drawer's *"Claude is editing…"*, which tells **you** what **your own** agent is doing to a doc in front of you; presence tells **someone else** that a task is in motion.)

### Vault app *(post-v1)*
An agent-authored interactive app living at `.holi/apps/<name>/` (manifest + `index.html` + optional `server.mjs`), synced as vault content, opened as a first-class tab in a sandboxed webview. State = a shared Yjs doc on the relay → live-multiplayer by default.

### holi bridge
The scoped postMessage API a vault app gets: `holi.data` (the app's shared Yjs doc), `holi.tasks`/`holi.docs` (membership-gated vault access), `holi.awareness`, `holi.open`, `holi.theme`.

### Typst export *(phase 2)*
Rendering a markdown doc into a branded **syv.ai Typst template** to produce a company-styled document.

### Client / Server / Shared (code)
- **Client** = `apps/desktop` (Electron + React).
- **Server** = `apps/server` (Hocuspocus + tRPC + Postgres).
- **Shared** = `packages/shared` (types, task model, wiki-link grammar, path-safety), imported by both.
