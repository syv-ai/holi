# Google Pillar Depth — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the Google API data the pillar currently discards — calendar triage, mail labels and attachments, pagination — and make refresh cheap with a bounded local cache plus Gmail incremental sync.

**Architecture:** Three phases, each independently shippable. Phases 1 and 2 are pure "stop dropping fields" work on the existing on-demand fetch path. Phase 3 adds an account-scoped `node:sqlite` cache in `userData` and Gmail `history.list` deltas; it amends D67 §7.

**Tech Stack:** `node:sqlite` (built into Node 24 / Electron 43 — **no native module, no `electron-rebuild`**), the existing hand-rolled `GoogleApi`, tRPC, jotai, Tailwind v4 + the primitives/composites/features hierarchy.

**Plan style:** lean per `holi-plan-style` — contracts, exact paths, test intent and gotchas, *not* full inline implementations. This deliberately overrides the writing-plans skill's "complete code in every step" rule. Test names are given verbatim; write the body from the stated intent.

---

## Scope check

These are three subsystems and could be three plans. They are one document because they share type contracts (`CalendarEvent`, `MailThreadSummary`) that would otherwise be defined twice and drift. **Each phase has its own exit and ships alone** — do not start Phase 3 until 1 and 2 are committed and green.

## Findings that shaped this plan (verified, not assumed)

1. **`node:sqlite` is available and works** in both Electron 43 (Node 24.18.0) and the plain Node the `node` vitest project runs under. FTS5 compiles. Verified 2026-08-04 by running `DatabaseSync` + `CREATE VIRTUAL TABLE … USING fts5` in both. No experimental warning is printed.
2. **Calendar `syncToken` is incompatible with `timeMin`/`timeMax`.** Verified verbatim from the `events.list` reference: *"There are several query parameters that cannot be specified together with `nextSyncToken` … These are: `iCalUID`, `orderBy`, `privateExtendedProperty`, `q`, `sharedExtendedProperty`, `timeMin`, `timeMax`, `updatedMin`"*. An expired token returns **410**.
   **Consequence — this is the plan's biggest design decision:** calendar incremental sync would force a **full-calendar mirror** (every event, all time, per calendar) to serve an agenda that only ever shows 7 days. That trade is refused. Phase 3 gives Calendar a *cache for instant paint* and keeps refetching the window (already one request per enabled calendar). **Gmail is where incremental sync pays** — a mail refresh is currently `threads.list` + one `threads.get` per thread, i.e. **26 requests for 25 threads**, and `history.list` collapses an unchanged refresh to **1**.
3. **Gmail `history.list` 404s when `startHistoryId` is too old** (Google keeps roughly a week). That is a normal outcome, not an error — it means full resync.

## Open question to resolve during Phase 2, not now

Whether `format=metadata` returns `payload.parts`. If it does, a thread row can show a paperclip for free; if not, **drop the list-level attachment indicator** rather than adding a request per thread. Check a real response (Task 9) before building the indicator.

## File structure

| File | Responsibility |
|---|---|
| `src/main/google/calendar.ts` | modify — richer `RawEvent`/`CalendarEvent`, RSVP, event kind, conference URL |
| `src/main/google/event-colors.ts` | **create** — `colors.get` palette, so a per-event `colorId` resolves to Google's own hex |
| `src/main/google/gmail.ts` | modify — labels, categories, attachments, extra headers, pagination |
| `src/main/google/labels.ts` | **create** — `labels.list`, id→name, session-memoised |
| `src/main/google/cache.ts` | **create** — the `node:sqlite` store: threads, meta, bounded prune, wipe |
| `src/main/google/mail-sync.ts` | **create** — `history.list` delta + full-resync fallback |
| `src/main/router.ts` | modify — pagination shape, category input, cache wiring |
| `src/main/index.ts` | modify — open the cache, wipe on disconnect |
| `src/renderer/src/features/google/AgendaView.tsx` | modify — RSVP badge, kind markers, attendees, conference |
| `src/renderer/src/features/google/MailView.tsx` | modify — star/draft/labels/attachments/category/load-more |
| `test/google-calendar.test.ts`, `test/google-gmail.test.ts` | modify |
| `test/google-event-colors.test.ts`, `test/google-labels.test.ts`, `test/google-cache.test.ts`, `test/google-mail-sync.test.ts` | **create** |

