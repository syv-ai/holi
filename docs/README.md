# Holi docs

A registry of how Holi works and why. Each page is short and owns one subject; pages link to each
other rather than repeating each other.

## Foundation

| Page                            | What it is                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- |
| [vision](vision.md)             | What Holi is, its principles, and what comes after v1                       |
| [architecture](architecture.md) | A map of the system: processes, the vault, the agent, security              |
| [ui-system](ui-system.md)       | The renderer's component layers, tokens, focus, motion, drawers and theming |
| [glossary](glossary.md)         | Canonical terms; when a word is ambiguous, this wins                        |
| [not-built](not-built.md)       | Designed and wanted, but absent                                             |

## Features

| Page                                             | What it covers                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| [vaults-sync](features/vaults-sync.md)           | Managed clones, autosave commits, pull, push, reconcile, vault git hooks |
| [history](features/history.md)                   | A file's and a vault's history, and restoring from it                    |
| [settings](features/settings.md)                 | `.holi/settings/app.yaml`, its schema, the settings tab                  |
| [file-tree](features/file-tree.md)               | The tree, folders, hidden and local files, icons                         |
| [auth](features/auth.md)                         | GitHub sign-in, the token, collaborators, access                         |
| [editor](features/editor.md)                     | CodeMirror live preview, tables, images, external writes, completion     |
| [tabs-panes](features/tabs-panes.md)             | Panes, preview and pinned tabs, moving tabs                              |
| [frontmatter](features/frontmatter.md)           | The frontmatter block, typed rows, schemas                               |
| [wiki-links](features/wiki-links.md)             | Link grammar, rename, backrefs                                           |
| [tasks](features/tasks.md)                       | Task files, the board, dates, recurrence, reminders                      |
| [daily-notes](features/daily-notes.md)           | Idempotent daily notes and their archive                                 |
| [agent-sessions](features/agent-sessions.md)     | Claude Code background sessions, agent tabs, turn review, reconcile      |
| [agent-config](features/agent-config.md)         | Config layering, the per-vault silo, seeded files, tools, permissions    |
| [agent-memory](features/agent-memory.md)         | The vault's `.holi/memory/` directory                                    |
| [scheduled-agents](features/scheduled-agents.md) | Prompts Holi runs as agent sessions on a cron schedule, on this machine  |
| [google](features/google.md)                     | Gmail and Calendar per vault                                             |
| [pdf](features/pdf.md)                           | Typst export, templates, the PDF viewer                                  |
| [vault-apps](features/vault-apps.md)             | Agent-written apps in their own origin                                   |
| [command-palette](features/command-palette.md)   | Quick open and the one table of commands                                 |
| [nav-menu](features/nav-menu.md)                 | The morphing menu at the sidebar's foot, and Home                        |
| [onboarding](features/onboarding.md)             | First run, creating or joining a vault                                   |
| [updates](features/updates.md)                   | Releases from CI, and the app updating itself                            |

## Rules for these docs

- **Code is the authority.** A page describes what exists. Check the code, never the claim.
- **A page is current, not a history.** No dates, no changelog, no "was reversed". Git keeps the
  history.
- **What is absent goes in [not-built](not-built.md)**, and leaves it when it ships. A deliberate
  boundary with a reason stays on its feature page.
- **Rejected alternatives stay** beside the design that beat them, so nobody re-proposes them.
- **A decision goes straight into the page that owns it**, with its reason. Code comments say
  what they mean in words, or name the page, and never cite a decision number.
- **There is no server.** A page that implies one is stale.
