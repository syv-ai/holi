# Glossary

Canonical terms. When a word is ambiguous, this file wins. Definitions only.

### Vault

A GitHub repository, cloned locally, holding markdown documents, tasks and agent config. Its
identity is its remote (`owner/repo`); there is no vault id. A **personal vault** has one
collaborator, a **shared vault** several.

### Managed vault root

`~/Holi`, the directory Holi clones into as `~/Holi/<owner>/<repo>`. Not user-configurable;
`HOLI_VAULT_ROOT` overrides it for development and tests. Holi never adopts a checkout made
elsewhere.

### ActiveVault

The one open vault as a live object in main: its git handle, watcher, cached snapshot and sync
timers. Replaced on vault switch, torn down on quit. Not called a "vault session", because a
**session** is an agent session (below).

### Membership

The repo's GitHub collaborator list. Holi defines no roles and enforces no access control; GitHub
does, at push time.

### Document

A `.md` file in the vault, named by its vault-relative path. The file is the document.

### Task

A file named `task.<name>.md` in the folder it is about. Frontmatter carries `status`, `start`,
`due`, `priority`, `estimate`, `tags`, `assignees` (GitHub logins), `reminder`, `recurrence`; the
body is the description. The path is its identity
and the filename prefix is what makes it a task. See [tasks](features/tasks.md).

### Lane

A task's containing folder, derived and never stored. The board groups by it; moving a task between
lanes moves the file.

### Status

A task's state: one of the vault's statuses in `.holi/statuses.yaml`, by default `backlog`,
`todo`, `doing`, `review` or `done`. Each has a **category** (`backlog`, `unstarted`, `started`,
`review`, `completed`) that says what it means; a task is **open** unless its status is
`completed`. See [planning](features/planning.md).

### Project

The vault itself, seen as one ongoing piece of work: `.holi/project.md` holds its name, status,
lead, dates, milestones and About. There is one per vault. See [planning](features/planning.md).

### Autosave commit

A local commit made when editing goes idle, or on ⌘S. It keeps the working tree clean so a pull can
always merge, and pushes within seconds. See [vaults-sync](features/vaults-sync.md).

### Flush

Writing a dirty buffer to disk, which comes before the commit. **Dirty buffer**: the editor holds
text the file does not; only a flush fixes it, and it is the only state that can lose data. **Dirty
tree**: the file holds text the last commit does not; an autosave commit fixes it. The renderer
flushes and main commits. Blur and tab close flush; ⌘S, a vault switch and quit flush, commit and
push at once.

### Push

Sending local commits to the remote. Automatic, on a short coalescing timer, and at once on ⌘S, a
vault switch or quit. There is no publish step.

### Reconcile

The conflict path. A pull that conflicts is aborted at once, leaving a clean tree, and a banner
offers **Ask Claude to reconcile** (named for the running agent, and offered only while one runs),
which pauses autosave, re-runs the merge and hands it to an agent session.

### 3-way reload

What the editor does when its file changes on disk. A clean buffer reloads; a dirty buffer takes a
text 3-way merge whose **base** is the text the editor last loaded or saved; an overlap goes to
reconcile.

### Wiki-link

`[[folder/note.md]]`, optionally `[[path|Label]]`. The only link grammar, for notes and tasks alike.
Renaming a file rewrites inbound links. See [wiki-links](features/wiki-links.md).

### Reminder

A task frontmatter value that fires a local notification: always an absolute moment, which the
date picker can compute relative to `due`. Evaluated by the running app; missed fires catch up on launch. The delivered
watermark is machine-local, so a fire never makes a commit.

### Recurrence

A rule that rolls a completed task forward to its next occurrence by rewriting its file.

### Agent

Claude Code, run by the vault's own Claude Code supervisor, with the vault clone as its cwd. "The
agent" is the set of a vault's sessions.

### Session

One Claude Code background session in a vault, named by its job id: one conversation, run
by the supervisor whether or not a window shows it. Holi's **agent tabs** are terminals onto
sessions: the agent list, or one session attached. Its name and its state (`needs-you`, `working`,
`idle`) come from Claude Code itself. Closing a tab detaches; Stop, a vault switch or quitting stops
it, and it stays in the agent list. See [agent-sessions](features/agent-sessions.md).

### Schedule

Also **automation**. A file in `.holi/schedules/` whose frontmatter says when (`cron`, one or more,
or `at`, local time), which Holi carries it out (`holi`) and what the run may do without asking,
and whose body is a prompt. Holi starts it as a session at those times
while the vault is open, on a machine that turned it on: **on** approves its current prompt, model
and `allow` list and its Holi's soul and rules, and any change to those reads **changed** until
approved again. See
[scheduled-agents](features/scheduled-agents.md).

### Holi

An agent that belongs to the vault: a folder in `.holi/holis/` with a name and a face
(`holi.yaml`), a **soul** (`SOUL.md`, its standing instructions) and a **memory** (`MEMORY.md`, dated
facts its runs keep), the documents it takes and what it may do without asking. A person sends it a
document from the menu beside the document's Agent button, or gives it **habits**: automations that
name it. The first run on a machine, and the first after its soul or rules changed, asks that
machine's person to approve it. See
[holis](features/holis.md).

### Ask

Text sent from Holi to a session (a selection, a task, a mail thread). It lands in the input as a
bracketed paste with no Enter, so Holi never submits a draft the user was typing. A reconcile or a
stuck push is the exception: it submits its instruction as the first turn of its own session.

### Provider

A coding agent Holi can run a session in: Claude Code or Codex. Its core is the command a terminal
runs; what else it can do (sessions its own supervisor runs, hooks that report turns, a context
reading) are its capabilities, and the UI offers only what a session's provider has. See
[agent-sessions](features/agent-sessions.md), Providers.

### Session Holi runs

A session of a provider with no supervisor of its own (Codex): its CLI in a PTY Holi owns, named by
Holi's id (`p` and twelve hex digits), alive as long as that process. Its turns are read from its
hooks and its terminal's signals, never its text.

### Agent surface

The files that configure the agent rather than hold content: `AGENTS.md`, `CLAUDE.md`, `.holi/memory/`,
`.holi/schedules/`, `.holi/holis/`, `USER.local.md`, and all of `.claude/`. Writing them changes what the agent does next, so anything
less trusted than the user (a vault app, a hook) is kept off them.

### Local file

Any file with `.local.` in its name, or anything under a folder with `.local.` in its name, and
any secret file: `.env`, `.env.<x>`, `.secrets` or `.secrets.<x>`, in any folder.
Machine-local: shown under _show hidden files_, never synced. The path is the whole rule.

### Secret file

A `.env`, `.env.<x>`, `.secrets` or `.secrets.<x>`: a local file no capability may read. A vault app
gets one of its values only by declaring the name under `env` in its `app.yaml` (`holi.env`), from
the vault root's `.env` with `.env.local` winning.

### Vault app

A web app the agent writes as a `<name>.app` folder anywhere in the vault, opened as a tab in its
own origin and reaching the vault only through the `holi.*` bridge. See [vault-apps](features/vault-apps.md).

### Community plugin

A plugin from another repository, with a `holi-plugin.json` at its root or in a folder named after
it (a repository can hold several): installed on this machine, run as its
own process, and opening the files it names in a tab framing its local server. See
[community-plugins](features/community-plugins.md).

### Pin

A vault's record of the community plugin it uses, `.holi/plugins/<id>/manifest.json`: the manifest
plus the repository, the plugin's folder in it and the commit every member is offered.

### Per-turn context

What the `UserPromptSubmit` hook adds to every prompt: the note focused in the editor, and nothing
else the agent could find itself.
