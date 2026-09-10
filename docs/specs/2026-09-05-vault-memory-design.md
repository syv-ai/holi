# Vault memory (D89) — design

**Date** 2026-09-05 · **Status** BUILT 2026-09-10. Kept as the design of record; the notes marked **[built]** below are where the build corrected it
**Source of the idea** [`syv-ai/holi#3`](https://github.com/syv-ai/holi/issues/3), an evaluation of
[understory](https://github.com/thecodacus/understory) whose deterministic OKF layer is the part
worth having. Scope agreed 2026-09-05: items 1 to 3 of that issue.

## The gap

Holi's memory is **one file with a word limit and a request**. `MEMORY.md` carries "Budget: 5,000
characters; consolidate when it fills up", which is a prompt rather than a mechanism: nothing
measures the budget, nothing consolidates, and nothing tells the agent a memory is there before it
has already answered without it.

[`../upcoming.md`](../upcoming.md) item 13 records what actually happens — **the agent uses its own
memory instead of ours**. Claude Code has had an auto-memory directory for a while now; it lives
outside the vault (D72), never syncs, is invisible to teammates, and the agent reaches for it because
it is the surface its own system prompt describes. Holi's memory is the one it has to be reminded
about. Item 13's chosen approach was to surface that outside-the-vault directory in the file tree,
which needs a second source for the tree and a read/write path outside path-safety containment, and
which would leave the vault with **two** memory surfaces rather than one.

## The decision

Memory becomes a **directory of typed markdown files at the vault root**, Holi **regenerates its
index at the commit boundary**, a **`SessionStart` hook** prints an overview so the agent starts
every session knowing what it knows, and **Claude Code's own auto-memory is switched off** so there
is exactly one memory surface. Item 13 is closed by that last clause rather than built.

## What is taken from understory, and what is not

**Taken:** the deterministic layer — typed frontmatter, a generated index, and a seed overview
injected at session start. **Left:** the inner agent, the provider registry, hot memory, the query
cache, the MCP server, `GIT_AUTOCOMMIT` (a `git add .` over the whole bundle, destructive in a
vault), and `DREAM_INTERVAL` unattended editing, which
[`../not-built.md`](../not-built.md) already ruled on: personal layer only, shared-layer changes
become proposals.

**The port is smaller than #3 estimated.** `splitFrontmatter` is already in
`packages/shared/src/task-file.ts` and `yaml` is already a dependency of that package, so
understory's `frontmatter.ts` and its `gray-matter` dependency are not needed. What is left to write
is an indexer over a directory, which is why this design describes contracts rather than a port.

### OKF v0.2 is the shape. Holi does not claim the label

#3 cites OKF v0.1; the spec now serves
[v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md), and reading
it changes two things.

**v0.2 is far softer than the port assumes.** `type` is the only required key. A concept carrying
nothing but `type` conforms. Broken links are explicitly legal ("Consumers MUST tolerate broken
links: a link whose target does not exist in the bundle is not malformed"), a missing `index.md` must
be tolerated, and consumers "MUST treat all other constraints as soft guidance". Conformance is:
parseable YAML frontmatter, a non-empty `type`, and the reserved filenames shaped right where they
exist.

So **there is nothing here that could earn a veto**, and the sharpest question in #3 answers itself.
[`../prd/vaults-sync.md`](../prd/vaults-sync.md) FR-9 is explicit that a transform can never block a
commit, with the large-file guard as the single exception, because git history is permanent and push
is automatic. Nothing about a missing `description` is of that weight. Understory's stated rule,
*"conformance is enforced in code, not prompts"*, is its product philosophy, not the format's demand.
**Holi's indexer maintains; it never enforces.**

**And OKF's link grammar is not Holi's.** OKF links are markdown, `[text](/path/to/concept.md)`.
Holi's are `[[path.md]]` (`packages/shared/src/wiki-links.ts`, one grammar since D12/D22). A
wiki-link is prose to an OKF consumer, so a wiki-linked directory is OKF-*shaped* and not
OKF-conformant. **Holi takes the shape and never claims the label.** The alternative would put a
second link grammar inside `memory/` that `relink`, backlinks and the editor's chips do not
understand — so a renamed memory file would break its own links — bought in exchange for portability
to tooling nobody runs.

## Where memory lives: `memory/` at the vault root

Memory is **content, not plumbing**. `MEMORY.md` sits at the vault root today; `.holi/` holds
settings, apps, themes and document templates, and putting memory there would make the thing the user
most wants to read and correct a file they have to unhide first.

**Personal memory is `memory/whatever.local.md`** and needs no new machinery at all: D65 makes
`.local.` the only locality marker, and the seeded `.gitignore` already carries `*.local.*`, so a
personal memory is gitignored the moment it is written. It shows in the tree under show-hidden and
never syncs.

### The index must not leak a personal memory

`index.md` is committed. A `.local.md` file's title and description are not — that is the whole point
of the marker. **So the generated index lists tracked memories only**, and a personal one appears in
no committed file anywhere.

The obvious counterpart, an `index.local.md`, is **deliberately not built**. It could not be
maintained by the commit-boundary transform in any case, because a gitignored file never stages and
so never appears in `StagedChanges`. More to the point, its only reader would be the overview hook,
which can read the handful of personal files directly for the same cost. A generated file that must
never be committed, sitting one `.gitignore` edit away from leaking every personal memory's title, is
a liability with no compensating reader. **The committed index exists because it is committed.**

### There is no `log.md`, because git already is one

#3 item 1 carries understory's newest-first `log.md` across. It should not come.

Understory needs a log file because its bundle may be a tarball. **Holi's vault is always a git
repository**, so `git log -- memory/` is the same record, deterministic, with authorship and
timestamps for free and nothing to keep in step. Adopting the file would add the single worst merge
surface in this design: a newest-first log is prepended to on every write, so two members writing
memory in the same afternoon conflict on its first three lines, every time — and a conflict in a
*generated* file pauses that vault's auto-pull and raises a reconcile banner (FR-12, FR-17) over
something no human wrote.

The index has no such problem: one line per memory, sorted by path, so two members adding different
memories touch lines that git merges without noticing.

## The file contract

A memory is one fact in one file. Frontmatter:

| key | | |
|---|---|---|
| `type` | **required** | A short free-form string. See below — there is no registry |
| `description` | strongly wanted | One line. It is what the index and the overview print, so a memory without one is a memory nobody finds |
| `title` | optional | Falls back to the H1, then the filename |

Anything else is preserved and ignored. The body is the fact, and links to other memories are
ordinary `[[memory/other.md]]` wiki-links, so `relink` and backlinks work on them exactly as on any
note.

**`type` is free-form on purpose.** OKF requires consumers to tolerate unknown types, and the seed
overview prints *types in use*, which makes the vocabulary self-documenting and self-converging
without anyone maintaining a list. `AGENTS.md` suggests a starting set (`convention`, `environment`,
`person`, `project`, `reference`, `preference`) and nothing enforces it. A closed registry here would
be a config surface designed before a second consumer asked for one, which is the argument that
killed `manifest.json` in D74.

**The indexer fills gaps rather than refusing them.** No `title` takes the H1 then the filename; no
`description` takes the first sentence of the body; **no `type` is written as `note`**. Every one of
those is maintenance, and none of them can fail a commit. That is what "maintains, never enforces"
means concretely.

## `memory/index.md`

**One index, at `memory/`, grouped by `type`, listing every memory file in the tree.** Grouping by
type rather than by directory is what makes "types in use" free for the overview, and it matches OKF
§8's shape exactly (section heading, then a bullet list). Subdirectories are allowed and show as
paths in the links.

```markdown
<!-- Generated by Holi. Edit the memory files, not this. -->

## convention

- [[memory/plan-style.md|Plan style]] — plans carry contracts and gotchas, never inline code

## environment

- [[memory/shell-quirks.md|Shell quirks]] — bare node and npx are broken; always pnpm exec
```

Wiki-links rather than OKF's markdown links, per the grammar decision above — which also means the
index is **clickable in Holi's editor**, and that is most of what it is for on the human side.

**Per-directory indexes are deferred**, not rejected. They are OKF's progressive-disclosure move and
they earn their place in a deep tree; a vault's memory will be tens of files before it is hundreds,
and nothing in this format prevents adding them the day it is not.

## The `memory-index` transform

A new entry in `VAULT_TRANSFORMS` (the fifth, not the fourth this said: `scaffold-md` landed between design and build) (`apps/desktop/src/main/vault/hooks/transforms.ts`), enabled by
default in `VAULT_SETTING_DEFAULTS.hooks`. That file's own comment anticipates this: *"A fourth
transform gets added to this array; it does not get a plugin system."*

- **Runs last**, after `relink` and `archive-done` have finished moving and rewriting, so it indexes
  the tree they left behind.
- **Returns immediately** when nothing under `memory/` is staged. It runs on every commit and most
  commits are edits.
- **Regenerates from the tree**, not from the diff, and adds `memory/index.md` to `changed` so the
  runner restages it into the commit being made.

### Why the commit boundary

Not for `relink`'s reason. `relink` lives there because `git diff --cached -M` is the only place a
rename's `from → to` map exists; an index regenerated from the tree does not need to know what moved.
It lives there for the other two reasons:

- **The restage.** The index must land in the *same* commit as the memory it describes. Anywhere else
  and every commit is followed by an index commit, forever.
- **Coalescing.** A burst of memory writes in one turn produces one commit with its index already
  correct, rather than N commits of index churn pushed to every member. It is the same argument that
  put `relink` there, and it is the friction #3 item 2 already spotted.

### It cannot block a commit

Restating FR-9 because this is the transform most likely to tempt someone: if the indexer throws, the
runner catches it, logs to `.holi/hooks.local.log`, and **the commit proceeds**; three consecutive
failures disable it for the session. Holi's auto-commit *is* the user's save, and an index is an
opinion about tidiness. The large-file guard is the one veto in the vault and this is not it.

## The overview hook

A new `.claude/hooks/memory-overview.mjs` on **`SessionStart`**.

**Not `UserPromptSubmit`.** That hook exists for the one piece of *per-turn* state the agent cannot
discover — the focused note — and it stays exactly that. Memory is session state, and injecting 3k
characters into every turn would pay for it over and over. `SessionStart` fires on `startup`,
`resume` **and `compact`**, which matters: a compaction is precisely the moment the agent forgets it
has memory at all.

What it prints, capped at **~3,000 characters**:

- **Types in use**, with counts.
- **The index lines**, grouped by type — read straight from `memory/index.md`, which the transform
  already generated, so the hook parses nothing.
- **Personal memories**, from a direct scan of `memory/**/*.local.md` (title and description from
  frontmatter). A handful of small files, and the only reader they have.
- **Recent changes**, from `git log --format=… -n 3 -- memory/`. One subprocess, once per session,
  which is a looser budget than the per-turn hook's 50 ms.

Over the cap it **drops descriptions first**, then truncates with a pointer to `memory/index.md`,
which the agent can `Read`. With no `memory/` directory it prints nothing at all, exactly as the
focused-note hook does outside Holi.

## Claude Code's own auto-memory is switched off

Verified against the CLI binary at 2.1.261: **`autoMemoryEnabled`** is a settings boolean described
as *"Enable auto-memory for this project. When false, Claude will not read from or write to the
auto-memory directory."* It defaults on, storing under `~/.claude/projects/<sanitized-cwd>/memory/`.
`CLAUDE_CODE_DISABLE_AUTO_MEMORY` is the environment equivalent.

Holi's seeded `.claude/settings.json` sets `"autoMemoryEnabled": false`, and
`settingsWithRequired` merges it into vaults that already exist — set only when absent, the same
shape as `disableClaudeAiConnectors`, and for the same reason recorded there: **a seed that only runs
at creation is a migration that never happens.** A user who set it `true` deliberately has said
something, and Holi does not argue with them once a session.

That one key is the whole of what item 13 was reaching for, in place of a second tree source and a
read/write path outside path-safety containment.

### Why off rather than redirected

`autoMemoryDirectory` exists and would point Claude Code's own memory at `memory/`. It is the wrong
lever twice.

- Its own description says it is *"Ignored if set in projectSettings (checked-in
  `.claude/settings.json`) for security"*. Holi could only set it per clone in
  `.claude/settings.local.json`, so a shared vault's memory location would depend on every member's
  machine-local config being right — and being right about a file that never syncs.
- The format would be Anthropic's: undocumented, versioned with the CLI, and its `[[slug]]` links
  address memories by name rather than by vault path, so they would collide head-on with Holi's
  `[[path.md]]` grammar *inside* the vault. Holi would be committing a format it does not control to
  every member of a shared repository.

**[built] The verification this owed is paid, and live rather than static.** Against 2.1.267: a
headless session in a directory whose project `.claude/settings.json` carries the key reports no
memory directory at all, where the same session given `{}` reports
`~/.claude/projects/<sanitized-cwd>/memory/`. Reading the binary agrees — the resolver takes
`autoMemoryEnabled` off the **merged** settings (user, then project, then local), so a vault's
committed file reaches it and outranks a user-level `true`. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is
checked *before* the setting and stays available as a fallback that was not needed.

## `MEMORY.md` and `USER.local.md` are not moved by code

Both keep working. A new vault's seed stops writing `MEMORY.md` and writes a `memory/index.md`
in its empty-state form instead, as a `ONCE_FILE`, so the directory exists and is tracked from the
first commit and the transform owns it thereafter.

**An existing vault's `MEMORY.md` is content the user wrote, and moving it automatically is exactly
the shared-layer auto-edit `not-built.md` ruled against.** So: `AGENTS.md` names `memory/` as where
memory goes and describes `MEMORY.md` as legacy and still read, and the overview hook adds one line
when a non-empty `MEMORY.md` exists, suggesting it be split. **The split is agent work the user
asks for**, which is the same shape as every other shared-layer change.

`USER.local.md` is the same file with a different audience and gets the same treatment. Its `.local.`
already does precisely what `memory/x.local.md` would do, so folding it in buys a migration and
nothing else.

## What the build corrected

Three things, none of which changes the design, all of which would have cost the next reader time.

**[built] `memory/` in `isAgentSurfacePath` is load-bearing for `scaffold-md`, not only for apps.**
`wantsScaffold` consults that predicate, so the same one-line change is what stops the scaffolder
prepending a `created:`/`tags:` block to a memory file — whose frontmatter is `type` and
`description`, not metadata about prose — and, worse, to the generated `index.md`, which the indexer
would then rewrite straight back on the same commit. The two would have taken turns forever.

**[built] "Runs last" has a sharper reason than the ordering one given below.** `memory-index` is the
only transform that reads the whole **tree** rather than the staged set, so it must see the tree the
other four left behind: a memory file `relink` has just rewritten links in, one `normalize-md` has
just tidied.

**[built] A vault can have memories and no index, and the hook printed nothing for it.** Found by
running a real `claude -p` session against a seeded vault: with `memory/*.md` present but no
`index.md`, the agent was told the vault remembers nothing. It now says so and points at the
directory. Not a fallback scan — that would be a second copy of the indexer living in the hook.

**[built] The wiki-link hazard was the wrong one.** The grammar is `\[\[([^\]\n]+)\]\]` and the
parser splits on the **first** pipe, so a `|` inside a title arrives intact and needs no escaping at
all; what breaks a link is a single `]`, which ends the body early so the token stops matching and
the reader gets raw brackets. The grammar has no escape sequence, so a title is **substituted**
rather than escaped.

## Vault apps must not read memory

`router.ts`'s `apps.read` refuses the agent surface outright — `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`,
`USER.local.md`, `.claude/` — because a vault app hosts untrusted code and `MEMORY.md` is what the
user told the assistant. **`memory/` is that same thing, subdivided**, and joins the refusal list. A
`.local.md` beneath it is refused for a second reason on top.

## Not in this slice

- **Lint as proposals** (#3 item 4): orphans, broken links, duplicate candidates, oversized concepts.
  It is worth little until the directory is big enough to be untidy, and v0.2 settles that none of it
  is a conformance question — broken links are legal. Its home when it arrives is a proposal surface,
  personal layer only.
- **A vault-wide `[[link]]` graph view** (#3 item 5). A feature about the whole vault rather than
  about memory, and the largest single piece of the work.
- **Consolidation.** Claude Code has `autoDreamEnabled`, understory has `DREAM_INTERVAL`, and both
  are unattended edits to shared state. `not-built.md`'s ruling stands unchanged.

## Risks

- **A directory nobody prunes** grows until the overview is all the agent reads. The cap degrades
  (descriptions first) rather than truncating arbitrarily, and lint-as-proposals is the real answer
  when it is needed.
- **Two members writing memory in the same commit window.** The index is one sorted line per file, so
  git merges concurrent additions cleanly; a genuine conflict resolves by regeneration on the next
  commit. Dropping `log.md` removed the case where this would have been chronic.
- **`autoMemoryEnabled` is read out of a binary.** Named above as verification owed. Everything else
  in this design stands whether or not that key behaves, because switching off the other surface is
  hygiene rather than the mechanism.