**Gate reminder:** `features/*` may import `primitives`, `composites`, its own feature, `lib/`, `state/`. Native `<button>/<input>/<form>` are banned outside `primitives/`. Arbitrary colour literals in class names are banned — a Google colour goes in an inline `style`, as `Swatch` already does.

**Verification loop** (from `apps/desktop`, absolute-path your `cd` — the shell drifts):
`pnpm exec node node_modules/typescript/bin/tsc --noEmit` · `pnpm exec eslint src` · `pnpm exec vitest run --project node` (~200s, background it) · `--project dom` · shared from `packages/shared`.

---

# Phase 1 — Calendar triage

**Exit:** the agenda distinguishes an unanswered invitation, an out-of-office block and a "free" event; shows who called the meeting and how many are coming; and a Zoom/Teams link works, not only Meet.

### Task 1: Event colour palette

**Files:** Create `src/main/google/event-colors.ts`, `test/google-event-colors.test.ts`

Contract:
```ts
/** colorId → hex, from GET /calendar/v3/colors (the `event` map). */
export async function fetchEventColors(api: GoogleApi): Promise<Record<string, string>>
```

- [ ] **Step 1: Write the failing tests** in `test/google-event-colors.test.ts`, using the `googleApi(routes)` fake already at the top of `test/google-calendar.test.ts` (copy it; it is 20 lines and the two files version independently):
  - `'maps a colorId to the hex Google actually uses'`
  - `'returns an empty map rather than throwing when the palette is unavailable'` — a palette failure must never take the agenda down with it
- [ ] **Step 2: Run** `pnpm exec vitest run --project node test/google-event-colors.test.ts` — expect FAIL, module not found
- [ ] **Step 3: Implement.** One `api.get` of `https://www.googleapis.com/calendar/v3/colors`, read `.event`, map each entry to its `background`. Catch and return `{}`.
- [ ] **Step 4: Run** the same command — expect PASS
- [ ] **Step 5: Commit** `feat(google): resolve Google's own event colour palette`

### Task 2: Richer event parsing

**Files:** Modify `src/main/google/calendar.ts`, `test/google-calendar.test.ts`

Contract — extend the existing exported types:
```ts
export type RsvpStatus = 'needsAction' | 'tentative' | 'accepted' | 'declined'
/** `workingLocation` is deliberately absent — those are filtered out entirely. */
export type EventKind = 'default' | 'outOfOffice' | 'focusTime' | 'birthday' | 'fromGmail'

export interface CalendarEvent {
  // … all existing fields unchanged …
  /** The user's own RSVP. `null` when they are not an attendee at all. */
  myResponse: RsvpStatus | null
  kind: EventKind
  /** `false` when Google says `transparency: 'transparent'` — it does not block time. */
  busy: boolean
  description: string | null
  attendeeCount: number
  organizer: string | null
  /** conferenceData entry point, falling back to `hangoutLink`. Meet, Zoom or Teams. */
  conferenceUrl: string | null
  recurring: boolean
}
```
`RawEvent` gains: `description`, `organizer { displayName, email }`, `conferenceData { entryPoints: { entryPointType, uri }[] }`, `eventType`, `transparency`, `colorId`, `recurringEventId`, and `attendees[]` gains `email`/`displayName`/`resource`.

`toCalendarEvent` takes the colour palette as a third argument; `color` = `palette[event.colorId] ?? calendar.color`.

- [ ] **Step 1: Write the failing tests** in the existing `describe('listAgenda')`:
  - `'surfaces an invitation the user has not answered'` — `attendees: [{ self: true, responseStatus: 'needsAction' }]` → `myResponse === 'needsAction'`. **The single most valuable field in this phase.**
  - `'leaves myResponse null for an event with no attendees'` — a solo event is not an unanswered invitation
  - `'drops workingLocation events, which Google creates every day'` — pure agenda noise, not an event
  - `'marks out-of-office and focus-time so they do not read as meetings'`
  - `'marks a transparent event as not blocking time'`
  - `'prefers a conferenceData entry point over hangoutLink, so Zoom and Teams work'` — pin a `video` entryPoint with a `zoom.us` uri
  - `'falls back to hangoutLink when there is no conferenceData'`
  - `'lets a per-event colour override the calendar colour'`
  - `'counts attendees and names the organizer'`
  - `'marks an instance of a recurring series'`
  - `'carries the description through'` — it holds dial-in details and agendas
