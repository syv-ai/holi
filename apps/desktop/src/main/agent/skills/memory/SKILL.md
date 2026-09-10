---
name: memory
description: Write and organise this vault's memory — one fact per file under memory/, typed and indexed. Use whenever you learn something the vault will want again, when asked to remember or note something, or when splitting a legacy MEMORY.md or USER.local.md into the directory.
---

# Remember something in this vault

A memory is **one fact in one file** under `memory/` at the vault root. Write one
whenever you learn something this vault will want again: a convention, an
environment quirk, a fact about a person, a decision and why.

`memory/` is ordinary vault content. It is committed, it syncs to everyone who
clones the vault, and it is readable in Holi like any note.

## Writing one

Create `memory/<short-kebab-name>.md`:

```markdown
---
type: environment
description: bare node and npx are broken here, always pnpm exec
---

The nvm shim is not on PATH for processes Holi spawns, so `node` and `npx`
resolve to nothing. Use `pnpm exec` for every tool.
```

Three keys, all soft:

- **`type`** — one short free-form word. `convention`, `environment`, `person`,
  `project`, `reference` and `preference` are a starting set, **not** a closed
  list; invent one when none fits. It becomes the `## heading` this memory is
  grouped under in the index. Missing, it is filed as `note`.
- **`description`** — one line. This is what the index and the session overview
  print, so **a memory without one is a memory nobody finds**. Missing, the
  body's first sentence is used instead.
- **`title`** — optional. Falls back to the body's H1, then the filename.

Anything else you add is preserved and ignored. The body is the fact. Link other
memories with ordinary wiki-links: `[[memory/other-fact.md]]`.

## Shared or personal — the filename decides, nothing else

- `memory/pnpm-exec.md` is **shared**. Committed, indexed, everyone sees it.
- `memory/ada-roles.local.md` is **personal**. The `.local.` makes it
  gitignored, so it never leaves this clone, and it never appears in the
  committed index. It still reaches you: the session overview lists personal
  memories separately, and that overview is the only reader such a file has.

**Anything about one individual goes in a `.local.md`.** Their role, their
preferences, how they like to be written to, what they are working on. Not
because it is secret, but because it is a model of a person and a shared vault
should not carry one person's model of another.

## What you do not do

- **Do not edit `memory/index.md`.** It is generated on every commit that touches
  a memory, so an edit to it is discarded silently. Edit the memory files.
- **Do not create the directory or the index.** Both already exist in every
  vault.
- **Do not batch memories into one file.** One fact per file is what makes the
  index useful and what makes two people writing memory on the same afternoon
  merge cleanly instead of conflicting.
- **Do not reorganise or consolidate shared memory unasked.** Rewriting what
  someone else recorded is a change to shared state; propose it instead.

## The older shape

Some vaults still carry a root **`MEMORY.md`**, and some a **`USER.local.md`**.
Both still work and are still read. Neither is written to any more:

- `MEMORY.md` was one shared file with a character budget nothing measured.
- `USER.local.md` was one personal file. It is never auto-loaded, appears in no
  index and in no overview, so a fact in it is one you have to remember to go and
  look for. `memory/<name>.local.md` is announced to you at the start of every
  session, which is the whole difference.

**Splitting either into `memory/` is worth doing, and only when the user asks.**
Never migrate one unprompted: it is content they wrote, and moving it is a change
to shared state, not tidying. When asked, one fact per file, keep the original
until they confirm, and give each new file a `type` and a `description`.
