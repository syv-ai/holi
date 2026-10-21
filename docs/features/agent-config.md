# Agent config

What a vault agent knows and can reach. Holi builds no prompt and no tool server: the agent is plain
Claude Code, configured by files in the vault and by a config directory Holi keeps for that vault.
Holi's job is to seed those files, keep them current, and keep the machine's own config out.

## How it works

**A config directory per vault.** Every `claude` Holi runs sets `CLAUDE_CONFIG_DIR` to
`userData/agent-config/<slug>/`, where the slug is the sanitised remote plus 8 hex of its sha1 (the
sanitised half alone is not unique). The machine's `~/.claude` (global settings, skills, plugins,
marketplaces, MCP servers) is excluded by construction, and one vault's plugins never reach another.
It is also the key of the vault's Claude Code supervisor, so the agent list shows that vault's
sessions only. Holi creates the directory when it opens the vault and merges into its
`settings.json`: `disableClaudeAiConnectors` (only when absent), `theme` (dark or light, from the
app's resolved colour mode) and an `env` block with Holi's static paths (`HOLI_BIN`), the one
channel that reaches every background session. It
removes the `statusLine` older versions installed. A theme change reaches a running session on
**Restart** (`claude respawn`).

**Where a session finds Holi.** Not in this directory, and not in the environment: a background
session's environment is its supervisor's, which may predate this Holi. Every command and hook
walks up from its current directory to the folder holding `.holi/vault` and reads
`.holi/state/bridge.local.env` there (mode 0600), written whole each time Holi opens the vault
and deleted when it leaves: the bridge's port and the vault's token. It is a map each part of Holi contributes to
(`bridgeEnv.contribute`), and it is parsed key by key, never sourced, because a collaborator
could force-add one. `CLAUDE_CONFIG_DIR` stays the agent's config silo only.

**Sign-in is lazy.** Credentials are keyed to the config directory, so each vault needs its own
`/login`. The first terminal Holi opens on a directory writes a `.holi-spawned` marker and prints a
notice into its scrollback. Holi never reads Claude Code's sign-in state. A leftover shared
`agent-config/` is renamed whole into the slot of the vault whose path appears in its
`.claude.json` `projects{}`.

**Shared layer, committed.** `.claude/` (settings, hooks, skills), `AGENTS.md` (the vault's
instructions, which Claude Code reads natively, so no `CLAUDE.md` is seeded), and `.holi/memory/`
([agent-memory.md](agent-memory.md)). Claude Code reads them from the cwd. **Personal layer:**
`CLAUDE.local.md` and anything `*.local.*`, gitignored. A session reads `.claude/settings.json`,
`CLAUDE.md` and `AGENTS.md` when its process starts, so a change reaches it on Restart; hooks and
skills are re-read per use.

**Per-turn context is a line or two.** The `UserPromptSubmit` hook prints `Focused note: <path>` from
`.holi/state/context.local.json`, with `(selected lines 12-18; ...)` when text is selected in it,
which main keeps current from the renderer's one report of what the person is looking at
(`ui.report`: the focused note and its selected lines, the open ones, the recents), the same report
`holi vault recents` answers from. A selection is the primary selection's line numbers only, 1-based
and inclusive as `Read` numbers them, never its text: the agent reads the lines from the file, and
nothing a person selected is written to disk. A caret is no selection, and a selection that ends at
the start of a line (a triple-click, `Mod-L`) does not count that line. The renderer reports a selection once it has
held still for a moment, and only when its lines change, so typing reports nothing. The editor that
last changed its selection owns it, and it outlives that editor's unmount, so a selection still
counts while the person types to the agent in the same pane; a vault switch clears it. Tasks, backlinks and sync state the
agent finds itself with `Glob`, `grep` and `git`. The line carries no time or count, so the same
focus and selection print the same bytes and do not break the prompt cache.

The second line is what changed since the session's last turn that the session did not change:
`Changed since your last turn, not by you: <paths> (git diff <sha> shows how)`. The hook finds the
session's newest record in `.holi/state/turns.local.json` by its job id (the name of
`$CLAUDE_JOB_DIR`, as the turn hooks send it) and diffs that record's `end` against the working
tree as it stands, written as a tree object through a scratch index so the real one is untouched:
commits since then (autosave makes most edits commits) and work not yet committed alike. That is
the user's edits, a pull, or another session's turn, which is why it says "not by you" rather than
naming who. A turn that ends while another session's is still running cannot have a settle commit
yet, so its record ends at the same kind of tree, taken as it ends; its own uncommitted edits are
then never reported back to it. What the user edits during the session's own turn lands in that
turn's settle commit and is not reported either. Ten paths at most, then `and N more`;
`.holi/state/`, `.local.` and secret files are left out, and a name a code span cannot hold is
quoted instead. A session with no recorded turn, an unreachable `end`, or a vault opened outside
Holi prints nothing. The hook is a shipped one, so a vault created before it gets it with
`holi skills update`.

