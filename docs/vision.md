# Vision

## What Holi is

Holi is **Syv.ai's document-management system and vault assistant** — the place where the company's knowledge lives, gets written, and gets acted on. It replaces reaching for Obsidian: a markdown-native, local-feeling knowledge base, but **collaborative by default** and with an **AI assistant that actually lives in the vault**.

Every employee has a **personal vault**. Teams have **shared vaults** — and shared vaults are the point. Two people can edit the same document at the same time, see each other's cursors, and watch the assistant work alongside them. Knowledge stops being trapped in one person's local folder.

## Why we're rebuilding

The current Holi is a genuinely good single-user app — a Tauri 2 (Rust + React) desktop client with a file-based vault, a file-based task system, git sync, and a headless Claude Code agent. But three forces make a rebuild, not an iteration, the right call:

1. **Shared vaults break the foundation.** The whole storage model is "a vault is a row in *my* local SQLite + a git repo I auto-commit to every 30 s and never pull from," with client-minted IDs and whole-vault link-rewrites on rename. The moment two people share a vault, that model produces constant divergence and merge conflicts. Real-time collaboration isn't a feature you bolt on — it's a foundation you build on. So the storage engine changes from **git-synced files** to **CRDTs over a Syv-hosted sync server**.

2. **Holi becomes part of Syv.ai officially.** That means real accounts (Google Workspace SSO), shared ownership, roles, per-user privacy inside shared spaces, and server-owned durability/backup — none of which the current local-only, auth-less app has.

3. **One language, one team.** Moving from Tauri (Rust backend + TS frontend, bridged by generated types) to a **full-TypeScript Electron + Node stack** with a shared domain package removes the Rust/TS seam, the codegen step, and the impedance between client and server — and lets the same people move fluidly across the whole system.

The rebuild also lets us **pay down the two biggest UX debts**: the task system (too many concepts, too much board configuration, a phantom `area`) and the agent's headless plumbing (brittle stream parsing, a large op surface) — both of which get radically simpler when we lean on what already works well: a real collaborative backend, and Claude Code's *native* interactive experience.

## What stays sacred

The rebuild is aggressive about the backend and the plumbing, and **conservative about what already delights**:

- **The editor.** CodeMirror 6 with live-preview (rendered as you type, raw when you click in) is the best part of Holi. It stays and gets **simpler** — the fragile animation layer that had grown out of shape is cut (D22) — while gaining multiplayer cursors.
- **Markdown-native, path-based links.** `[[folder/note.md]]` stays readable and portable — for humans *and* the agent.
- **The design system.** The `tone`/`variant`/`shape`/`size` primitive system and the token-driven typography stay intact.
- **A vault assistant that reads and writes the vault like you do.** The agent keeps its native file tools; it's just another collaborator in the doc.

## Product principles

1. **Collaboration is the foundation, not a mode.** One code path, real-time by default, presence everywhere. No "share" toggle that flips a different engine.
2. **Local-feeling, server-backed.** It should feel like editing local markdown — instant, offline-capable — while the server quietly owns truth, history, and sync.
3. **The assistant is a peer, not a chatbot.** It runs *in* the vault, edits files like a teammate, shows up in presence, and asks in plain terms. It uses its native tools; we don't cage it behind a wall of custom ops.
4. **Simple by default, powerful on demand.** One obvious way to do the common thing (create a task, open a note, ask the assistant). Advanced configuration exists but never blocks the path.
5. **Personal privacy inside shared spaces.** Your assistant's model of *you*, your chat history, and your personal tweaks follow *you* and stay invisible to the team — even in a vault everyone shares.
6. **Open-source, self-hosted, no lock-in.** Company knowledge lives on infrastructure Syv controls, built on OSS (Yjs, Hocuspocus, Postgres).
7. **Don't fight the grain.** Lean on Claude Code's native behavior, on CRDT auto-merge, on the platform — rather than reimplementing them behind bespoke layers.

## The shape of v1

A signed-in employee opens Holi and sees their vaults. They open a shared vault, start typing a note, and a colleague's cursor appears in the same paragraph. They hit a shortcut, the **assistant drawer** slides up with a live Claude session that can read and edit the vault; it shows up in the doc as another editor. They flip to the **task board** — a clean Todo/Doing/Done board with swim lanes by folder — and drag a task to Doing. A **daily note** is waiting for them. Everything they do syncs to their other devices and to their teammates in real time; their private assistant memory and chat history stay theirs.

That's v1. It proves the two hard things — **CRDT collaboration** and the **interactive vault assistant** — on top of a real product.

## Beyond v1

- **Phase 2:** PDF/docx preview → **Google Gmail + Calendar** sync (native to a Google-Workspace company) → **Typst export** (turn any doc into a branded syv.ai document).
- **Deferred:** agent-authored HTML apps/widgets; an opt-in self-improvement loop scoped to personal memory.

See [`decisions.md`](decisions.md) for the reasoning behind every major choice, and [`architecture.md`](architecture.md) for how it all fits together.
