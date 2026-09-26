# Agent config

What a vault agent knows and can reach. Holi builds no prompt and no tool server: the agent is plain
Claude Code, configured by files in the vault and by a config directory Holi keeps for that vault.
Holi's job is to seed those files, keep them current, and keep the machine's own config out.

## How it works

**A config directory per vault.** Every spawn sets `CLAUDE_CONFIG_DIR` to
`userData/agent-config/<slug>/`, where the slug is the sanitised remote plus 8 hex of its sha1 (the
sanitised half alone is not unique). The machine's `~/.claude` (global settings, skills, plugins,
marketplaces, MCP servers) is excluded by construction, and one vault's plugins never reach another.
Holi creates the directory and merges three keys into its `settings.json`:
`disableClaudeAiConnectors` (only when absent), `theme` (dark or light, written on every spawn from
the app's resolved colour mode), and `statusLine` (Holi's script, rewritten when its path moves).
A theme change reaches a running session only on restart, and its dot says so.

**Sign-in is lazy.** Credentials are keyed to the config directory, so each vault needs its own
`/login`. The first spawn in a directory writes a `.holi-spawned` marker and prints a notice into the
scrollback. Holi never reads Claude Code's sign-in state. A leftover shared `agent-config/` is
renamed whole into the slot of the vault whose path appears in its `.claude.json` `projects{}`.

**Shared layer, committed.** `.claude/` (settings, hooks, skills), `AGENTS.md` (the vault's
instructions, which Claude Code reads natively, so no `CLAUDE.md` is seeded), and `memory/`
([agent-memory.md](agent-memory.md)). Claude Code reads them from the cwd. **Personal layer:**
`CLAUDE.local.md` and anything `*.local.*`, gitignored. A change to `.claude/settings.json`,
`CLAUDE.md` or `AGENTS.md` (`AGENT_CONFIG_FILES`) marks running sessions stale until restarted.
Hooks and skills are re-read per use, so they are not in that set.

**Per-turn context is one line.** The `UserPromptSubmit` hook prints `Focused note: <path>` from
`.holi/state/context.local.json`, which main keeps current. Tasks, backlinks and sync state the agent
finds itself with `Glob`, `grep` and `git`.

**Seeding.** `ensureSeeded` runs on create, adopt and every open. It writes `.gitignore`'s
`*.local.*` line first, line-wise, then three classes:

- **Once files**: `AGENTS.md`, `memory/index.md`, `.holi/vault`,
  `.holi/settings/app.yaml` and `app.local.yaml`, `theme.css`, `theme.local.css`, `icons.yaml`,
  `.holi/document-templates/**`. Created if absent, then the user's.
- **Managed files**: `.claude/hooks/**` and `.claude/skills/**`. Refreshed on open only when the
  file matches the sha256 Holi recorded in `.holi/state/seed-state.local.json`. No record means no
  refresh, except a file already identical to what Holi ships, which is adopted.
  `holi seed refresh [path] [--force]` does it on demand; `--force` reaches managed files only.
- **`.claude/settings.json`**: merged key-wise by `settingsWithRequired`. Holi adds its hooks,
  `permissions.ask` and `permissions.allow` rules, `disableClaudeAiConnectors` and
  `autoMemoryEnabled`, and keeps everything else. Malformed JSON is left alone.

Changing a once file's seed text reaches new vaults only. To tell existing vaults something, use a
managed skill, a `settingsWithRequired` key, or a file whose writer regenerates it (`app.yaml` and
the theme files are rewritten whole from the schema on every write).

**Tool surface.** Native `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`. No MCP server. Holi's
additions are commands in a directory prepended to `PATH`, plus skills that document them:

- `holi`: `app open`, `app init`, `seed refresh`, `pdf comments <path> [--json]`. It posts to the
  hook server with the session's token. All reversible or read-only, so none is gated.
- `holi-google`: mail and calendar through main, which holds the tokens ([google.md](google.md)).
- `$TYPST_BIN` for PDF export ([pdf.md](pdf.md)).
- Managed skills: `memory`, `using-tasks`, `vault-apps`, `theme`, `gmail-calendar`, `md-to-pdf`,
  `pdf-comments`.

**Permissions.** Claude Code's native prompts are the permission UX. The seeded rules ask for
`curl`, `wget` and the undoable `holi-google` writes, and allow `holi pdf comments`. Sending mail is
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

- `apps/desktop/src/main/agent/agent-config-dir.ts`: per-vault config dir, first-spawn marker, migration
- `apps/desktop/src/main/agent/seed-content.ts`: seed classes, `AGENTS.md` text, `settingsWithRequired`
- `apps/desktop/src/main/agent/seed-state.ts`: managed-file hashes
- `apps/desktop/src/main/agent/cli.ts`, `ops.ts`: the `holi` and `holi-statusline` scripts and their routes
- `apps/desktop/src/main/agent/hooks/`, `skills/`: shipped hook scripts and skills
- `packages/shared/src/path-safety.ts`: `AGENT_CONFIG_FILES`, `isAgentSurfacePath`