- [ ] **Step 2: Run** `pnpm exec vitest run --project node test/google-calendar.test.ts` — expect FAIL
- [ ] **Step 3: Implement.** Extend `RawEvent`, add the mapping, filter `workingLocation` in `isWorthShowing`, thread the palette through `listAgenda`.
  **Gotcha:** existing fixtures have no `attendees`; `attendeeCount` must be `0` and `myResponse` `null` without throwing. **Gotcha:** `isWorthShowing` already drops `declined` — keep that, and do not also drop `needsAction`, which is the case we now want to surface.
- [ ] **Step 4: Run** — expect PASS, including every pre-existing test in the file
- [ ] **Step 5: Commit** `feat(google): parse RSVP, event kind, conference and description`

### Task 3: The user's own name for a subscribed calendar

**Files:** Modify `src/main/google/calendar.ts`, `test/google-calendar.test.ts`

- [ ] **Step 1: Write the failing test** `'prefers the name the user gave a subscribed calendar'` — `summaryOverride: 'Jane (design)'` beats `summary: 'Jane Doe'`. Google Calendar displays the override; showing the owner's name for a calendar you renamed is a small, constant papercut.
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement.** `CalendarListEntry` gains `summaryOverride?: string`; `resolveCalendars` uses `summaryOverride ?? summary` for `name`.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(google): honour summaryOverride for subscribed calendars`

### Task 4: Agenda UI

**Files:** Modify `src/renderer/src/features/google/AgendaView.tsx`, `src/renderer/src/features/google/__tests__/AgendaView.test.tsx`

- [ ] **Step 1: Write the failing dom tests:**
  - `'flags an invitation that still needs an answer'` — a visible RSVP affordance; clicking opens the event in Google (read-only scope, so Holi cannot RSVP and must not pretend to)
  - `'marks out-of-office distinctly from a meeting'`
  - `'dims an event that does not block time'`
  - `'offers the video link for a Zoom conference, not just Meet'`
  - `'puts the event description into the task it creates'` — assert the `tasks.create` description contains both the link and the description
- [ ] **Step 2: Run** `pnpm exec vitest run --project dom src/renderer/src/features/google` — expect FAIL
- [ ] **Step 3: Implement.** Extend the renderer's local `CalendarEvent` interface to match Task 2 exactly. RSVP badge, kind marker, dimming via existing tokens, `conferenceUrl` on the video button.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Run the full loop** (typecheck, eslint, node, dom) and **commit** `feat(google): agenda shows RSVP, event kind and conference links`

---

# Phase 2 — Mail depth

**Exit:** the inbox defaults to Primary, rows show starred/draft/labels, a message lists its attachments, and the list pages.

### Task 5: Extra headers and labels on the thread summary

**Files:** Modify `src/main/google/gmail.ts`, `test/google-gmail.test.ts`

Contract:
```ts
export type MailCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums'

export interface MailThreadSummary {
  // … all existing fields unchanged …
  starred: boolean
  important: boolean
  /** An unsent draft sits in this thread — you started replying and stopped. */
  hasDraft: boolean
  category: MailCategory | null
  /** User label NAMES, already resolved. Gmail's own system labels are excluded. */
  labels: string[]
  /** From the List-Unsubscribe header — a URL to open, never a request Holi sends. */
  unsubscribeUrl: string | null
}
```
Add `To`, `Cc`, `Reply-To`, `List-Unsubscribe` to the `metadataHeaders` array. **This is free** — same request, and the array form now works (that was the `(no subject)` fix).

- [ ] **Step 1: Write the failing tests:**
  - `'marks a starred thread'`, `'marks an important thread'`
  - `'marks a thread holding an unsent draft'` — pairs with `answered`; "you started replying" is a distinct state from both
  - `'reads the category from Gmail's own label'` — `CATEGORY_PROMOTIONS` → `'promotions'`; **`CATEGORY_PERSONAL` → `'primary'`**, which is the mapping that will be got wrong if it is not pinned
  - `'leaves category null when Gmail assigns none'`
  - `'excludes system labels from the label list'` — `INBOX`/`UNREAD`/`CATEGORY_*` are not user labels and must not render as chips
  - `'extracts an unsubscribe URL from a List-Unsubscribe header'` — the header may hold `<mailto:…>, <https://…>`; **prefer the https one**, and return `null` when only mailto is offered
  - `'asks for the recipient and unsubscribe headers in the same request'` — assert `getAll('metadataHeaders')` contains the new names, guarding the regression that caused `(no subject)`
