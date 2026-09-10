# PRD — Daily Notes

A per-day journaling note, auto-created when you open your **personal** vault, seeded with a title, that you land on. A small but real v1 feature — and one that got substantially simpler when the server went away: creating today's note is now `if (!exists) write(seed)`.

Daily notes are **something the vault says it wants**, via `dailyNotes` in `.holi/settings/app.json` (D85). It defaults to on, and the onboarding step asks at vault creation, explaining that in a shared vault everyone writes the same file.

**This replaced a guess.** Until D85 the answer was inferred from the GitHub collaborator count: sole collaborator meant a daily note, more than one meant none, and every failed check counted as personal. The reasoning was sound (one owner means one author and one clock) but it answered a question nobody had been asked, cost a network round trip on every cold start, and was decided by a timeout when you were offline. The harm it guarded against is real and unchanged: two people in a shared vault both write `DD-MM-YYYY.md`, the same file. That is now something the user is told at the moment they choose, rather than something chosen for them.

---

## Summary

Every day, in a vault that keeps them, you get a **daily note** — `DD-MM-YYYY.md` at the vault root, seeded with `type: daily-note` frontmatter and a `# DD-MM-YYYY` title heading. On vault open, Holi creates it if it isn't there and navigates you to it. A sweep archives prior-day notes into `journal/` and deletes **untouched stubs** so empty dailies don't accumulate.

What came across from the old repo: the well-tested **untouched-stub heuristic** (`is_untouched_daily_note`), the seed-content shape (`buildDailyNoteContent`), and the root→`journal/` **archive move**, all now in `packages/shared/src/daily-note.ts` and `main/vault/daily.ts`. What did not: the orphan-rescue machinery the old move fed, which existed to serve a `source_file` that does not exist here.

---

## Goals / Non-goals

**Goals**
- Create today's daily note on vault open when `dailyNotes` is on, idempotently.
- Exactly one daily note per day, including across your own devices.
- Seed with `type: daily-note` frontmatter + title; treat an untouched stub as disposable.
- Archive prior-day notes into `journal/` to keep the vault root uncluttered, rewriting `[[links]]` on the move.
- Fast navigation: today's note **marked in the file tree**, a keyboard shortcut, and a task-count badge.
- **Work offline, completely.** This is a change from the previous design and it is a straight improvement.

**Non-goals**
- Daily notes in **shared** vaults — out of scope by design.
- The wiki-link grammar and rename internals — [`notes-editor.md`](notes-editor.md).
- Daily-note templates / configurable seed content — deferred post-v1 ([`../not-built.md`](../not-built.md)).
- Reminders about the daily note.

---

## User stories

- As a user, when I open a vault that keeps daily notes I get today's note, ready to jot; if it already exists I get the **same** note, not a second copy. Whether I *land* on it is `landing` (D85), which defaults to the daily.
- As a user, an empty daily note I never wrote in doesn't pile up as clutter.
- As a user, yesterday's note moves into `journal/` so my vault root stays clean, and links to it still resolve.
- As a user, I can see which file is today's note in the tree and jump to it from there or by shortcut, and see how many open tasks reference it.
- As a user on a plane, today's note is created anyway — because it's a file.

---

## Functional requirements

1. **Path shape.** `DD-MM-YYYY.md` at the vault **root**, where the date is the device's local date. Deterministic per date, so the path is the identity.
2. **Filename format** is old `dailyNoteFilename`'s: zero-padded `DD-MM-YYYY.md`. `isDailyNoteFilename` (`^\d{2}-\d{2}-\d{4}\.md$`) and `isDailyNote` (frontmatter `type: daily-note`) live in `packages/shared` as pure predicates.
3. **Seed content** is `buildDailyNoteContent`'s: frontmatter `type: daily-note`, `date: YYYY-MM-DD`, then a `# DD-MM-YYYY` title heading matching the stem. **The seed must be byte-for-byte deterministic** for a given date — see [Idempotency](#idempotency).
4. **Auto-create on open.** On vault open, when `dailyNotes` is on, create the file if absent. **Creating is not landing** (D85): the vault keeps its journal whether or not you open on it, and `landing` decides what you are actually looking at. Folding the two together means a vault pointed at its board quietly stops journalling, which is a hole in the record found weeks later. With `dailyNotes` off nothing is minted and nothing is swept, but **⌘⇧D still creates today's note on demand**: off means "stop doing this behind my back", not "the feature is gone".
5. **Stub GC + archive** run on open (§ Archiving).
6. **Navigation** surfaces (§ UX): a `today` marker on the note's row in the tree, shortcut, task-count badge.

