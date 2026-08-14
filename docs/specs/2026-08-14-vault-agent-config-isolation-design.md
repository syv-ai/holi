# Vault agent config isolation — design

**Status:** designed 2026-08-14, not yet built. **Decision:** D72.
**Half of it already shipped** — see §7.

## The problem, as it actually presented

Asked to *"write a draft email to nicolaibthomsen@gmail.com with a short, funny
poem of a turtle"*, the vault agent did this:

```
claude.ai Gmail - Create draft email (MCP)(to: [...], subject: "A Short Turtle Poem", ...)
```

Not `holi-google draft`. A **claude.ai Gmail connector** — a tool Holi does not
know exists, connected to the user's Anthropic account rather than to Holi's
Google session.

That single call routes around three separate decisions:

| Decision | What it says | What the connector does |
| --- | --- | --- |
| D67 | main is the sole token authority; the agent never holds a Google token | uses its own connection to Google entirely |
| D70 | `send`/`reply` pass a `PreToolUse` gate that always asks | the gate matched `Bash`; an MCP call is not a shell command, so it **deferred** |
| D68 | Holi's writes patch Holi's cache | the cache never hears about it |

**The gate hole is the serious one.** D70 recorded an honest limit — *"this
gates a cooperative agent, not an adversarial one; no string match survives
`eval`"*. This is worse than that limit admits: a **cooperative** agent walked
around the gate by reaching for the more convenient tool, exactly as it should
have, because nothing told it not to. It could have *sent* with no prompt at all.

**And the connector is a symptom.** The general fault is that a vault agent is a
plain Claude Code session with the user's home `~/.claude` underneath it.

## 1. What actually leaks in

Measured on this machine, 2026-08-14 — not inferred:

| Source | What the vault agent inherits |
| --- | --- |
| `~/.claude/settings.json` | `enabledPlugins`, `skillOverrides`, `extraKnownMarketplaces`, and **`skipDangerousModePermissionPrompt: true`** |
| `~/.claude/skills/` | `find-skills`, `humanize-text`, `pr-review`, `web-artifacts-builder` |
| `~/.claude/plugins/` | every installed plugin and marketplace |
| `~/.claude/mcp.json` | an `azure-devops` MCP server |
| claude.ai account connectors | `Gmail`, `Google Calendar`, `Google Drive`, `Claude Code Remote` (from `claudeAiMcpEverConnected`) |

`buildAgentEnv` copies `process.env` wholesale and has never set
`CLAUDE_CONFIG_DIR`; `buildAgentArgs` deliberately omits `--strict-mcp-config`
so a *vault* may declare its own MCP servers. Neither is wrong on its own. The
gap is that nothing distinguishes "the vault's config" from "this machine's
config", and the agent gets the union.

## 2. Two levers, and why one is not enough

**Settings precedence** is managed > CLI > local > **project** > user, so a
checked-in vault `.claude/settings.json` outranks the user's. That reaches some
things and not others:

- **`disableClaudeAiConnectors`** is settable in *any* scope and `true` in *any*
  source wins — so a project file can opt the vault out of cloud connectors, and
  a user-level `false` cannot undo it. **This closes the gate hole.**
- **User-level skills and plugins cannot be disabled by project settings.** There
  is no project-scope lever for them at all.

So the connector problem is solvable with settings; the general problem is not.
The only thing that reaches everything is relocating the config directory
itself — `CLAUDE_CONFIG_DIR`, which puts every `~/.claude` path under a
directory of our choosing.

## 3. The cost of relocation, measured

This is the finding that shaped the design, and it contradicts the obvious
inference.

There is no `~/.claude/.credentials.json` on macOS — credentials live in the
Keychain (`Claude Code-credentials`, plus a suffixed
`Claude Code-credentials-33e1db04`). From that it *looks* as though relocating
the config dir would leave authentication untouched. It does not:

```
$ CLAUDE_CONFIG_DIR=<fresh dir> claude -p "reply with exactly: OK"
Not logged in · Please run /login
```

Symlinking `~/.claude.json` into the fresh directory **does not fix it** — tried,
same result. Credentials are keyed to the config directory, not merely stored
beside it. Note also that `~/.claude.json` *moves* with `CLAUDE_CONFIG_DIR`
despite living outside `~/.claude`: the isolated run created its own.

**So isolation costs one `/login` per config directory.** That is the whole
argument for §4.

## 4. One shared config dir, not one per vault

`userData/agent-config/`, shared by every vault.