- [ ] **Step 2: Run** `pnpm exec vitest run --project node test/google-gmail.test.ts` — expect FAIL
- [ ] **Step 3: Implement.** Label predicates on the aggregate thread (starred/important/draft if *any* message carries it), category from the last message, `labels` filtered to non-system ids.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(google): star, draft, category and unsubscribe on mail threads`

### Task 6: User label names

**Files:** Create `src/main/google/labels.ts`, `test/google-labels.test.ts`; modify `src/main/google/gmail.ts`

Contract:
```ts
/** id → user-visible name, for Gmail's user labels only. */
export async function fetchLabelNames(api: GoogleApi): Promise<Map<string, string>>
```

- [ ] **Step 1: Write the failing tests:**
  - `'maps a label id to its name'` — `Label_12` → `Work/Clients`
  - `'omits system labels, which are not the user's'`
  - `'returns an empty map rather than throwing'` — labels are decoration; losing them must not lose the inbox
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement.** One `api.get` of `…/users/me/labels`, keep `type === 'user'`. `listThreads` resolves ids to names through it; **fetch once per `listThreads` call, not once per thread** — that is the N+1 this whole area keeps inviting.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(google): resolve Gmail user label names`

### Task 7: Category filter and pagination

**Files:** Modify `src/main/google/gmail.ts`, `src/main/router.ts`, `test/google-gmail.test.ts`

Contract — **this changes the router's return shape**, so update `MailView`'s local types in the same commit:
```ts
export interface MailPage {
  threads: MailThreadSummary[]
  /** null when there is nothing more to load. */
  nextPageToken: string | null
}
export interface ListThreadsOptions {
  query?: string
  limit?: number
  pageToken?: string
  /** Composed into the Gmail query as `category:<name>`. */
  category?: MailCategory
}
export async function listThreads(api: GoogleApi, options?: ListThreadsOptions): Promise<MailPage>
```

**Design note — the category filter is a query, not a client-side filter.** Gmail's search grammar already has `category:primary`, and the search box passes that grammar through verbatim. Composing the query costs nothing and keeps one code path.

**Deliberately NOT built: the per-category counts** shown in the design mock. They would cost a request each and `resultSizeEstimate` is an *estimate* — a wrong count is worse than no count.

- [ ] **Step 1: Write the failing tests:**
  - `'composes the category into Gmail's own query grammar'` — `q` contains `category:primary`
  - `'keeps the user's query when a category is also set'` — both survive; a search inside Promotions must work
  - `'returns the page token so the list can load more'`
  - `'reports null when there is no further page'`
  - `'passes the page token back to Gmail'`
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement.** Then update `router.ts`'s `threads` procedure input (`category`, `pageToken`) and return type. **Gotcha:** `fields()` is string-only — `category` is a string, so it fits; do not reach for `booleanOrThrow` here.
- [ ] **Step 4: Run** node tests + `tsc --noEmit` — expect PASS
- [ ] **Step 5: Commit** `feat(google): category filter and pagination for mail`

### Task 8: Attachments on a read thread

**Files:** Modify `src/main/google/gmail.ts`, `test/google-gmail.test.ts`

Contract:
```ts
export interface MailAttachment {
  filename: string
  mimeType: string
  /** Bytes, from the part's `body.size`. */
  size: number
}
export interface MailMessage {
  // … existing …
  to: string[]
  cc: string[]
  attachments: MailAttachment[]
}
```
`readThread` already uses `format=full`, so the parts are present — **no extra request**.

