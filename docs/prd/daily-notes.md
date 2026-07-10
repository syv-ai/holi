# PRD — Daily Notes

A per-day journaling note, auto-created on activation of your **personal** vault, seeded with a title, that you land on. A small but real v1 feature (**D17**). Daily notes are **personal-vault-only** (**D24**): auto-created only in your own personal vault, never in a shared vault. That single decision dissolves the hard problems the shared-vault version had to face (duplicate creation across members, cross-user disagreement about "today", visibility) — a personal vault has exactly one owner (**D13**), so there is only ever one author and one clock. In the new model a note is a **Yjs CRDT Doc** (**D1**), so "make today's daily note" is an **idempotent, server-arbitrated doc-create**, not a local file write. Decisions cited as **D#** live in [`../decisions.md`](../decisions.md).

---

## Summary

Every day, in your **personal** vault, you get a **daily note** — a Doc named `DD-MM-YYYY` at the vault root, seeded with `type: daily-note` frontmatter and a `# DD-MM-YYYY` title heading (exactly as the old single-user app did). On activation the client asks the server to **get-or-create** today's daily note for your local date; the server upserts a Doc keyed by a deterministic path, so concurrent activations from **your laptop and desktop** converge on **one** Doc with no duplicates. You land on it (sidebar "Today", shortcut). A server-side sweep archives yesterday's note into `journal/` and garbage-collects **untouched stubs** so empty dailies don't accumulate.

Because daily notes live only in the personal vault (**D24**), the shared-vault problems the CRDT model would otherwise raise never arise: there are no other members to race on creation, and no other clock to disagree with about the date. The remaining correctness concern is narrow — the **same** user on **multiple devices** — and it is handled by making creation **server-arbitrated** (§ Idempotent creation).

This ports the well-tested **daily-note untouched-stub heuristic** (decisions.md "Carried forward"; old `is_untouched_daily_note`), the seed-content shape, and the root→`journal/` **archive move**, and drops the **orphan-rescue** machinery the old move fed (killed with `source_file` in **D4**).

---

## Goals / Non-goals

