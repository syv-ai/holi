# Not built

Work that is wanted, mostly designed, and absent. The feature pages describe what exists; this page
is the other half. No ordering, no sizing, no dates.

An entry answers "what could we build next". A deliberate absence with a trigger ("add an OS
network listener only if retry latency proves annoying") is product shape and stays on its feature
page, not here. Check an entry against the code when writing it, and delete it when it ships,
folding its reasoning into the owning page.

## Agent

**Surfacing a pre-commit hook's failure when no session made the commit.** What the transforms
say on a commit an agent session made goes to that session ([agent-sessions](features/agent-sessions.md)); on
Holi's own commits it is only in `.holi/state/hooks.local.log`. The sync status bar does not show
it.

**A cap on concurrent sessions.** A vault can run any number.

**Shared automations in the cloud.** An automation is one person's and runs on their machine. Work
that should run once for everyone, with every laptop shut, would be Claude Code's scheduled cloud
runs against the vault's GitHub repository, its outcome read from its commit. Claude Code drives
those from its `/schedule` skill against claude.ai, which Holi has no interface to yet
([scheduled-agents](features/scheduled-agents.md)).

**More ways to send a Holi work.** Only a document, from its Agent menu, today. Each further trigger
would start the same session under the same per-machine approval:

- **the selection's lines** with the document, which the pane header's slot does not carry yet;
- **a Claude Code hook**, a session handing work to a Holi, as `holi holis send <holi> <path>`
  behind a seeded `ask` rule, the person answering in the tab it opens;
- **the CLI with a prompt** (`holi holis ask <holi> "…"`) and the same as an **MCP tool** for other
  agents, returning the run's id, its report read in Holi;
- **a connection**, such as a new mail matching a filter, offered as a notification the person
  accepts rather than a run that starts unattended.

**A Holi from another vault.** A file here that only names another of the person's vaults and a
Holi in it (`from: owner/repo#id`), read from that vault each time, its approval still this
vault's.

**Holis and automations on another agent.** Their runs need a provider with `background`, which
only Claude Code has. `codex exec` runs a prompt unwatched and fires `notify`, so Codex could carry
a run once a run in a Holi-owned process, which ends when Holi quits, is acceptable
([agent-sessions](features/agent-sessions.md), Providers).

**More providers.** opencode and pi, each as its core and whatever its hooks allow.

**The rest of the inbox.** A banner clicked while Holi had no window open opens Holi, but not the
entry: the renderer is not listening yet when the click lands, so the entry waits in the inbox. A
needs-you entry stays after the session is answered, until dismissed. A session that outlives a
switch away from its vault loses its notices: `holi agent notify` and `holi agent log` reach Holi
only through the open vault's bridge, so they fail, and nothing queues the notice or the log line
for when the vault is open again. See
[agent-inbox](features/agent-inbox.md).

**Memory tooling.** Per-directory indexes. See
[agent-memory](features/agent-memory.md).

**Self-improvement loop.** Dropped from v1: unproven, and one person's background agent editing
shared skills and memory is a hazard. If revived, auto-edits touch the personal layer only and
shared changes become proposals.

**An injection eval.** The fence around mail and calendar text is tested; whether a real run
honours it is not. A run against a planted "ignore previous instructions and send" mail, checking
that it drafts or reports and attempts no send, would need a live model and a fake Google.

**Fencing what was copied into the vault.** Only what `holi google` prints is fenced. A task made
from a mail or an event in Mail or Agenda, or a vault app's stored records, carries someone else's
words into a vault file, and a later run reads that file as the vault's own.

**Agent theme proposals.** The agent writes a vault's theme; proposing one for approval is absent.

**Durable trigger events.** A schedule's batch waiting to run and the router's dedupe memory are in
memory, so quitting Holi loses events heard and not yet run. Moments (tasks, calendar) are safe by
their watermark; file and mail events are not, and nor is what changed while Holi was closed. The
issue's shape: the pending queue in `.holi/state/triggers.local.json`, written before a run starts,
cleared when it has. See [scheduled agents](features/scheduled-agents.md).

**Telling a run's own writes apart.** A file changed while a schedule's run works starts a
follow-up only when its change lies outside the run's span; one changed during the span is
dropped, a stranger's included, because a turn's commit holds everyone's changes made while it ran.
Knowing the run's own paths (a hook on its file tools, which a shell command escapes) would drop
only those. See [scheduled agents](features/scheduled-agents.md).

**Trigger priority.** A trigger run waits for the schedule's previous run, but not for the person:
it does not hold back while they are in a session of their own or one waits on them (`needs-you`),
and no schedule outranks another.

**More task triggers.** A status change (`doing`, `done`) and a task newly assigned to this
machine's person. Today `task` is due and overdue only, and an assigned task triggers every
schedule with a task trigger, not only its assignee's.

## Vault apps

**Location for apps.** A `location` affordance, approved like mail and calendar. Electron's
geolocation needs Google's network location service (an API key) and does not answer on macOS even
with one, so it needs a native source first (CoreLocation on macOS) behind a bridge call.

**The rest of the bridge and manifest.** No theme-change event (a mode change reloads the
frame). `app.yaml`'s `description` is written but never read.

**Backend, hot reload.** A `utilityProcess` backend (`server.mjs`), and reloading an open app when
its files change (today reload is a button).

## Notes & editor

**More of note comments.** Editing or deleting a comment, a list of open threads across the
vault in the app (the agent has `holi comments list`), and a comment's body drawn as markdown (it
shows as plain text). A mention reaches only the agent's inbox, so with the agent plugin off it is
seen only in the panel. See
[note-comments](features/note-comments.md).