- [ ] **Step 1: Write the failing tests:**
  - `'lists a message's attachments'`
  - `'does not mistake the body for an attachment'` — a `text/plain` part with no filename is the message; this is the mirror of the existing `bodyTextOf` attachment test
  - `'finds an attachment nested in a multipart tree'`
  - `'reads Cc alongside To'`
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement.** Walk the MIME tree collecting parts with a non-empty `filename`; reuse the existing recursion rather than adding a second walker.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(google): list attachments on a mail thread`

### Task 9: Mail UI

**Files:** Modify `src/renderer/src/features/google/MailView.tsx`, `src/renderer/src/features/google/__tests__/MailView.test.tsx`

- [ ] **Step 1: Resolve the open question.** With the app running and Google connected, log one `listThreads` raw response and check whether `format=metadata` includes `payload.parts`. If not, **skip the row-level paperclip entirely** — do not add a request per thread to draw an icon.
- [ ] **Step 2: Write the failing dom tests:**
  - `'defaults the inbox to Primary'` — assert the query sent carries `category: 'primary'`
  - `'lets the user look at Promotions'`
  - `'marks a starred thread'`, `'marks a thread with an unsent draft'`
  - `'shows user labels as chips'`
  - `'lists attachments on an open message'`
  - `'opens an attachment in Gmail rather than downloading it'` — assert `openExternal` with the thread's `webUrl`; the scope is read-only and v1 does not download
  - `'loads the next page when asked'` — assert the second query carries the page token and rows are appended, not replaced
  - `'offers an unsubscribe link for a newsletter'` — `openExternal`, never a request Holi makes itself
- [ ] **Step 3: Run** `pnpm exec vitest run --project dom src/renderer/src/features/google` — expect FAIL
- [ ] **Step 4: Implement.** Category as a `DropdownMenu` in the list header (mirror `CalendarPicker`). "Load more" is a `Button` at the list foot — **not** an infinite scroller; a rate-limited API and an unbounded scroll are a bad pair.
- [ ] **Step 5: Run the full loop** and **commit** `feat(google): primary inbox, labels, attachments and paging in the mail UI`

---

# Phase 3 — Cache and Gmail incremental sync

**Exit:** launching paints the last inbox and agenda immediately; a refresh with nothing new costs one request instead of twenty-six; disconnect leaves nothing on disk.

**Do not start until Phases 1 and 2 are committed and green.**

### Task 10: The cache

**Files:** Create `src/main/google/cache.ts`, `test/google-cache.test.ts`

Contract:
```ts
export interface GoogleCache {
  /** Wipes everything if `sub` differs from the stored account. Call before any read. */
  useAccount(sub: string): void
  readThreads(key: string): MailThreadSummary[] | null
  writeThreads(key: string, threads: MailThreadSummary[]): void
  readAgenda(key: string): CalendarEvent[] | null
  writeAgenda(key: string, events: CalendarEvent[]): void
  historyId(): string | null
  setHistoryId(id: string): void
  /** Delete the database file. Disconnect calls this. */
  destroy(): void
  close(): void
}
export function openGoogleCache(path: string): GoogleCache
```
`key` is the query + category (mail) or the window + calendar set (agenda) — cached results must never be served to a different question.

**Bounded at 500 threads**, newest first, pruned on write. This is the "last N, refetch older" shape: paging past the tail is a `pageToken` fetch, not a cache read.

- [ ] **Step 1: Write the failing tests:**
  - `'returns null before anything has been cached'`
  - `'round-trips a thread list'`
  - `'never serves one query's results for another'`
  - `'wipes everything when a different Google account connects'` — **the security-relevant one.** Connect account A, cache mail, connect account B: B must not see A's inbox.
  - `'keeps only the newest N threads'`
  - `'destroy leaves no file behind'` — pin the file is gone, because Disconnect promises exactly that
  - `'survives a corrupt database file rather than crashing'` — same stance as `token-store`: a bad file costs the cache, never the app
- [ ] **Step 2: Run** `pnpm exec vitest run --project node test/google-cache.test.ts` — expect FAIL
- [ ] **Step 3: Implement** with `node:sqlite`'s `DatabaseSync`. Tables: `meta(key TEXT PRIMARY KEY, value TEXT)` and `threads(…, key TEXT, position INTEGER)`. Use a temp dir per test (`mkdtemp`), as `google-calendar-prefs.test.ts` does.
  **Gotcha:** `node:sqlite` is a *sync* API — do not wrap it in promises for the look of it.
  **Gotcha:** the DB is **unencrypted**, deliberately (SQLCipher is a native module, and encrypting columns would kill any future FTS5 search). Say so in the module header; the protection is the OS account and disk encryption, which is what every desktop mail client relies on.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(google): bounded account-scoped cache on node:sqlite`

### Task 11: Gmail incremental sync

**Files:** Create `src/main/google/mail-sync.ts`, `test/google-mail-sync.test.ts`

Contract:
```ts
/**
 * The cached list brought up to date. Falls back to a full `listThreads` when
 * there is no cache, no history id, or Google has expired the id.
 */
