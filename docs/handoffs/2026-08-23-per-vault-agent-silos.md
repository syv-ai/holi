# Handoff: plan D86, the per-vault agent silo

**Repo** `/Users/nicolaibthomsen/repos/syv/better-holi-final` · branch `main`, pushed.
**Your job:** turn [`specs/2026-08-23-per-vault-agent-silos-design.md`](../specs/2026-08-23-per-vault-agent-silos-design.md)
into an implementation plan. The design is agreed. Do not re-open it.

## Working agreement

- **Nicolai approves every push.** Ask, every time. Commit straight to `main`,
  trailer `Claude goes brr.. via Dash`.
- **Ask questions with the AskUserQuestion tool**, never as prose A/B/C options.
- **No em dashes.** Not in UI copy, not in prose written for him. He said so
  flatly on 2026-08-23. Commas, colons, full stops.
- **He rejects the framing when the fork is drawn wrong**, and he is usually
  right when he does. A no-option-selected answer means re-ask with his reframe.
  Budget two or three rounds.
- **Plans stay lean**: contracts, decisions, ported constants, test intent,
  gotchas. Not full inline code. He has said so explicitly and it still holds.

## Read first, in this order

1. `docs/specs/2026-08-23-per-vault-agent-silos-design.md` — the design.
2. `docs/specs/2026-08-14-vault-agent-config-isolation-design.md` — what it
   overturns, and **why that spec was right at the time**. §3's measurement (a
   fresh config dir costs a `/login`) is the load-bearing fact and was tested;
   take it as given rather than re-testing, unless something looks wrong.
3. `docs/decisions.md` rows **D86** and **D87**.

## The four files that matter

| file | what changes |
|---|---|
| `src/main/agent/agent-config-dir.ts` | `ensureAgentConfigDir(userDataDir)` becomes per vault. Its module docstring currently *argues for* the shared directory; that argument is the thing being overturned and the comment has to go with it |
| `src/main/index.ts:444` | resolves the dir **once per app launch** today, and hands it to `createAgentManager({configDir})`. That is the shape change: it has to become per spawn |
| `src/main/agent/agent-manager.ts:279` | passes `configDir` through to the runtime. Likely becomes a getter rather than a value |
| `src/main/agent/agent-runtime.ts:119-120` | `delete env.CLAUDE_CONFIG_DIR` then sets it. Already takes a path; probably untouched |

Everything downstream of `index.ts` already takes a path, so the work is mostly
about **when** the path is resolved, not what is done with it.

## Three things the design leaves you to decide

These are genuine choices, not omissions. Put them to Nicolai if they turn out to
be load-bearing; otherwise decide and say what you decided.

1. **The slug.** `remote` is `owner/repo` and needs to be filesystem-safe.
   Claude Code solves the same problem in `projects/` as
   `-Users-nicolaibthomsen-Holi-nthomsencph-privat`. Matching that is not
   required, only cheap and legible.
2. **Migration of the existing shared directory.** It is already logged in and
   already holds `privat`'s transcripts. A **rename** into the first vault's slot
   preserves both for the vault Nicolai actually uses. Note the 2026-08-14 spec
   refused to *copy transcripts between* directories, which is a different and
   riskier operation than renaming one wholesale. If you skip migration, every
   existing vault starts logged out, which is defensible but should be a stated
   choice rather than an oversight.
3. **Where the "sign in to Claude for this vault" message lives.** The design
   says the panel, before launch, read from `<configDir>/.claude.json`'s
   `oauthAccount` key. It does not say what the panel looks like.

## Gotchas that will cost you a session if you miss them

- **`ensureAgentConfigDir` runs on every launch on purpose**, not on first run.
  Its comment carries D70's lesson: *a seed that only runs at creation is a
  migration that never happens*. Keep that property per vault.
- **`settingsWithRequired` merges, never overwrites.** The file accumulates the
  user's own choices. The new `theme` key is different from
  `disableClaudeAiConnectors`: it is written on **every** spawn because it
  tracks a setting, rather than only when absent.
- **Never scrape the PTY** for login state, or for anything else. Standing
  decision, and there is a memory about it (`holi-no-custom-cc-state-monitoring`).
  The answer is a key in a JSON file.
- **Main-process edits do not hot-reload.** Relaunch with `pnpm dev:debug`
  (CDP on 9333) before verifying anything in this area. Renderer edits do reload.
- **Kill the dev app scoped**: `pkill -9 -f "better-holi-final/node_modules/.pnpm/electron@"`.
  Never a bare electron pkill; Dash is Electron too.
- **`pnpm exec` always.** Bare `node`/`npx` are broken in this shell.

## Gates

From `apps/desktop`, absolute paths (the cwd drifts):

`pnpm exec vitest run --project node` (**1728**) · `--project dom` (**567**) ·
from root `pnpm --filter @holi/shared exec vitest run` (**429**) ·
`pnpm typecheck` · `pnpm exec eslint src` = **0 errors, exactly 2 known
warnings** (`EditorPane.tsx:236`, `TaskDetail.tsx:404`). A third is yours.

Never run the node suite in parallel with another suite.

## How this repo expects work to be verified

Not optional here, and it caught three real bugs in the D85 work that the tests
agreed with:

- **Mutation-check every test.** Break the implementation two or three specific
  ways and confirm a test fails each time. Restore and `diff` against a backup
  before moving on.
- **`assert old in s` before every scripted edit.** A silently no-op'd
  replacement surfaces as a test failure minutes later with no clue where.
- **Drive the running app over CDP** (`apps/desktop/cdp.mjs`). Read the
  `holi-ui-verification-ceiling` memory first. For this work the useful probe is
  `window.holi.trpc({path,type,input})`, which reaches main directly.

## What is NOT in scope

- **D87, per-vault Google accounts.** Agreed, not designed, and a separate build.
  Its constraints are listed in the design's §Companion. Read it, do not build it.
- **Whose Claude account fills the directories.** Open since 2026-08-14 §8 and
  still open. This change separates the directories, not the identities.
- **Agentic onboarding.** Considered and set aside in the design, with reasons.
  If it comes back it is its own piece of work.

## State of the tree

`main` is pushed. D85 (the landing target, the vault settings, the onboarding
settings act, light mode) is built, verified in the running app and documented.
The worklist's next items are 13 (agent memory in the explorer), 12, then 11/5.
`docs/upcoming.md` is untracked and gitignored on purpose: **never run
`git add docs`**, stage paths.