The per-vault version was the first instinct and it is worse, for one reason
that turns out to be free: **session history is keyed by working directory**
(`projects/<cwd-slug>/`), so a single shared directory *already* keeps each
vault's `--resume` history separate. Per-vault directories buy separate settings
— which nothing needs, since Holi seeds the same set everywhere — and cost a
`/login` per vault.

One directory, one login, ever.

## 5. What the agent sees afterwards

| | Before | After |
| --- | --- | --- |
| Holi's seeded skills (`gmail-calendar`, `md-to-pdf`, `theme`) | ✓ | ✓ — project scope, read from cwd |
| The vault's own `.claude/` | ✓ | ✓ — unchanged, still the user's to configure |
| Claude Code's bundled skills | ✓ | ✓ — part of the binary, not of `~/.claude` |
| Home skills, plugins, marketplaces | ✓ | ✗ |
| `azure-devops` MCP | ✓ | ✗ |
| claude.ai connectors | ✓ | ✗ (already, via §7) |
| `skipDangerousModePermissionPrompt: true` | ✓ | ✗ |

**The vault's `.claude/` is deliberately untouched.** Isolation is from *the
machine*, not from the vault — a vault is entitled to declare its own MCP
servers and skills, which is why `--strict-mcp-config` stays off.

## 6. The one-time login, and how not to detect it

The first launch after this ships will be unauthenticated, and the user must run
`/login` once inside the agent panel.

**Do not detect this by reading the PTY.** Holi has a standing decision against
inferring Claude Code's state from its output — it is a rabbit hole, and the
supported mechanisms are hooks and files. The state is available as a *file*:
`<configDir>/.claude.json` either has an `oauthAccount` key or it does not.
Check that before launching and say so plainly in the panel; never scrape the
terminal for `Not logged in`.

**Existing session history stays where it is.** Transcripts under
`~/.claude/projects/<vault-slug>/` become invisible to the relocated agent.
Copying them across is possible and is *not* proposed: they are Claude Code's
internal format, the cost of losing them is `--resume` starting empty once, and a
migration that silently rewrites another program's state store is a worse bet
than a sentence in a release note.

## 7. What already shipped, 2026-08-14

The connector half was severable and cost nothing, so it landed immediately
(`438ca2a`):

- `disableClaudeAiConnectors: true` in the seeded vault `.claude/settings.json`.
- The send gate additionally matches `mcp__.*[Gg]mail.*` and asks on
  `send`/`reply`/`forward`. It defers on connector drafts and reads — this gates
  what cannot be undone, not what it dislikes.
- **Both go through the merge path, not only the creation path.** Every vault
  that exists already has a `settings.json`, so a creation-only change would have
  reached none of them — D70's own lesson (*"a seed that only runs at creation is
  a migration that never happens"*) applied to itself. It is set only when
  absent, so a user who deliberately wrote `false` is not overruled once a
  session.

This spec's remaining work is §4 and §6.

## 8. Open, and deliberately not decided here

- **Does anything from home deserve an allowlist?** `syv-skills` (`hjernen`,
  `tilbud`, `brainstorming`) is a home *plugin* and will disappear from vault
  agents. That may be the right outcome — a vault agent is for the vault — or it
  may be missed within a week. The escape hatch is a symlink into the shared
  config dir, and the decision should be made when it is felt, not now.
- **Whether the vault agent should share a login with the user's own Claude
  Code at all.** It does today by accident. A separate account or an API key
  would be a real decision about identity, not a config-dir question.

## Rejected

- **Per-vault config directories** — a `/login` per vault, buying separate
  settings nothing needs, when per-vault history comes free from cwd keying (§4).
- **Symlinking `~/.claude.json` into an isolated dir to keep the login** —
  tried, does not work (§3), and it would have dragged the machine's MCP and
  project state back in anyway.
- **Settings-only, no relocation** — closes the connector hole and nothing else;
  project settings cannot reach user-level skills or plugins (§2). Shipped as far
  as it goes (§7), and it is not the general fix that was asked for.
- **Copying session transcripts into the new dir** — rewriting another program's
  internal state store to save one empty `--resume` (§6).
- **Detecting the logged-out state by parsing the terminal** — against a
  standing decision, and unnecessary: the answer is a key in a JSON file (§6).
- **`--strict-mcp-config`** — it would also suppress MCP servers the *vault*
  declares, which a vault is entitled to do. Isolation is from the machine, not
  from the vault.
