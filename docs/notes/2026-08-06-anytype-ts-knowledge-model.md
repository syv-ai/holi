# anytype-ts — the knowledge model, and what beats Obsidian

Companion to [`2026-08-06-anytype-ts-learnings.md`](2026-08-06-anytype-ts-learnings.md), which covers
the engineering. That note said the product overlap yields little because the architectures diverge.
That was too quick: the architecture doesn't transfer, but **several of the product ideas it enables
are reachable from files and a grep**, and one of them is the best idea in the repo.

Same source: `anyproto/anytype-ts` @ `775df05` (v0.56.1), reviewed 2026-08-06. Same licence
constraint — Any Source Available 1.0, commercial use only on Allowed Networks, so nothing is
copyable and everything below is an idea to reimplement.

---

## The one-sentence difference

**Obsidian treats properties as a convention; Anytype treats them as a schema.**

Frontmatter in Obsidian is text that some plugins agree to read. In Anytype a property (they call it
a *relation*) is itself an object, with a format (`RelationType`: LongText, Number, Select, Date,
Checkbox, Url, MultiSelect, Object…), a scope (`RelationScope`: Object / Type /
SetOfTheSameType / ObjectsOfTheSameType / Library — `interface/object.ts:36-58`), and a bidirectional
index behind it. Types are objects. Select options are objects. Dates are objects.

Everything they do better than Obsidian is a consequence of that one move. So the useful question for
Holi is not "should we build a schema" — D60 settled that, and `architecture.md` §8 says *there isn't
a data model* — but **which consequences survive without one.** Most of the good ones do, because
they turn out to be queries, and Holi's substrate answers queries with a glob and a grep.

Confirmation that we're on the right substrate: their own Obsidian importer states the mapping
(`src/json/text.json:1310-1311`) — *"`[[Internal Links]]` → become linked objects… Frontmatter (the
`---` metadata at the top) → becomes object properties."* **Holi already is their import format.**

---

## The standout features, ranked by what we could actually have

### 1. Dates are objects, and a date's page is a query — `src/ts/component/page/main/date.tsx`

The best idea in the product, and the one I'd take first.

There is no "daily note file". Every calendar day is an auto-materialised object, and opening it
calls `RelationListWithValue(space, rootId)` (`:69`) — *"which properties, anywhere in this space,
hold this date as a value"* — and renders the answer as **categories you switch between**:

- `mentions` is pinned first (`:77`, `:89-92`) — everything that named the date in prose.
- `links` and `backlinks` are explicitly **excluded** (`:81-83`): a generic link is not a
  relationship to the *day*, and including it would drown the useful categories.
- Everything else — `dueDate`, `createdDate`, and any user-defined date property — becomes its own
  tab, filtered `>= startOfDay AND <= endOfDay` (`:120-142`).
- A **dot map** (`:144`) marks which days in the surrounding month have anything at all, so the
  calendar itself shows where the density is.

Obsidian's daily note is a file you write into, and its backlinks pane is one undifferentiated list.
Anytype's is a **report you look at, grouped by why each thing is here**. "What's due today", "what
did I create today", and "what did I mention today" are three different questions and it answers them
separately.

**Holi can have most of this without a schema, and cheaply.** Every input already exists:

- `due:` is in the task grammar (`packages/shared/src/task-file.ts:60`) and every task is one glob away.
- Daily notes already live at deterministic paths with an untouched-stub heuristic
  (`prd/daily-notes.md`).
- Backrefs are already specified as a grep (`architecture.md` §7) — *"a local vault greps in
  milliseconds, and an index would be a second copy of the truth that can go stale"*.
- `git log --since --until` gives created/modified-on-this-day for free, which is the one category
  they need a database for and we get from the sync engine we already built.

So: **render the daily note page as the stub you type into *plus* three computed sections above or
beside it** — tasks due today (glob + parse), notes touched today (`git log`), and notes mentioning
this date (grep). All three are cold reads with no stored state, no midnight write, and no commit —
which is the same reasoning that keeps `overdue` and `p1` computed at render rather than stored
(`prd/tasks.md:122`). It extends that principle rather than fighting it.

This is the single highest value-to-cost item in the whole review.

### 2. Query and Collection are different things, and convert into each other

