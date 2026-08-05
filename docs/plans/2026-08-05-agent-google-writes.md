# D70 — agent mail + calendar writes: implementation plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent the mail and calendar writes D68 §6 withheld, with `send`/`reply`
behind a hook that always asks.

**Architecture:** The ops server is handed *more functions and still never `googleData`*.
Label writes reuse `googleData`'s existing four bound methods so the UI's cache stays
coherent; `send`/`draft`/`reply` and the calendar writes are raw functions, because those
land in the cache via the next `history.list` delta (mail) or the always-refetch agenda
(calendar). The gate is a seeded `PreToolUse` hook, not a permission rule.

**Spec:** `docs/specs/2026-08-05-agent-google-writes-design.md` · **Decision:** D70

**Plan style:** contracts and gotchas, not inline implementations. Tests are named and their
*assertion* is specified; write the code to match the codebase around it.

---

## Standing rules for this plan

- **`pnpm exec` always.** Bare `node`/`npx` are broken here. `cd` with absolute paths.
- **Never run `pnpm run format` / `prettier --write`** — it corrupts this repo (no semicolons,
  hand-formatted; root `.prettierrc.json` omits `"semi": false`).
- **Node tests live in `apps/desktop/test/*.test.ts`** and are **not typechecked**. Renderer
  tests are co-located and must be `.test.tsx`.
- **Main-process edits do not hot-reload.** Everything in this plan except `SKILL.md` needs a
  `pnpm dev` restart to see live.
- **No personal name in code** — fixtures use `Ada Holm` / `ada@syv.ai`.
- Verification loop from `apps/desktop`: `pnpm exec node node_modules/typescript/bin/tsc
  --noEmit` · `pnpm exec eslint src` · `pnpm exec vitest run --project node` (~150s,
  background it) · `pnpm exec vitest run --project dom`.

**The failure mode this plan is written against** (D69, three occurrences): *a test that
asserts what the code assumes, rather than what the external system does, passes while the
feature is broken.* Every fake added here must **refuse the way Google refuses**. Nothing in
this repo has ever talked to Google.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/main/google/api.ts` | + `postJson<T>` — a write whose body is read. **Modify** |
| `src/main/google/mime.ts` | **New.** RFC-822 assembly + base64url. Pure, no network. |
| `src/main/google/gmail.ts` | + `sendMessage`, `createDraft`, `replyToThread`. **Modify** |
| `src/main/google/calendar.ts` | + `createEvent`, `updateEvent`, `deleteEvent`, attendee refusal. **Modify** |
| `src/main/google/ops-server.ts` | + POST routing, + 9 operations on `GoogleOps`. **Modify** |
| `src/main/google/cli.ts` | + 9 subcommands, stdin bodies. **Modify** |
| `src/main/google/data.ts` | module doc only — the agent now writes through here. **Modify** |
| `src/main/google/session.ts` | + `calendar.events` scope. **Modify** |
| `src/main/agent/agent-runtime.ts` | prepend the `bin/` dir to the child `PATH`. **Modify** |
| `src/main/agent/hooks/google-send-gate.mjs` | **New.** Returns `ask` for send/reply, `defer` otherwise. |
| `src/main/agent/seed-content.ts` | seed the hook + `permissions.ask` rules. **Modify** |
| `src/main/agent/skills/gmail-calendar/SKILL.md` | teach the tiers; delete the false claims. **Modify** |
| `src/main/index.ts` | wire the new ops. **Modify** |

Tests: `test/google-mime.test.ts` (new), and additions to `google-api`, `google-gmail`,
`google-calendar`, `google-ops-server`, `google-cli`, `agent-runtime`, `seed-content`.

---

## Task 1: `postJson` — a write whose body is read, without ever reporting a done send as failed

**Files:** Modify `src/main/google/api.ts` · Test `test/google-api.test.ts`

`post` returns `void` on purpose (D69), and the reason is load-bearing: *"Reading
`res.json()` and letting it throw would report a completed archive as failed."* For `send`
the consequence is worse than a wrong UI — **the agent retries and the recipient gets the
email twice.**

So `postJson` is not `post` with a parse bolted on. Contract:

```ts
async postJson<T>(url: string, body: unknown): Promise<T | null>
```

- **Non-2xx → throw** the same `classify(res)` error `post` throws. Unchanged semantics.
- **2xx with an unparseable or empty body → `null`, never a throw.** `null` means *"Google
  accepted it; we could not read what it said."*
- `post` stays exactly as it is. Do not refactor it to call `postJson` — its drain-and-
  discard is the documented behaviour for the four label writes.

- [ ] **Step 1** — Write failing tests in `test/google-api.test.ts`:
  - `postJson returns the parsed body on 200`
  - `postJson returns null when a 200 carries no body` — fake responds 200 with `''`
  - `postJson returns null when a 200 body is not JSON` — fake responds 200 with `'<html>'`;
    **assert it does not throw.** This is the test that stops a double send.
  - `postJson throws on 403 exactly as post does` — assert the `GoogleApiError` kind is
    `scope`, not merely that it threw.
- [ ] **Step 2** — Run `pnpm exec vitest run --project node test/google-api.test.ts`. Expect FAIL.
- [ ] **Step 3** — Implement `postJson`. Comment must say why `null` is not an error.
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(google): a write whose body is read, without reporting a done send as failed`