**Showing a file.** `holi docs open <path>` opens a note, task, PDF, vault app or any file the
vault's snapshot holds in a pinned tab, so the agent can say "here it is" rather than "go to X".
When the agent's tab is the active one, the file opens in the pane beside it, or a new pane, so the
agent stays in view. It refuses a secret file and `.holi/state/`, so a prompt-injected agent cannot
put a token on screen. It is the CLI door only (an app has `holi.open`), it opens only into the vault Holi is showing (an agent
session outlives a vault switch, and its open must not switch the person away), and it brings the
window forward. Main asks the renderer over one push, `vault:open`, the same one a clicked
reminder uses; the renderer switches vault when the path lives elsewhere and opens it through
`openPathAtom`.

**Seeding.** `ensureSeeded` runs on create, adopt and every open, over a list of seed
contributions: core (`main/vault/seed/core.ts`), and each plugin the vault
enables (`src/plugins/<id>/main/`, through `main/plugin-host/`), the agent's included
(`src/plugins/agent/main/claude/`). The agent's contribution owns `.claude/`: while the agent is
off, no plugin's file or settings fragment under it is written, and turning the agent on seeds
them once, recorded in the seed state as `<plugin>@agent`. Each keeps its files as real files under `vault/once/` and `vault/shipped/`
beside its module, at their vault path, read in through `import.meta.glob` (binaries such as the
brand fonts as `?inline` bytes). A path belongs to one contribution. Merged files go first, so
core's `.gitignore` gets its `*.local.*` line, line-wise, before anything else is written. Then:

- **Once files**: `AGENTS.md`, `.holi/memory/index.md`, `.holi/vault`,
  `.holi/settings/app.yaml` and `app.local.yaml`, `theme.css`, `theme.local.css`, `icons.yaml`
  (core), `.holi/document-templates/**` (PDF). Created if absent, then the user's.
- **Shipped files**: `.claude/hooks/**` and `.claude/skills/**` (the agent; PDF's two skills). Written only when the
  vault is created (`.holi/vault` does not exist yet), and the vault's from then on: an open never
  writes one, so a deleted skill stays deleted. A plugin's are also written once when it is first
  enabled on a machine that has seeded the vault before; the seed state records which plugins
  this machine has seen, and its first open of a clone only records them. They are plain committed files because a vault
  works in any Claude Code, the web and the desktop app included; a Claude Code plugin would not
  reach cloud sessions or a machine it was never installed on.
- **Merged files** have one owner, which merges what the vault has with what Holi needs; any
  contribution adds to one with a fragment. `.gitignore` is core's: its `*.local.*` lines plus
  any fragment's, appended line-wise. `.claude/settings.json` is the agent's, merged key-wise
  (`src/plugins/agent/main/claude/settings.ts`). Fragments add hooks, each only where its script is (a hook a
  later release adds is wired when its script arrives), and `permissions.ask`, `allow` and `deny`
  rules: the agent's own (the turn bracket's `turn-signal.mjs` among them), Google's send gate
  and ask rules, the vault-app check, the tasks deny of Claude Code's `Task*` tools, and PDF's
  allow of `holi pdf comments`. The agent's own keys go in only when absent: each `skillOverrides`
  entry, `disableClaudeAiConnectors`, `autoMemoryEnabled`, `awaySummaryEnabled` and
  `promptSuggestionEnabled` (all `false`: no session recap, no next-prompt suggestion),
  `worktree.bgIsolation: "none"` (so sessions edit the vault rather than a worktree of it) and the
  inline `statusLine`. Everything else stays. A vault turns a default back by setting it here or
  in `settings.local.json`; Claude Code's `/config` writes user settings, which a project value
  outranks. Malformed JSON is left alone.

