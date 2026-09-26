# Vision

## What Holi is

Holi is a document- and task-management system for individuals and small teams, featuring a claude code-based assistant. For Syv.ai, it is the infrastructure around a shared vault where the company's knowledge (contracts, project descriptions, bids, exit reports) lives, gets written, and gets acted on. It is very similar to Obsidian in that it takes a GitHub-backed, markdown-native, local-first knowledge base approach, but meant to be collaborative by default and with an AI assistant (Claude Code or Claude Cowork) that actually lives in the vault.

Every vault is a GitHub repo, and auth and access rights work through GitHub. Every user of Holi can have n vaults, each a private repo that can be shared with other individuals. The foremost value of Holi is that teams can have shared vaults.

For each vault, a user will be able to add integrations, most importantly a Google Drive mirror for documents, an important channel for Syv.ai. That integration is deferred beyond v1.

An example of a shared vault (still work in progress and not refactored to work for Holi): https://github.com/syv-ai/1brain

## Key design choices

- The editor is CodeMirror 6 with live-preview (rendered as you type, raw when you click in).
- Markdown-native, path-based links. `[[folder/note.md]]` stays readable and portable, for humans and the agent.
- A vault assistant that reads and writes the vault like you do. The agent keeps its native file tools; it's just another collaborator in the doc.
- Each vault stores its shared settings in `.holi/settings/app.yaml` and the user's machine-local ones in `.holi/settings/app.local.yaml`. Same pattern as `.claude` uses.
- **The vault is text-first by _authorship_, not by content.** Any file lives in a vault as an ordinary committed file, and binaries are **assets it holds and documents it emits**: an agent drafts markdown, the vault renders a branded PDF. Nothing is converted on the way in, because a lossy converter serves a direction the work does not flow in.

## Product principles

3. **The assistant is a peer, not a chatbot.** It runs _in_ the vault, edits files like a teammate, and asks in plain terms. It uses its native tools; we don't cage it behind a wall of custom ops.
4. **Simple by default, powerful on demand.** One obvious way to do the common thing (create a task, open a note, ask the assistant). Advanced configuration exists but never blocks the path.
5. **Don't fight the grain.** Lean on Claude Code's native behavior.
6. Every user is a developer (the terminal is a natural interface, not a liability), and Claude Code is already installed and authenticated on their machines with their own accounts. Holi provisions nothing.

## The shape of v1

A signed-in employee opens Holi and sees their latest used vault. They open a shared vault. They hit ⌘J and a live Claude session opens in a tab, able to read and edit the vault. They flip to the **task board**, a clean Todo/Doing/Done board with swim lanes by folder, and drag a task to Doing.

## Beyond v1

- Google Drive mirror for vault documents
- Previewing a `.docx` in place
- App **widgets embedded in a note**. The apps themselves are built; putting one inside the editor is deliberately not, so the editor stays lean
- An opt-in self-improvement loop scoped to personal memory

## Deferred

- Two people can edit the same document at the same time, see each other's cursors, and watch the assistant work alongside them. Knowledge stops being trapped in one person's local folder. Git is not the right transmitter here. It will require a server-backed host.
- **Personal privacy inside shared spaces.** Your assistant's model of _you_, your chat history, and your personal tweaks follow _you_ and stay invisible to the team, even in a vault everyone shares.