---

## Idempotency

**Within a machine** it is a file existence check. There is no window to race in: one process, one filesystem, and the create is `writeFile` with `flag: 'wx'` so a lost race fails harmlessly instead of overwriting.

**Across your devices**, the guarantee comes from two properties together:

1. **The path is deterministic** — both devices compute `21-07-2026.md`.
2. **The seed is deterministic** — both devices write *identical bytes*.

So if your laptop and your desktop each create today's note before either syncs, git sees **the same blob at the same path** and merges them with **no conflict at all**. If one of them was then edited, git merges the edit against an identical base. Only if *both* were edited in the same region does it conflict, and that is an ordinary conflict on an ordinary file.

**This is why FR-3 says byte-for-byte.** A seed containing a timestamp, a random id, or a locale-dependent date rendering would turn a non-event into an add/add conflict every time you open two machines on the same morning. The determinism is load-bearing, not tidiness.

**What this replaces.** The old design made creation a server-arbitrated upsert against a unique `(vault_id, path)` index, and — because that index was the whole idempotency story — concluded that **daily notes must degrade offline** rather than risk two devices minting two Docs for one path with no arbitrator. Both the mechanism and its cost are gone: the filesystem plus a deterministic seed gives the same guarantee, offline, with no arbitrator.

---

## Timezone & "today"

**The device's local date.** A vault with one owner has one clock, and that clock is on the machine.

**Whose clock, in a shared vault, is not a question this answers.** A vault with `dailyNotes` on and several members has several clocks, and two of them on either side of midnight write different files. That is a real limit of the current shape, accepted rather than solved: the step warns that everyone writes the same file, and per-person daily paths (`daily/<login>/DD-MM-YYYY.md`) are the answer if it becomes a problem, deferred to the daily-note-as-dashboard rebuild where a personal surface wants a personal path anyway.

**Offline-complete is now structural rather than a fallback.** It used to rest on the collaborator check defaulting to "personal" when it threw, so daily notes worked on a plane by way of a timeout. There is no network call left on this path to fail.

Use a local-date formatter, **not `toISOString()`** — the latter is UTC and reports the wrong day on either side of local midnight, which is exactly when a daily-note feature is most likely to be used. `shared/dates.ts`'s `formatDate` is UTC-based and is for epoch math, not for asking a device what day it is.

- **Edge:** a session spanning local midnight — re-evaluate the date per call, so opening the vault after midnight lands on *tomorrow's* note.
- **A "home" timezone preference for travellers is deferred.** "Today" is already an *input* rather than something computed, so an override would only change who supplies the date — which is why it stays cheap to add and unmotivated until someone is annoyed by it.

---

## Archiving

Port the old sweep's ergonomics: (a) **move** the prior-day root note into `journal/`, (b) **delete untouched stubs**, (c) **rewrite `[[links]]`** so anchored notes follow the move.

**What the sweep looks at.** Daily notes are selected by their **`type: daily-note` frontmatter**, never by filename shape. The old sweep pattern-matched a directory listing because it had nothing else to go on; the frontmatter marker is written only by the seed, so only system-created notes are ever swept. Matching on the filename would let the sweep pick up a **hand-authored** note that merely looks like a date — and the GC, finding it empty, would delete a note the system never created. `isDailyNoteFilename` survives as a **display predicate only** (tagging tree leaves), never a sweep input.

**Archive move (a).** Today's note sits at the root; on a later day the prior-day note moves into `journal/`. The move goes through the **standard rename path**, so links are rewritten in the same pass ([`notes-editor.md`](notes-editor.md) FR-11). An archived daily keeps its `type: daily-note` frontmatter — that says what a note *is*, not where it lives; it is the **root-level filter** that stops the sweep re-archiving `journal/` forever, and that makes a re-run a no-op.

