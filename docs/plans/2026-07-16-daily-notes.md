# Daily notes, slices 1–2 — the get-or-create spine and the sweep

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** on activating your **personal** vault you land on today's daily note — the same one on every device, never a duplicate — and yesterday's is archived into `journal/` while untouched stubs are quietly reaped. At the end of these two slices the feature is correct and complete end-to-end, minus its convenience surfaces.

**Slice 3 (not here):** the nav surfaces — sidebar "Today" entry, the keyboard shortcut, the task-count badge. Each carries a refactor that does not belong in a feature build: the shortcut needs `Shell`'s `view` lifted from `useState` into an atom, and the badge needs the tasks SSE subscription hoisted out of `BoardView` so it survives the notes view. Do not design them out; do not build them here.

**The one structural fact:** a daily note is **not a file write** — it is a server-arbitrated Doc create. The unique index `docs_vault_path_idx` on `(vault_id, path)` *is* the entire idempotency guarantee. Everything else (client dedup cache, promise coalescing) is a round-trip optimization and must never be load-bearing.

**Spec:** `prd/daily-notes.md` (owning doc) · rename: `prd/notes-editor.md` · `docs` table + `link_index`: `prd/server-data.md`.

---

## Decisions

| # | Decision |
|---|---|
| **D44** | **The client passes its local date; the server never computes "today".** `getOrCreateDaily` and `sweepDaily` both take `localDate: 'YYYY-MM-DD'` as an **input**, validated by `parseDate` (`shared/dates.ts`). **Why:** the server has no idea which timezone the caller is in — a server-side `now()` would mint the wrong note for anyone east or west of it, and "prior-day" in the sweep would archive today's note for someone past midnight. A personal vault has exactly one owner and therefore exactly one clock; that clock is on the device. Bonus: the ops become **pure with respect to time**, so tests pass a date instead of injecting a clock. `shared/dates.ts` stays timezone-free — the device resolves local→ISO before the wire. |
| **D45** | **Daily notes degrade offline — there is no optimistic local create.** Get-or-create is server-only; offline it fails cleanly and you land on the last-viewed surface with no daily note. **Why:** the unique `(vault_id, path)` constraint is the *whole* idempotency story. An offline optimistic create abandons it — two devices would each mint a Doc claiming one path, with no arbitrator, forcing a same-path merge-or-rebind protocol into existence. That decision belongs to **vaults-collaboration** (it is that PRD's sync/bridge layer, not this one's), and buying it here would mean designing CRDT-union semantics to serve a convenience. A missing daily note offline is a non-event: you get it the moment you reconnect, and nothing was lost because there was nothing in it. Closes `prd/daily-notes.md` OQ1 for v1. Agreed with Nicolai 2026-07-16. |
| **D46** | **The sweep selects daily notes by `kind='daily'`, never by filename shape.** The old Rust sweep read the vault root and regex-matched `^\d{2}-\d{2}-\d{4}\.md$` because it had nothing else to go on; the server has a typed record. **Why it matters:** filename-matching would let the sweep pick up a **hand-authored** note that merely looks like a date — and then the GC, finding it empty, would **delete a note the system never created**. `kind='daily'` is written only by `getOrCreateDaily`, so only system-minted notes are ever swept. `isDailyNoteFilename` survives as a **client-side display predicate only** (tagging tree leaves), never as a sweep input. |

## Contract

**Shared** — `packages/shared/src/daily-note.ts`, pure, no deps, exported from `index.ts`:
- `dailyNoteStem(isoDate: string): string` → `DD-MM-YYYY`; `dailyNoteFilename(isoDate)` → `<stem>.md`. **Take the ISO string, not a `Date`** — ports old `dailyNoteFilename`'s output shape while keeping the function pure and matching the wire format (D44). Reject a malformed date rather than emitting `NaN-NaN-NaN.md`.
- `buildDailyNoteContent(isoDate): string` — ports `buildDailyNoteContent` verbatim in shape: `---\ntype: daily-note\ndate: <iso>\n---\n\n# <stem>\n\n`.
- `isDailyNoteFilename(name)` (`^\d{2}-\d{2}-\d{4}\.md$`) and `isDailyNote(content)` (`type: daily-note` frontmatter) — port as-is. Display predicates (D46).
- `isUntouchedDailyNote(text: string, stem: string): boolean` — ports Rust `is_untouched_daily_note` over **materialized CRDT text** instead of a file read. True when the body after the frontmatter is empty **or** trims to exactly `# <stem>`. **False whenever it cannot positively classify** — no frontmatter → false. The old code's `Ok(content) else return false` (unreadable file → keep) has no analogue here and needs none; the "can't classify → keep" *policy* is what ports.

**Server** — both ops on `notesRouter` (`apps/server/src/routers/notes.ts`), logic in a service (`src/daily/…`) taking explicit deps `{ db, bus, getLiveDoc }`, per the `renameNote` convention:

- `getOrCreateDaily({ vaultId, localDate }) -> { docId, path, created }`
  - **Personal-vault only.** Reject a shared vault (`vaults.kind !== 'personal'`) — `BAD_REQUEST`. The PRD is emphatic that this is not a shared-vault feature; the guard is what makes "one owner, one clock" true rather than aspirational.
  - One tx: `ensureAncestorFolders` → `INSERT … ON CONFLICT DO NOTHING RETURNING` → **if no row, `SELECT` the existing one and return it with `created: false`**. This is the whole idempotency mechanism; the loser of the race reads the winner's row.
  - **Only on insert**, seed the Yjs state with `buildDailyNoteContent` — a `Y.Doc` whose `getText(YDOC_TEXT_KEY)` carries the seed, persisted via `storeDocState`. **Never seed an existing doc** (it would duplicate the title into a note you wrote in). Then `refreshLinkIndex`.
  - Emit `bus.emitDocs('created')` only when `created` — the SSE frame must not lie.
  - **Do not reuse `notes.create`**: it throws `CONFLICT` on a taken path (`notes.ts:23`) and seeds an *empty* doc. Both are exactly wrong here.

