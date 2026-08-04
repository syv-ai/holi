# Gmail write scope — mark-read, star, archive, trash, and a real address book

> **For agentic workers:** Use the executing-plans skill. Steps are `- [ ]` checkboxes.
> **Plan style:** contracts, decisions and gotchas — not full inline code. Derive the rest.

**Goal:** Opening a thread marks it read; the reader gains star / archive / trash; `@`-completion
reads the real address book. One consent screen for all of it.

**Architecture.** `gmail.readonly` → **`gmail.modify`**, plus **`contacts.readonly`**. `GoogleApi`
gains its first write verb. Mutations are a thin `modifyThread()` over `threads.modify`, applied
optimistically to the SQLite cache and reconciled authoritatively by the existing `history.list`
delta — a local patch is optimism, history is truth. The renderer gets four mutations; **the agent
gets none** (see D68 deferred).

**Tech stack:** Electron main, tRPC router, `node:sqlite` cache, React renderer, Vitest (node + dom).

---

## Read before starting

**Nicolai chose the full triage surface**, not mark-read alone (asked and answered 2026-08-05).
He also said yes to adding contacts to the same consent screen. Both are settled; do not re-ask.

**Three facts verified in the source before this plan was written:**

1. `GOOGLE_SCOPES` (`main/google/session.ts:63`) is `openid`, `email`, `gmail.readonly`,
   `calendar.readonly`. Removing `UNREAD` needs `gmail.modify`; `readonly` cannot do it.
2. `GoogleApi` (`main/google/api.ts:52`) exposes **only `get` and `getAll`**. Nothing in
   `main/google/` writes to Google at all.