**Goals**
- Auto-create today's daily note on personal-vault activation, idempotently, and land on it.
- Exactly one daily note per day — no duplicates across your devices.
- Seed with `type: daily-note` frontmatter + title; treat an untouched stub as disposable (GC, don't accumulate).
- Archive prior-day notes into `journal/` to keep the vault root uncluttered; rewrite any `[[links]]` atomically on the move (**D12**).
- Fast navigation: sidebar "Today" entry, a keyboard shortcut, and a task-count badge.

**Non-goals**
- Daily notes in **shared** vaults — resolved as out of scope (**D24**); this PRD is personal-vault-only.
- The Doc/CRDT lifecycle, materialization, `docs` table, and `link_index` — **vaults-collaboration** / **server-data** PRDs (this PRD only names the daily-note-specific rules layered on top).
- The wiki-link grammar and `note_rename` op internals — **notes-editor** PRD.
- Task records, `related[]`, and the board — **server-data** / **tasks** PRDs.
- Daily-note templates / configurable seed content — deferred post-v1.
- Recurring/scheduled *reminders* about the daily note — out of scope (**D19** covers task reminders only).

---

## User stories

- As a user, when I open my personal vault I land on today's daily note, ready to jot; if it already exists (I opened it earlier, or on another device) I get the **same** note, not a second copy.
- As a user, an empty daily note I never wrote in doesn't pile up as clutter — it's quietly cleaned up.
- As a user, yesterday's note moves into `journal/` so my vault root stays clean, and any note or task I linked to it still resolves after the move.
- As a user, I can jump to today's daily note from the sidebar or a shortcut, and see at a glance how many open tasks are attached to it.

---

## Functional requirements

1. **Path shape.** Today's daily note is a Doc at the personal-vault **root**: `DD-MM-YYYY.md`, where `DD-MM-YYYY` is the user's local date. Deterministic per date, so the path is the idempotency key. No author namespacing — a personal vault has a single owner (**D13**).
2. **Filename format** ports old `dailyNoteFilename`: zero-padded `DD-MM-YYYY.md`. The `isDailyNoteFilename` shape check (`^\d{2}-\d{2}-\d{4}\.md$`) and `isDailyNote` frontmatter check (`type: daily-note`) port to `packages/shared` as pure predicates.
3. **Seed content** ports `buildDailyNoteContent`: frontmatter `type: daily-note`, `date: YYYY-MM-DD`, then a `# DD-MM-YYYY` title heading matching the stem. Written as the Doc's **initial CRDT state** at create time (server-side), not a post-create edit.
4. **Auto-create on activation.** On personal-vault activation the client calls a `getOrCreateDailyNote` op for the user's local date; the user is navigated to the returned Doc. Replaces the old vault-activation effect + `ensureDailyNoteAtom`. Per-session client-side dedup (the old `dailyNoteEnsured` promise cache, keyed by `(vaultId, date)`) still coalesces the redundant call sites (activation effect, empty-state CTA) into one round-trip, but is **no longer the correctness boundary** — the server is (§ Idempotent creation). Shared-vault activation does **not** create a daily note (**D24**).
5. **Stub GC + archive** run on activation (§ Archiving).
6. **Navigation** surfaces (§ UX): sidebar "Today", shortcut, task-count badge.

---

## Idempotent creation (multi-device)

**The problem, now narrowed.** Old `ensureDailyNote` did `readFile(path)`; on failure `writeFile(path, seed)` — a check-then-act **TOCTOU**. It survived only because vaults were single-device: the client-side per-session promise cache (`dailyNoteEnsured`) is per-process and can't coordinate a **second device**. Personal vaults now sync across a user's devices (**D13**), so activation on laptop and desktop at 09:00 could each mint a daily note. (This is the *only* residual race — **D24** removes the multi-member variant entirely; there is no second author.)

**The solution — server-arbitrated upsert.** Because the path is deterministic per date and the `docs` table has a **unique constraint on `(vault_id, path)`** (server-data PRD), creation is a single idempotent op:

```
getOrCreateDailyNote(vaultId, localDate) -> { docId, path, created: bool }
  # server, inside one tx:
  #   path = <localDate as DD-MM-YYYY>.md   (vault root)
  #   INSERT INTO docs (vault_id, path, kind='daily') ON CONFLICT (vault_id, path) DO NOTHING
  #   if inserted: initialize Yjs state with seed(frontmatter + title)
  #   return existing-or-new docId
```

The DB unique index serializes concurrent inserts; the loser's `ON CONFLICT DO NOTHING` yields the winner's row. Every device gets the **same `docId`**. No client cache, no read-then-write window, no arbitration protocol beyond the constraint. This is a plain-Doc create-with-known-path, so it can also be reached by a native tool (creating `DD-MM-YYYY.md` hits the same unique-path guard), but the client uses the explicit op to centralize the seed + `kind='daily'` + local-date resolution (matches **D10**'s "only what isn't a plain file" for the seed/date logic; the idempotency itself is just the path constraint).

---

## Timezone & "today"

**Resolved — the caller's local date, no reconciliation needed.** "Today" is the personal vault owner's device-local date (`chrono::Local` in the old app; now the client passes its local date to `getOrCreateDailyNote`). Because a personal vault has a **single owner** (**D13**) and daily notes exist **only** there (**D24**), there is no second clock to disagree with — the cross-timezone problem the shared-vault version wrestled with simply has no shared object to be wrong about.

- **Edge:** a session spanning local midnight — key the date into the client dedup cache (`(vaultId, localDate)`) so a long-running session creates *tomorrow's* note after midnight. Ports old intent.
- **Optional refinement (deferred):** a per-user timezone preference for a "home" timezone while travelling (tier-2 pref, **D6**); default = device-local. Not required for v1.

---

## Shared vs per-user daily notes

**Resolved — personal-vault-only (D24).** The daily note is a personal-journaling feature; it is auto-created only in your own personal vault, never in a shared vault. This was the decision that dissolved the shared-vault machinery an earlier draft carried (author-namespaced `journal/<handle>/` paths, cross-user timezone policy, per-member creation arbitration): none of it is needed, because there is never more than one author or one clock. Shared vaults simply have no daily-note behavior. "Today's note" is always yours.

---

## Archiving (stub heuristic, archive move, link rewrite)

The old sweep did four things: (a) **move** yesterday's root `DD-MM-YYYY.md` into `journal/`, (b) **delete untouched stubs**, (c) **rewrite `[[links]]`** so anchored notes/tasks followed the move, plus (d) an orphan-heal for pre-fix data. With daily notes back at the personal-vault **root** (single user), the old ergonomics port almost verbatim.

**Archive move (a) stays.** Today's note sits at the vault root; on a subsequent day the prior-day note is moved into `journal/` to keep the root uncluttered — exactly the old behavior. The move goes through the standard **atomic server-side `note_rename`** (**D12**), so it is a single operation over the affected CRDT Docs.

**Stub GC (b) stays — the ported heuristic.** A server-side sweep deletes a daily note when it is an **untouched stub**: body after the frontmatter is **empty**, or is **only** the seeded `# DD-MM-YYYY` title (ported `is_untouched_daily_note`, evaluated against the Doc's materialized CRDT text). Guardrails ported: a Doc that can't be positively classified as a stub is **never** deleted. **New guard:** delete a stub only if it has **zero backreferences** (`link_index`, server-data PRD) — the old orphan-rescue safety net is gone (killed with `source_file`, **D4**), so GC must not create a dangling `[[link]]`. A referenced-but-empty daily note is kept.

**Link rewrite (c) is folded into `note_rename` (D12).** The archive move's path change + every referencing `[[link]]` rewrite happen atomically in one pass over the affected CRDT Docs, preserving Doc identity. There is no bespoke daily-archive rewrite path — daily notes reuse the one rename mechanism, and the old distributed-git rewrite conflict (N clients colliding) is gone by construction.

**Orphan-heal (d) is dropped** — no legacy data (clean slate, **D16**).

**Trigger — on-activation server op, optionally a nightly cron.** Port the old "runs on vault activation" ergonomics: on personal-vault activation the client kicks the sweep (archive prior-day + GC unreferenced stubs). A low-frequency server cron may additionally reap/archive for users who haven't opened the vault; both paths are idempotent.

---

## UX / flows

- **On personal-vault activation:** `getOrCreateDailyNote(vaultId, deviceLocalDate)` → open the returned Doc, navigate to the editor. Ports the old activation effect (`ensureDaily().then(openFile … navigate('editor'))`), now server-idempotent. (Shared-vault activation opens the last-viewed surface, no daily note.)
- **Sidebar "Today":** a dedicated entry (personal vault only) that opens today's daily note (get-or-create). Ports the old sidebar daily-note entry / empty-state "Open today's daily note" CTA.
- **Keyboard shortcut:** a global shortcut opens today's daily note (registered alongside the other global shortcuts).
- **Task-count badge:** the "Today" entry shows a count of **open tasks whose `related[]` references today's daily note** (server query; live via the task subscription). Zero → no badge. (Exact predicate — related-to vs due-today — finalized with tasks PRD; default: related-to.)
- **Empty-state recovery:** if the panes ever reach zero tabs, the "Open today's daily note" button remains the recovery CTA (ports old behavior), routed through the same get-or-create.

---

## Edge cases & risks

- **Midnight rollover mid-session:** date is re-evaluated per call and keyed into the client dedup cache → after local midnight, activation/CTA create *tomorrow's* note (ported intent).
- **Clock skew / wrong device clock:** the local date only shapes the owner's own path, so a bad clock affects only that user's own note — self-limiting, and there is no shared object to corrupt.
- **Referenced empty stub:** kept, not deleted (backref guard) — avoids dangling links now that orphan-rescue is gone.
- **Offline activation:** get-or-create is a server op; offline, the client can create the daily Doc in the **local Yjs cache** at the deterministic path and reconcile on reconnect. Risk: two of the user's offline devices create the *same-path* daily Doc → on reconnect two Docs claim one `(vault_id, path)`. Mitigation: the server merges same-path daily Docs on sync (union their CRDT state) or rejects the later insert and rebinds the client; handled by the sync/bridge layer (vaults-collaboration) — **flag** below.
- **JSONL / history coupling:** none here — daily notes are Docs, unrelated to chat history (which is native `--resume`, **D9**).

---

## Dependencies

- **vaults-collaboration** — Doc lifecycle, working-copy materialization, offline Yjs cache + reconnect merge (the same-path offline-create edge), `link_index` for backref checks, folder hierarchy (`journal/`).
- **notes-editor** — CRDT Doc + editor, wiki-link grammar (`packages/shared`), the `note_rename` atomic op (**D12**) reused for the archive move.
- **server-data** — `docs` table + **unique `(vault_id, path)`** constraint (the idempotency guarantee), `kind='daily'`, backref query.
- **tasks** — `related[]` and the task subscription that feeds the task-count badge; final badge predicate.

---

## Open questions

1. **Offline duplicate daily Docs.** If two of a user's devices both create today's daily note offline at the same deterministic path, how does sync reconcile — server-side same-path merge (union CRDT state) or reject-and-rebind? Needs a decision in vaults-collaboration; affects whether the client may optimistically create offline or must degrade to "daily note unavailable offline."
2. **Task-count badge semantics.** Tasks *related to* today's daily note vs tasks *due today*? Defaulting to related-to; confirm with tasks PRD.
3. **Per-user timezone override** (tier-2 pref) — ship in v1 or defer? Default device-local is correct for the common case; the override only matters for travellers.
