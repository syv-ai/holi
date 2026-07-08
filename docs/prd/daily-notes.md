# PRD — Daily Notes

A per-day journaling note, auto-created on vault activation, seeded with a title, that the user lands on. A small but real v1 feature (**D17**). In the new model a note is a **Yjs CRDT Doc** (**D1**), so "make today's daily note" is an **idempotent, server-arbitrated doc-create**, not a local file write — which also fixes the shared-vault problems (duplicate creation across members/devices, and disagreement about what "today" is) that the old single-user, machine-local-time flow never had to face. Decisions cited as **D#** live in [`../decisions.md`](../decisions.md).

---

## Summary

Every day, each user gets a **daily note** — a Doc named `DD-MM-YYYY` seeded with `type: daily-note` frontmatter and a `# DD-MM-YYYY` title heading. On vault activation the client asks the server to **get-or-create** that user's daily note for their local date; the server upserts a Doc keyed by a deterministic path, so concurrent calls from multiple devices — or, in a shared vault, multiple members — converge on **one** Doc with no duplicates. The user lands on it (sidebar "Today", shortcut). A server-side sweep garbage-collects **untouched stubs** (empty, or only the seeded title) so empty dailies don't accumulate.

Two old problems dissolve under the new model. The old flow (`ensureDailyNote`: `readFile` → on-miss `writeFile`) was a **client-side TOCTOU** that only survived because vaults were single-user, single-device; and it used **`chrono::Local`** ("today" = one machine's clock), which in a shared vault means members in different timezones disagree. Making daily notes **per-user** (§ Shared vs per-user) and creation **server-arbitrated** (§ Idempotent creation) resolves both.

This ports the well-tested **daily-note untouched-stub heuristic** (decisions.md "Carried forward"; old `daily_archive::is_untouched_daily_note`) and the seed-content shape, and drops the git-era **root→`journal/` archive move** and the **orphan-rescue** machinery it fed (killed with `source_file` in **D4**).

---

## Goals / Non-goals

**Goals**
- Auto-create today's daily note on vault activation, idempotently, and land the user on it.
- Exactly one daily note per user per day — no duplicates across devices or shared-vault members.
- A coherent, timezone-safe definition of "today" in a multi-user, multi-timezone vault.
- Seed with `type: daily-note` frontmatter + title; treat an untouched stub as disposable (GC, don't accumulate).
- Fast navigation: sidebar "Today" entry, a keyboard shortcut, and a task-count badge.

**Non-goals**
- The Doc/CRDT lifecycle, materialization, `docs` table, and `link_index` — **vaults-collaboration** / **server-data** PRDs (this PRD only names the daily-note-specific rules layered on top).
- The wiki-link grammar and `note_rename` op internals — **notes-editor** PRD.
- Task records, `related[]`, and the board — **server-data** / **tasks** PRDs.
- Daily-note templates / configurable seed content (a daily-note "template" beyond the title) — deferred post-v1.
- Recurring/scheduled *reminders* about the daily note — out of scope (**D19** covers task reminders only).

---

## User stories

- As a member, when I open a vault I land on today's daily note, ready to jot; if it already exists (I opened it earlier, or on another device) I get the **same** note, not a second copy.
- As two members in different timezones, we each get **our own** "today" — nobody's daily note flips a day early because a colleague's clock did.
- As a user, an empty daily note I never wrote in doesn't pile up as clutter — it's quietly cleaned up.
- As a user, I can jump to today's daily note from the sidebar or a shortcut, and see at a glance how many open tasks are attached to it.
- As a member, I can link to a colleague's daily note (`[[journal/alice/08-07-2026.md]]`) as a team log, and the link survives rename (**D12**).

---

## Functional requirements

1. **Path shape.** A daily note is a Doc at `journal/<handle>/DD-MM-YYYY.md`, where `<handle>` identifies the authoring user and `DD-MM-YYYY` is that user's local date. Deterministic per `(user, date)`, so the path is the idempotency key. In a personal vault (**D13**) there is a single handle; one code path for both vault kinds.
2. **Filename format** ports old `dailyNoteFilename`: zero-padded `DD-MM-YYYY.md`. The `isDailyNoteFilename` shape check (`^\d{2}-\d{2}-\d{4}\.md$`) and `isDailyNote` frontmatter check (`type: daily-note`) port to `packages/shared` as pure predicates.
3. **Seed content** ports `buildDailyNoteContent`: frontmatter `type: daily-note`, `date: YYYY-MM-DD` (plus `author`), then a `# DD-MM-YYYY` title heading matching the stem. Written as the Doc's **initial CRDT state** at create time (server-side), not a post-create edit.
4. **Auto-create on activation.** On vault activation the client calls a `getOrCreateDailyNote` op for the current user + their local date; the user is navigated to the returned Doc. Replaces the old vault-activation effect + `ensureDailyNoteAtom`. Per-session client-side dedup (the old `dailyNoteEnsured` promise cache, keyed by `(vaultId, date)`) still coalesces the redundant call sites (activation effect, empty-state CTA) into one round-trip, but is **no longer the correctness boundary** — the server is (§ Idempotent creation).
5. **Roles.** Creating/GC'ing a daily note requires **member+** (write). A **viewer** authors nothing, so gets no daily note and no auto-create (**D7**, server-side gating — same boundary as any Doc mutation).
6. **Stub GC** removes untouched, unreferenced daily-note stubs (§ Archiving).
7. **Navigation** surfaces (§ UX): sidebar "Today", shortcut, task-count badge.

---

## Idempotent creation (the shared-vault duplicate problem + solution)

**The problem.** Old `ensureDailyNote` did `readFile(path)`; on failure `writeFile(path, seed)` — a check-then-act **TOCTOU**. Two concurrent callers both miss the read and both write. Old code only papered over this with a client-side per-session promise cache (`dailyNoteEnsured`), which is per-process: it cannot coordinate a **second device** or a **second member**. Single-user + single-device made the race unobservable. A shared vault (**D1**) removes both assumptions — activation on two laptops at 09:00, or two members, would each mint a daily note.

**The solution — server-arbitrated upsert.** Because the path is deterministic per `(user, date)` and the `docs` table has a **unique constraint on `(vault_id, path)`** (server-data PRD), creation is a single idempotent op:

```
getOrCreateDailyNote(vaultId, localDate) -> { docId, path, created: bool }
  # server, inside one tx:
  #   path = journal/<caller-handle>/<localDate as DD-MM-YYYY>.md
  #   INSERT INTO docs (vault_id, path, kind='daily') ON CONFLICT (vault_id, path) DO NOTHING
  #   if inserted: initialize Yjs state with seed(frontmatter + title)
  #   return existing-or-new docId
```

The DB unique index serializes concurrent inserts; the loser's `ON CONFLICT DO NOTHING` yields the winner's row. Every caller — any device, any member — gets the **same `docId`**. No client cache, no read-then-write window, no arbitration protocol beyond the constraint. This is a plain-Doc create-with-known-path, so it can be a **native-tool** path (Claude/editor creating `journal/<handle>/DD-MM-YYYY.md` hits the same unique-path guard) — but the client uses the explicit op to get the seed + `kind='daily'` and the local-date resolution in one place. (Matches **D10**'s "only what isn't a plain file" only insofar as the seed/date logic is worth centralizing; the idempotency itself is just the path constraint.)

---

## Timezone & "today" (the shared-vault problem + recommendation)

**The problem.** Old code took "today" from `chrono::Local` — the executing machine's clock. In a single-user app that's unambiguous. In a shared vault, a member in Copenhagen and one in San Francisco disagree on the date for ~8 hours every day; a *shared* daily note would then be created twice (or worse, one member's note "is" the wrong day for the other).

**Recommendation — per-user "today" from the caller's local date.** Because daily notes are **per-user** (next section), each user's daily note is keyed by **their own** local date, so there is *no cross-user date to reconcile* — the disagreement simply has no shared object to be wrong about. The client passes its **device-local date** to `getOrCreateDailyNote`; the server trusts it only to form that caller's own path (it can't affect anyone else). This is the payoff of the per-user model: the timezone problem **dissolves** rather than needing a vault-wide timezone policy.

- **Optional refinement:** a per-user **timezone preference** (tier-2 UI pref, **D6**) for a user who wants a fixed "home" timezone while travelling; default = device-local. Not required for v1 correctness.
- **Edge:** a session spanning local midnight — the old `dailyNoteEnsured` cache keyed the date into its key precisely so a long-running session creates *tomorrow's* note after midnight; keep that (key on `(vaultId, localDate)`).

> Rejected: a single **vault-wide timezone** (would force one member's daily note onto another's clock — the exact problem) and **UTC "today"** (nobody journals in UTC; rolls at an arbitrary local hour).

---

## Shared vs per-user daily notes (recommend + justify)

**Recommendation: per-user authored, vault-visible Docs, namespaced by author.** Each user has their own daily note under `journal/<handle>/`; it is a normal **shared Doc** (tier-1 content, visible in the file tree and linkable), just **authored by one person**.

Justification:
- A daily note is a **personal scratchpad/journal** — the old single-user semantics. A single *shared team-daily* would dump every member's todos and jottings into one concurrently-edited page (workable under CRDT, but semantically a mess) **and** reintroduce the timezone collision (whose "today"?). Per-user sidesteps both.
- It must remain a **normal Doc**, not a tier-2 *private* artifact: keeping it in the shared file tree means wiki-links from shared notes/tasks into a daily note (`[[journal/alice/08-07-2026.md]]`) resolve, backrefs work, and a colleague's journal is readable as a **team log** — a feature, not a leak. (Per-user *private* config lives in tier-2; daily notes are per-user *authored* but tier-1 *visible*.)
- One code path for personal and shared vaults (**D13**): a personal vault is just the degenerate single-handle case.

> Rejected: **one shared team-daily per vault** (timezone collision returns; muddled semantics) and **tier-2-private per-user dailies** (breaks wiki-links/backrefs into them; can't be a team log).

---

## Archiving (stub heuristic, link rewrite, trigger)

The old sweep did three things: (a) **move** yesterday's root `DD-MM-YYYY.md` into `journal/`, (b) **delete untouched stubs**, (c) **rewrite `[[links]]`** so anchored tasks/notes followed the move, plus an orphan-heal for pre-fix data.

**The move (a) goes away.** It existed only to keep a single-user vault's **root uncluttered** while today's note sat at root. In the new model daily notes are created **directly under `journal/<handle>/`** — already organized by author and date — so there is nothing to relocate. That also removes the archive-time link rewrite as a routine event.

**Stub GC (b) stays — this is the ported heuristic.** A server-side sweep deletes a daily note when it is an **untouched stub**: body after the frontmatter is **empty**, or is **only** the seeded `# DD-MM-YYYY` title (ported `is_untouched_daily_note`, evaluated against the Doc's materialized CRDT text). Guardrails ported: a Doc that can't be classified as a stub is **never** deleted; only positively-identified empty stubs go. **New guard:** delete a stub only if it has **zero backreferences** (`link_index`, server-data PRD) — the old orphan-rescue safety net is gone (killed with `source_file`, **D4**), so GC must not create a dangling `[[link]]`. A referenced-but-empty daily note is kept.

**Link rewrite (c) — only if a note_rename ever moves a daily note.** Should a daily note be renamed or relocated for any reason, it goes through the standard **atomic server-side `note_rename`** (**D12**): the path change + every referencing `[[link]]` rewrite happen in one pass over the affected CRDT Docs, preserving Doc identity. There is no bespoke daily-archive rewrite path — daily notes reuse the one rename mechanism. The old distributed-git rewrite conflict (N clients colliding) is gone by construction.

**Trigger — on-activation server op (per user), optionally a nightly cron.** Port the old "runs on vault activation" ergonomics: on activation the client calls `gcDailyStubs()` scoped to the **caller's own** prior-day daily notes (a member can only GC their own; server-enforced). Because it's per-user, no cross-user coordination is needed. A low-frequency server cron may additionally reap stubs for users who haven't opened the vault; both paths are idempotent (delete-if-still-an-unreferenced-stub). Orphan-heal for pre-fix data (old `heal_pre_fix_orphan_source_files`) is **dropped** — no legacy data (clean slate, **D16**).

---

## UX / flows

- **On vault activation:** `getOrCreateDailyNote(vaultId, deviceLocalDate)` → open the returned Doc, navigate to the editor. Ports the old activation effect (`ensureDaily().then(openFile … navigate('editor'))`), now server-idempotent.
- **Sidebar "Today":** a dedicated entry that opens today's daily note (get-or-create). Ports the old sidebar daily-note entry / empty-state "Open today's daily note" CTA (the last-tab-close recovery surface).
- **Keyboard shortcut:** a global shortcut opens today's daily note (registered alongside the other global shortcuts).
- **Task-count badge:** the "Today" entry shows a count of **open tasks whose `related[]` references today's daily note** (server query; live via the task subscription). Zero → no badge. (Exact predicate — related-to vs due-today — finalized with tasks PRD; default: related-to.)
- **Empty-state recovery:** if the panes ever reach zero tabs, the "Open today's daily note" button remains the recovery CTA (ports old behavior), routed through the same get-or-create.

---

## Edge cases & risks

- **Midnight rollover mid-session:** date is re-evaluated per call and keyed into the client dedup cache → after local midnight, activation/CTA create *tomorrow's* note (ported intent).
- **Clock skew / wrong device clock:** the client-supplied local date only ever shapes the **caller's own** path, so a bad clock affects only that user's own daily note (self-limiting) — not a shared object.
- **Viewer role:** no auto-create, no GC; a viewer simply never has a daily note in that vault (correct — they don't author).
- **Referenced empty stub:** kept, not deleted (backref guard) — avoids dangling links now that orphan-rescue is gone.
- **Offline activation:** get-or-create is a server op; offline, the client can create the daily Doc in the **local Yjs cache** at the deterministic path and reconcile on reconnect. Risk: two offline devices create the *same-path* daily Doc → on reconnect two Docs claim one `(vault_id, path)`. Mitigation: the server merges same-path daily Docs on sync (union their CRDT state) or rejects the later insert and rebinds the client; must be handled by the sync/bridge layer (vaults-collaboration) — **flag** below.
- **JSONL / history coupling:** none here — daily notes are Docs, unrelated to the chat-history reconstruction risk (**D9**).
- **Handle stability:** `<handle>` must be stable per user (derive from the immutable Google identity, not a display name that can change) or historical daily-note paths drift. Use a stable id/slug.

---

## Dependencies

- **vaults-collaboration** — Doc lifecycle, working-copy materialization, offline Yjs cache + reconnect merge (the same-path offline-create edge), `link_index` for backref checks, folder hierarchy (`journal/<handle>/`).
- **notes-editor** — CRDT Doc + editor, wiki-link grammar (`packages/shared`), the `note_rename` atomic op (**D12**) reused for any daily-note relocation.
- **server-data** — `docs` table + **unique `(vault_id, path)`** constraint (the idempotency guarantee), `kind='daily'`, backref query, role gating (**D7**).
- **tasks** — `related[]` and the task subscription that feeds the task-count badge; final badge predicate.

---

## Open questions

1. **Offline duplicate daily Docs.** If two of a user's devices both create today's daily note offline at the same deterministic path, how does sync reconcile — server-side same-path merge (union CRDT state) or reject-and-rebind? Needs a decision in vaults-collaboration; affects whether the client may optimistically create offline or must degrade to "daily note unavailable offline."
2. **Task-count badge semantics.** Tasks *related to* today's daily note vs tasks *due today*? Defaulting to related-to; confirm with tasks PRD.
3. **Do we still want a "today at a prominent path"?** The per-user-folder model drops the root→`journal/` move. If product wants today's note surfaced at a fixed prominent path (not just via the sidebar), reintroducing a move brings back a routine `note_rename` (**D12**) at day-rollover. Recommendation: no — sidebar/shortcut is enough; flagged in case product disagrees.
4. **Per-user timezone override** (tier-2 pref) — ship in v1 or defer? Default device-local is correct for the common case; the override only matters for travellers.