3. Read-only is stated as *intent* in three places — D67 §4, the scope comment at `session.ts:55`,
   and the module note at `MailView.tsx:1` ("no archive, no label, no delete… pretending otherwise
   would be a button that cannot work"). All three are now wrong and all three must change.

**The thing the handoff missed, and Task 1 exists for it.** `StoredGoogleAuth.scopes`
(`token-store.ts:36`) is written on every connect — "so a failure can name the missing scope" — and
then **never read**. Grepping `.scopes` outside `token-store.ts` finds exactly two hits, both
writes (`loopback-flow.ts:127`, `session.ts:182`). So widening `GOOGLE_SCOPES` does **not**
invalidate Nicolai's existing grant: his refresh token keeps minting `readonly` access tokens, every
write 403s with `code: 'scope'`, and there is no path back except manually disconnecting. **Task 1
must land before anything that writes**, or the first thing he sees is a dead button.

**Gotchas that will bite:**

- `pnpm run format` / `prettier --write` **corrupts this repo** (adds semicolons, rewraps). Hand-format.
- Bare `node`/`npx` are broken — `pnpm exec` always. `cd` with an absolute path.
- Node tests live in `apps/desktop/test/*.test.ts` and are **not typechecked**. Renderer tests are
  co-located and **must** be `.test.tsx` — the dom glob is `src/renderer/**/*.test.tsx`, so a
  `.test.ts` there silently never runs.
- Boundaries gate is at error: native `<button>`/`<input>` are banned outside `primitives/`.
- **`SHAPE_VERSION`** (`cache.ts:74`) must be bumped if `MailThreadSummary` changes. This plan is
  designed **not** to change it — reuse `unread`/`starred`, which already exist. If you add a field,
  bump to `'3'`.
- jsdom + `react-resizable-panels`: handles are parked at 10,000px in `test/setup.dom.ts`. If a
  Radix control inside a panel group stops opening, that is why.
- **Nothing in this repo talks to Google in tests, ever.** All fakes. Say so when reporting.

**Verification loop** (from `apps/desktop`, absolute `cd`):
`pnpm exec node node_modules/typescript/bin/tsc --noEmit` · `pnpm exec eslint src` ·
`pnpm exec vitest run --project node` (**~125s — background it**) · `--project dom` ·
shared from `packages/shared`.

---

### Task 1: Widen the scopes, and detect a grant that predates them

**Why first:** without the guard, Nicolai's existing token silently lacks the new scopes and every
later task appears broken. This task is the only one he must reconnect for.

**Files:** `main/google/session.ts` · `main/router.ts` (`google.status`) ·
`renderer/src/features/google/GoogleConnection.tsx` · `renderer/src/state/google.ts` ·
Test: `test/google-session.test.ts`

- [ ] **Step 1 — Failing test.** In `test/google-session.test.ts`: a session restored from a store
      whose `scopes` hold only the old four reports the two new scopes as missing; one holding all
      of `GOOGLE_SCOPES` reports none. **Make it discriminate:** check it goes red with the
      comparison stubbed to `[]`, per the method note that caught a weak cache test last session.

- [ ] **Step 2 — Run it, confirm red.** `pnpm exec vitest run --project node test/google-session.test.ts`

- [ ] **Step 3 — Change the scopes.** In `session.ts`, `GOOGLE_SCOPES` becomes:
      ```
      openid
      email
      https://www.googleapis.com/auth/gmail.modify
      https://www.googleapis.com/auth/calendar.readonly
      https://www.googleapis.com/auth/contacts.readonly
      ```
      `gmail.modify` **replaces** `gmail.readonly` — it is a superset (read + label/state changes),
      so requesting both is redundant. Rewrite the doc comment at `session.ts:55`: it currently
      claims read-only both services. New framing: *mail is read-write within a bounded set —
      read state, star, archive, trash. Permanent delete is impossible (`mail.google.com` is not
      requested). **Send is not** — `gmail.modify` permits `messages.send`, so the token can send
      and only the absence of a send function stops it. That is a code boundary, not a scope
      boundary; say so here rather than implying Google enforces it.*

- [ ] **Step 4 — Implement the guard.** Add `missingScopes(): string[]` to `GoogleSession`,
      comparing stored `scopes` against `GOOGLE_SCOPES`. **Contract:** returns `[]` when nothing is
      missing; never throws; safe to call with no account (returns `[]`, because "not connected" is
      a different state the UI already renders).

- [ ] **Step 5 — Green.** Same command. Then surface it: `google.status` returns
      `{ account, missingScopes }`; `state/google.ts` carries it; `GoogleConnection.tsx` renders a
      "Reconnect to grant new permissions" affordance when the array is non-empty and an account
      exists. Reuse the existing connect flow — reconnecting is not a new code path.

- [ ] **Step 6 — Commit.**
      ```
      feat(google): request gmail.modify + contacts, and notice a grant that predates them

      `scopes` has been stored since the connector landed and never read, so widening
      GOOGLE_SCOPES would have left an existing grant minting readonly tokens while every
      write 403s with no route out. It is compared now.
      ```

- [ ] **Step 7 — Ask Nicolai to reconnect Google**, and to confirm the consent screen lists Gmail
      *and* contacts. Nothing after this task works on his machine until he does.

---

### Task 2: `GoogleApi` gains a write verb

**Files:** `main/google/api.ts` · Test: `test/google-api.test.ts` — **create it; there is none today**,
which is why `get`'s repeated-key bug reached production. Cover `post` and leave `get` alone.

- [ ] **Step 1 — Failing test.** With a fake `fetch`: `post()` sends `POST`, a JSON body,
      `Content-Type: application/json` and the bearer token; a 403 carrying
      `insufficientPermissions` surfaces as `GoogleApiError` with `code: 'scope'`.
      That last one is the load-bearing case — it is what a stale grant produces, and Task 1's UI
      is what resolves it.

- [ ] **Step 2 — Red.**

- [ ] **Step 3 — Implement.** `async post<T>(url: string, body: unknown): Promise<T>`. Reuse
      `classify()` and the existing token-getter/timeout shape verbatim — the only differences from
      `get` are the method, the body and the `Content-Type`. **Do not** add a params/query path;
      no Gmail write this plan needs one.
      **Gotcha:** some Gmail modify responses are effectively empty. Tolerate a non-JSON or empty
      body rather than throwing on `res.json()`.

- [ ] **Step 4 — Green. Step 5 — Commit:** `feat(google): the API client learns to POST`

---

### Task 3: Thread mutations against Gmail

**Files:** `main/google/gmail.ts` · Test: `test/google-gmail.test.ts`

- [ ] **Step 1 — Failing tests**, one per operation, against a fake api recording calls:
      - `markThreadRead` → `POST …/threads/{id}/modify` with `{ removeLabelIds: ['UNREAD'] }`
      - `setThreadStarred(id, true|false)` → `addLabelIds` / `removeLabelIds` `['STARRED']`
      - `archiveThread` → `{ removeLabelIds: ['INBOX'] }`
      - `trashThread` → `POST …/threads/{id}/trash` — **a different endpoint, not a label modify.**
        Getting this wrong is silent: modifying a `TRASH` label appears to work and does not.

- [ ] **Step 2 — Red. Step 3 — Implement.**
      One private `modifyThread(api, id, { add, remove })` over `users.threads.modify`; the four
      named functions are thin wrappers, so the URL and body shape exist once.
      **Contract:** each takes `(api, id)` and returns `Promise<void>`. They do **not** touch the
      cache — Task 4 owns that, and a function that both calls Google and mutates local state is
      untestable as either.
      `BASE` is already `https://gmail.googleapis.com/gmail/v1/users/me` at `mail-sync.ts:31`;
      `gmail.ts` has its own — use whichever that file already declares, don't add a third.

- [ ] **Step 4 — Green. Step 5 — Commit:** `feat(google): mark read, star, archive and trash a thread`

---

### Task 4: The cache learns to patch and drop one thread

**The discovery this rests on:** `cache.ts:174` already inserts an **`id` column** into `threads`
that nothing ever reads. It is exactly the index needed to find every cached list holding a thread —
and there *are* several, because the key is `query|category` (`mail-sync.ts:249`), so one thread
lives in the inbox list, the unread-filtered list and any search that matched it. **Patching only
the visible list is the bug to avoid:** clearing bold in the inbox while the unread filter still
lists it is worse than not patching at all.

**Files:** `main/google/cache.ts` · `main/google/mail-sync.ts` · Test: `test/google-cache.test.ts`

- [ ] **Step 1 — Failing test.** Write the same thread into two keys (`|` and `|unread`), then:
      - `patchThread(id, { added: [], removed: ['UNREAD'] })` clears `unread` in **both**, leaves
        other threads and `position` ordering untouched.
      - `dropThread(id)` removes it from both and leaves the rest contiguous.
      - Both are no-ops for an unknown id.

- [ ] **Step 2 — Red. Step 3 — Implement.**
      Add to the `GoogleCache` interface:
      - `patchThread(id: string, change: { added: string[]; removed: string[] }): void`
      - `dropThread(id: string): void`

      `SELECT key, position, json FROM threads WHERE id = ?`, apply, write back.
      **Reuse the flag logic:** `patch()` at `mail-sync.ts:226` already maps a label delta onto a
      summary and knows the `PATCHABLE` set. Export it and call it — inventing a second mapping is
      how `unread` and `starred` drift apart. It takes `Set`s; either widen it to accept arrays or
      construct the sets at the call site, but keep **one** implementation.
      **Do not renumber `position`** on drop — `readThreads` uses `ORDER BY position`, and a gap is
      harmless where a rewrite is a second chance to corrupt order.

- [ ] **Step 4 — Green. Step 5 — Commit:**
      `feat(google): the cache can patch or drop one thread across every list holding it`

---

### Task 5: Mutations through `GoogleData` and the router

**The reconciliation contract, and the reason this is safe:** a local patch is **optimism**;
`history.list` is **truth**. Gmail records our own label change in the mailbox history, so the next
`syncThreads` sees it and corrects every cached list independently of what we patched. That is why
archive/trash may simply `dropThread` from *all* lists even though a search for `in:anywhere` would
still legitimately match — the next sync restores it. This is a cache, not a mirror (`cache.ts:6`).

**Assumption to flag, not to trust:** `syncThreads` calls `history.list` with `labelId: 'INBOX'`
(`mail-sync.ts:90`). Whether Gmail reports an `INBOX`-removal under that filter is unverified here
and unverifiable without a real mailbox. If archived threads reappear after a refresh, this is the
first place to look.

**Files:** `main/google/data.ts` · `main/router.ts` · Test: `test/google-data.test.ts`

- [ ] **Step 1 — Failing test.** With a fake api + real in-memory cache: each mutation calls Google
      **then** updates the cache; a Google failure leaves the cache **untouched** and rethrows.
      Order matters — patching first and then failing leaves a lie on disk that survives restart.

- [ ] **Step 2 — Red. Step 3 — Implement.** Four methods on `GoogleData`:
      - `markRead(id)` → `patchThread(id, { added: [], removed: ['UNREAD'] })`
      - `setStarred(id, starred)` → patch `STARRED`
      - `archive(id)` → `dropThread(id)`
      - `trash(id)` → `dropThread(id)`

      Then four `t.procedure.…mutation()` entries on the `google` router, input `fields({ id:
      'string' })` (plus `starred: 'boolean'`). **`fields()` learned booleans in `7b473b2` and does
      not coerce** — a coerced `"false"` reads as true, which is exactly how a star would refuse to
      turn off. Follow `google.setCalendar`'s existing precondition-failure shape when
      `googleData`/session is absent.

- [ ] **Step 4 — Green. Step 5 — Commit:** `feat(google): mail mutations reach the router`

---

### Task 6: The reader marks read, and gains its triage row

**Files:** `renderer/src/features/google/MailView.tsx` ·
Test: `renderer/src/features/google/__tests__/MailView.test.tsx`

- [ ] **Step 1 — Failing tests.**
      - Opening an unread thread calls `google.markRead` **once** and the row loses its unread
        styling without a refetch.
      - Opening an already-read thread calls it **not at all** — a request per open, for a thread
        that is already read, is the whole `history.list` saving spent on nothing.
      - Star toggles; archive and trash remove the row **and** close the reader.
      - A failed mutation restores the previous row state.

- [ ] **Step 2 — Red. Step 3 — Implement.**
      `openThread` is at `MailView.tsx:265` and already has `thread: ThreadSummary` in hand — gate
      on `thread.unread` there. The list lives in `list.threads` under `ListState`
      (`MailView.tsx:173`); update it with the same `setList((previous) => …)` guard-on-`kind`
      shape `loadMore` uses at `:241`.
      Actions belong on the open-thread header beside the existing link/external controls, using
      `primitives/` buttons — **native `<button>` is banned here by the boundaries gate.**
      Archive and trash clear `open`/`openId`/`openSummary` together; leaving `openSummary` set is
      how a reader keeps rendering a thread that is no longer in the list.
      **Optimism, then reconcile:** update local state immediately, revert on rejection. Do not
      call `load()` after each mutation — that is a full round trip for a state you already know.

- [ ] **Step 4 — Green.**

- [ ] **Step 5 — Rewrite the module note at `MailView.tsx:1`.** It currently says there is no
      archive, no label and no delete, and that the scope is read-only "and pretending otherwise
      would be a button that cannot work". All of that is now false. Keep what is still true:
      no reply box, no *permanent* delete, no label editing — and say why trash is not delete.
      **Do not re-state "the scope is read-only" in any weakened form.** Replying still opens Gmail
      because a compose surface is not built, **not** because the grant forbids it; send is planned
      and needs no further consent. A comment that blames the scope will read as a reason not to
      build it.

- [ ] **Step 6 — Commit:** `feat(google): opening a thread marks it read, and the reader can triage`

---

### Task 7: A real address book behind `@`-completion

`@`-completion lives **inside `MailView.tsx`** (added in `7b473b2`) and completes the search box —
`from:jane@syv.ai`. Its corpus is senders across loaded threads, ranked by frequency, and that
commit says a People API source "merges in behind these". This is that merge; the local corpus
**stays** as the fallback when contacts are cold or the request fails.

**Files:** `main/google/people.ts` (create) · `main/router.ts` · `main/google/cache.ts` (optional) ·
`renderer/src/features/google/MailView.tsx` · Test: `test/google-people.test.ts` (create)

- [ ] **Step 1 — Failing test.** Against a fake api: `listContacts` reads
      `people.connections.list` **and** `otherContacts.list`, requests
      `personFields=names,emailAddresses`, pages via `getAll`, and returns
      `MailAddress[]` (`{ name, email }` — the type already exists at `gmail.ts:38`, reuse it,
      **do not** introduce a second address shape). A person with no email is dropped; duplicates
      collapse on lowercased email.
      `otherContacts` is the one people forget and is where "everyone I have mailed" actually
      lives — connections alone is a thin address book.

- [ ] **Step 2 — Red. Step 3 — Implement** `listContacts(api)` + a `google.contacts` query.
      A failure returns `[]`, never throws: completion degrading to the local corpus is correct
      behaviour, and a broken dropdown over a cold contacts API is not.

- [ ] **Step 4 — Green.** Then merge in the renderer: contacts first, local corpus behind,
      deduplicated on lowercased email. **Keep the existing `mentionAt` gate** — that commit
      records that testing the text *after* the `@` cannot work, because the last `@` never has one
      after it, and it reopened the popup on an accepted `from:jane@syv.ai`.

- [ ] **Step 5 — Commit:** `feat(google): @-completion reads the real address book`

---

### Task 8: Write the decisions down

`docs/` **is** committed (that rule reversed 2026-07-16). `decisions.md` is a staging ledger and
the next free number is **D68**.

**Files:** `docs/decisions.md` · `docs/specs/2026-08-04-google-mail-calendar-design.md`

- [ ] **Step 1 — Add D68**, "Mail is read-write within a bounded set", in the file's ADR shape
      (context / decision / why / rejected / deferred). It must carry:
      - **It reverses D67 §4**, which said read-only both services. Cross-reference both ways —
        add a line to D67 §4 pointing at D68, matching how §7's "nothing persisted" was overturned
        in place.
      - **The boundary, and which half of it Google actually enforces.** Built: read state, star,
        archive, trash. Not built: send, label editing. Impossible: permanent delete
        (`mail.google.com` is not requested). Trash is recoverable; that is what makes it not-delete.
      - **`gmail.modify` grants send, and there is no scope that does not.** `users.messages.send`
        accepts `gmail.modify`, and `threads.modify` — which archive and trash need — is available
        under no lesser scope. So "Holi cannot send" stopped being a fact about the *grant* the
        moment this landed and became a fact about the *code*. This matters to D67 §5, which gated
        the agent's send behind `Bash(holi-google send:*)` permission rules while treating the
        read-only scope as the outer wall. That wall is gone; the permission rule is now the only
        one. Deliberate and accepted — archive is unobtainable otherwise — but recorded, because a
        defence that quietly became single-layered is exactly what nobody re-derives later.
        Sending, when it is built, needs **no new scope and no second consent screen**.
      - **`contacts.readonly` rode the same consent screen** — one re-consent instead of two, which
        is why it landed with a mail decision rather than on its own.
      - **Verification:** `gmail.modify` is restricted, the same CASA tier as `gmail.readonly`, so
        D67's testing-mode/≤100-users posture is unchanged. `contacts.readonly` is *sensitive*, a
        lighter tier. Neither is a new verification problem; say so explicitly so nobody re-derives it.
      - **The stored-scopes gap** (Task 1) — `scopes` was written and never compared, so widening
        the list would have stranded an existing grant. Worth recording as a class of bug, not a
        line of code.
      - **Reconciliation:** local patch is optimism, `history.list` is truth.
      - **Deferred, on purpose: the agent gets none of this.** `holi-google` is handed read
        functions and stays that way. Giving an LLM archive and trash over a real mailbox is a
        separate decision; D67 §5 already names the mechanism if it is ever taken
        (`Bash(holi-google …)` permission rules).

- [ ] **Step 2 — Update the spec** where it states the read-only stance.

- [ ] **Step 3 — Full suite**, all five, then commit: `docs(google): D68 — mail is read-write within a bounded set`

---

## Done when

- [ ] typecheck 0 · eslint 0 errors (2 known warnings in `EditorPane.tsx` / `TaskDetail.tsx`)
- [ ] node ≥964 · dom ≥171 · shared 229 — all green
- [ ] The three read-only claims (D67 §4, `session.ts:55`, `MailView.tsx:1`) all rewritten
- [ ] Nicolai has reconnected and confirmed the consent screen
- [ ] **Not pushed.** He approves pushes himself, each time, explicitly.

**What no suite here can prove:** nothing in this repo talks to Google, so every mutation is
verified against fakes. Real-mailbox behaviour of `threads.modify`, `threads.trash`, the
`labelId: 'INBOX'` history assumption in Task 5, and the People API shape are all unproven until
Nicolai uses it. Report it that way.