---

## Task 2: `mime.ts` — RFC-822 assembly

**Files:** Create `src/main/google/mime.ts` · Test `test/google-mime.test.ts`

Pure logic, no network — the easiest thing here to get right and the easiest to get
silently wrong. `messages.send` takes `{ raw: <base64url of a full RFC-822 message> }`.

```ts
export interface OutgoingMail {
  to: string[]
  subject: string
  body: string              // plain text
  cc?: string[]
  inReplyTo?: string        // RFC-822 Message-ID of the message being answered
  references?: string[]     // the thread's Message-ID chain
}
export function buildRfc822(mail: OutgoingMail): string      // the MIME text
export function toBase64Url(text: string): string            // base64, +/ → -_, no padding
```

**Gotchas, each of which gets a test:**
- **base64url, not base64.** `+`→`-`, `/`→`_`, `=` padding stripped. Plain base64 is rejected.
- **A reply needs `In-Reply-To` *and* `References`.** With only `In-Reply-To`, Gmail starts a
  new thread. This looks perfect in a fake and is wrong in the mailbox.
- **CRLF line endings** between headers. `\n` alone is out of spec and some servers care.
- **Non-ASCII must survive.** A subject with `æøå` needs RFC 2047 encoded-word
  (`=?UTF-8?B?...?=`); a body with `æøå` needs `Content-Type: text/plain; charset="UTF-8"`.
  A Danish user will hit this on day one — do not skip it.
- **Header injection.** A `to` or `subject` containing `\r` or `\n` must be **rejected with a
  throw**, not sanitised. The agent composes these strings from user prose; a newline in a
  subject is how you smuggle extra headers.

- [ ] **Step 1** — Write `test/google-mime.test.ts` covering all five gotchas, plus a
  round-trip: `toBase64Url` output decodes back to the exact `buildRfc822` text.
- [ ] **Step 2** — Run it. Expect FAIL.
- [ ] **Step 3** — Implement `mime.ts`.
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(google): assemble an RFC-822 message, including the reply chain`

---

## Task 3: `sendMessage`, `createDraft`, `replyToThread`

**Files:** Modify `src/main/google/gmail.ts` · Test `test/google-gmail.test.ts`

```ts
export async function sendMessage(api: GoogleApi, mail: OutgoingMail): Promise<{ id: string | null }>
export async function createDraft(api: GoogleApi, mail: OutgoingMail, threadId?: string): Promise<{ id: string | null }>
export async function replyToThread(api: GoogleApi, threadId: string, body: string): Promise<{ id: string | null }>
```

Endpoints: `POST {BASE}/messages/send` `{raw}` · `POST {BASE}/drafts` `{message:{raw, threadId?}}`.

**`replyToThread` is where the real work is.** It must `readThread` first to derive:
- recipients — the `From` of the **last message not sent by the user**, plus its `Cc`
- the subject — the thread's, prefixed `Re: ` **only if not already so prefixed** (never `Re: Re:`)
- `inReplyTo` / `references` from the RFC-822 `Message-ID` headers
- `threadId` on the outgoing message, so Gmail files it in the thread

`id: null` (from `postJson`) is a **success**. Name the field so no caller reads it as failure.

- [ ] **Step 1** — Tests. The fake must **refuse the way Google refuses**: reject a `raw`
  that is not valid base64url with a 400, so a plain-base64 bug fails the test.
  - `sendMessage posts base64url raw to messages/send`
  - `a reply carries In-Reply-To and References from the thread` — assert both headers by
    decoding the `raw` the fake received. Not "a send happened".
  - `a reply to an already-Re: subject does not double the prefix`
  - `a reply addresses the last sender who is not the user`
  - `a draft carries threadId so it files into the thread`
  - `a send whose response body is unreadable still reports success` (guards the double send)
- [ ] **Step 2** — Run. Expect FAIL.
- [ ] **Step 3** — Implement.
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(google): send, draft, and a reply that stays in its thread`

