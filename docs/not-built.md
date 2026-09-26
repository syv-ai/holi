# Not built

Work that is wanted, mostly designed, and absent. The feature pages describe what exists; this page
is the other half. No ordering, no sizing, no dates.

An entry answers "what could we build next". A deliberate absence with a trigger ("add an OS
network listener only if retry latency proves annoying") is product shape and stays on its feature
page, not here. Check an entry against the code when writing it, and delete it when it ships,
folding its reasoning into the owning page.

## Agent

**Telling a live session something unprompted.** Holi has no channel into a running Claude Code
session except its PTY, where anything written lands in the user's input box. The pre-commit
transforms wanted to tell the agent what they rewrote: the runner supports a `notify` callback and
main leaves it unwired. The substitute is `.holi/state/hooks.local.log`, which the agent reads when
asked. Also absent: surfacing a hook failure in the sync status bar when no session is open.

**A cap on concurrent sessions.** A vault can run any number.

**Memory tooling.** Lint findings as proposals, a graph view, and per-directory indexes. See
[agent-memory](features/agent-memory.md).

**Self-improvement loop.** Dropped from v1: unproven, and one person's background agent editing
shared skills and memory is a hazard. If revived, auto-edits touch the personal layer only and
shared changes become proposals.

**Agent theme proposals.** The agent writes a vault's theme; proposing one for approval is absent.

## Vault apps

**App state.** Agreed design: state is per app and declared in `app.yaml`. `state: local` is a
SQLite database under `userData` with a path and size cap in the manifest, never in the repo, and is
the default (a finance app's data belongs nowhere near git). `state: shared` is a committed text
file (JSON or NDJSON) in the app's folder, because text merges and diffs where a committed database
cannot. Sensitivity is a location, not a cipher: with no server there is no key distribution, so
encrypting shared state protects against nobody. Open: whether shared state is written like a
document (last writer wins) or a log (merge keeps both). Until this lands there is no `holi.data`
and no bridge write, and a retro board or a poll cannot be built.

**The rest of the bridge and manifest.** `holi.open` opens a vault path as a note, so it cannot
open another app, even by its bundle path. No `holi.tasks` writes or subscriptions, no theme-change
event. `app.yaml`'s `description` is written but never read.

**Backend, personal apps, hot reload.** A `utilityProcess` backend (`server.mjs`), personal apps in
`userData/apps/`, and reloading an open app when its files change (today reload is a button).

## Notes & editor

**Slash commands as small programs.** Agreed design: a command is a small JS module the vault
commits, run in the same isolated origin vault apps use, handed the buffer and selection and
returning text or an action. It gets `fetch`, the vault actions apps have, an agent query and a mail
compose call; no filesystem, shell or Node. Real scripts were rejected because a committed command
is code that arrives on a teammate's laptop with a pull. Machine-local-only commands were rejected
because the agent could not write one for the team. Today the menu is a fixed `/todo` and `/table`.

**Standard markdown links instead of wiki-links.** In-vault links are `[[path]]`. Plain
`[text](path.md)` would render on GitHub and is what every tool and agent already knows. The cost:
the editor's link chips, `@` completion, the relink transform and backrefs all move grammar,
existing links need a one-time rewrite, and a relative link breaks when its source file moves where
a vault-rooted `[[path]]` does not. Undesigned.

**Live preview inside an unfocused table cell.** Cells read as prose (bold, code, links coloured),
but a wiki-link is not a chip and an image is not drawn. `codemirror-markdown-tables` renders an
unfocused cell itself from a highlighter, with no decorations, and everything live preview does
beyond colour is a decoration. Fixing it means patching the package or owning the table widget.
Worth it only if tables become a common place for links.

**A binary with an unknown extension opens as text.** A `.ttf` shows as replacement characters and
looks like corruption. Probably a byte sniff rather than a longer extension list.

**Viewing a `.docx` in place.** It gets a typed placeholder. Revealing it in Finder may be the whole
feature.

**Importing a folder** from Finder is refused; recursing means deciding collisions for a whole tree.

**Dragging a tree row out to Finder.** `webContents.startDrag` starts, but Finder refuses the drop.
Copy to Folder and Move to Folder cover the need.

**Tabs.** Dragging a tab to a new window or another vault, and vertical splits.

## Sync

**Git LFS setup.** The large-file hook's message mentions LFS; nothing configures it.

**Reconcile lock for task files.** A conflicted task file opened in `TaskFileEditor` is not locked
during a reconcile; the lock covers note tabs only.

## Tasks

**A time-grouped board view** ("Today / This week / Later"), as an option, never a mode to configure.

**Assignees**, and with them per-person reminders on shared tasks. This is the answer if vault-wide
reminders prove noisy, not a private reminder channel.

**A renumber pass** for exhausted ranks. `needsRenumber` exists in `packages/shared/src/rank.ts`;
nothing calls it.

**Mail and calendar chips on a board card.** `GoogleLinkChips` exists and is never rendered.

**A launch-at-login toggle** after the first-launch prompt.

**A task that lights up for a recurring event series**, tying reminders to the agenda.

## PDF

**Mermaid in a PDF.** A mermaid fence draws in the editor and exports as a code block. The export
paths differ in DOM: `ConvertToPdf` runs in the renderer, the agent's `md-to-pdf` skill shells
`typst` with no DOM. Pre-rendering in the renderer fixes one path only; an offscreen window in main
behind the `holi` CLI fixes both and costs the most; not rendering mermaid in PDFs at all keeps one
story. Undecided.

**Note-relative images in a PDF.** cmarker resolves them against its own package directory, so
only absolute image paths export.

**Template distribution across vaults.** Templates are per-vault; a shared brand repo is the
obvious answer and is not designed.

**The agent replying to PDF comments**, and recording which note a PDF was exported from.

## Daily notes

**Configurable seed content** and a home-timezone override.

## Auth

**Pasting a fine-grained PAT.** The device flow is the only sign-in.
