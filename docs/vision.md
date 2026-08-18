# Vision

## What Holi is

Holi is a document- and task-management system for individuals and small teams, featuring a claude code-based assistant. For Syv.ai, it is the infrastructure around a shared vault where the company's knowledge (contracts, project description, bids, exit report etc.) lives, gets written, and gets acted on. It is very similar to Obsidian in that it takes a GitHub-backed, markdown-native, local-first knowledge base approach, but meant to be collaborative by default and with an AI assistant (Claude Code or Claude Cowork) that actually lives in the vault.

Every vault is a GitHub repo, and auth and access rights work through GitHub. Every user of Holi can have n vaults, with each being a private repo that can be shared with other individuals. The foremost value of Holi is that teams can have shared vaults. 

For each vault, a user will be able to add integrations — most importantly a Google Drive mirror for documents, an important channel for Syv.ai. That integration is **deferred beyond v1** (see *Beyond v1*): adding an integration during the release whose purpose is trimming scope is how a release stops shipping.

An example of a shared vault (still work in progress and not refactored to work for Holi): https://github.com/syv-ai/1brain



## Key design choices

- The editor is CodeMirror 6 with live-preview (rendered as you type, raw when you click in).
- Markdown-native, path-based links. `[[folder/note.md]]` stays readable and portable — for humans and the agent.
- A vault assistant that reads and writes the vault like you do. The agent keeps its native file tools; it's just another collaborator in the doc.
- Each vault can have a .holi/.settings.json directory in which we store vault-level settings, and a .holi/.settings.local.json where we store local vault settings for only the user. Same pattern as is used for .claude. 
- **The vault is text-first by *authorship*, not by content.** Any file lives in a vault as an ordinary committed file, and binaries are **assets it holds and documents it emits** — an agent drafts markdown, the vault renders a branded PDF. Nothing is converted on the way in: forcing an incoming PDF through a lossy converter serves a direction the work does not flow in.

## Product principles

3. **The assistant is a peer, not a chatbot.** It runs *in* the vault, edits files like a teammate, shows up in presence, and asks in plain terms. It uses its native tools; we don't cage it behind a wall of custom ops.
4. **Simple by default, powerful on demand.** One obvious way to do the common thing (create a task, open a note, ask the assistant). Advanced configuration exists but never blocks the path.
7. **Don't fight the grain.** Lean on Claude Code's native behavior-
8. Every user is a a developer (the terminal is a natural interface, not a liability), and Claude Code is already installed and authenticated on their machines with their own accounts — Holi provisions nothing.

## The shape of v1

A signed-in employee opens Holi and sees their latest used vault. They open a shared vault. They hit ⌘J, the **assistant drawer** opens from the right with a live Claude session that can read and edit the vault. They flip to the **task board** — a clean Todo/Doing/Done board with swim lanes by folder — and drag a task to Doing. 

## Beyond v1

Two things that were on this list have shipped and now have PRDs of their own: **Gmail + Calendar** ([`prd/google-mail-calendar.md`](prd/google-mail-calendar.md)) and **branded PDF export via Typst** ([`prd/pdf-export.md`](prd/pdf-export.md)). What remains:

- PDF/docx preview in place
- Google Drive mirror for vault documents
- Agent-authored HTML apps/widgets
- An opt-in self-improvement loop scoped to personal memory.

See [`architecture.md`](architecture.md) for how it all fits together, and the PRDs in [`prd/`](prd/) for each pillar's full requirements and rationale.

## Deferred

- Two people can edit the same document at the same time, see each other's cursors, and watch the assistant work alongside them. Knowledge stops being trapped in one person's local folder. Git is not the right transmitter here. It will require us to have a server-backed host. 
- **Personal privacy inside shared spaces.** Your assistant's model of *you*, your chat history, and your personal tweaks follow *you* and stay invisible to the team — even in a vault everyone shares.