**Updating skills and hooks**. A Holi release may ship newer versions; they reach a vault
only when its user asks, with `holi skills update` or the palette's **Update skills**. Against the
base Holi recorded when it wrote each file (`.holi/state/seed-state.local.json`, machine-local): an
untouched file is replaced, one the vault changed elsewhere is 3-way merged, and a same-line
conflict is left as it is with the shipped version (and the base) staged beside it as
`*.shipped.local.*` and `*.base.local.*`. From the palette, conflicts get an agent session whose
submitted first turn merges them and deletes the staged files (`skills.update` answers that turn,
and the renderer starts it through the agent service); until it does, the file stays a conflict.
`holi skills update` and a vault without the agent leave the staged files for a person. A machine with
no recorded base hands every changed file to the agent. The palette reports the outcome as a
native notification. Whether an update would bring anything is asked, writing nothing, whenever a
vault opens (`skills.status`, also `holi skills status`): a file Holi has a newer version of than the
one it last brought here, or one new to the vault. A diverged file with no recorded base is not
counted, since nothing says whose change it is. While there are some, the nav menu's update item
offers Update skills ([updates](updates.md)). Holi's side of a hook is not kept compatible with older scripts: the update
is how a vault gets the current ones.

Changing a once file's seed text reaches new vaults only. To tell existing vaults something, use a
shipped skill (through the update), a `settings.json` key or fragment, or a file whose writer
regenerates it (`app.yaml` and the theme files are rewritten whole from the schema on every
write).

**Tool surface.** Native `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`. No MCP server. Holi's
additions are commands in a directory prepended to `PATH`, plus skills that document them:

- `holi <namespace> <verb>`: generic. It posts its argv to the bridge's `/cli`, and main reads
  it against the capabilities open at the CLI door ([vault apps](vault-apps.md)), each of which
  declares its positional arguments and a one-line summary; bare `holi` prints them all. Any
  argument can also be given as `--name value`, `--json` prints the value, and nothing may come
  before the verb. Exit 0 prints the answer, 1 a refusal (its code and a `next:` step), 2 a usage
  error. An answer over 16 KiB is written to `.holi/state/out/` and the command prints its path and
  shape instead ([architecture](../architecture.md) §3). A command that reads a
  body from stdin and was not given one is answered 428 without running, and the script sends
  stdin once (`send --draft <id>` reads none). Today: `apps open|init`, `skills update`,
  `pdf comments|typst`, `google agenda|search|read|mark-read|star|archive|trash|draft|send|reply|schedule|reschedule|unschedule`, `tasks list|complete`,
  `store list|get|put|delete|check`, `docs list|read|render|open`, `sync status`, `agent sessions`,
  `schedules list|enable|disable|run`,
  `vault members|recents`. The registry's reads the agent already has as Grep, Read and git
  (search, history, settings) stay app-only rather than grow a second way in. The script finds
  the bridge through the vault's `bridge.local.env`. All reversible or read-only (a record write is a file
  change in git history) except `google send` and `google reply`, which the send gate asks about.
- `holi google <verb>`: mail and calendar through main, which holds the tokens ([google.md](google.md)).
- `holi pdf typst` for PDF export, which prints the Typst binary's path ([pdf.md](pdf.md)).
- Shipped skills: `memory`, `using-tasks`, `scheduled-agents`, `vault-apps`, `theme`,
  `gmail-calendar`, `md-to-pdf`, `pdf-comments`, `holi-feedback` (a GitHub issue on syv-ai/holi, labelled `vault-assistant`,
  through `.github/ISSUE_TEMPLATE/vault-assistant.yml`).