---

## Task 4: calendar writes, with the attendee refusal in the function

**Files:** Modify `src/main/google/calendar.ts` · Test `test/google-calendar.test.ts`

```ts
// A plain Error. The ops server already turns a thrown error's message into the
// 502 body the agent reads, so the message IS the user-facing refusal.
export async function createEvent(api: GoogleApi, e: NewEvent): Promise<{ id: string | null }>
export async function updateEvent(api: GoogleApi, id: string, patch: EventPatch): Promise<void>
export async function deleteEvent(api: GoogleApi, id: string): Promise<void>

export interface NewEvent { title: string; start: string; end: string; allDay?: boolean; location?: string; description?: string }
export interface EventPatch { start?: string; end?: string; title?: string }
```

**The refusal is the point of this task (spec §2).** An event carrying attendees emails them
on create, and emails cancellations on delete. So:

- `NewEvent` has **no `attendees` field at all** — the type is the first wall.
- `updateEvent` and `deleteEvent` **`GET` the event first** and throw if it has a non-empty
  `attendees` array. This is the wall that matters, because those act on events the agent did
  not create.
- All three send **`sendUpdates=none`** as a belt-and-braces query param.
- Writes target `calendars/primary/events`.

**Gotcha:** an all-day event uses `start.date` (a `YYYY-MM-DD` string); a timed event uses
`start.dateTime` + `timeZone`. Sending `dateTime` for an all-day event silently creates a
midnight-to-midnight timed block, which looks right in a list and wrong in the day view.

- [ ] **Step 1** — Tests:
  - `createEvent posts a timed event with dateTime and a timeZone`
  - `createEvent posts an all-day event with date, not dateTime`
  - `deleteEvent refuses an event that has attendees` — **assert main refused: the fake's
    DELETE was never called.** Not that Google returned an error.
  - `updateEvent refuses an event that has attendees`
  - `deleteEvent removes an event with no attendees`
  - `every write carries sendUpdates=none`
- [ ] **Step 2** — Run. Expect FAIL.
- [ ] **Step 3** — Implement. The refusal message is read by the agent, so it must say *why*
  and what to do instead (ask the user to do it in Google Calendar).
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(google): calendar writes that refuse to email anyone`

---

## Task 5: the ops server learns POST and nine operations

**Files:** Modify `src/main/google/ops-server.ts` · Test `test/google-ops-server.test.ts`

**Ordering:** do **Task 6's first half** (`setRead`) before implementing this one — the ops
interface below names it. Everything else here is independent.

`GoogleOps` grows from 3 to 12. Reads unchanged; new:

```ts
setRead(id: string, read: boolean): Promise<void>    // see Task 6 — generalised from markRead
star(id: string, on: boolean): Promise<void>
archive(id: string): Promise<void>
trash(id: string): Promise<void>
draft(mail: OutgoingMail & { threadId?: string }): Promise<{ id: string | null }>
send(mail: OutgoingMail): Promise<{ id: string | null }>
reply(threadId: string, body: string): Promise<{ id: string | null }>
schedule(e: NewEvent): Promise<{ id: string | null }>
reschedule(id: string, patch: EventPatch): Promise<void>
unschedule(id: string): Promise<void>
```

**Contract for POST:** JSON body, `Content-Type: application/json`. The token stays in the
**query string** (`?t=`) for both verbs — one check, one place, and it keeps the existing
403 test honest.

**Gotchas:**
- **The token check must run before the body is read**, and an unauthenticated POST must not
  be parsed at all.
- **Bound the body size.** An unbounded `req.on('data')` accumulator on a localhost server is
  still a memory bug. Reject over ~1 MB with 413.
- A malformed JSON body is **400**, not the 502 that the Google-failure branch returns —
  those are different failures and the agent reads the difference.
- Keep `route()` returning `undefined` for unknown paths → 404. Do not let a new verb bypass it.

- [ ] **Step 1** — Tests: one per new route asserting the op is called with parsed args; plus
  `POST without a valid token is 403 and the body is never parsed`, `a malformed JSON body is
  400`, `an oversized body is 413`, `an unknown POST path is 404`.
- [ ] **Step 2** — Run. Expect FAIL.
- [ ] **Step 3** — Implement.
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(google): the ops server takes writes, and reads a bounded body`