A **Set/Query** is a saved query (`setOf` a type or relation). A **Collection** is a hand-curated
list. They are distinct object layouts (`ObjectLayout.Set = 3`, `ObjectLayout.Collection = 14`), and
the menu offers **"Turn Query into Collection"** (`text.json:889`) — freeze a query's current result
into an editable list.

Obsidian's Dataview gives you the query and stops. A curated list is a separate file of links with no
relationship to the query that suggested it, and no way to go from one to the other.

For Holi this is the generalisation of the board. `prd/tasks.md` gives us exactly one query —
all `task.*.md`, lanes by folder, three filter controls — and FR-121 deliberately refuses to let the
filter bar become "a second configuration surface". I think that refusal is right **for the user**
and wrong **for the agent**: the reason not to ship a query builder is that configuring views is
work the user shouldn't have to do, and that argument evaporates when the thing writing the query is
the assistant. A saved view as a committed file — greppable, diffable, agent-authorable, reviewed in
a PR like everything else — costs no UI at all.

**If we do it:** a view is a markdown file with the query in frontmatter, not a `.json` in `.holi/`.
Same reasoning as tasks — it stays readable, the agent authors it natively, and `git diff` shows what
changed.

### 3. A type declares which properties matter, in tiers — `src/ts/lib/util/object.ts:829-844`

