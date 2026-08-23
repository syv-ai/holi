# The vault agent runs in its own silo

**Date** 2026-08-23 · **Status** designed, not built · **Proposes D86**
**Overturns** [`2026-08-14-vault-agent-config-isolation-design.md`](2026-08-14-vault-agent-config-isolation-design.md) §4

That spec asked "isolate the agent from the machine" and answered it with one
shared config directory, `userData/agent-config/`, on the grounds that per-vault
directories cost a `/login` each and bought only separate session history, which
comes free from Claude Code's own cwd keying.

The reasoning was right and the conclusion has since become wrong, because
something else turned out to be shared.

## What is actually shared today, measured

Read off a real install on 2026-08-23, with two vaults registered.

| | keyed by | crosses vaults? |
|---|---|---|
| session transcripts / `--resume` | `projects/<cwd-slug>/` | no |
| prompt history (`history.jsonl`) | every line carries `"project": "<vault path>"` | no |
| per-project config (`.claude.json` → `projects{}`) | absolute path | no |
| **`plugins/`** (444 files: marketplaces, installed plugins) | nothing | **yes** |
| **`settings.json`** (user scope) | nothing | **yes** |
| credentials (`oauthAccount`, keychain) | the config dir | yes, and desirably |
| `file-history`, `backups`, `sessions`, `cache`, telemetry | session or machine | not meaningfully |

So §4 was right that *history* comes free. It did not consider **capability**.
A plugin or marketplace installed while working in one vault is available to the
agent in every vault, and `history.jsonl` on this machine records a `/plugins`
run inside `privat`. That is the leak, and it is the one that was felt.

## The decision

**One config directory per vault**, at `userData/agent-config/<vault-slug>/`,
handed to the child as `$CLAUDE_CONFIG_DIR` exactly as the shared one is today.

A vault agent gets nothing from another vault except the Claude Code binary.

### What it costs, and why that is acceptable now

**A `/login` per vault.** Measured in the 2026-08-14 spec §3 and not
re-litigated here: credentials are keyed to the config directory, symlinking
`.claude.json` does not carry them, and the keychain entry is suffixed per
directory. One Claude *account*, several login ceremonies.

This was the whole argument against per-vault directories, and it is weaker than
it looks because of what §4 could not know: the thing it was protecting was
never free. A shared directory does not buy one login, it buys one login **plus
a shared plugin set**, and the second half is not something anyone asked for.

### Not folded into onboarding

The login is **lazy**: the agent panel says the vault needs a Claude sign-in the
first time the agent is opened *in that vault*, and not before.

Vault creation stays as short as it is. A vault whose agent is never opened never
asks. And an agentic onboarding, which was considered, does not work here: an
agent needs a config directory, a login and a cwd before it can say anything, so
making onboarding agentic moves the login *earlier* and makes it a prerequisite
for configuring anything at all, rather than removing it. Four booleans and a
choice are also the worst case for a conversation: a form shows them at once,
answers instantly, and always the same way.

The open-ended half ("set this vault up for the Krifa work") is real agent work
and is not foreclosed by any of this. The agent can already edit
`.holi/settings.json` with ordinary file tools, and every row of the settings act
names the file it writes.

## §6 was never built, and this needs it

The 2026-08-14 spec closes with *"This spec's remaining work is §4 and §6."* §4
shipped. **§6 did not**: there is no `oauthAccount` check anywhere in `main`, so
today an unauthenticated agent simply prints `Not logged in` into the panel and
the user is expected to work out that `/login` is the answer.

Once per install that is survivable. Once per vault it is not, so §6 becomes part
of this change rather than a follow-up:

- Read `<configDir>/.claude.json` for an `oauthAccount` key **before** launching.
- Say so in the panel, in words, with the `/login` instruction.
- **Never scrape the PTY for it.** Standing decision, and unnecessary: the answer
  is a key in a JSON file.

## The theme, which is what surfaced this