---

## Task 6: `setRead`, then wire main — more functions, still never `googleData`

**Files:** Modify `src/main/google/gmail.ts`, `src/main/google/data.ts`, `src/main/router.ts`,
`src/main/index.ts` · Test `test/google-gmail.test.ts`, `test/google-data.test.ts`

**First, a small generalisation the CLI surface requires.** `mark-read <id> [--unread]` needs
both directions, and today there is only one: `markThreadRead(api, id)` removes `UNREAD` and
`googleData.markRead(id)` wraps it. Generalise both to the shape `setStarred` already has —
`setThreadRead(api, id, read)` and `googleData.setRead(id, read)` — so the two label pairs are
symmetrical instead of one being a special case. The router's `mail.markRead` call site updates
with it; its tRPC input gains `read: boolean` **or** keeps calling `setRead(id, true)`, whichever
leaves the renderer untouched. Marking unread is a real triage move ("leave this one for me")
and the asymmetry would otherwise leak into the ops server.

- [ ] **Step 1** — Tests: `setThreadRead(…, false) adds UNREAD`, `setThreadRead(…, true)
  removes it`, and the `googleData.setRead` equivalents patching the cache in both directions.
- [ ] **Step 2** — Run. Expect FAIL. Implement, update the router call site, re-run. Expect PASS.
- [ ] **Step 3** — Commit: `refactor(google): read is a two-way label, like starred`

**Then the wiring.** Pass into `createGoogleOpsServer`:
- **label writes → `googleData`'s bound methods** (`googleData.markRead` etc.) so the UI's
  cached list is patched by the identical function the router calls. No stale window.
- **`send`/`draft`/`reply`/calendar writes → the raw functions** with `googleApiFor()`. They
  need no cache patch: a new message reaches the cache via the next `history.list` delta, and
  the agenda always refetches (`cachedAgenda` is paint-only).

**`data.ts`'s module doc is now wrong and must be corrected in this commit.** It says *"The
agent does not come through here, and that is the point."* That stays true for **reads** and
becomes false for **label writes**. State both halves and why: the agent must never be served
a stale read, but its writes must land in the same cache the UI paints from.

- [ ] **Step 4** — Update the wiring in `index.ts`.
- [ ] **Step 5** — Correct the `data.ts` module doc.
- [ ] **Step 6** — `pnpm exec node node_modules/typescript/bin/tsc --noEmit`. Expect 0 errors.
- [ ] **Step 7** — Commit: `feat(google): the agent's writes land in the cache the UI paints from`

---

## Task 7: the CLI grows nine subcommands, with bodies on stdin

**Files:** Modify `src/main/google/cli.ts` · Test `test/google-cli.test.ts`

Surface is spec §5. Bodies arrive on **stdin** — a multi-line email in a shell argument is a
quoting accident, and it would put the whole message into the text of the confirmation prompt.

**Gotchas:**
- Build JSON in POSIX `sh` **without embedding unescaped user text**. Prefer
  `curl --data-binary @-` with the body piped in, or have `curl` read a file. Hand-rolling
  JSON escaping in `sh` is the same class of bug as hand-rolling percent-encoding, which is
  why `-G --data-urlencode` exists in the current script.
- **Update the header comment again.** Task 1 of this session made it say "every subcommand
  only reads". That becomes false here. The `test/google-cli.test.ts` pin added then will
  fail — that is the pin working. Rewrite both.
- Keep the existing `-G --data-urlencode` form for all read subcommands. Do not "unify" them.
- Unknown subcommand still exits 2 with usage.

- [ ] **Step 1** — Tests, against the live ops server the file already spins up:
  `archive`, `trash`, `star --off`, `mark-read --unread`, `schedule`, `unschedule` arg passing;
  `send reads the body from stdin` — pipe a **multi-line body containing a quote, a `$`, and
  `æøå`** and assert the op received it byte-identical. That single test covers the whole
  class of shell-quoting bugs.
