# PRD — Daily Notes

A per-day journaling note, auto-created on activation of your **personal** vault, seeded with a title, that you land on. A small but real v1 feature. Daily notes are **personal-vault-only**: auto-created only in your own personal vault, never in a shared vault. Why: personal-only sidesteps shared-vault duplicate creation across members, cross-timezone disagreement about "today", and visibility questions entirely — a personal vault has exactly one owner, so there is only ever one author and one clock, and "today's note" is always yours. A note is a **Yjs CRDT Doc**, so "make today's daily note" is an **idempotent, server-arbitrated doc-create**, not a local file write.

---

## Summary

Every day, in your **personal** vault, you get a **daily note** — a Doc named `DD-MM-YYYY` at the vault root, seeded with `type: daily-note` frontmatter and a `# DD-MM-YYYY` title heading. On activation the client asks the server to **get-or-create** today's daily note for your local date; the server upserts a Doc keyed by a deterministic path, so concurrent activations from **your laptop and desktop** converge on **one** Doc with no duplicates. You land on it (sidebar "Today", shortcut). A server-side sweep archives yesterday's note into `journal/` and garbage-collects **untouched stubs** so empty dailies don't accumulate.

Because daily notes live only in the personal vault, there are no other members to race on creation and no other clock to disagree with about the date. The remaining correctness concern is narrow — the **same** user on **multiple devices** (personal vaults sync across a user's devices) — and it is handled by making creation **server-arbitrated** (§ Idempotent creation).

Porting notes: port the well-tested **daily-note untouched-stub heuristic** (old `is_untouched_daily_note`), the seed-content shape (`buildDailyNoteContent`), and the root→`journal/` **archive move**. Do **not** port the orphan-rescue machinery the old move fed — it existed to serve `source_file`, which no longer exists now that tasks are structured server records.

---

## Goals / Non-goals

**Goals**
- Auto-create today's daily note on personal-vault activation, idempotently, and land on it.
- Exactly one daily note per day — no duplicates across your devices.
- Seed with `type: daily-note` frontmatter + title; treat an untouched stub as disposable (GC, don't accumulate).
- Archive prior-day notes into `journal/` to keep the vault root uncluttered; rewrite any `[[links]]` atomically on the move via the single server-side rename operation.
- Fast navigation: sidebar "Today" entry, a keyboard shortcut, and a task-count badge.

**Non-goals**
- Daily notes in **shared** vaults — out of scope by design; this PRD is personal-vault-only (§ Shared vs per-user daily notes).
- The Doc/CRDT lifecycle, materialization, `docs` table, and `link_index` — **vaults-collaboration** / **server-data** PRDs (this PRD only names the daily-note-specific rules layered on top).
- The wiki-link grammar and `note_rename` op internals — **notes-editor** PRD.
- Task records, `related[]`, and the board — **server-data** / **tasks** PRDs.
- Daily-note templates / configurable seed content — deferred post-v1.
- Recurring/scheduled *reminders* about the daily note — out of scope (server-evaluated reminders cover tasks only).

---

## User stories

- As a user, when I open my personal vault I land on today's daily note, ready to jot; if it already exists (I opened it earlier, or on another device) I get the **same** note, not a second copy.
- As a user, an empty daily note I never wrote in doesn't pile up as clutter — it's quietly cleaned up.
- As a user, yesterday's note moves into `journal/` so my vault root stays clean, and any note or task I linked to it still resolves after the move.
- As a user, I can jump to today's daily note from the sidebar or a shortcut, and see at a glance how many open tasks are attached to it.

---

## Functional requirements

1. **Path shape.** Today's daily note is a Doc at the personal-vault **root**: `DD-MM-YYYY.md`, where `DD-MM-YYYY` is the user's local date. Deterministic per date, so the path is the idempotency key. No author namespacing — a personal vault has a single owner.
2. **Filename format** ports old `dailyNoteFilename`: zero-padded `DD-MM-YYYY.md`. The `isDailyNoteFilename` shape check (`^\d{2}-\d{2}-\d{4}\.md$`) and `isDailyNote` frontmatter check (`type: daily-note`) port to `packages/shared` as pure predicates.
3. **Seed content** ports `buildDailyNoteContent`: frontmatter `type: daily-note`, `date: YYYY-MM-DD`, then a `# DD-MM-YYYY` title heading matching the stem. Written as the Doc's **initial CRDT state** at create time (server-side), not a post-create edit.
4. **Auto-create on activation.** On personal-vault activation the client calls a `getOrCreateDailyNote` op for the user's local date; the user is navigated to the returned Doc. Port the intent of the old vault-activation effect + `ensureDailyNoteAtom` into this single op call. Per-session client-side dedup (the old `dailyNoteEnsured` promise cache, keyed by `(vaultId, date)`) still coalesces the redundant call sites (activation effect, empty-state CTA) into one round-trip, but is **no longer the correctness boundary** — the server is (§ Idempotent creation). Shared-vault activation does **not** create a daily note.
5. **Stub GC + archive** run on activation (§ Archiving).
6. **Navigation** surfaces (§ UX): sidebar "Today", shortcut, task-count badge.

---

## Idempotent creation (multi-device)

**The problem.** Do not port old `ensureDailyNote`'s check-then-act (`readFile(path)`; on failure `writeFile(path, seed)`) — a **TOCTOU** that survived only because vaults were single-device. Its client-side per-session promise cache (`dailyNoteEnsured`) is per-process and can't coordinate a **second device**. Personal vaults sync across a user's devices, so activation on laptop and desktop at 09:00 could each mint a daily note. (This is the *only* residual race — personal-vault-only scoping removes the multi-member variant entirely; there is no second author.)

**The solution — server-arbitrated upsert.** Because the path is deterministic per date and the `docs` table has a **unique constraint on `(vault_id, path)`** (server-data PRD), creation is a single idempotent op:

```
getOrCreateDailyNote(vaultId, localDate) -> { docId, path, created: bool }
  # server, inside one tx:
  #   path = <localDate as DD-MM-YYYY>.md   (vault root)
  #   INSERT INTO docs (vault_id, path, kind='daily') ON CONFLICT (vault_id, path) DO NOTHING
  #   if inserted: initialize Yjs state with seed(frontmatter + title)
  #   return existing-or-new docId
```

The DB unique index serializes concurrent inserts; the loser's `ON CONFLICT DO NOTHING` yields the winner's row. Every device gets the **same `docId`**. No client cache, no read-then-write window, no arbitration protocol beyond the constraint. This is a plain-Doc create-with-known-path, so it can also be reached by a native tool (creating `DD-MM-YYYY.md` hits the same unique-path guard), but the client uses the explicit op to centralize the seed + `kind='daily'` + local-date resolution (consistent with the MCP-surface rule that ops exist only for what isn't a plain file operation — the op carries the seed/date logic; the idempotency itself is just the path constraint).

---

## Timezone & "today"

**The caller's local date, no reconciliation needed.** "Today" is the personal vault owner's device-local date — the client passes its local date to `getOrCreateDailyNote`. Because a personal vault has a **single owner** and daily notes exist **only** there, there is no second clock to disagree with — the cross-timezone problem a shared-vault version would face simply has no shared object to be wrong about.

- **Edge:** a session spanning local midnight — key the date into the client dedup cache (`(vaultId, localDate)`) so a long-running session creates *tomorrow's* note after midnight. Ports old intent.
- **Optional refinement (deferred):** a per-user timezone preference for a "home" timezone while travelling; default = device-local. Not required for v1.

---

## Shared vs per-user daily notes

**Personal-vault-only.** The daily note is a personal-journaling feature: auto-created only in your own personal vault, never in a shared vault. Shared vaults have no daily-note behavior at all. Why: with a single owner there is never more than one author or one clock, so none of the shared-vault machinery (author-namespaced `journal/<handle>/` paths, cross-user timezone policy, per-member creation arbitration) is needed. "Today's note" is always yours.

---

## Archiving (stub heuristic, archive move, link rewrite)

Port the old sweep's ergonomics, which did three things worth keeping: (a) **move** yesterday's root `DD-MM-YYYY.md` into `journal/`, (b) **delete untouched stubs**, (c) **rewrite `[[links]]`** so anchored notes/tasks follow the move. Its fourth job — an orphan-heal for legacy data — is not ported (v1 starts from a clean slate with no content import).

**What the sweep looks at.** Daily notes are selected by their **`kind='daily'` record**, never by filename shape. The old sweep pattern-matched `^\d{2}-\d{2}-\d{4}\.md$` against a directory listing because it had nothing else to go on; the server has a typed record. Matching on the filename would let the sweep pick up a **hand-authored** note that merely looks like a date — and the GC, finding it empty, would delete a note the system never created. `kind` is written only by `getOrCreateDaily`, so only system-minted notes are ever swept; `isDailyNoteFilename` is a client-side display predicate (tagging tree leaves) and never a sweep input.

**Archive move (a) stays.** Today's note sits at the vault root; on a subsequent day the prior-day note is moved into `journal/` to keep the root uncluttered. The move goes through the standard **atomic server-side `note_rename`**, so it is a single operation over the affected CRDT Docs. An archived daily keeps `kind='daily'` — `kind` says what a doc *is*, not where it lives; it is the **root-level filter** (not the kind) that stops the sweep re-archiving `journal/` forever, and that makes a re-run a no-op.

**Stub GC (b) stays — the ported heuristic.** A server-side sweep deletes a daily note when it is an **untouched stub**: body after the frontmatter is **empty**, or is **only** the seeded `# DD-MM-YYYY` title (ported `is_untouched_daily_note`, evaluated against the Doc's materialized CRDT text). Guardrails ported: a Doc that can't be positively classified as a stub is **never** deleted. **New guard:** delete a stub only if it has **zero backreferences** (`link_index`, server-data PRD) — there is no orphan-rescue safety net (it served `source_file`, which no longer exists), so GC must not create a dangling `[[link]]`. A referenced-but-empty daily note is kept.

**Link rewrite (c) is folded into `note_rename`.** The archive move's path change + every referencing `[[link]]` rewrite happen atomically in one pass over the affected CRDT Docs, preserving Doc identity. There is no bespoke daily-archive rewrite path — daily notes reuse the one rename mechanism, and because rename is a single central server-side operation, concurrent rewrites cannot collide.

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
- **Referenced empty stub:** kept, not deleted (backref guard) — avoids dangling links, since there is no orphan-rescue to heal them.
- **Offline activation:** get-or-create is a server op; offline, the client can create the daily Doc in the **local Yjs cache** at the deterministic path and reconcile on reconnect. Risk: two of the user's offline devices create the *same-path* daily Doc → on reconnect two Docs claim one `(vault_id, path)`. Mitigation: the server merges same-path daily Docs on sync (union their CRDT state) or rejects the later insert and rebinds the client; handled by the sync/bridge layer (vaults-collaboration) — **flag** below.
- **JSONL / history coupling:** none here — daily notes are Docs, unrelated to chat history (which is Claude Code's native `--resume`, local to each machine).

---

## Dependencies

- **vaults-collaboration** — Doc lifecycle, working-copy materialization, offline Yjs cache + reconnect merge (the same-path offline-create edge), `link_index` for backref checks, folder hierarchy (`journal/`).
- **notes-editor** — CRDT Doc + editor, wiki-link grammar (`packages/shared`), the atomic `note_rename` op reused for the archive move.
- **server-data** — `docs` table + **unique `(vault_id, path)`** constraint (the idempotency guarantee), `kind='daily'`, backref query.
- **tasks** — `related[]` and the task subscription that feeds the task-count badge; final badge predicate.

---

## Open questions

1. ~~**Offline duplicate daily Docs.**~~ **Settled 2026-07-16 (D45): daily notes degrade offline.** Get-or-create is server-only; offline it fails cleanly and you land on the last-viewed surface. The unique `(vault_id, path)` index is the whole idempotency story, and an optimistic offline create abandons it — two devices would each mint a Doc claiming one path with no arbitrator. The same-path merge-vs-rebind question therefore stays where it belongs, in **vaults-collaboration**'s sync/bridge layer, rather than being bought here to serve a convenience. A missing daily note offline is a non-event: you get it on reconnect, and nothing was lost because there was nothing in it yet.
2. **Task-count badge semantics.** Tasks *related to* today's daily note vs tasks *due today*? Defaulting to related-to; confirm with tasks PRD. *(Still open — the badge ships with the nav surfaces, not the correctness spine.)*
3. **Per-user timezone override** — **deferred past v1** (2026-07-16). Device-local (D44) is correct for the common case; the override only matters for travellers, and nothing in the shipped shape designs it out — "today" is already an input to both ops, so a home-timezone preference would only change who computes the date.
