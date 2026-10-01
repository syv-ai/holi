# Agent memory

A vault remembers in `.holi/memory/`: one fact per markdown file, typed, indexed on commit,
and summarised to the agent at the start of every session. It sits with Holi's other vault files so
the agent's notes to itself stay out of the user's notes: hidden in the tree like the rest of
`.holi/`, but committed and synced like any note, and readable and correctable once hidden files
are shown.

## How it works

**A memory is one file.** Frontmatter carries `type` (short and free-form), a one-line
`description`, and an optional `title`. Anything else is kept and ignored. The body is the fact.
Memories link with ordinary `[[.holi/memory/other.md]]` wiki-links, so rename rewriting, backlinks and
chips work on them. `AGENTS.md` suggests a starting set of types (`convention`, `environment`,
`person`, `project`, `reference`, `preference`); nothing enforces it.

**Personal memory is `.holi/memory/<name>.local.md`.** The `.local.` marker makes it gitignored, so it
never leaves the clone and needs no other machinery. Anything about one individual goes there.

**`.holi/memory/index.md` is generated** by the `memory-index` pre-commit transform, so the index lands in
the same commit as the memory it describes, and a burst of writes in one turn is one commit. It is
grouped by type, one `[[path|Title]]` line per memory with its description, sorted by path, under
a "generated" header. One sorted line per file is also why concurrent additions merge cleanly. It lists shared memories only, and says so in a line under the header. The transform runs last among the transforms, because it is
the only one that reads the whole tree rather than the staged set, and it returns at once when
nothing under `.holi/memory/` is staged. The transform framework is in [vaults-sync.md](vaults-sync.md).

**The indexer maintains, it never enforces.** A missing `title` takes the H1, then the filename. A
missing `description` takes the body's first sentence. A missing `type` becomes `note`. Invalid YAML
is treated as no frontmatter. A title is substituted into the link, not escaped: a `]` ends a
wiki-link and the grammar has no escape.

**A `SessionStart` hook prints an overview** (`.claude/hooks/memory-overview.mjs`), on startup,
resume and compact. Compact matters most: it is when the agent forgets it has memory. Capped at 3,000
characters, it prints the types in use with counts, the index lines, the personal memories (read
directly, since the index cannot carry them), and the last three commits touching `.holi/memory/`. Over
the cap it drops descriptions first and keeps every title, then truncates with a pointer to the
index. With memory files but no index yet, it says so and points at the directory. It needs no Holi
port: local reads and one `git log` with a 2 s timeout.

**One memory surface.** The seeded `.claude/settings.json` sets `autoMemoryEnabled: false`, merged
into existing vaults only when the key is absent, so Claude Code's own out-of-vault memory is off.

**The contract ships as a `memory` skill**, not only as `AGENTS.md` prose. `AGENTS.md` is a once
file and cannot be corrected in existing vaults; a skill can, through `holi skills update`
([agent-config.md](agent-config.md)).

**Legacy files.** `MEMORY.md` and `USER.local.md` still work and are still read, and nothing moves
them. New vaults are seeded with an empty `.holi/memory/index.md` instead of `MEMORY.md`. The overview
names either legacy file when present and suggests splitting it into `.holi/memory/`, which the agent does
only when the user asks.

**`.holi/memory/` is on the agent surface** (`isAgentSurfacePath`). Vault apps may not read or list it,
and the `scaffold-md` transform does not prepend frontmatter to a memory or to the index.

## Rules

- The committed index lists shared memories only. A personal memory's title and description appear
  in no committed file.
- Nothing in the indexer can fail a commit.
- `.holi/memory/index.md` is a once file, never shipped: an update merging into it would fight the
  transform.
- Edits to `.holi/memory/index.md` are discarded on the next memory commit. A seeded `PreToolUse` hook
  (`memory-index-guard.mjs`) refuses them up front with that reason; `AGENTS.md` says it too, for
  agents other than Claude Code.
- Duplicating `x.local.md` yields `x copy.local.md`, keeping the marker. A copy name that breaks the
  marker publishes the file.
- No unattended edits to shared memory: consolidation or splitting is agent work the user asks for.

## Rejected

- Surfacing Claude Code's own memory directory in the tree: two memory surfaces, and a read/write
  path outside path containment.
- `autoMemoryDirectory` pointed at `.holi/memory/`: ignored in checked-in project settings, and its
  `[[slug]]` links address by name where Holi's address by path.
- OKF's markdown links inside `.holi/memory/`: a second link grammar that relink and backlinks do not
  understand. Holi takes the OKF shape and does not claim conformance.
- A `log.md` of memory changes: git already is one, and a newest-first file conflicts on every
  concurrent write.
- An `index.local.md` for personal memories: never staged, so the transform cannot maintain it, and
  one ignore edit from leaking.
- A closed registry of types: the overview's "types in use" converges the vocabulary without one.
- Memory under `.holi/`: the thing users most want to read should not need unhiding.
- Injecting memory per turn: it is session state, and would be paid for on every prompt.

## Code

- `packages/shared/src/memory-index.ts`: the pure indexer, header and empty stub
- `apps/desktop/src/main/vault/hooks/memory-index.ts`: the pre-commit transform
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/hooks/memory-overview.mjs`: the `SessionStart` overview
- `apps/desktop/src/plugins/agent/main/claude/vault/shipped/.claude/skills/memory/SKILL.md`: the memory contract given to the agent
- `packages/shared/src/path-safety.ts`: `MEMORY_DIR`, `isAgentSurfacePath`