- [ ] **Step 2** — Run. Expect FAIL (plus the header-claim pin failing, as designed).
- [ ] **Step 3** — Implement, and rewrite the header comment truthfully.
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(google): the CLI can write, and takes a message on stdin`

---

## Task 8: `PATH`, so the gate has something stable to match

**Files:** Modify `src/main/agent/agent-runtime.ts` · Test `test/agent-runtime.test.ts`

`buildAgentEnv` gains `googleBinDir?: string | null`, **prepended** to `PATH` so the agent can
type the bare name `holi-google`. This exists solely so the hook's `if` conditions have
predictable text to match (spec §4).

**Gotchas:**
- **Prepend, never append** — a `holi-google` earlier in `PATH` would win.
- Follow the file's existing reserved-key discipline: it deliberately strips inherited
  `HOLI_*` values so a vault env cannot spoof the target. `PATH` cannot be stripped, but the
  prepend must be built from *our* value, not from anything inherited.
- **`$HOLI_GOOGLE_BIN` stays set.** It is what the skill has always used, and the hook covers
  both spellings. Removing it breaks a working path for no gain.

- [ ] **Step 1** — Tests: `the google bin dir is prepended to PATH`; `PATH is unchanged when
  no bin dir is given`; `HOLI_GOOGLE_BIN is still set alongside it`.
- [ ] **Step 2** — Run. Expect FAIL.
- [ ] **Step 3** — Implement, and pass the dir from `index.ts` (`dirname(googleCliPath)`).
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(agent): the google bin dir goes on PATH so the gate can match`

---

## Task 9: the gate

**Files:** Create `src/main/agent/hooks/google-send-gate.mjs` · Modify `src/main/agent/seed-content.ts` · Test `test/google-send-gate.test.ts` (new), `test/seed-content.test.ts`

Follow the existing pattern exactly: `?raw` import, seeded to `.claude/hooks/`, invoked via
`hookCommand('google-send-gate')`.

**Hook contract** — reads the `PreToolUse` payload on stdin, writes to stdout:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
  "permissionDecision": "ask",
  "permissionDecisionReason": "Sending mail reaches someone outside Holi." } }
```

- `ask` for `send` and `reply`. **`defer` for everything else** — `defer` removes the hook's
  opinion and restores the normal permission flow, which is the correct "not my business"
  answer. Returning `allow` would silently widen every other command.
- Read the command from `tool_input.command`; match both `holi-google send|reply` and the
  `$HOLI_GOOGLE_BIN send|reply` form.
- **Fail closed.** Unparseable input, unexpected shape, any internal error → `ask`. A gate that
  crashes into `defer` is a gate that opens.

Seed alongside it in `settings.json`:
```
permissions.ask += Bash(holi-google archive:*), Bash(holi-google trash:*), Bash(holi-google send:*), Bash(holi-google reply:*)
```
These are the *undoable-tier* prompts and a belt-and-braces duplicate for send. They are **not
the wall** — the hook is, because `ask` overrides `permissions.allow` and a prior "don't ask
again" and these rules do not.

- [ ] **Step 1** — Write `test/google-send-gate.test.ts` (new), running the `.mjs` as a child
  process with real stdin payloads: `send → ask`, `reply → ask`, `$HOLI_GOOGLE_BIN send → ask`,
  `archive → defer`, `search → defer`, `a non-Bash tool → defer`, `garbage on stdin → ask`,
  `a command merely containing the word send (e.g. grep send notes.md) → defer`.
- [ ] **Step 2** — Run. Expect FAIL.
- [ ] **Step 3** — Implement the hook; seed it and the permission rules.
- [ ] **Step 4** — Re-run, plus `test/seed-content.test.ts`. Expect PASS.
- [ ] **Step 5** — Commit: `feat(agent): sending mail always asks, and the gate fails closed`

---

## Task 10: `SKILL.md` stops saying the false thing

**Files:** Modify `src/main/agent/skills/gmail-calendar/SKILL.md` · Test `test/seed-content.test.ts`

Paragraph 2 (*"You cannot send mail… there is nothing to call"*) and §Rules bullet 1 (*"You
have no write commands"*) both become false. `seed-content.test.ts` pins the old true claim and
the absence of the old false one — **update the pin in this commit**, that is the mechanism
working.

The replacement teaches the **tiers**, not a capability list:
- prefer `draft` for anything outbound; it reaches nobody and leaves the user one click away
- `send`/`reply` will prompt the user every time — expected, not an error to route around
- attendee-bearing events are refused by Holi; offer to let the user do it in Google Calendar
- `unschedule` deletes a real event off a real calendar — confirm with the user in chat first
- keep the existing "Do not cache" and linking guidance untouched

- [ ] **Step 1** — Update the pin in `seed-content.test.ts`: assert the new true claim
  (`draft` preferred, `send` prompts) and the **absence** of `there is nothing to call` and
  `You have no write commands`.
- [ ] **Step 2** — Run. Expect FAIL.
- [ ] **Step 3** — Rewrite the skill.
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(agent): the skill teaches which writes reach a human`

