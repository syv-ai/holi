# Architecture

A map of how Holi fits together. Each section points at the pages that own the detail.

## 1. System shape

Holi is one desktop app. There is no server, no database and no hosted service.

```
┌──────────────────────── apps/desktop (Electron) ────────────────────────┐
│  Renderer (React, Jotai, CodeMirror)       Main (Node)                  │
│  editor · board · drawers · views          vault store (walk, watcher)  │
│              │                             sync engine (commit, pull,   │
│              │  tRPC over IPC                push, reconcile)           │
│  preload / contextBridge ◄──────────────── PTYs → `claude agents|attach`│
│                                            GitHub · Google · Typst      │
└────────────────────────────────────────────────────┬────────────────────┘
                                                     │ git over HTTPS, REST
                                                     ▼
                                          GitHub: the vault repo,
                                          collaborators, history

  ~/Holi/<owner>/<repo>            packages/shared
  the vault: a git clone           pure rules: paths, task files, wiki-links,
  of markdown files                dates, recurrence, themes, 3-way merge
```

**The filesystem is the truth.** The editor, the board, the file tree and the agent all read and
write the same files in one directory. Nothing is derived and stored elsewhere, so nothing can
disagree.

`packages/shared` holds the rules the app uses with itself and with the files on disk. It is a
separate package because its contents are pure and browser-safe, which keeps them testable without
Electron. `@holi/shared/path-safety-node` is the one Node-only entrypoint.

## 2. Build only what Claude Code does not do

The agent is Claude Code, unmodified. Holi adds no adapter layer and no prompt-building, and fixes
forward when a Claude Code release changes something. Users are developers: the raw terminal is the
interface, git is a tool they already know, and Claude Code is already installed and signed in. With
the vault being plain files in a git repo, the agent needs no Holi-specific operations at all.

## 3. Processes and the IPC seam

- **Main** owns everything with side effects: the filesystem, git, GitHub and Google calls, the
  vault store and watcher, sync, reminders, Typst and the Claude PTYs. It holds every credential.
- **Preload** is a narrow `contextBridge` adapter over `ipcRenderer`.
- **Renderer** is the React UI. It runs with `contextIsolation` and without Node, and never sees a
  token. It reaches main through a typed tRPC router (`src/main/router.ts`).

Across the seam a document is named by its vault-relative path, validated with `vaultRelPath`,
never by an absolute path or a generated id. A binary the renderer draws itself (a PDF) crosses as
bytes; `holi-vault://` serves `<img>` only. Vault-scoped stores (the tree, the task set) mount in the
app shell for the life of the active vault: a store loaded by whichever view reads it first cannot
tell "not loaded" from "empty", and the failure looks like data loss.

## 4. The vault

A vault is a GitHub repository cloned under a Holi-managed root, `~/Holi/<owner>/<repo>`. Its
identity is its remote. Holi never adopts a checkout the user maintains, because it commits on its
own and would trample WIP branches and staged changes.

- **Autosave commits** keep the working tree clean, so a pull can always merge.
- **Auto-push** sends them within seconds; ⌘S, a vault switch and quit commit and push at once.
- **Auto-pull merges, never rebases.**
- **A conflicting merge is aborted** at once, and the user may hand it to the agent to reconcile.

The file tree is a walk plus a watcher. Folders are real directories. A file with the `.local.`
marker is machine-local: it shows under _show hidden files_ and never syncs. A file changing under
an open editor (the agent, a pull, another window) is one event: a clean buffer reloads, a dirty one
takes a 3-way merge, and an overlap goes to reconcile.

See [vaults-sync](features/vaults-sync.md), [history](features/history.md),
[file-tree](features/file-tree.md), [settings](features/settings.md) and [auth](features/auth.md).

## 5. The agent

Every session is a Claude Code background session: the vault's supervisor runs it, its job
id names it, and it keeps running with no window open. Main opens terminals onto them in `node-pty`
PTYs (`claude agents` for the list, `claude attach <id>` for one session) with the vault clone as
cwd, and the renderer draws each in xterm as an ordinary tab. What a session is doing is read from
Claude Code itself (its session listing and turn hooks), never inferred from terminal output.

