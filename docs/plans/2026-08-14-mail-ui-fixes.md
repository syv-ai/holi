# Mail UI fixes — implementation plan

> **For agentic workers:** use the executing-plans skill. Steps are `- [ ]` checkboxes.
> **Plan style:** contracts and gotchas, not inline code — the standing preference in this repo.
> Write the code at the keyboard; the plan tells you what it must satisfy and where it will bite.

**Goal:** sixteen fixes to the mail surface and the two overlay primitives it sits on — four of
them features (a Sent mailbox, multi-select triage, a row context menu, in-thread find), four of
them bugs with a named root cause, the rest chrome.

**Architecture.** Nothing structural moves. The list's three competing mode switches (the
Mail/Drafts button row, the category dropdown, the unread toggle) collapse into **one mailbox
picker**, which is what makes room for Sent and for a selection bar. Main gains a `mailbox`
option on the thread list so Sent is a query rather than a second code path. In-thread find is
the one genuinely new subsystem: message bodies live in sandboxed iframes, so finding across a
thread means reaching into those documents, and that has consequences the plan spells out.

**Tech stack.** Existing: Radix (primitives only), Tailwind v4 `@theme` tokens, jotai, tRPC,
`turndown` + `turndown-plugin-gfm`, `node:sqlite` mail cache, DOMPurify.

---

## Baselines to beat

Measured at `a98b9dc`. Re-measure before claiming a regression.

| suite | count | how |
| --- | --- | --- |
| node | 1224 | `pnpm exec vitest run --project node` (~115s — background it) |
| dom | 343 | `pnpm exec vitest run --project dom` (~6s) |
| shared | 229 | from `packages/shared`: `pnpm exec vitest run` |
| typecheck | 0 | repo root: `pnpm typecheck` |
| eslint | 0 errors, 2 known warnings | from `apps/desktop`: `pnpm exec eslint src` |

The two ESLint warnings (`EditorPane.tsx:240`, `TaskDetail.tsx:348`, both
`react-hooks/exhaustive-deps`) are long-standing and expected. Errors are not.

---

## Findings that changed the plan

Three of the sixteen were diagnosed by reading before any code was written. Two are confirmed;
one is a hypothesis with a named repro.

| # | Reported | Actual |
| --- | --- | --- |
| 16 | quoted tables come through as raw HTML | **Confirmed.** `turndown-plugin-gfm` calls `turndown.keep()` on any `<table>` whose first row is not a heading row (`lib/turndown-plugin-gfm.cjs.js:132`). Every MJML layout table in mail hits that and is emitted verbatim. Not a sanitiser bug and not a `quoteAsMarkdown` bug. |
| 8 | "Unread" doesn't filter | **Hypothesis, Task 9 reproduces it first.** The unread list is served through the delta cache. `mail-sync.ts` only treats INBOX/TRASH/SPAM movement as leaving a list, so a thread that becomes *read* is patched (`unread: false`) and **kept in the cached unread list**. Cold cache is correct; warm cache returns read threads. |
| 8 | per-category unread numbers look wrong (16 total, 0/0/1/4/0 per tab) | **Probably not a bug.** `fetchCategoryUnread` runs `in:inbox category:X is:unread` and counts ids — exact. `category:primary` matches nothing unless the account uses Gmail's tab layout, which is the case `CATEGORIES` already documents; Promotions and Updates are labelled regardless. So a per-tab sum below the inbox total is the expected shape. Task 9 verifies against the live account before anything is changed. |

**Stated assumption, item 2.** The brief names the right-click menu. `DropdownMenu` (the mailbox
picker, right beside it in the same toolbar) and `Popover` share the identical
`border bg-popover shadow-popover` treatment, and a borderless context menu next to a bordered
dropdown reads as a rendering bug. All four overlays are changed together. Say so at review; it
is a one-line revert per file if unwanted.

---

## Where things go