Claude Code's theme lives in the config directory's `settings.json`, and on this
install it reads `"theme": "auto"`. `auto` means *detect the terminal
background*, which inside Holi's embedded PTY has nothing reliable to read, so
the agent stayed dark while the app went light.

With one directory per vault this stops being a compromise: Holi writes
`theme: "dark" | "light"` into that vault's config directory from the same
resolved mode that stamps `data-theme` (D85's `activeModeAtom`).

**Known limit:** Claude Code reads settings at start, so a session already
running keeps its theme until it is restarted. Worth a sentence in the panel
rather than an attempt to hot-swap another program's settings.

## Design notes for whoever builds it

- **`ensureAgentConfigDir(userDataDir)` becomes per vault.** It is called once
  per app launch from `main/index.ts:444` and its result is passed to
  `createAgentManager({configDir})`, which forwards it to `agent-runtime.ts:120`
  (`env.CLAUDE_CONFIG_DIR`). A per-vault directory has to be resolved **per
  spawn**, not per launch, because the active vault changes while the app runs.
  That is the shape change; everything downstream already takes a path.
- **The directory name must be stable and filesystem-safe.** `remote` is
  `owner/repo`, so it needs slugging. Claude Code's own convention for the same
  problem is in `projects/` (`-Users-nicolaibthomsen-Holi-nthomsencph-privat`),
  and matching it is not required but is cheap and legible.
- **`settingsWithRequired` keeps its merge-not-overwrite rule.** It exists
  because this file accumulates the user's own choices; that argument is
  unchanged and now applies per vault. The theme key joins
  `disableClaudeAiConnectors` as something Holi sets, but the theme is set on
  **every** spawn (it tracks a setting) rather than only when absent.
- **Migration.** The existing shared directory is already logged in and already
  holds `privat`'s transcripts. Moving or copying it into the first vault's slot
  would preserve both for one vault. The 2026-08-14 spec refused to copy
  transcripts between directories on the grounds that rewriting another program's
  state store is a bad bet; a straight **rename of the whole directory** is a
  different and much safer operation, and is worth considering so the vault
  someone actually uses does not lose its history and its login on upgrade.
- **§8's escape hatch still applies.** Home plugins like `syv-skills` are
  reachable by symlinking into a config directory. Per vault, that becomes a
  per-vault choice, which is arguably the right place for it.

## Companion: Google is the same shape, and is not this change

Agreed separately on 2026-08-23 and recorded as **D87, agreed and not designed**.

**The problem.** Google tokens live in `userData/google-auth.enc`
(`main/google/electron.ts:25`), machine-level by D67. Every vault on a machine
therefore shows the same Gmail and the same Calendar. Creating a second vault is
the first time anyone sees it, and what it looks like is a brand-new work vault
showing personal mail.

**The decision.** A vault's Google account is its own. Not a per-vault *toggle*
over one shared account, which was the cheaper option and was rejected: the ask
is genuinely "this vault connects to that account".

**What it costs**, and why it wants its own design rather than a paragraph here:

- The token store is a single file with a single account's tokens.
- The OAuth loopback flow assumes one connection.
- The `holi-google` CLI, which the agent shells out to, resolves credentials with
  no notion of which vault it is running for.
- The bounded `node:sqlite` mail/calendar cache is machine-level and would need
  keying, or splitting, or both.
- Signing out, token refresh and revocation all become per vault.

**The shared shape with D86** is worth stating once: both are "an identity that
Holi currently holds per machine, and that a vault should hold for itself". They
are separate builds and should not be merged into one, but whoever designs the
Google half should read this document first, because the questions (where does
the credential live, what does a fresh vault do before it has one, how does the
user find out) already have answers here.

## Open

- **Whether the vault agent should share an account with the user's own Claude
  Code at all** stays open, unchanged from 2026-08-14 §8. This change makes the
  *directories* separate; it does not decide whose account fills them, and
  answering that would be a decision about identity rather than about config.
- **Whether a per-vault plugin set is a feature.** Once directories are separate,
  a vault can carry the plugins its work needs and no others. That may be worth
  surfacing deliberately rather than leaving as a consequence.