Each vault's agent gets its own `CLAUDE_CONFIG_DIR`, so it inherits the vault's committed `.claude/`,
`AGENTS.md` and `memory/`, not the machine's global config. Claude Code's own permission prompts
stay on. There is no MCP server: the agent uses its native tools plus small Holi CLIs (`holi`,
`holi-google`) that talk to main. Holi pauses sync while a turn runs and reviews a turn as the commit
range it produced.

See [agent-sessions](features/agent-sessions.md), [agent-config](features/agent-config.md) and
[agent-memory](features/agent-memory.md).

## 6. The pillars

| Page                                           | What it covers                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| [editor](features/editor.md)                   | CodeMirror live preview, tables, images, external writes, completion |
| [tabs-panes](features/tabs-panes.md)           | Panes, preview and pinned tabs, split panes, moving tabs             |
| [frontmatter](features/frontmatter.md)         | The frontmatter block and its typed rows                             |
| [wiki-links](features/wiki-links.md)           | Path-based links, rename, backrefs                                   |
| [tasks](features/tasks.md)                     | `task.*.md` files, the board, recurrence and reminders               |
| [daily-notes](features/daily-notes.md)         | Idempotent daily notes and their archive                             |
| [google](features/google.md)                   | Gmail and Calendar, per vault                                        |
| [pdf](features/pdf.md)                         | Typst export and the PDF viewer                                      |
| [vault-apps](features/vault-apps.md)           | Agent-authored apps in their own origin                              |
| [command-palette](features/command-palette.md) | Quick open and the one table of commands                             |
| [onboarding](features/onboarding.md)           | First run and adding a vault                                         |

## 7. State outside the repo

- `userData` holds the GitHub and Google tokens (encrypted with Electron `safeStorage`), the vault
  registry (which repos are added and where), each vault's agent config directory, the Google cache
  and the `holi` CLIs. It is a machine fact: a second laptop starts empty.
- Per vault, `.holi/settings/app.local.yaml` holds machine-local settings and the reminder
  watermark; `.holi/settings/app.yaml` holds the shared ones.
- Conversations are Claude Code's own transcripts, local to the machine that ran them.

## 8. Security boundaries

- **Path safety.** `packages/shared` rejects `..`, absolute paths and NUL, canonicalises through the
  closest existing ancestor and re-checks containment. It is the only thing between a path and the
  user's filesystem.
- **Renderer isolation.** No Node in the renderer, no token in the renderer.
- **Authorization is GitHub's**, at push time. Holi performs no permission checks of its own: a
  check running on the machine of the person it restricts is not a boundary.
- **The agent's trust boundary is repo access.** Members are trusted colleagues. A destructive git
  command is possible from the vault, and is bounded by Claude Code's permission prompts, a managed
  clone holding nothing else, and branch protection. Git is not blocklisted, because reconcile needs
  it. Prompt injection through shared content is an accepted residual risk.
- **Token scope.** A `repo` grant reaches every repo the user has. Mitigated by encrypting it with
  `safeStorage` and keeping it in main.
- **Untrusted HTML** (mail bodies, event descriptions) is sanitised and shown in a sandboxed frame
  that never gets `allow-scripts`; see [google](features/google.md).
- **Vault apps** run in their own `holi-app://` origin and cannot reach the agent surface; see
  [vault-apps](features/vault-apps.md). `holi-vault://` sends no CORS header, because a packaged
  renderer and an app frame share the `null` origin and the header's absence is what keeps apps out.
- **The renderer's CSP is not an XSS defence.** It omits `script-src` because Vite's dev preamble
  is inline, and a policy with `'unsafe-inline'` would look like protection while stopping nothing.

## 9. Build

`pnpm dev` runs the app and `pnpm --filter @holi/desktop build` builds it with electron-vite. There
is no packaging configuration yet, and no Docker, database or compose file.