**New**

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/src/features/google/MailboxPicker.tsx` | The one mode switch: All mail + five tabs + Sent + Drafts. Replaces `CategoryPicker` and the Mail/Drafts button row. |
| `apps/desktop/src/renderer/src/features/google/ThreadMenu.tsx` | The row context menu — `ContextMenu` primitive fed thread actions. Wraps a `ThreadRow`. |
| `apps/desktop/src/renderer/src/features/google/SelectionBar.tsx` | The bar that replaces the toolbar while a selection exists. |
| `apps/desktop/src/renderer/src/features/google/ThreadFind.tsx` | ⌘F inside a thread: the bar, the match model, next/prev. |
| `apps/desktop/src/renderer/src/lib/mail-find.ts` | Pure: walk a document, wrap matches, unwrap them, report count. No React, no iframes — takes a `Document`. |
| `apps/desktop/src/renderer/src/state/mail-frames.ts` | The registry a `SandboxedHtml` frame publishes its document to, keyed by message id, so find can reach it. |
| `apps/desktop/src/renderer/src/lib/mail-stamp.ts` | Pure date formatting: `listStamp` and `messageStamp`. |

**Modified**

| File | Change |
| --- | --- |
| `primitives/Tooltip.tsx` | drop `border`, take the new elevation |
| `primitives/ContextMenu.tsx` | same, on `ContextMenuContent` and `ContextMenuSubContent` |
| `primitives/DropdownMenu.tsx`, `primitives/Popover.tsx` | same (see stated assumption) |
| `renderer/src/index.css` | `--shadow-popover` gains real elevation; a light-mode softening |
| `features/google/MailView.tsx` | mailbox state, toolbar layout, selection, context menu, find routing, stamps, message index, metadata header |
| `features/google/SandboxedHtml.tsx` | register the frame document; forward ⌘F out of the frame |
| `lib/mail-types.ts` | `ThreadMessage.bcc` |
| `lib/mail-unmarkdown.ts` | unwrap layout tables before turndown |
| `lib/compose-intent.ts` | nothing — it already calls `mailHtmlToMarkdown`; the fix lands underneath it |
| `main/google/gmail.ts` | `ListThreadsOptions.mailbox`; `Bcc` in `readThread`; sent base query |
| `main/google/mail-sync.ts` | mailbox-aware history scoping; drop rows that no longer match the list's filter |
| `main/router.ts` | `mailbox` on the `threads` input |

---

## Task order and why

Tasks 1–2 are chrome with no dependants, so they land first. Task 3 (the merged picker) must
precede Tasks 6 and 7, because both put new controls in a toolbar it rewrites, and Task 7 reuses
the triage callbacks Task 6 lifts. Task 8 (unread) touches the same main-side files as Task 3's
`mailbox` option, so it follows it. Tasks 4 and 5 are independent and can be taken in any order.
Task 9 (find) is last and largest; it is the one that can be dropped without stranding anything
else.

---

## Task 1: The overlays lose their border and gain real elevation

Items 1 and 2.

**Files**
- Modify: `apps/desktop/src/renderer/src/index.css` (`--shadow-popover`, ~line 48)
- Modify: `apps/desktop/src/renderer/src/primitives/Tooltip.tsx:58`
- Modify: `apps/desktop/src/renderer/src/primitives/ContextMenu.tsx:86,107`
- Modify: `apps/desktop/src/renderer/src/primitives/DropdownMenu.tsx`, `primitives/Popover.tsx`
- Test: `apps/desktop/src/renderer/src/primitives/__tests__/ContextMenu.test.tsx`

**Contract**
- `--shadow-popover` becomes a two-layer elevation with a real ambient layer. Target values:
  `0 10px 24px -6px rgb(0 0 0 / 0.28), 0 4px 8px -4px rgb(0 0 0 / 0.20)` on the dark-first
  `:root`, softened under `[data-theme='light']` to roughly `0.14` / `0.10` alpha.
- Every overlay content class drops the bare `border` utility. `bg-popover` stays.
- `--shadow-dialog` is **not** touched. Dialogs are a different elevation and nobody complained.

**Gotchas**
- `--shadow-popover` is consumed through `.shadow-popover` in the unlayered block at the foot of
  `index.css` (~line 285), not through a Tailwind utility — Tailwind v4 bakes shadow geometry in
  at build time, which is the whole reason that class exists. Change the custom property, not the
  class body.
- The light theme currently defines no shadow override at all, and the comment at line 87 says
  black-alpha "reads fine on a light surface". That was true at 0.1 alpha; at 0.28 it is not.
  Add the light override and update that comment, or the next reader will trust it.
- Dark mode is where a borderless popover is riskiest: `--popover` is `neutral-900` against a
  `neutral-950` page, a one-step separation. The shadow is now carrying the whole edge. Check a
  tooltip over the dark editor before calling this done.

**Steps**
- [ ] Add a dom test asserting `ContextMenuContent` renders without the `border` class and with
      `shadow-popover`. Watch it fail on the border assertion.
- [ ] Change `--shadow-popover` in `:root` and add the `[data-theme='light']` override; update
      the line-87 comment to stop claiming no override is needed.
- [ ] Drop `border` from `Tooltip.tsx`, `ContextMenu.tsx` (both content variants),
      `DropdownMenu.tsx`, `Popover.tsx`.
- [ ] `pnpm exec vitest run --project dom` — 343 + the new one, green.
- [ ] `pnpm exec eslint src` from `apps/desktop` — 0 errors.
- [ ] Commit: `style(ui): overlays carry their edge in shadow, not in a border`

---

## Task 2: Stamps, icons, message index, metadata header

Items 9, 10, 14, 15 — independent, small, one commit each.

**Files**
- Create: `apps/desktop/src/renderer/src/lib/mail-stamp.ts`
- Create: `apps/desktop/src/renderer/src/lib/__tests__/mail-stamp.test.tsx`
- Modify: `MailView.tsx` (`shortDate` deleted; `ThreadRow`, `MessageBlock`), `DraftsList.tsx`
- Modify: `lib/mail-types.ts`, `main/google/gmail.ts` (`readThread`)
- Test: `features/google/__tests__/MailView.test.tsx`

**Contract — stamps (item 10).** `shortDate` currently shows *either* a time (today) *or* a date
(otherwise), never both. Replace with two functions, both pure and both taking a `now` parameter
so tests do not depend on the clock:
- `listStamp(iso, now)` — `Today 14:22`, else `14 Aug 14:22`, else `14 Aug 2025 14:22` when the
  year differs. Compact, because the list is 320px by default and 220px at minimum.
- `messageStamp(iso, now)` — always full: `14 Aug 2026, 19:47`.
- `''` in, `''` out; an unparseable date returns `''` rather than `Invalid Date` (`DraftsList`
  already guards this way — keep that behaviour, do not regress it).

**Contract — icons (item 9).** Compose-new and continue-draft are both `PenLine` today. Compose
becomes `SquarePen` (the universal compose glyph); every "there is an unsent draft here" marker
becomes `FilePen` — the `ThreadRow` chip, the reader's *continue your draft* button, and the
`DraftsList` row icon, so the three agree. Both exist in `lucide-react@1.27.0`; verified.

**Contract — metadata header (item 14).** The header line is currently
`<From> to <To> · cc <Cc>` as running prose. It becomes labelled rows, rendered only for fields
that have content: `From` / `To` / `Cc` / `Bcc`, label in `text-muted-foreground`, addresses
still `AddressLink`. `Bcc` needs plumbing that does not exist:
- `ThreadMessage.bcc: MailAddress[]` in `lib/mail-types.ts`.
- `readThread` in `main/google/gmail.ts` parses it — it already fetches `format: 'full'`, so the
  header is in hand; one `parseAddresses(headerOf(message.payload, 'Bcc'))`.
- **Bcc is only ever present on messages the account sent.** Gmail strips it from received mail,
  by design. So this field is empty for almost everything until Task 3 ships the Sent mailbox,
  and that is correct rather than broken. Do not go looking for it on inbox mail.

**Contract — message index (item 15).** `MessageBlock` takes `index` and `total`. The collapsed
and expanded header both show `3/7` in `text-[10px] text-muted-foreground tabular-nums`, beside
the stamp. Hidden when `total === 1` — a "1/1" on every one-message thread is noise.

**Gotchas**
- `MailView.tsx` has a local `shortDate`; `DraftsList.tsx` has a *different* local `shortDate`
  that guards `Invalid Date`. Both go. Grep for other copies before assuming there are two.
- `ThreadMessage` is mirrored in three places by hand — `lib/mail-types.ts`, `main/google/gmail.ts`,
  and the agent-facing `textOnly`. The module note on `mail-types.ts` exists because these drifted
  once. Add `bcc` to all of them in one commit.
- The node suite has main-side mail tests outside `src` (`apps/desktop/test/*.test.ts`) — grep
  both trees for `readThread` fixtures before changing its shape.

**Steps**
- [ ] Write `mail-stamp.test.tsx` covering: today, this year, prior year, `''`, garbage. Fails —
      module does not exist.
- [ ] Write `lib/mail-stamp.ts`; both suites green; delete both local `shortDate`s.
- [ ] Commit: `feat(mail): a timestamp says the day and the hour`
- [ ] Swap the icons; update any test querying by `aria-label` on those buttons.
- [ ] Commit: `fix(mail): a draft and a blank message no longer share an icon`
- [ ] Add `bcc` through the three mirrors + `readThread`; run the node suite.
- [ ] Rewrite the metadata block as labelled rows; add a dom test that Cc and Bcc rows appear
      only when populated.
- [ ] Add index/total to `MessageBlock`; dom test for `3/7` present at total 7, absent at 1.
- [ ] Full dom + node suites; typecheck; eslint.
- [ ] Commit: `feat(mail): a message says who else got it, and where it sits in the thread`

---

## Task 3: One mailbox picker — Sent, Drafts and the tabs in one control

Items 4, 5, 6. The structural task; Tasks 6, 7 and 8 depend on it.

**Files**
- Create: `features/google/MailboxPicker.tsx`
- Modify: `MailView.tsx` (state, `MailToolbar`, delete `CategoryPicker` and the Mail/Drafts row)
- Modify: `main/google/gmail.ts`, `main/google/mail-sync.ts`, `main/router.ts`
- Test: `features/google/__tests__/MailView.test.tsx`, `apps/desktop/test/mail-sync.test.ts`

**Contract — the view model.** Replace the two independent `category` / `showDrafts` states with
one discriminated union in `MailView`:

```
type MailboxView =
  | { kind: 'category'; category: MailCategory | null }
  | { kind: 'sent' }
  | { kind: 'drafts' }
```

The picker lists: All mail, Primary, Social, Promotions, Updates, Forums, separator, Sent,
Drafts. Trigger shows the current label followed by a `ChevronDown` (item 6's chevron). Unread
counts stay on the six category entries only — Sent and Drafts have no unread and a blank column
beside them is the honest rendering.

**Contract — the toolbar row.** One `h-11` row, left to right: search icon, unread toggle,
mailbox picker, `ml-auto`, **compose**, refresh. That is item 5: compose leaves the row below and
sits in line with refresh. The whole Mail/Drafts button row is deleted — it exists only to reach
Drafts, which the picker now does.
- The unread toggle renders **only** for `kind: 'category'`. `is:unread` against Drafts is
  meaningless and against Sent is nearly so.
- Search stays visible in every mode. A search already escapes the category (`filter` is
  `undefined` when `submitted !== ''`); it escapes the mailbox the same way, for the same reason
  written above `filter` in `MailView`.

**Contract — main.** `ListThreadsOptions` gains `mailbox?: 'inbox' | 'sent'`, default `inbox`.
- `composeQuery`: the base term becomes `in:sent` for `sent`. An explicit query still replaces
  the base entirely — unchanged behaviour.
- `cacheKey` gains the mailbox. **This is the same class of bug the `unread` key had** — read the
  note above `cacheKey`; omitting it would serve the inbox back under the Sent key.
- `mail-sync`: the mailbox's own label drives two things that are currently hardcoded to `INBOX`
  — the `labelId` passed to `history.list`, and `LEFT_WHEN_REMOVED`. For Sent both become `SENT`.
  A message never loses `SENT`, so departures from Sent are only TRASH/SPAM, which
  `LEFT_WHEN_ADDED` already covers. Rename `scopedToInbox` → `scopedToMailbox`; its rule is
  unchanged (no explicit query).
- `router.ts`: `mailbox: 'string?'` on the `threads` input, narrowed the way `asMailCategory`
  narrows category. An unrecognised value falls back to `inbox` rather than throwing.

**Gotchas**
- **Do not give Sent its own fetch path.** The tempting shortcut is to bypass `syncThreads` and
  call `listThreads` directly. That costs 26 requests against a rate-limited API every time the
  user switches to Sent and back. The four-line generalisation above is cheaper and keeps one
  code path.
- `continueDraft` sets `setOpenId(null)` deliberately (the composer renders in the reader pane,
  and leaving a thread open sent it off-screen). That must survive the state rewrite.
- `emptyMessage` currently names the category filter. It needs a Sent arm, or an empty Sent
  mailbox reads "No threads. Gmail's tabs only apply if your inbox uses them."
- `MailView.test.tsx` is 1517 lines and drives the current Mail/Drafts buttons by role and label.
  Expect real churn there; that is the cost of the merge, not a sign the merge is wrong.

**Steps**
- [ ] Node test: `cacheKey` differs for inbox vs sent with otherwise identical options. Fails.
- [ ] Node test: `composeQuery({ mailbox: 'sent' })` is `in:sent`; with an explicit query the
      query wins. Fails.
- [ ] Add `mailbox` to `ListThreadsOptions`, `composeQuery`, `cacheKey`; green.
- [ ] Node test in `apps/desktop/test/`: a Sent list scopes `history.list` to `labelId: 'SENT'`
      and does not drop a thread when INBOX is removed from it. Fails, then implement.
- [ ] Wire `mailbox` through `router.ts` and `trpc.google.threads`; `pnpm typecheck`.
- [ ] Build `MailboxPicker.tsx`; dom test that it lists nine entries with a separator, shows the
      chevron, and that selecting Sent calls back with `{ kind: 'sent' }`.
- [ ] Rewrite `MailView`'s state to `MailboxView`; delete `CategoryPicker` and the Mail/Drafts
      row; move compose into the toolbar; add the Sent arm to `emptyMessage`.
- [ ] Repair `MailView.test.tsx`; full dom suite green at ≥343.
- [ ] Node suite, typecheck, eslint.
- [ ] Commit: `feat(mail): one picker for every mailbox, and Sent is one of them`

---

## Task 4: Quoted layout tables stop arriving as raw HTML

Item 16. Confirmed root cause; smallest fix in the batch.

**Files**
- Modify: `apps/desktop/src/renderer/src/lib/mail-unmarkdown.ts`
- Test: `apps/desktop/src/renderer/src/lib/__tests__/mail-unmarkdown.test.tsx`

**Contract.** A `<table>` with a real heading row keeps converting to a GFM table — that is the
behaviour `turndown.use(gfm)` was added for and it must not regress. A table **without** one is a
layout table, and its content is unwrapped into the surrounding flow instead of being kept as
markup. Implement by overriding the plugin's `keep`: register a rule after `turndown.use(gfm)`
whose filter matches `TABLE` with a non-heading first row and whose replacement returns the
processed content of its cells, block-separated.

**Gotchas**
- The plugin's `keep()` is registered inside `tables()`; a later `addRule` for the same node name
  wins over a keep filter in turndown's resolution order. Assert that with the test before
  building on it — if it does not hold, the fallback is to strip layout tables in a DOM pass
  before `turndown.turndown()` is called, which is more code but definitely works.
- `mailHtmlToMarkdown` has **two** callers with different stakes: reply/forward quoting, and
  opening a foreign draft for editing. The second is the dangerous one — a botched unwrap eats a
  Gmail-authored draft's content. Cover both in tests.
- Nested layout tables are the norm in MJML (the user's own paste is three deep). The test
  fixture must nest.

**Steps**
- [ ] Test: a heading-row table still becomes a GFM pipe table. Passes today — it is the guard.
- [ ] Test: the user's nested MJML fixture (trimmed) produces no `<table` in the output and
      keeps the visible text. Fails.
- [ ] Implement the override; both green.
- [ ] Test: a foreign draft containing a layout table round-trips to editable markdown.
- [ ] dom suite; commit: `fix(mail): a quoted layout table is prose, not markup`

---

## Task 5: Images from a sender actually appear

Item 13. **Reproduce before hypothesising** — the two chokidar theories in this repo that looked
obvious were both wrong, and the file headers say so.

**Files**
- Investigate: `SandboxedHtml.tsx`, `lib/mail-frame.ts`, `state/mail-images.ts`
- Test: `features/google/__tests__/SandboxedHtml.test.tsx` (create if absent)

**What is already ruled out by reading**
- The app's own CSP does not restrict `img-src` (`renderer/index.html:35`), and says so on
  purpose. Not CSP inheritance from the host document.
- The iframe `key` flip on `allowRemoteContent` (`SandboxedHtml.tsx:245`) exists precisely
  because a `<meta>` CSP cannot be widened by rewriting a document. That fix is in place, and its
  note records the exact symptom being reported now — so either it regressed, or the
  *sender-always* path does not reach it.
- Both handlers call `setAllowedLocally(true)`, so on paper both flip the key.

**Candidate causes, to be discriminated by the repro**
1. `allowSenderAlways` writes to `alwaysAllowedSendersAtom`, and `useAlwaysAllowedSenders`'
   effect re-runs on `senders` changing — check it cannot re-query and overwrite the optimistic
   set with main's pre-write answer. That would flip `allowed` back to false and rebuild the
   frame blocked.
2. `identity.sender` is `message.from.email` raw; `allowImagesFrom` stores the lowercased form.
   A `From` header carrying a display name that `parseAddress` mangles gives a sender that does
   not match on the next read.
3. The image is not remote at all — `cid:` inline attachments are stripped unconditionally and
   deliberately (`mail-html.ts`, the comment above the final `removeAttribute`), and *those never
   come back*, because Holi does not download attachment bytes. If the user's test message uses
   `cid:`, the affordance is lying and the fix is to not offer it.

**Steps**
- [ ] Write a dom test that renders `SandboxedHtml` with a remote `<img>`, clicks *Always from
      this sender*, and asserts the written frame document contains the `src`. If it passes, the
      renderer is innocent and the problem is candidate 3 or environmental — say so and hand it
      to Nicolai with a specific message to test against.
- [ ] If it fails, instrument to find which of `allowed` / `sanitized.html` / the frame's CSP is
      still wrong, and fix that one thing.
- [ ] Regression test at the level the bug actually lives.
- [ ] Commit: `fix(mail): …` — message named after the confirmed cause, not the symptom.

---

## Task 6: Right-click a thread row

Item 3.

**Files**
- Create: `features/google/ThreadMenu.tsx`
- Modify: `MailView.tsx` (`ThreadRow` usage; lift the triage callbacks)
- Test: `features/google/__tests__/MailView.test.tsx`

**Contract.** Right-click only — no hover `⋯` button. Items, in order, with a separator before
the destructive pair:
`Open` · `Mark read` / `Mark unread` (whichever applies) · `Star` / `Unstar` · separator ·
`Archive` · `Move to trash` · separator · `Link to task` · `Open in Gmail` ·
`Unsubscribe` (only when `thread.unsubscribeUrl !== null`).

Built on the `ContextMenu` primitive fed items — **there is no per-surface menu component**
(decided 2026-08-01, recorded in `ContextMenu.tsx:94`). Follow `features/explorer/FileTree.tsx:294`
for the shape.

**Gotchas**
- `markRead` exists; **mark-unread does not exist in the renderer.** Main already supports both
  directions (`setThreadRead(api, id, read)`, and the note there says the second direction exists
  for the agent). `trpc.google.markRead` may only expose one — check the router and add the
  parameter rather than adding a second procedure.
- `Link to task` is `linkToTask`, which takes a `Thread`, not a `ThreadSummary`, and needs
  `remote !== null`. From a row you have only the summary. Either fetch the thread on select or
  build the task from the summary's `subject` + `webUrl` — the latter is what `linkToTask`
  actually uses, so prefer it and simplify `linkToTask` to take those two fields.
- Every action must go through `write()` so it stays optimistic-with-revert and so `writeError`
  surfaces. Do not call `trpc` directly from the menu.

**Steps**
- [ ] dom test: right-clicking a row opens a menu containing Archive; selecting it removes the
      row. Fails.
- [ ] Build `ThreadMenu.tsx`; wire the callbacks; green.
- [ ] dom test: Unsubscribe is absent on a thread with no `unsubscribeUrl`.
- [ ] dom test: the label reads *Mark read* on an unread thread and *Mark unread* on a read one.
- [ ] Add the read direction to the router if missing; node suite.
- [ ] eslint (the boundaries gate: `ThreadMenu` may import `primitives` and its own feature only).
- [ ] Commit: `feat(mail): triage a thread without opening it`

---

## Task 7: Multi-select

Item 7. Depends on Task 3 (toolbar) and reuses Task 6's action callbacks.

**Files**
- Create: `features/google/SelectionBar.tsx`
- Modify: `MailView.tsx`, `ThreadRow`
- Test: `features/google/__tests__/MailView.test.tsx`

**Contract — mechanics.** Checkbox on hover; once anything is selected every row's checkbox stays
visible. Cmd/Ctrl-click a row toggles it. Shift-click extends from the last-toggled row through
the clicked one (inclusive), using the *rendered* order. A plain click with an empty selection
opens the thread as it does today; a plain click with a non-empty selection **also** opens it and
leaves the selection alone — the selection is dismissed by its own Clear, never by accident.

**Contract — the bar.** While `selected.size > 0` the toolbar row is replaced by the selection
bar: `n selected` · mark read · mark unread · star · unstar · archive · trash · Clear. Icon
buttons with tooltips, matching the reader header's vocabulary. Escape clears.

**Contract — the writes.** Every bulk action is N calls to the existing per-thread `write()`,
issued through the same pooling discipline main uses elsewhere, **not** a new bulk endpoint.
Reason: `write()` owns the optimistic paint, the generation check and `explainWriteFailure`, and
a bulk endpoint would need its own copy of all three. A partial failure leaves the successful
rows changed and raises one `writeError`; the list re-reads via `load()` on the generation-moved
branch, which is already how a stale snapshot is recovered.

**Gotchas**
- `ThreadRow` renders a `Button` as its outer element. A checkbox inside a button is invalid and
  the boundaries gate bans a native `<input>` outside `primitives/` anyway. Use the `Checkbox`
  primitive and restructure the row so the checkbox is a **sibling** of the clickable area, not a
  child of it. This is the fiddliest part of the task.
- Selection is thread ids in a `Set`, and the list is replaced wholesale by every refresh,
  optimistic write and page load. Prune ids that are no longer in `list.threads` whenever the
  list changes, or the count claims threads that are gone.
- `listGeneration` guards the optimistic undo. N concurrent writes bump it N times, so the
  snapshot-restore branch will almost never be taken during a bulk action — the `load()` branch
  is the one that runs. That is correct; do not "fix" it.
- Fake timers: several composer tests use `vi.useFakeTimers({ shouldAdvanceTime: true })` with
  `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`. Copy that idiom for any test that
  drives shift-click sequences, or the interaction deadlocks rather than failing.

**Steps**
- [ ] dom test: cmd-click two rows → bar reads "2 selected". Fails.
- [ ] Restructure `ThreadRow` so the checkbox is a sibling; existing row tests stay green.
- [ ] Selection state + cmd-click; green.
- [ ] dom test: shift-click extends a range; implement.
- [ ] Build `SelectionBar`; dom test: Archive on a 2-selection removes both rows.
- [ ] dom test: refreshing the list prunes a selected id that has gone.
- [ ] dom test: Escape clears.
- [ ] Full dom + node suites; typecheck; eslint.
- [ ] Commit: `feat(mail): select several threads and triage them at once`

---

## Task 8: The Unread filter tells the truth

Item 8. Reproduce first — the filtering half is a hypothesis, the counting half is probably not a
bug at all.

**Files**
- Modify: `main/google/mail-sync.ts`
- Modify: `MailView.tsx` (the toggle's number)
- Test: `apps/desktop/test/mail-sync.test.ts`

**Step zero, before any change.** Confirm the counting complaint against the live account. Run
the same query the app runs (`in:inbox category:primary is:unread`) and compare with the inbox's
`threadsUnread`. If the tabs are simply not in use on this account, the numbers are correct and
the finding is a documentation fix, not a code fix. Say which it was.

**Contract — filtering.** `merge()` in `mail-sync.ts` must drop a thread that no longer satisfies
the list's own filter, on both branches (`kept` and `added`). A summary carries `unread` and
`category`, so the check is local and costs nothing:
- `options.unread === true` and `!thread.unread` → gone from this list.
- `options.category !== undefined` and the category differs → gone from this list.

This is the same idea as `LEFT_WHEN_REMOVED`, generalised from "left the mailbox" to "left this
list", and it is why the bug exists: the departure machinery only ever modelled the mailbox.

**Contract — the number.** The toggle currently shows `counts.unread` — inbox-wide — regardless
of the selected tab. It should describe the list it sits above: inbox unread for All mail, the
tab's own count when a tab is selected. When that count is not known, show **nothing**, matching
the rule the picker already follows (`unreadLabel`, and the note above it: an absent number says
"not known", `0` says "nothing here"). Do **not** fetch the five category counts on mount to fill
it — that cost decision is deliberate and documented above `loadCategoryCounts`.

**Gotchas**
- Fix the merge, not `composeQuery`. The query is already right; a cold cache proves it.
- The regression test must run the **delta** path, not `fullSync` — seed the cache and a history
  id, then hand it a `labelsAdded`/`labelsRemoved` record. A test that starts cold passes today
  and proves nothing.
- Sent lists have no unread filter; make sure the new check is inert for them.

**Steps**
- [ ] Verify the counting complaint against the live account; record the answer here.
- [ ] Node test: an unread-only list with a warm cache, given a history record removing `UNREAD`
      from a thread, no longer returns that thread. Watch it fail.
- [ ] Implement the filter check in `merge`; green.
- [ ] Node test: the same for a category list when a thread's category changes.
- [ ] Scope the toggle's number to the current view; dom test that a tab with an unknown count
      shows no number.
- [ ] Node + dom suites; commit: `fix(mail): a read thread leaves the unread list`

---

## Task 9: ⌘F finds inside the thread

Items 11 and 12. Largest task; last, so it can be deferred without stranding anything.

**Files**
- Create: `lib/mail-find.ts`, `lib/__tests__/mail-find.test.tsx`
- Create: `state/mail-frames.ts`
- Create: `features/google/ThreadFind.tsx`
- Modify: `SandboxedHtml.tsx`, `MailView.tsx`

**Contract — routing (item 11).** `MailView`'s `onKeyDown` currently opens the list search
unconditionally. It becomes: if a thread is open **and** the keydown originated inside the reader
panel, open the thread find; otherwise open the list search. Mark the reader panel with a data
attribute and test `event.target.closest(...)`.

**Contract — reaching the bodies.** An HTML message body lives in a sandboxed iframe. Two
consequences, and both are load-bearing:
- **Keydown inside an iframe does not bubble to the parent document.** ⌘F pressed while the
  pointer is over a message body never reaches React. `HtmlFrame`'s effect must add its own
  keydown listener on the frame document and invoke a callback for ⌘F. Without this the feature
  appears to work everywhere except over the text the user is reading.
- The frame is `allow-same-origin` with no `allow-scripts`, so the app's script may walk and
  mutate that document freely. It is inert; nothing inside runs.

`state/mail-frames.ts` is the registry: a frame publishes its `contentDocument` under the message
id on write and withdraws it on cleanup. `ThreadFind` reads the registry rather than holding refs
through three component layers.

**Contract — the search.** `lib/mail-find.ts` is pure and takes a `Document`:
- `findIn(doc, term)` walks text nodes with a `TreeWalker`, skipping nothing (the document is
  already sanitised), wraps each case-insensitive match in `<mark data-holi-find>`, and returns
  the wrapped elements in document order.
- `clearIn(doc)` unwraps every `[data-holi-find]` and normalises the text nodes back.
- Plain-text bodies are not in a frame; they are ordinary app DOM. Same functions, same
  attribute — but `clearIn` must never run over the app document at large. Scope it to the
  message container element.

`ThreadFind` composes: term → for each message in order, find in its document → flat list of
matches → index. Enter / ⇧Enter step; the bar shows `3/12`. The active match gets a distinct
class and is scrolled into view — **frame offset plus in-document offset**, since the match's own
`scrollIntoView` only scrolls inside its frame and leaves the thread scroller where it was.

**Contract — collapsed messages.** A collapsed message has no frame, so it cannot be searched and
its matches cannot be counted. Opening a find **expands every message in the thread** for the
duration of the search, and restores the previous expansion state when the bar closes. A count
that silently excludes collapsed messages is worse than no count.

**Contract — item 12, focus.** Two changes, and the second is the actual fix:
- After Enter in the list `SearchField`, keep focus in the input explicitly.
- The ⌘F binding is on the panel group and React only sees a keydown whose target is inside it.
  When focus escapes to `document.body` — which is what happens when a focused element is
  removed by a re-render — ⌘F reaches nothing. Give the panel group `tabIndex={-1}` and move
  focus to it whenever the search closes or its input unmounts, so the pane keeps the keyboard.
- Reproduce this one before fixing it. The mechanism above is the reading; confirm the target is
  `body` at the moment it fails.

**Gotchas**
- Wrapping matches mutates a document `HtmlFrame`'s effect rewrites on `[html, palette,
  allowRemoteContent]`. A theme change mid-search wipes the marks. Re-run the find when the
  registry reports a document was rewritten, rather than assuming marks persist.
- `<mark>` inside a message inherits the message's own CSS, and mail brings hostile CSS. Style
  the mark with `!important` on background and colour, or a newsletter's own rules will hide it.
- The frame is sized by a `ResizeObserver` on `body`. Wrapping text can reflow and change height;
  that is fine and self-correcting, but do not add marks inside the observer callback.
- `matchHotkey` already handles ⌘/Ctrl portably. Use it in the frame listener too; do not
  hand-roll a `metaKey` check.

**Steps**
- [ ] Test `mail-find.ts` against a plain jsdom document: match count, case-insensitivity,
      `clearIn` restoring the original text exactly. Fails.
- [ ] Implement `mail-find.ts`; green.
- [ ] Build `state/mail-frames.ts`; register from `HtmlFrame`; dom test that a rendered
      `SandboxedHtml` publishes a document and withdraws it on unmount.
- [ ] Add the frame's ⌘F forwarding listener; dom test that a keydown dispatched on the frame
      document reaches the callback.
- [ ] Reproduce item 12: assert the failing case (focus on `body`, ⌘F does nothing) in a test.
- [ ] Fix routing + focus; that test goes green and the list search still opens from the list.
- [ ] Build `ThreadFind`: bar, expand-all, match model, next/prev, counter.
- [ ] dom test: with a two-message thread, searching a term present in both reports `1/2` and
      Enter advances to `2/2`.
- [ ] dom test: closing the bar clears every mark and restores collapse state.
- [ ] Full dom + node suites; typecheck; eslint.
- [ ] Commit: `feat(mail): ⌘F finds inside the thread you are reading`

---

## Close-out

- [ ] Full suite sweep: node ≥1224, dom ≥343, shared 229, typecheck 0, eslint 0 errors / 2 known
      warnings.
- [ ] `docs/prd/google.md` (or whichever PRD carries mail) updated for Sent, multi-select and
      in-thread find — these are user-visible capabilities, not refactors.
- [ ] No decision number is claimed. Nothing here overturns a standing decision; if Task 3's
      merge or Task 7's selection model turns out to contradict one, stop and allocate **D73**
      (`docs/decisions.md` records allocation — check it, it may have moved).
- [ ] Hand Nicolai the list of things this environment cannot verify: anything needing a live
      Electron window, the Task 5 image repro against a real message, and the Task 8 step-zero
      count comparison.
