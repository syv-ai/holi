# Decisions

Code comments and commit messages cite decisions by number. This page says what each number
decided and which page now holds it. The pages carry the reasoning; the numbers live only here, in
code and in git history (`git log -p docs/decisions.md` has every original write-up).

A new decision gets the next free number, a line here, and its substance written straight into the
page that owns it. **Next free: D111.**

## D60 onward

| #    | Decided                                                                             | Lives in                                                                     |
| ---- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| D60  | The vault is a GitHub repo; there is no server                                      | [architecture](architecture.md), [vaults-sync](features/vaults-sync.md)      |
| D61  | Push is automatic: a coalescing timer plus leave points, no Publish                 | [vaults-sync](features/vaults-sync.md)                                       |
| D62  | Text-first by authorship: binaries are assets a vault holds and documents it emits  | [vision](vision.md), [editor](features/editor.md), [pdf](features/pdf.md)    |
| D63  | Moving a task between lanes is a note-style rename                                  | [tasks](features/tasks.md)                                                   |
| D64  | A vault's theme is a whitelisted token map, read as data                            | [ui-system](ui-system.md)                                                    |
| D65  | Local-ness is the `.local.` marker and nothing else                                 | [file-tree](features/file-tree.md), [agent-config](features/agent-config.md) |
| D66  | PDF templates live in `.holi/document-templates`                                    | [pdf](features/pdf.md)                                                       |
| D67  | One main-held Google connector; the agent reaches it through a CLI, not MCP         | [google](features/google.md)                                                 |
| D68  | Mail is read-write within a bounded set of actions                                  | [google](features/google.md)                                                 |
| D69  | A cached list is keyed by every filter that narrows it                              | [google](features/google.md)                                                 |
| D70  | The agent may do anything the user can undo; sending asks first                     | [google](features/google.md), [agent-config](features/agent-config.md)       |
| D71  | The mail composer's source is markdown                                              | [google](features/google.md)                                                 |
| D72  | A vault agent inherits the vault, not the machine                                   | [agent-config](features/agent-config.md)                                     |
| D73  | A mail thread and a calendar event are joined by the invite's UID                   | [google](features/google.md)                                                 |
| D74  | A vault app is bounded by its own origin and barred from the agent surface          | [vault-apps](features/vault-apps.md)                                         |
| D75  | A managed file Holi wrote is refreshed, not frozen                                  | [agent-config](features/agent-config.md)                                     |
| D76  | Vault git hooks are a managed capability: Holi ships the code, the vault enables it | [vaults-sync](features/vaults-sync.md)                                       |
| D77  | A document lives in exactly one pane                                                | [tabs-panes](features/tabs-panes.md)                                         |
| D78  | A tab is dragged, and a drag only offers what it can do                             | [tabs-panes](features/tabs-panes.md)                                         |
| D79  | A task's dates are stamps you pick, not a grammar you type                          | [tasks](features/tasks.md)                                                   |
| D80  | An app's state is declared per app; sensitivity is a location                       | [not-built](not-built.md) (agreed, not built)                                |
| D81  | A slash command is a small program in the apps sandbox                              | [not-built](not-built.md) (agreed, not built)                                |
| D82  | File icons are a vault-level map, not a property of a file                          | [file-tree](features/file-tree.md)                                           |
| D83  | The tab strip scrolls and counts what is off each edge                              | [tabs-panes](features/tabs-panes.md)                                         |
| D84  | A tab reorder is shown by opening a hole                                            | [tabs-panes](features/tabs-panes.md)                                         |
| D85  | A vault says what it opens on, and is asked at birth                                | [settings](features/settings.md), [daily-notes](features/daily-notes.md)     |
| D86  | Each vault's agent runs on its own config directory                                 | [agent-config](features/agent-config.md)                                     |
| D87  | A vault's Google account is its own                                                 | [google](features/google.md)                                                 |
| D88  | An agent turn is a commit range                                                     | [agent-sessions](features/agent-sessions.md)                                 |
| D89  | The vault remembers in `memory/`, one fact per file                                 | [agent-memory](features/agent-memory.md)                                     |
| D90  | Skipped, never spent                                                                |                                                                              |
| D91  | Live preview reveals the element, not the line                                      | [editor](features/editor.md)                                                 |
| D92  | A heading's `#` slides                                                              | [editor](features/editor.md)                                                 |
| D93  | A table cell is styled by a highlight style, not decorations                        | [editor](features/editor.md)                                                 |
| D94  | A note gets frontmatter however it arrived                                          | [frontmatter](features/frontmatter.md)                                       |
| D95  | Settings are a tab, and the ritual asks a subset                                    | [settings](features/settings.md)                                             |
| D96  | A task's detail view is the task file; frontmatter is typed rows                    | [frontmatter](features/frontmatter.md), [tasks](features/tasks.md)           |
| D97  | A setting is declared once, and its file explains itself                            | [settings](features/settings.md)                                             |
| D98  | Motion is four named behaviours from one vocabulary                                 | [ui-system](ui-system.md)                                                    |
| D99  | There is one completion popup, and it is Holi's                                     | [editor](features/editor.md)                                                 |
| D100 | A vault runs several agent sessions                                                 | [agent-sessions](features/agent-sessions.md)                                 |
| D101 | A session's state is read from Claude Code (its tab half: see D110)                 | [agent-sessions](features/agent-sessions.md)                                 |
| D102 | One table of commands behind keys, menu and palette                                 | [command-palette](features/command-palette.md)                               |
| D103 | A PDF opens in a tab, and a mark is saved into the file                             | [pdf](features/pdf.md)                                                       |
| D104 | Signatures in the PDF viewer                                                        | [pdf](features/pdf.md)                                                       |
| D105 | A PDF's marks can be made read-only                                                 | [pdf](features/pdf.md)                                                       |
| D106 | PDF comments reach the agent through the `holi` CLI                                 | [pdf](features/pdf.md), [agent-config](features/agent-config.md)             |
| D107 | An app is a `.app` bundle anywhere in the vault, named by its path                  | [vault-apps](features/vault-apps.md), [file-tree](features/file-tree.md)     |
| D108 | The sidebar ends in one morphing nav menu; Home is a tab                            | [nav-menu](features/nav-menu.md)                                             |
| D109 | Leave drops your access, Delete happens on GitHub; stuck work blocks both           | [vaults-sync](features/vaults-sync.md)                                       |
| D110 | A session is a Claude Code background session; a Holi tab is a terminal onto it     | [agent-sessions](features/agent-sessions.md)                                 |

## D1 to D59

Decisions from the server and CRDT architecture that D60 replaced. They are superseded as a set.
The ones still cited in code, and what survives of each:

| #   | Decided                                                         | What survives                                                                    |
| --- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D1  | Storage and sync over a CRDT relay                              | Nothing; replaced by D60                                                         |
| D12 | Wiki-links are path-based                                       | [wiki-links](features/wiki-links.md)                                             |
| D19 | Recurrence math ported from the old service                     | [tasks](features/tasks.md)                                                       |
| D22 | Keep simple live preview, cut the animation layer               | [editor](features/editor.md), narrowed by D91 and D92                            |
| D27 | Stable ids for machines, paths for prose                        | Paths only; a task is a file ([wiki-links](features/wiki-links.md))              |
| D41 | `overdue` and `p1`–`p3` are computed labels, never stored       | [tasks](features/tasks.md)                                                       |
| D44 | The client passes its local date; nothing else computes "today" | [daily-notes](features/daily-notes.md)                                           |
| D45 | A server index made daily notes unique                          | Replaced by deterministic path and seed ([daily-notes](features/daily-notes.md)) |
| D46 | Select by an explicit marker, never by filename shape           | [daily-notes](features/daily-notes.md)                                           |