**Stub GC (b).** Delete a daily note when it is an **untouched stub**: the body after the frontmatter is **empty**, or is **only** the seeded `# DD-MM-YYYY` title (ported `is_untouched_daily_note`). Guardrails ported: a note that can't be positively classified as a stub is **never** deleted. **Backref guard:** delete a stub only if **nothing links to it** — a grep, now, rather than an index query. There is no orphan-rescue safety net (it served `source_file`), so GC must not create a dangling `[[link]]`. A referenced-but-empty daily note is kept and archived like any other.

**Link rewrite (c)** is folded into rename — there is no bespoke daily-archive rewrite path.

**Trigger, on vault open.** Archive prior-day notes and GC unreferenced stubs when a vault that keeps daily notes opens. The sweep stops with the minting when `dailyNotes` is off, and resumes where it left off if it is turned back on. Both steps are idempotent, so a re-run costs a directory listing.

**One consequence worth stating:** the sweep now produces **commits**. Archiving three notes and deleting two stubs is a real change to the repo. Batch the sweep into a **single commit** with a clear message (`Archive daily notes`), rather than letting the autosave debounce scatter it across several — this is the one place in the product where a background process rewrites the vault's shape, and it should read that way in the log.

---

## UX / flows

- **On vault open:** create-if-absent when `dailyNotes` is on; what you then land on is `landing` (D85), the daily by default. A vault that keeps no daily note and names no landing target opens on an empty pane, which is what a shared vault did before D85.
- **The tree marks today's note**, on the row the file actually occupies, with the open-task count beside it. It replaced a sidebar chip, and the reason is worth keeping: the chip named a file you could not see, sat a long way from it, and in a **shared vault** it was a control that did nothing at all — there is no daily note there to open. A marker on a row is absent in exactly that case, for free. **⌘⇧D still creates**, which matters because a marker cannot: it marks a file, and a file that does not exist has no row. In a vault that keeps daily notes that gap closes itself, since opening the vault creates the note (FR-4). In one that does not, ⌘⇧D is the whole feature and still works.
- **Keyboard shortcut:** a global shortcut opens today's daily note.
- **Task-count badge:** the "Today" entry shows a count of **open tasks that link to today's note** — a grep over task files for a wiki-link to the daily's path. Zero → no badge. **Linking-to, not due-today**, deliberately: the daily note is where you gather the day, so what belongs on it is what you have pointed at it. Due-today is a board question, and answering it here would put two different counts on two surfaces with no way to tell them apart. In a shared vault nothing links to the daily path, so the badge stays hidden.
- **Empty-state recovery:** if the panes reach zero tabs, "Open today's daily note" remains the recovery CTA.

---

## Edge cases & risks

- **Midnight rollover mid-session:** the date is re-evaluated per call, so after local midnight you get tomorrow's note.
- **Clock skew / wrong device clock:** the local date only shapes your own path — self-limiting, with no shared object to corrupt.
- **Referenced empty stub:** kept, not deleted (backref guard).
- **Two devices, same morning, both offline:** identical bytes at an identical path — git merges silently. See [Idempotency](#idempotency).
- **Two devices, same morning, both *edited*:** a genuine conflict on one file, handled by the vault's ordinary reconcile path ([`vaults-sync.md`](vaults-sync.md)). The blast radius is one day's note.
- ~~**A vault that becomes shared.**~~ **Resolved differently by D85.** The concern was that "personal" was an observation about a GitHub repo which could change without Holi being told, so a vault could quietly acquire a second author for the same `DD-MM-YYYY.md`. The proposed fix was to keep watching the collaborator count and stop auto-creating when it grew. What shipped instead removes the observation altogether: `dailyNotes` is a committed answer, so nothing drifts, and the collaborator count is no longer consulted on this path. The underlying collision (two members, one file) is unsolved and named as such under §Timezone; the step warns about it at the moment the choice is made.
- **The sweep running on a vault with unpushed work** — it commits like anything else, and the automatic push carries it out with everything else waiting.

---

## Dependencies

- **[`notes-editor.md`](notes-editor.md)** — the wiki-link grammar and the rename path the archive move reuses.
- **[`vaults-sync.md`](vaults-sync.md)** — the commit the sweep produces, and the conflict path for the two-devices-both-edited case.
- **[`tasks.md`](tasks.md)** — task files, which the badge greps for links to today's note.

---