export async function syncThreads(
  api: GoogleApi,
  cache: GoogleCache,
  options: ListThreadsOptions,
): Promise<MailPage>
```

- [ ] **Step 1: Write the failing tests:**
  - `'does a full fetch when nothing is cached'`
  - `'asks Gmail only what changed when a history id is held'` — assert `history.list` is called and `threads.get` is **not**
  - `'refetches only the threads history says changed'` — the actual win: two changed threads → two `threads.get`, not twenty-five
  - `'falls back to a full fetch when Google has expired the history id'` — **404 is a normal outcome here, not an error**; assert it resyncs and does not surface a failure
  - `'stores the new history id after a sync'`
  - `'applies a label change without refetching the thread'` — read/unread flipping is the most common delta of all
  - `'drops a thread history reports as deleted'`
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement.** `history.list` with `startHistoryId` and `labelId=INBOX`. Catch `GoogleApiError` with `status === 404` → full resync. Take the new `historyId` from the response.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(google): incremental Gmail sync via history.list`

### Task 12: Wire the cache in, and wipe it on disconnect

**Files:** Modify `src/main/index.ts`, `src/main/router.ts`, `src/main/google/session.ts` (or the router's `disconnect`), `test/router-google.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - `'disconnect deletes the cached mail'` — **the one that matters.** Disconnect already revokes at Google and clears the keychain; leaving mail on disk would make the button a lie
  - `'a cached agenda is served before Google answers'`
  - `'the agent's ops server never reads the cache'` — the agent asks for current data and must not be handed a stale answer (see D67: "Do not cache")
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement.** Open the cache in `main/index.ts` beside `calendarPrefs`, at `join(app.getPath('userData'), 'google-cache.db')`. Pass to the router. Call `useAccount(sub)` on connect, `destroy()` on disconnect.
  **Gotcha:** `google/cache.ts` must not import `electron` — every other file in `google/` avoids it so the suite runs under plain Node, and `electron.ts` is the only exception.
- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(google): serve cached mail on launch, wipe it on disconnect`

### Task 13: Record the decision change

**Files:** Modify `docs/decisions.md` (D67), `docs/specs/2026-08-04-google-mail-calendar-design.md`, memory `holi-google-mail-calendar-design`

- [ ] **Step 1: Amend D67 §7.** It says *"nothing persisted"*, and *"Persist mail to disk — contradicts 'Google is source of truth'"* sits in its Rejected list. **Both are now overturned, on Nicolai's call.** Record what actually changed and why: a bounded last-N cache is not a mirror, Google remains the source of truth (the cache is discarded on disconnect and on an account change), and the win is a refresh costing 1 request instead of 26.
- [ ] **Step 2: Record what was NOT done and why** — calendar `syncToken`, because it cannot be combined with `timeMin`/`timeMax` and would force a full-calendar mirror to serve a 7-day view. Quote the constraint so nobody re-derives it.
- [ ] **Step 3: Update the memory** so the next session does not "fix" the unencrypted DB or move the cache into the vault.
- [ ] **Step 4: Commit** `docs(google): D67 amended — bounded local cache overturns "nothing persisted"`

---

## Self-review

**Spec coverage.** RSVP/`needsAction` → T2, T4. `eventType` → T2, T4. `transparency` → T2, T4. `description` → T2, T4. attendees/organizer → T2, T4. `conferenceData` → T2, T4. `colorId` → T1, T2. `summaryOverride` → T3. STARRED/IMPORTANT/DRAFT → T5, T9. `CATEGORY_*` + Primary default → T5, T7, T9. `labels.list` → T6, T9. To/Cc/Reply-To/List-Unsubscribe → T5, T8, T9. Attachments → T8, T9. Pagination → T7, T9. Incremental sync → T10, T11, T12. D67 amendment → T13. **No gaps.**

**Type consistency.** `MailThreadSummary` is extended once (T5) and consumed unchanged after. `listThreads` returns `MailPage` from T7 onward — T11's `syncThreads` returns the same type, and T9's UI is updated in the same commit as the shape change. `CalendarEvent` is extended once (T2); T1's palette feeds `toCalendarEvent` there. `GoogleCache` is defined in T10 and used verbatim in T11 and T12.

**Known deviations from the mock shown to Nicolai:** per-category counts are dropped (T7 explains why). The row-level attachment paperclip is conditional on a real-response check (T9 Step 1).