**What is taken away.** Claude Code tools and bundled skills with no job in a vault are off, from
`settings.json`: `permissions.deny` holds `NotebookEdit`, plan mode, worktrees, `ReportFindings`,
`EndConversation`, `SendFeedback` (which reaches Anthropic, not Holi) and the todo tools
(`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, whose tasks are not the vault's `task.*.md`); `skillOverrides` turns
off the code-work and Claude Code configuration skills (`code-review`, `simplify`, `init`, `run`,
`update-config` and the like), `import-memory`, and `schedule`, whose cloud routines cannot reach
the vault's machine (a vault's schedules are Holi's, [scheduled-agents](scheduled-agents.md)).
`loop` and `dataviz` stay. A deny
outranks an allow in every scope, so getting a tool back means removing it from the vault's
`settings.json`; a skill comes back by setting it to `"on"`, which the merge leaves alone.

**Permissions.** Claude Code's native prompts are the permission UX. The seeded rules ask for
`curl`, `wget`, `holi schedules run` and `holi google archive|trash|unschedule|send|reply` (one
rule per verb), and allow `holi pdf comments` and `holi schedules list`. Turning a schedule on is
no command at all ([scheduled-agents](scheduled-agents.md)). Sending mail is
behind a seeded `PreToolUse` hook that always asks ([google.md](google.md)). The agent's commits pass
the vault's pre-commit transforms like anyone's ([vaults-sync.md](vaults-sync.md)).

## Rules

- Never launch with `--dangerously-skip-permissions`.
- Strip any inherited `CLAUDE_CONFIG_DIR` and `HOLI_*` before setting ours.
- Isolate from the machine, not from the vault: a vault may declare its own MCP servers and skills.
- A seed that only runs at creation is a migration that never happens: seed on every open.
- The seed-state file is machine-local. A committed copy would tell a teammate their file is untouched.
- Control which tools exist rather than gating how one is reached: a gate matching tool names is only
  as complete as the last inventory.
- Trust boundary is repo access. The agent can run destructive git; git history is the recovery.
  Do not blocklist git, which reconcile needs.
- Prompt injection through shared vault content is an accepted residual risk.

## Rejected

- A built system prompt or rich per-turn context: duplicates native tools and drifts.
- An MCP server or ops: a documented command returning text or JSON does the job through `Bash`.
- Composing config per launch, or syncing personal config.
- One config directory for all vaults: plugins leak between vaults.
- Reading `.claude.json`'s `oauthAccount` to detect sign-in: it records an account, not a usable credential.
- Copying transcripts from `~/.claude`: rewriting another program's store.
- `--strict-mcp-config`: suppresses the vault's own MCP servers.
- Fetching seed files from the product repo: needs a token, and the binary already has them.
- Sandboxed bash by default: friction, and it gets turned off.

## Code

- `apps/desktop/src/plugins/agent/main/claude/config-dir.ts`: per-vault config dir, first-spawn marker
- `apps/desktop/src/main/vault/seed/`: the seeder (`seed.ts`), `holi skills update` (`update.ts`),
  seed folders (`folder.ts`), core's contribution (`core.ts`, `vault/once/AGENTS.md`), and
  `state.ts`: what Holi seeded, the base an update merges from
- `apps/desktop/src/plugins/agent/main/claude/seed.ts`: the agent's contribution and its `settings.json`
  fragments; `settings.ts`: the merge
- `apps/desktop/src/main/bridge/cli.ts`: the `holi` script, its argv and refusal text;
  `bridge/spill.ts`: long answers to a file; `bridge/server.ts`: `/cli`;
  `apps/desktop/src/plugins/agent/main/claude/routes.ts`: the turn and status-line routes
- `apps/desktop/src/main/bridge/env-file.ts`: `bridge.local.env` and its shell reader
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/`: shipped hook scripts and skills
- `packages/shared/src/path-safety.ts`: `isAgentSurfacePath`