- `sweepDaily({ vaultId, localDate }) -> { archived, deleted }`
  - Personal-vault guard, same as above. Idempotent — safe to call on every activation.
  - Select `docs where vaultId AND kind='daily'` (D46), **root-level only** (no `/` in path), **excluding** today's stem. Everything already under `journal/` is skipped by the root-level filter, which is what makes a re-run a no-op.
  - Per doc: materialize text (`loadDocState` → `docText`). If `isUntouchedDailyNote` **and** it has **zero backrefs** in `link_index` → delete. Else → archive to `journal/<filename>` via **`renameNote`** (`src/yjs/rename.ts`), which already rewrites every `[[link]]`, snapshots, refreshes `link_index`, and `ensureAncestorFolders`-creates `journal/`. There is **no bespoke rewrite path** — that reuse is the point.
  - **The backref guard is new and load-bearing** (PRD §Archiving): the old code deleted stubs freely because an orphan-rescue dialog healed the dangling `source_file` afterwards. That machinery is **not ported** (it served `source_file`, which no longer exists), so there is no safety net — a referenced-but-empty daily note is **kept**.
  - A doc that fails to classify is **archived, never deleted** — the ported guardrail.

**Desktop** — `state/daily.ts` next to `state/vaults.ts`:
- A `getOrCreateDailyAtom` write-atom: resolve the active vault from `vaultsAtom` + `activeVaultIdAtom`, **bail unless `kind === 'personal'`**, resolve the device-local date to ISO (local, **not** `toISOString()` — see gotchas), call the op, `set(activeDocAtom, doc)`, kick `sweepDaily` fire-and-forget.
- **Per-session dedup** keyed `(vaultId, localDate)` — ports `dailyNoteEnsured`'s promise cache, including **dropping the cache entry on rejection** so a failure retries instead of returning a stale rejection forever. Date in the key is what makes a session spanning midnight create tomorrow's note. It is a round-trip optimization, **not** the correctness boundary (D45/the unique index is).
- Wire into `Shell.tsx`'s existing activation effect (`:39`). Offline/error → swallow and land on last-viewed (D45).

## Tasks

- [x] **1** `packages/shared/src/daily-note.ts` + tests, exported from `index.ts`. Pure, no deps. TDD — the heuristic and the predicates are the two things worth pinning. Commit.
- [x] **2** Server `getOrCreateDaily`: service + router op + tests (`rename.test.ts` is the template — its ctx has `getLiveDoc`). Test: creates seeded, second call returns **same docId** with `created: false`, a shared vault is rejected, an existing doc at the path is adopted un-reseeded.
- [x] **3** Server `sweepDaily`: service + router op + tests. Test: today's note untouched by the sweep; a written prior-day note lands in `journal/` **with its backrefs rewritten**; an unreferenced stub is deleted; a **referenced** stub survives; a re-run is a no-op.
- [x] **4** Desktop `state/daily.ts` + the `Shell.tsx` activation hook. Test the pure parts (local-date→ISO, dedup keying) headlessly per `board-state.test.ts`.
- [x] **5** `pnpm -r test` + `pnpm -r typecheck` + `pnpm --filter @holi/desktop build`. Then the **real app** (CDP): activate the personal vault → land on a seeded `DD-MM-YYYY.md`; activate again → **same doc, no duplicate**; plant a written prior-day daily + a note linking to it, activate, watch it move to `journal/` and the link follow it; plant an unreferenced stub and watch it vanish.
- [x] **6** `prd/daily-notes.md`: close OQ1 (D45) and note OQ3 stays deferred. Record D44/D45/D46 in `docs/decisions.md` (next free is D44 → after this, **D47**). **Never `git add` anything under `docs/`.**

## Gotchas

- **`toISOString()` is a bug here.** It formats **UTC** — for a user east of UTC after 00:00 local it yields *yesterday*, minting the wrong note. Derive the local date from `getFullYear`/`getMonth`/`getDate` (the old repo's `toIsoDate` did exactly this, deliberately). `shared/dates.ts`'s `formatDate` is **UTC-based** and is for epoch math, not for asking a device what day it is.
- **`notes.create` is a trap** — `CONFLICT` on conflict, empty seed. Neither is reusable; write the insert-or-select yourself.
- **Don't reuse `task-file.ts`'s `splitFrontmatter`.** It is private and **throws** (`TaskFileError`) by design — an agent writing bad frontmatter must fail loudly. The daily heuristic needs the opposite policy: cannot classify → keep silently. Same parse, opposite failure semantics. Give `daily-note.ts` its own small tolerant splitter returning `null`, and say why in a comment.
- **Archiving does not flip `kind`.** An archived daily stays `kind='daily'`; `kind` says what a doc *is*, not where it lives. The sweep's root-level filter — not the kind — is what stops it re-archiving `journal/` forever.
- **Seed only on insert.** Re-seeding an adopted doc duplicates the title into content you wrote.
- **The sweep is fire-and-forget from activation** — it must never block landing on today's note. Its failure is invisible and retried next activation (idempotent).
- **`pnpm dev` auto-signs-in a dev user onto a personal vault**, so the activation path is exercised on every launch — a broken op is loud immediately.