---

## Task 11: the scope, and the re-consent

**Files:** Modify `src/main/google/session.ts` · Test `test/google-session.test.ts`

Add `https://www.googleapis.com/auth/calendar.events` to `GOOGLE_SCOPES`.

**Gotcha (D68, and it has bitten once already):** widening `GOOGLE_SCOPES` does **not**
invalidate the existing grant. The refresh token keeps minting tokens for the old scopes, mail
keeps working, and only the new calendar calls 403 — which reads as a broken feature, not a
missing consent, and no amount of retrying fixes it. `missingScopes()` already handles this and
vault settings already offers Reconnect; the test is that it reports the new scope as missing.

**Also check `SCOPE_ALIASES`** (session.ts ~line 98) — Google grants some scopes under a
different name than requested. Verify `calendar.events` is not one of them, or `missingScopes`
will report it missing forever after a successful consent.

- [ ] **Step 1** — Test: `a grant predating calendar.events reports it missing`.
- [ ] **Step 2** — Run. Expect FAIL.
- [ ] **Step 3** — Add the scope.
- [ ] **Step 4** — Re-run. Expect PASS.
- [ ] **Step 5** — Commit: `feat(google): calendar.events, and a grant that predates it`

**GCP, by hand, before the manual pass:** add `calendar.events` to the consent screen. Same
*sensitive* tier as `calendar.readonly` — no new verification burden.

---

## Task 12: the manual pass — the only part that proves any of this

Nothing above has talked to Google. Treat every one of these as broken until it runs.

- [ ] Full suite green: typecheck 0, `eslint src` 0 errors (2 known warnings), node, dom, shared.
- [ ] `pnpm dev` — **restart**, main-process edits do not hot-reload.
- [ ] Reconnect Google in vault settings; confirm the consent screen lists calendar access
      and that `missingScopes` clears afterwards.
- [ ] **Verify the gate fires.** In the agent panel: ask it to send a mail. A permission prompt
      must appear. This is the single most important check in the plan — *a gate that does not
      fire is worse than no gate, because it is believed in.* Then click "don't ask again" and
      **ask it to send another** — the prompt must appear *again*. That is the property the
      whole design was chosen for, and it is the one thing not provable in a unit test.
- [ ] `holi-google draft` → the draft appears in Gmail, in the right thread.
- [ ] `holi-google reply` on a real thread → **lands in the existing thread**, not a new one.
      Check in Gmail's web UI, not in Holi.
- [ ] Send with `æøå` in subject and body → arrives legible, not mojibake.
- [ ] `archive` from the agent → the thread leaves the list in Holi's UI too (this is the
      `googleData` wiring in Task 6 doing its job).
- [ ] `schedule` a solo block → appears in Google Calendar; nobody was emailed.
- [ ] `unschedule` an event **with** attendees → refused by Holi, with a message that says why.
- [ ] Amend D70 in `docs/decisions.md` with suite counts and what the manual pass proved —
      specifically which of the unproven items are now proven.

---

## Deliberately not in this plan

- **A main-side confirmation dialog** — rejected in D70 §Rejected; the hook already has the
  property it was wanted for.
- **Label editing / folder management** — D68 §2 bounded the write surface and nothing has
  asked to widen it.
- **Attendee-bearing events behind the hook** — the refusal is structural on purpose. If this
  is ever wanted, it is a new decision, not a config change.
- **A renderer surface for any of this.** The agent is the only consumer.