A type carries four separate property lists: `recommendedRelations` (offered when you fill an object
in), `recommendedFeaturedRelations` (rendered in the object's header, always visible),
`recommendedHiddenRelations`, and `recommendedFileRelations`. Plus `headerRelationsLayout` for how
the featured ones render (`component/block/featured.tsx:305`).

This is the answer to the problem every Obsidian vault eventually has: frontmatter sprawls, nothing
says which keys are meaningful for this kind of note, and no two notes of the same kind agree.

Holi has exactly two schemas today, at opposite extremes:

- **Tasks** — closed, validated, 7 keys, rejected on malformed input (`task-file.ts:60,187-208`).
- **Notes** — nothing. `editor/frontmatter.ts` renders frontmatter as a collapsible pill and
  validates only that the YAML *parses* (the status dot goes red and the save is held off); it has no
  opinion about keys.

The gap in the middle is where a contract, a bid, or an exit report lives — exactly the documents
`vision.md` names as the point of the Syv vault.

**The cheap version already exists in our own repo.** `specs/2026-07-26-typed-template-fields-design.md`
defines a six-type field vocabulary (`text`, `textarea`, `date`, `select`, `number`, `checkbox`)
where the declared type compiles a widget, coerces a value, and treats an unknown type as `text` so
old manifests keep working. It is aimed at Typst PDF export. **Pointing that same manifest at note
frontmatter** — a `.holi/note-types/<kind>.json` declaring which keys a kind of note has, which are
featured, and what each one is — reuses the vocabulary and the widget compiler wholesale. It stays a
*suggestion* rather than a gate, which is the right posture for a vault where the agent and a human
both write files by hand.

### 4. Templates bind to a view, not only to a type

`defaultTemplateId` exists on a type *and* on a dataview view, with a menu item literally called
**"Template for this View"** (`text.json:2102`, `:2086`). Creating a card in the *In Review* column of
a board instantiates a different template than creating one in *Backlog*.

Obsidian's Templater must be invoked; it is never implied by where you created the thing.

Holi's quick-add writes a bare `task.<slug>.md` carrying that column's status (`prd/tasks.md:134`).
A per-lane seed — *tasks created in `projects/` start with these frontmatter keys and this body* —
is a small extension of the seeding machinery already in `main/agent/seed-content.ts`, and it fits
the "folder is the lane" model: the folder already determines the lane, so letting it determine the
seed is the same idea one step further.

### 5. Orphan cleanup is a first-class surface — `src/ts/component/page/main/archiveSuggested.tsx`

The Bin has a **Suggestions** tab. When you bin something, whatever it orphaned shows up there —
grouped by *the source object that orphaned them*, each group carrying the **reason** it is orphaned
(`:112-131`), with a persistent per-item **ignore** (`ObjectCleanupSuggestionIgnore`, `:240`) so it
stops nagging about the ones you meant to keep.

Obsidian leaves orphaned attachments in the vault forever; finding them is a community plugin.

Holi's version of this problem is concrete and, again, greppable:

- **Broken wiki-links** — `[[folder/note.md]]` whose target no longer exists. One parse
  (`packages/shared/wiki-links`) plus one `existsSync` per target.
- **Unreferenced inline images** — `specs/2026-07-26-inline-images-design.md` puts real files in the
  vault; deleting the note that used them leaves the bytes, and
  `specs/2026-08-03-large-binary-policy-design.md` already establishes we care about what gets
  committed.
- **Tasks whose lane vanished** — a `task.*.md` in a folder nothing else references.

Worth being precise about what git does and doesn't cover here: git makes the **deletion** safe
(`git revert` is the recovery story, `architecture.md` §10) and does nothing at all about the
**dangling reference**. The rename path rewrites inbound links (`prd/notes-editor.md`); the *delete*
path leaves them broken by design, and `architecture.md` §5 already books the skill-driven rename as
non-atomic and able to miss a link. A cheap "N broken links in this vault" surface is the check that
catches both.

---

## Two more worth naming

### A local API with revocable keys and one-click MCP config — `component/page/main/settings/api.tsx`

Settings → API Keys: create a named key, **Copy Key**, **Copy MCP Config**, **Revoke** (`:29-31`).
The MCP config is a ready-to-paste block (`src/json/constant.ts:229-241`) running
`npx -y @anyproto/anytype-mcp` against a local OpenAPI-derived server, with a **dated API version
header** (`Anytype-Version: 2025-11-08`) alongside the bearer token.

This is the exact opposite of our D60 §10 ("the MCP server is deleted") — and **our call is still
right, for a reason worth stating**: they *must* expose an API because their data lives in a Go
middleware behind gRPC and no agent can read it otherwise. Holi's data is markdown on disk, which
Claude Code reads natively, so an op surface would be a worse copy of `Glob` and `Read`.

But `architecture.md` §5 already predicts the exception — *"Phase 2's calendar and mail are the one
category expected to need an MCP server again, because that data is not in the repo"* — and that is
now live work (`specs/2026-08-05-agent-google-writes-design.md`). When it grows a key: **the
key/scope/revoke/copy-config UX is the shape to copy, and the dated version header is the detail most
people skip.** Not the ops.

### A gallery of starter spaces — `gallery.any.coop`, `usecaseCategory*` (`text.json:606-620`)

Installable pre-built spaces by category (Project tracking, Work, Education…), including a
*Made by Any* set. It's how a new user gets a populated vault instead of a blank one.

Holi's analogue is nearly free and much simpler, because git already has the mechanism: **create a
vault from a GitHub template repo.** `vision.md:11` already points at `syv-ai/1brain` as the example
shared vault, auth is already GitHub, and cloning is already what vault creation does
(`prd/auth-identity.md:137`). "New vault from template" is a different source URL for a clone we
already perform — no gallery service, no import format, no installer.

---

## What is worse than Obsidian, and why it validates our bet

- **The round trip is lossy in both directions.** Import is markdown → objects
  (`settings/import/obsidian.tsx`), export is `export/markdown.tsx` or `export/protobuf.tsx`. You put
  markdown in and get an encrypted object database; getting markdown back out is a second, different
  conversion. Every idea above is bought with that trade.
- **The block model is expensive.** 62 block components, ~50 context menus, ~27 popup dialogs, a
  1,900-line dataview and a 1,659-line text block. That is the price of "everything is a composable
  block", and `vision.md`'s principle 4 — *one obvious way to do the common thing* — is the opposite
  bet, deliberately.
- **Nothing outside the app can read it.** No `grep`, no `git log`, no `git diff`, and no Claude Code
  reading the raw bytes — which is why they had to ship an MCP server to get an agent near their own
  data, and why we didn't.

The pattern across all five features above is the same: **each one is a view over data we already
have.** They needed an object store to get a typed property graph. We can get most of the same
*answers* from a glob, a grep, and `git log` — and keep the files legible to every tool the user and
the agent already own.

---

## Shortlist

1. **Date pages** (item 1) — biggest knowledge-management win in the repo, and every input already
   exists in Holi. Tasks due today + `git log` for today + a grep for the date, rendered above the
   daily stub. No stored state, no midnight write.
2. **Point the typed-template-fields vocabulary at note frontmatter** (item 3) — the six types and
   the widget compiler are already specced for PDF export; reusing them as a *suggested* note schema
   closes the gap between the closed task grammar and untyped note frontmatter.
3. **A broken-links / orphan surface** (item 5) — one parse and one `exists` per link. Git covers
   the delete; nothing currently covers the dangling reference.
