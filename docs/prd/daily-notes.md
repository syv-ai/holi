# PRD — Daily Notes

A per-day journaling note, auto-created when you open your **personal** vault, seeded with a title, that you land on. A small but real v1 feature — and one that got substantially simpler when the server went away: creating today's note is now `if (!exists) write(seed)`.

Daily notes are **personal-vault-only**: auto-created only in a vault you are the sole collaborator on, never in a shared one. Why: personal-only sidesteps duplicate creation across members, cross-timezone disagreement about "today", and visibility questions entirely — one owner means one author and one clock, and "today's note" is always yours.

---

## Summary

Every day, in your **personal** vault, you get a **daily note** — `DD-MM-YYYY.md` at the vault root, seeded with `type: daily-note` frontmatter and a `# DD-MM-YYYY` title heading. On vault open, Holi creates it if it isn't there and navigates you to it. A sweep archives prior-day notes into `journal/` and deletes **untouched stubs** so empty dailies don't accumulate.

Porting notes: port the well-tested **untouched-stub heuristic** (old `is_untouched_daily_note`), the seed-content shape (`buildDailyNoteContent`), and the root→`journal/` **archive move**. Do **not** port the orphan-rescue machinery the old move fed — it existed to serve `source_file`, which does not exist.

---

## Goals / Non-goals

**Goals**
- Create today's daily note on personal-vault open, idempotently, and land on it.
- Exactly one daily note per day, including across your own devices.
- Seed with `type: daily-note` frontmatter + title; treat an untouched stub as disposable.
- Archive prior-day notes into `journal/` to keep the vault root uncluttered, rewriting `[[links]]` on the move.
- Fast navigation: sidebar "Today", a keyboard shortcut, and a task-count badge.
- **Work offline, completely.** This is a change from the previous design and it is a straight improvement.

**Non-goals**
- Daily notes in **shared** vaults — out of scope by design.
- The wiki-link grammar and rename internals — [`notes-editor.md`](notes-editor.md).
- Daily-note templates / configurable seed content — deferred post-v1 ([`../roadmap.md`](../roadmap.md)).
- Reminders about the daily note.

---

## User stories

- As a user, when I open my personal vault I land on today's daily note, ready to jot; if it already exists I get the **same** note, not a second copy.
- As a user, an empty daily note I never wrote in doesn't pile up as clutter.
- As a user, yesterday's note moves into `journal/` so my vault root stays clean, and links to it still resolve.
- As a user, I can jump to today's note from the sidebar or a shortcut, and see how many open tasks reference it.
- As a user on a plane, today's note is created anyway — because it's a file.

---

## Functional requirements