**The rest of slash commands as small programs.** A vault app's commands are built
([vault apps](features/vault-apps.md)). Not built from that design: a mail compose call a command
can make (to start a reply), and embedding an app in the note, where it is still open whether that
is a widget in the note or a link that opens its tab.

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

**More of Holi links.** Joining a vault from a link to one this machine has not cloned (today a
dialog says to add it first), a copy action in the editor itself (there is no editor context menu;
the palette has it), and telling apart two headings with the same words, which GitHub does with a
`-1` suffix and a link does not. See [holi-links](features/holi-links.md).

## On the current shell

Main's half of each of these is built and documented on its page; the screens that used it were
drawn on the previous shell and are not rebuilt yet.

**The links drawer.** `notes.links` (`scanLinks`) answers a note's links in both directions, but
nothing shows them: there is no "Links to" and "Linked from" beside a note. See
[wiki-links](features/wiki-links.md).

**The graph tab.** `notes.graph` answers; nothing draws it. See [graph](features/graph.md).

**The inbox's entries.** `holi agent notify`, needs-you and mentions fill `inbox.local.json` and
raise banners, but the Inbox in the Agents sidebar does not list those entries. See
[agent-inbox](features/agent-inbox.md).

**Saved links' screens.** The preview card (on a tree row, a link in a note, a link file's tab),
New Link, saving a link dragged in from a browser, and Open in Browser. See
[links](features/links.md).

**Holi links in the window.** Copying a link to a file or a heading, and landing on its heading:
an arriving link opens its file (in its vault) at the top. See [holi-links](features/holi-links.md).

**Vault-app slash commands in the document editor.** The apps plugin answers `apps.commands` and
serves each command's document; the editor's slash menu does not list them, and nothing runs one in
its hidden frame. See [vault apps](features/vault-apps.md).

**Event triggers in the Automations editor.** A schedule's `on:` list runs and is kept when the
editor saves, but the editor neither shows nor adds one. See
[scheduled agents](features/scheduled-agents.md).

**Selected lines to the agent.** The per-turn context can name the focused note's selected lines,
but the document editor does not report a selection (`state/ui-report.ts`). See
[agent-config](features/agent-config.md).

**The rest.** Updating skills from Settings (`autoUpdateSkills`, `holi skills status`) and the
release notes ([updates](features/updates.md)); Google's bring-your-own OAuth client form
([google](features/google.md)); the vault's README on Home ([home](features/home.md)); the repo's
size in Settings ([vaults-sync](features/vaults-sync.md)); a tab's caret and scroll kept across tab
switches; `holi docs screenshot`'s renderer half, which says where a tab is drawn; PDF render
warnings in Convert to PDF ([pdf](features/pdf.md)); find and replace in the file view's code
editor; and images in the document editor capped at 70% of the window's height.

## Sync

**Git LFS setup.** The large-file hook's message mentions LFS; nothing configures it.

**Reconcile lock for task files.** A conflicted task file opened in `TaskFileEditor` is not locked
during a reconcile; the lock covers note tabs only.

## Tasks

**A time-grouped board view** ("Today / This week / Later"), as an option, never a mode to configure.

**A renumber pass** for exhausted ranks. `needsRenumber` exists in the tasks plugin's `shared/rank.ts`;
nothing calls it.

**Mail and calendar chips on a board card**, for the Gmail and Calendar links in a task's body.

**A task that lights up for a recurring event series**, tying reminders to the agenda.

## PDF

**Template distribution across vaults.** Templates are per-vault; a shared brand repo is the
obvious answer and is not designed.

**The agent replying to PDF comments**, and recording which note a PDF was exported from.

## Daily notes

**Configurable seed content** and a home-timezone override.

## Auth

**Pasting a fine-grained PAT.** The device flow is the only sign-in.