1. **Path shape.** `DD-MM-YYYY.md` at the personal-vault **root**, where the date is the device's local date. Deterministic per date, so the path is the identity.
2. **Filename format** ports old `dailyNoteFilename`: zero-padded `DD-MM-YYYY.md`. `isDailyNoteFilename` (`^\d{2}-\d{2}-\d{4}\.md$`) and `isDailyNote` (frontmatter `type: daily-note`) port to `packages/shared` as pure predicates.
3. **Seed content** ports `buildDailyNoteContent`: frontmatter `type: daily-note`, `date: YYYY-MM-DD`, then a `# DD-MM-YYYY` title heading matching the stem. **The seed must be byte-for-byte deterministic** for a given date — see [Idempotency](#idempotency).
4. **Auto-create on open.** On personal-vault open, create the file if absent and navigate to it. Shared-vault open does **not** create a daily note.
5. **Stub GC + archive** run on open (§ Archiving).
6. **Navigation** surfaces (§ UX): sidebar "Today", shortcut, task-count badge.

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

**The device's local date.** A personal vault has a single owner and therefore a single clock, and that clock is on the machine.

**And a vault is personal unless Holi positively knows otherwise** — more than one GitHub collaborator, checked when online. **Every failure defaults to personal**: offline, signed out, or a failed request all leave you with a daily note rather than without one, because the cost of a stray daily note in a shared vault is a file you delete, and the cost of the reverse is a feature that silently stops working on a plane. There is **no local "this vault is personal" override**; it was the leaning and it did not ship, because a marker that can drift from the collaborator list is a second answer to a question that already has one.

Use a local-date formatter, **not `toISOString()`** — the latter is UTC and reports the wrong day on either side of local midnight, which is exactly when a daily-note feature is most likely to be used. `shared/dates.ts`'s `formatDate` is UTC-based and is for epoch math, not for asking a device what day it is.

- **Edge:** a session spanning local midnight — re-evaluate the date per call, so opening the vault after midnight lands on *tomorrow's* note.
- **A "home" timezone preference for travellers is deferred** ([`../roadmap.md`](../roadmap.md)). "Today" is already an *input* rather than something computed, so an override would only change who supplies the date — which is why it stays cheap to add and unmotivated until someone is annoyed by it.

---

## Archiving

Port the old sweep's ergonomics: (a) **move** the prior-day root note into `journal/`, (b) **delete untouched stubs**, (c) **rewrite `[[links]]`** so anchored notes follow the move.

**What the sweep looks at.** Daily notes are selected by their **`type: daily-note` frontmatter**, never by filename shape. The old sweep pattern-matched a directory listing because it had nothing else to go on; the frontmatter marker is written only by the seed, so only system-created notes are ever swept. Matching on the filename would let the sweep pick up a **hand-authored** note that merely looks like a date — and the GC, finding it empty, would delete a note the system never created. `isDailyNoteFilename` survives as a **display predicate only** (tagging tree leaves), never a sweep input.

**Archive move (a).** Today's note sits at the root; on a later day the prior-day note moves into `journal/`. The move goes through the **standard rename path**, so links are rewritten in the same pass ([`notes-editor.md`](notes-editor.md) FR-11). An archived daily keeps its `type: daily-note` frontmatter — that says what a note *is*, not where it lives; it is the **root-level filter** that stops the sweep re-archiving `journal/` forever, and that makes a re-run a no-op.

**Stub GC (b).** Delete a daily note when it is an **untouched stub**: the body after the frontmatter is **empty**, or is **only** the seeded `# DD-MM-YYYY` title (ported `is_untouched_daily_note`). Guardrails ported: a note that can't be positively classified as a stub is **never** deleted. **Backref guard:** delete a stub only if **nothing links to it** — a grep, now, rather than an index query. There is no orphan-rescue safety net (it served `source_file`), so GC must not create a dangling `[[link]]`. A referenced-but-empty daily note is kept and archived like any other.

**Link rewrite (c)** is folded into rename — there is no bespoke daily-archive rewrite path.

**Trigger — on vault open.** Archive prior-day notes and GC unreferenced stubs when the personal vault opens. Both steps are idempotent, so a re-run costs a directory listing.

**One consequence worth stating:** the sweep now produces **commits**. Archiving three notes and deleting two stubs is a real change to the repo. Batch the sweep into a **single commit** with a clear message (`Archive daily notes`), rather than letting the autosave debounce scatter it across several — this is the one place in the product where a background process rewrites the vault's shape, and it should read that way in the log.

---

## UX / flows

- **On personal-vault open:** create-if-absent → open the note → navigate to the editor. (Shared-vault open lands on the last-viewed surface, no daily note.)
- **Sidebar "Today":** a dedicated entry (personal vault only) that opens today's daily note, creating it if needed.
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
- **A vault that becomes shared.** A personal vault is "personal" because it has one collaborator — which can change on GitHub without Holi being told. Adding a collaborator to a vault with daily notes reintroduces every problem personal-only scoping avoids. Holi should stop auto-creating dailies once a vault has more than one collaborator, and say why. *(This is a new edge the old design could not have: "personal" used to be a `kind` column the server owned, and now it is an observation about a GitHub repo.)*
- **The sweep running on a vault with unpushed work** — it commits like anything else, and the automatic push carries it out with everything else waiting.

---

## Dependencies

- **[`notes-editor.md`](notes-editor.md)** — the wiki-link grammar and the rename path the archive move reuses.
- **[`vaults-sync.md`](vaults-sync.md)** — the commit the sweep produces, and the conflict path for the two-devices-both-edited case.
- **[`tasks.md`](tasks.md)** — task files, which the badge greps for links to today's note.

---
