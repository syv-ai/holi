# Mail composer (D71) — implementation plan

> **For agentic workers:** use the executing-plans skill. Steps are `- [ ]` checkboxes.
> **Plan style:** contracts and gotchas, not inline code — the standing preference in this repo.
> Write the code at the keyboard; the plan tells you what it must satisfy and where it will bite.

**Goal:** the user can write, save, reopen and send mail from inside Holi — reply, reply-all,
forward and new message — with markdown as the source and HTML as an artifact of sending.

**Architecture.** The renderer owns markdown→HTML and is the only thing that renders it, so the
preview *is* the artifact rather than a likeness of it. Main owns MIME assembly, threading
headers and every Google call. Drafts live in Gmail; `X-Holi-Source: markdown` marks Holi's own
so they round-trip byte-exact, and `turndown` opens everything else — so nothing is ever
read-only and the marker is an optimisation rather than a gate.

**Tech stack.** `marked` (new), `turndown` (new), the existing `dompurify` →
`sanitizeMailHtml` → `SandboxedHtml` path, CodeMirror 6, tRPC, `node:sqlite` cache.

---

## What the grilling changed, relative to the spec

`docs/specs/2026-08-14-mail-composer-design.md` was approved in outline. Seven clauses were
overturned or sharpened on 2026-08-14, and **the spec and D71 have been amended to match** — they
are law and this table is the summary, not the source. Read the spec for the reasoning.

| Spec said | Now |
| --- | --- |
| §4 unmarked draft → **read-only, Open in Gmail** | **No read-only state ever.** Unmarked → `turndown` to markdown + a visible "converted" notice |
| §4 the marker is how "is this ours?" is answered | The marker is an **optimisation** (byte-exact round trip). Its failure degrades to a good conversion — so question 1 is no longer load-bearing |
| §4 autosave on a **350ms** debounce | **2s idle**, plus forced save on blur/close/send, plus a visible Saving/Saved/Not-saved state |
| §5 quote is a blockquote of `bodyTextOf` | Quote is `turndown(parent.html)` when the parent has HTML — a quoted table stays a table |
| §7 the composer marks only its own output | **`buildRfc822` writes the marker unconditionally**, so the agent's drafts are editable too — that loop is the pillar's whole point |
| §9 send-as aliases are a shipped wart | **Fetched.** `gmail.modify` already permits `settings.sendAs.list` — no new scope, checked against Google's docs |
| §10 no Drafts view; forward defers attachments | **Drafts view is in v1**, and **forward carries the original attachments** (main-side passthrough). Both were punts to Gmail, which is the thing being removed |

**Scope policy, settled and to be recorded:** Holi holds `gmail.modify` and does not widen it.
Google's own description of that scope is "Read, compose, and send emails (no permanent
delete)" — it is already "everything except the irreversible thing". OAuth has no negative
scope, so that bound exists in the *token*, not in a code path: nothing to review, nothing to
regress, nothing an agent can talk around. Widening needs a decision that names what it buys.

---

## Where things go

**New**

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/renderer/src/lib/mail-markdown.ts` | `marked` → HTML, inline HTML **escaped**. Pure. |
| `apps/desktop/src/renderer/src/lib/mail-unmarkdown.ts` | `turndown` → markdown. Foreign drafts and reply quotes. Pure. |
| `apps/desktop/src/renderer/src/lib/compose-intent.ts` | The typed intent: reply / reply-all / forward / new → subject, to, cc, quoted body. Pure. |
| `apps/desktop/src/renderer/src/primitives/ChipInput.tsx` | Recipient chips. A primitive because the boundaries gate bans native `<input>` elsewhere. |
| `apps/desktop/src/renderer/src/features/google/MailComposer.tsx` | The composer: Edit/Preview, chips, autosave state machine, send. |
| `apps/desktop/src/renderer/src/features/google/DraftsList.tsx` | The Drafts view. |

**Modified**

| File | Change |
| --- | --- |
| `apps/desktop/src/main/google/mime.ts` | `multipart/alternative`, `multipart/mixed`, unconditional `X-Holi-Source` |
| `apps/desktop/src/main/google/gmail.ts` | `sendInThread`, draft CRUD, `listSendAs`, `fetchAttachment` |
| `apps/desktop/src/main/google/data.ts` | `sendMail` / `saveDraft` / `discardDraft` / `sendAs()` |
| `apps/desktop/src/main/router.ts` | five `google.*` procedures |
| `apps/desktop/src/renderer/src/editor/extensions.ts` | `mailComposerExtensions()` — a third stack |
| `apps/desktop/src/renderer/src/state/dialogs.ts` | `{ kind: 'compose-mail' }` |
| `apps/desktop/src/renderer/src/features/google/MailView.tsx` | inline reply, Drafts tab, optimistic append; module note rewritten |

**Tests.** Node: `apps/desktop/test/google-{mime,gmail,data}.test.ts`, `test/router.test.ts` —
**not typechecked**, and not co-located. Renderer: co-located under `__tests__/`, and **must be
`.test.tsx`** — a `.test.ts` under `src/renderer/` silently never runs.

---

## Task 0 — Verify D70's **outbound** calls by hand. Nobody writes composer code first.

**Scope this precisely, because the broader version is false.** Mail read, the four triage writes
and the calendar agenda are proven in real use — so `GoogleApi.post`, `modifyThread`, the trash
endpoint and `googleData`'s Google-first write ordering are facts, not assumptions, and this
feature inherits them. What has never run is everything **outbound**: `buildRfc822`,
`messages.send`, `drafts.create`, reply threading, and `postJson`'s unreadable-2xx path. Those are
fakes written from documentation, and the composer sits directly on all of them.

- [ ] Ask the Holi agent, in a real vault, to draft a mail. Confirm it appears in Gmail Drafts,
      addressed correctly and filed in the right thread.
- [ ] Ask it to send one. Confirm it arrives.
- [ ] Ask it to reply to an existing thread. **Confirm it threads** rather than starting a new
      conversation — `References` is the header that decides this and it has never been checked.
- [ ] **The gate check, which only you can do:** ask the agent to send → approve → click *don't
      ask again* → ask it to send again. **The prompt must reappear.** No unit test in this repo
      can assert this, and a gate that does not fire is worse than no gate because it is
      believed in.
- [ ] **Check that contacts autocomplete actually returns people.** It is an *inbound* call and it
      is still unproven, because `listContacts` never rejects — it caches `[]` on refusal, so a
      scope or `readMask` failure looks exactly like an empty address book. Open the mail pane and
      confirm the recipient dropdown suggests real senders. If it is empty, fix it before Task 8,
      whose autocomplete is built on it.
- [ ] Record the results in `docs/decisions.md` under D70 and in
      `prd/_phase2-google-mail-calendar.md`'s proven/unproven list. If reply threading is broken,
      fix it before Task 1 — every reply in this plan inherits it.

**Do not start Task 1 until this passes.** This is the pillar's standing failure mode: a test
that asserts what the code assumes, rather than what Google does, passes while the feature is
broken. It has happened four times — and a fifth time in prose, where "nothing in this repo has
ever talked to Google" outlived its own truth in four documents.

---

## Slice A — the pure logic (no Google, no React)

### Task 1 — `mime.ts`: multipart, and the marker

**Files:** modify `src/main/google/mime.ts`; extend `test/google-mime.test.ts`.

**Contract.** `OutgoingMail` gains two optional fields; the existing single-part path is what
you get when both are absent, unchanged, because the agent's `holi-google send` still uses it.

```
html?: string          // rendered + sanitised. present -> multipart/alternative
attachments?: MailPart[]  // present -> multipart/mixed wrapping the alternative
MailPart = { filename: string; mimeType: string; data: string /* standard base64 */ }
```

One function, three shapes, chosen by what was supplied. `X-Holi-Source: markdown` is written
**unconditionally** — the agent writes markdown too, so the header states a fact that was
already true, and it is what makes the agent's drafts editable in Holi.

**Gotchas.**

- **The boundary must not occur in any part.** Take a boundary generator as an optional
  parameter so tests can pass a fixed one; the default is crypto-random. Assert absence and
  regenerate rather than hoping.
- **`attachments.get` returns base64url**, not standard base64. MIME needs standard base64,
  wrapped at 76 columns. Converting is one line and forgetting it produces attachments that
  open as garbage — visible only to the recipient.
- CRLF throughout, including between parts and around the closing delimiter. The existing note
  on `buildRfc822` explains why; the same applies to every boundary line.
- `Content-Transfer-Encoding` is `8bit` for text parts and `base64` for attachment parts.
- Order inside `multipart/alternative` is `text/plain` **then** `text/html` — least rich first.
  Reversed, clients show the plain part.

**Tests.** Single-part output is byte-identical to today (regression — the agent depends on it);
alternative has both parts in order with the right charset; mixed nests alternative as its first
part; the marker is present in all three; a body containing the generated boundary forces a new
one; `assertNoNewline` still refuses a `\n` in every header.

- [ ] Write the failing tests · run `pnpm exec vitest run --project node test/google-mime.test.ts` · implement · re-run · commit

### Task 2 — markdown → HTML

**Files:** create `src/renderer/src/lib/mail-markdown.ts` and
`src/renderer/src/lib/__tests__/mail-markdown.test.tsx`. `pnpm add marked` in `apps/desktop`.

**Contract.** `renderMailMarkdown(markdown: string): string` — GFM on (tables, autolinks,
strikethrough, task lists), **inline HTML escaped** via a `renderer.html` override.

Escaping is the decision: markdown becomes the only authoring language, the `text/plain` part
stays a message a human can read, and `value < 5` survives. `dompurify` remains in the pipeline
as defence in depth — it still has to handle the quoted parent, which is third-party text.

**Gotchas.**

- `marked` v9+ removed the `sanitize` option. Escaping is a renderer override, not a flag.
- Escape in **both** the block and inline HTML hooks, or `<div>` on its own line slips through.
- Do not enable `breaks`. A single newline is not a `<br>` in GFM, and mail written in an editor
  with soft wrapping would sprout them.

**Tests.** `**bold**` → `<strong>`; a GFM table → `<table>`; `<div>hi</div>` → escaped entities,
not markup; `value < 5` survives; a fenced code block keeps its content verbatim; an autolinked
address renders as a link.

- [ ] Write the failing tests · run `pnpm exec vitest run --project dom` · implement · re-run · commit

### Task 3 — HTML → markdown

**Files:** create `src/renderer/src/lib/mail-unmarkdown.ts` and its `__tests__/*.test.tsx`.
`pnpm add turndown @types/turndown`.

**Contract.** `mailHtmlToMarkdown(html: string): string`, and
`quoteAsMarkdown(text: string): string` which prefixes every line with `> `.

Two callers, and they are the reason this file exists: opening a draft Holi did not write, and
quoting a parent that only exists as HTML.

**Gotchas.**

- **Sanitise before converting.** `turndown` walks a DOM built from the string; feeding it raw
  third-party HTML means parsing untrusted markup. Run `sanitizeMailHtml(html, {
  allowRemoteContent: true })` first — remote content is irrelevant here since nothing renders.
- Enable the GFM plugin behaviour you need (tables, strikethrough) or a quoted table flattens to
  prose, which is the wart this task exists to remove.
- Quote blank lines as `>` with no trailing space — trailing whitespace is a diff nuisance and
  some clients render it.
- Collapse runs of three or more blank lines; newsletter HTML produces dozens.

**Tests.** A table survives as a markdown table; `<strong>`/`<em>`/`<a>` round-trip; a nested
list keeps its nesting; `<script>` is gone before conversion sees it; quoting an empty string is
an empty string, not `> `.

- [ ] Write the failing tests · run · implement · re-run · commit

### Task 4 — the compose intent

**Files:** create `src/renderer/src/lib/compose-intent.ts` and its `__tests__/*.test.tsx`.

**Contract.** A discriminated union, not a query string — ultramail's finding was that *"a typo
in the kind silently produced an empty composer"*.

```
ComposeIntent =
  | { kind: 'new' }
  | { kind: 'reply';   threadId: string; parent: ThreadMessage; all: boolean }
  | { kind: 'forward'; threadId: string; parent: ThreadMessage }

composeFrom(intent, self: string[]): { to, cc, subject, body }
```

`self` is the connected address **plus every send-as alias** (Task 6). `ThreadMessage` is
currently declared inside `MailView.tsx`; lift it to a module both files can import rather than
re-declaring it — a second copy of a mail shape is how the `to`/`cc` fields drift apart.

| | Subject | To | Cc |
| --- | --- | --- | --- |
| Reply | `Re:` — idempotent, never `Re: Re:` | parent `From` | — |
| Reply all | as reply | parent `From` | parent `To ∪ Cc` minus `self`, deduped |
| Forward | `Fwd:` — idempotent | empty | — |

`body` is `"\n\n---\nOn {date}, {name} wrote:\n\n" + quoteAsMarkdown(parentAsMarkdown)`, so the
cursor sits on line 1 above the quote. The parent as markdown is `mailHtmlToMarkdown(parent.html)`
when it has HTML, else `parent.body`.

**Gotchas.**

- **Where the threading headers are not.** They are resolved in main, per send *and* per save,
  from a fresh thread read — never held in the renderer, never baked at mount. §5's principle
  survives with one correction: because a saved draft can be sent from a phone, the headers must
  be in the draft's raw at *save* time too, not only at send.
- Dedupe case-insensitively — `Ada@syv.ai` and `ada@syv.ai` are one person.
- An address with an empty `email` (the header carried no address) is dropped, never rendered as
  a chip that cannot be mailed.

**Tests.** `Re: Re: x` stays `Re: Re: x` and `x` becomes `Re: x`; reply-all excludes each alias
in `self`; reply-all dedupes across `To ∪ Cc`; forward has no recipients; an HTML-only parent
quotes as real markdown; a parent with neither body nor html quotes as an attribution line alone.

- [ ] Write the failing tests · run · implement · re-run · commit

---

## Slice B — the main-side surface

### Task 5 — `gmail.ts`: draft CRUD, threaded send, aliases, attachments

**Files:** modify `src/main/google/gmail.ts`; extend `test/google-gmail.test.ts`.

**Contract.**

```
sendInThread(api, threadId, mail): Promise<{ id: string | null }>
saveDraft(api, mail, opts: { draftId?: string; threadId?: string }): Promise<{ id: string | null }>
sendDraft(api, draftId): Promise<{ id: string | null }>
deleteDraft(api, draftId): Promise<void>
listDrafts(api): Promise<DraftSummary[]>
readDraft(api, draftId): Promise<DraftBody>
listSendAs(api): Promise<string[]>
fetchAttachment(api, messageId, attachmentId): Promise<MailPart>
```

```
DraftSummary = { draftId, threadId: string | null, to: MailAddress[], subject: string,
                 snippet: string, date: string }
DraftBody    = { draftId, threadId: string | null, to: MailAddress[], cc: MailAddress[],
                 subject: string, markdown: string | null, html: string | null,
                 foreign: boolean }
```

**`createDraft` stays exactly as it is.** The agent calls it and its single-part shape is
covered by a regression test in Task 1. `saveDraft` is the composer's function: it creates when
`draftId` is absent and updates when it is present, which is the one call the autosave loop wants.

**`sendInThread` is not `replyToThread`.** `replyToThread` derives its own recipients, which is
right for the agent and wrong here — the UI has already shown the user chips they may have
edited. `sendInThread` takes recipients from `mail` and derives **only** `In-Reply-To` and
`References`, from a `format=metadata` thread read. Leave `replyToThread` alone; the agent uses it.

**`foreign` is computed from the absence of `X-Holi-Source`** in `payload.headers`
(`format=full`). Marker present → `markdown` is the `text/plain` part verbatim, byte-exact.
Marker absent → `markdown` is `null` and the renderer converts; main does not, because
`turndown` needs a DOM and main has none.

**Gotchas.**

- **Send a draft with `drafts.send`, not `messages.send` + `drafts.delete`.** Gmail deletes the
  draft atomically; the two-call version leaves an orphan draft whenever the second call fails.
- `drafts.update` **replaces** the whole draft. Every save must therefore carry the full message
  including the threading headers — which is why they are re-resolved per save. That is one
  cheap metadata read per autosave; if it ever shows up as slow, the tunable is to resolve on
  create and send only, and the cost of that is a draft sent from a phone losing its threading.
- `id: null` is a **success**, per `postJson`. Never auto-retry a send whose outcome is unknown:
  the failure mode of a send is a duplicate, not a loss.
- `settings/sendAs` returns `{ sendAs: [{ sendAsEmail, isDefault }] }`. Return the addresses
  lowercased; an account with no aliases returns one entry, not zero.
- `attachments.get` returns `data` as **base64url** (see Task 1).

**Fakes must refuse the way Google refuses** — the standing failure mode. At minimum: a
malformed `raw` → 400; `drafts.update` on an unknown id → 404 → `not-found`; `settings/sendAs`
without the scope → 403 → `scope`; `messages.send` with no `To` → 400. A fake that accepts
everything passes a real bug straight through.

- [ ] Write the failing tests · run `pnpm exec vitest run --project node test/google-gmail.test.ts` · implement · re-run · commit

### Task 6 — `data.ts`: writes that keep the cache honest, and cached aliases

**Files:** modify `src/main/google/data.ts`; extend `test/google-data.test.ts`.

**Contract.** `sendMail`, `saveDraft`, `discardDraft`, `sendAs()`. Google first, cache only on
success — the existing `write` helper, unchanged.

**This is where §7 earns itself.** A sent *message* is not a label delta and `patchThread`
cannot express it — but a draft appearing and disappearing **is** one:

- `saveDraft` on a thread → `patchThread(threadId, { added: ['DRAFT'] })` → `hasDraft` true →
  *Continue draft* appears without a refetch.
- `sendMail` / `discardDraft` → `patchThread(threadId, { removed: ['DRAFT'] })`.

`patchThread` stays label-only. If a thread had two drafts, removing `DRAFT` is briefly wrong and
the next `syncThreads` corrects it — this is a cache, not a mirror, exactly as `archive` already
over-reaches on purpose.

`sendAs()` is memoised per connected account and cleared in `useAccount`, **exactly like
`contacts()`** — same one-promise-not-one-value trick so two mounts make one request.

**Gotcha.** Do not hand these to the ops server. `main/index.ts` passes bound methods, never
`googleData` — the structural exclusion D68 §6 built. The agent gains nothing here.

- [ ] Write the failing tests · run · implement · re-run · commit

### Task 7 — the router procedures

**Files:** modify `src/main/router.ts`; extend `test/router.test.ts`.

```
google.drafts       query    -> DraftSummary[]
google.draft        query    { id }                            -> DraftBody
google.sendAs       query                                      -> string[]
google.saveDraft    mutation { draftId?, threadId?, mail }     -> { id }
google.discardDraft mutation { draftId }
google.send         mutation { draftId?, threadId?, mail }     -> { id }
```

One `send` for every case: `draftId` present → `drafts.send`; else `threadId` present →
`sendInThread`; else `sendMessage`. Each goes through `googleWrites()` and `.catch(rethrowGoogle)`
like the four triage writes.

**`mail` carries `html` from the renderer.** That is the settled shape — the renderer previewed
those bytes and main sends them. Main still validates rather than trusting: `assertNoNewline` on
every header, and reject an `html` that is present but empty.

**Sending from the UI is not hook-gated, and the code must say so.** D70's gate intercepts the
*agent's* `Bash`. A user pressing Send has already confirmed; prompting again would be a dialog
asking permission for the click that opened it. Write that as a comment on `google.send`, because
the next reader will otherwise assume it was forgotten.

- [ ] Write the failing tests · run `pnpm exec vitest run --project node test/router.test.ts` · implement · re-run · commit

**Manual checkpoint — the marker.** Compose a draft through `google.saveDraft`, reopen it through
`google.draft`, and confirm `foreign === false`. If Gmail strips `X-Holi-Source`, the fallback is
already built (Task 3) and the cost is a good conversion instead of a byte-exact one — record the
result in D71 and carry on. This is why the marker stopped being load-bearing.

---

## Slice C — the composer, to a first real send

### Task 8 — `ChipInput` primitive

**Files:** create `src/renderer/src/primitives/ChipInput.tsx`; export from `primitives/index.ts`;
test in `primitives/__tests__/ChipInput.test.tsx`.

Native `<input>` is banned outside `primitives/` by an AST selector in `eslint.config.mjs`
(`button|input|select|textarea|dialog|form`), which is why this is a primitive and not a composite.

**Contract.** `{ value: MailAddress[], onChange, suggestions, placeholder, label }`.

**Behaviour that people expect and notice the absence of:** Enter, Tab and `,` commit the typed
text; Backspace on an empty field deletes the last chip; paste splits on `,` and `;`; a chip
whose text is not a plausible address is refused at commit time with the text left in the field —
the typo is fixed where it was made, which is the whole reason send does not validate addresses.

**Gotcha.** Autocomplete comes from `google.contacts`, which already ranks real senders ahead of
address-book entries. Do not re-sort it.

- [ ] Write the failing tests · run `pnpm exec vitest run --project dom` · implement · re-run · commit

### Task 9 — the composer's editor stack

**Files:** modify `src/renderer/src/editor/extensions.ts`.

Add `mailComposerExtensions(): Extension[]`. **`baseEditorExtensions` cannot be reused** — it
takes `docExists`, `taskByPath`, `readNote`, `mentionData`, `nav` and `notePath`, all vault
machinery. `[[wiki links]]` mean nothing to a recipient and `@`-mention would paste vault paths
into mail.

Keep: `history`, `drawSelection`, `dropCursor`, `indentOnInput`, `bracketMatching`,
`lineWrapping`, `markdown({ base: markdownLanguage })`, `markdownTables()`, `formattingKeymap`
(⌘B/⌘I/⌘K are worth having), `editorTheme`, the standard keymaps.

Drop: `livePreview`, `frontmatterExtension`, `wikiHoverPreview`, `linkClickHandler`,
`mentionSource`, `slashCommands`, and all three facets.

- [ ] Write the failing test (assert a `[[x]]` renders as literal text, no chip) · run · implement · re-run · commit

### Task 10 — `MailComposer`

**Files:** create `src/renderer/src/features/google/MailComposer.tsx` and
`features/google/__tests__/MailComposer.test.tsx`.

**Props:** `{ intent: ComposeIntent, draftId?: string, onSent, onDiscarded }`.

**Layout:** `Edit | Preview` tabs above the editor; To / Cc / Subject as `ChipInput` + `Input`;
`[Send] [Discard]` and the save-state chip at the foot.

**Preview.** `<SandboxedHtml html={renderMailMarkdown(markdown)} label="preview of your message" />`.
It sanitises internally — pass it the *unsanitised* render, as its doc demands. Separately compute
the send payload as `sanitizeMailHtml(renderMailMarkdown(markdown), { allowRemoteContent: true })`.
Same pure function on the same input, differing only in the remote-image flag, so the two cannot
drift. **The preview will hold back remote images and the sent mail will not** — that is correct
(the reader's rule, D69) and the existing "Load images" banner makes them identical on one click.

**Autosave state machine.** `pristine → dirty → saving → saved`, plus `error`.

- No save until the first real edit — the pristine guard. Ultramail shipped without it and got
  zombie empty drafts.
- 2s idle debounce; forced save on blur, on close and before send.
- **Single-flight, latest-wins.** While a `create` is in flight every further save queues — a
  second create makes a second draft and the user watches their message fork. While an `update`
  is in flight, coalesce to one trailing save.
- Offline or refused → `Not saved`, text untouched, retried on the next edit or on Send.

**Foreign drafts.** `foreign === true` → convert with `mailHtmlToMarkdown` and show a notice
above the editor: *written outside Holi, converted to markdown, saving replaces the original
formatting*, with an Open-in-Gmail link. **Never read-only.**

**Send guards.** No recipients → `Send` disabled, "Add a recipient". Empty subject → confirm once,
remember nothing. Empty body sends. Addresses were already validated at chip entry.

**Failure.** `GoogleApiError.code` drives the action: `scope` / `reconnect` → **Reconnect**,
routing to vault settings; `rate-limit` → **Retry**; everything else → back to the composer with
the text intact. Never auto-retry a send.

**Dismissal.** Pristine closes on Escape/backdrop like any dialog. Dirty refuses both; the exits
are Send and an explicit Discard, and Discard asks — *Discard* deletes the Gmail draft, *Keep*
forces a save.

**Tests.** Mount and close → **no draft was created**; type then wait → exactly one create, never
two; type twice inside 2s → one save; a save that rejects → `Not saved` and the text is still
there; `scope` → a Reconnect action; no recipients → Send disabled; a foreign draft → converted
text plus the notice, and the editor is editable.

- [ ] Write the failing tests · run · implement · re-run · commit

### Task 11 — inline reply in `MailView`, and the first real send

**Files:** modify `features/google/MailView.tsx`; extend its `__tests__/MailView.test.tsx`.

Replace the Reply-opens-Gmail handoff (around `MailView.tsx:684–701`) with `Reply` / `Reply all` /
`Forward` buttons that mount `MailComposer` **inline at the foot of the thread reader** — when you
are replying, the thing you are replying to is the context you need, and a modal hides it.

**On send:** append the sent message to the open thread immediately and collapse the composer,
then `POST`, then invalidate `google.thread` and `google.threads`. On failure remove the appended
message, reopen the composer, text intact. This matches the file's existing rule — optimism in the
renderer, never on disk — and it survives `id: null`, since display needs no id.

**Rewrite the module note.** Lines 15–18 say replying opens Gmail because no compose surface is
built. It is now built. The permanent-delete paragraph above it stays exactly as it is — that
bound is still the scope, and it is the sentence this pillar keeps having to restore.

- [ ] Write the failing tests · run · implement · re-run · commit
- [ ] **Manual: send a real reply to yourself and confirm it threads.**

---

## Slice D — drafts, new message, forward

### Task 12 — Continue draft, and the Drafts view

**Files:** create `features/google/DraftsList.tsx`; modify `MailView.tsx`; extend both test files.

A `Drafts` entry beside the category tabs, backed by `google.drafts`. It answers three things
at once: a new-message draft is reachable, a thread with two drafts shows both, and no path
ends at a browser.

A thread's existing `hasDraft` chip becomes *Continue draft* → opens the **newest** draft for
that thread. The other one lives in the Drafts list; that is the whole answer to the ambiguity.

**Gotcha.** A draft with no recipients renders as `(no recipient)`, not as a blank row — a blank
row reads as a rendering bug on exactly the screen where the user is looking for something they
half-wrote.

- [ ] Write the failing tests · run · implement · re-run · commit

### Task 13 — new message, as a dialog

**Files:** modify `state/dialogs.ts` (`ActiveDialog` gains `{ kind: 'compose-mail' }`); register
and mount per the existing dialog block + registry; modify `MailView.tsx` for the entry point.

A fresh message has no context to preserve, so the dialog is right here where it was wrong for
reply. Dismissal is Task 10's rule; the Drafts view from Task 12 is what makes closing safe.

- [ ] Write the failing tests · run · implement · re-run · commit

### Task 14 — forward carries its attachments

**Files:** modify `src/main/google/gmail.ts`, `src/main/router.ts`, `MailComposer.tsx`; extend
`test/google-gmail.test.ts` and `test/router.test.ts`.

The renderer sends `forwardOf: { messageId }`; **main** fetches each part with `fetchAttachment`
and passes them to `buildRfc822` as `attachments`. The bytes never cross the IPC seam, so there is
no base64 in renderer state, no file picker and no size-cap UI. Picking a file from disk stays out
of v1.

**Gotchas.** Base64url → base64 (Task 1). Show the attachment names in the composer so the user
knows what is going along. A forward of a message with no attachments must take the
`multipart/alternative` path, not an empty `multipart/mixed`.

- [ ] Write the failing tests · run · implement · re-run · commit

---

## Slice E — the record

### Task 15 — full verification

- [ ] `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → 0
- [ ] `pnpm exec eslint src` → 0 errors (2 long-standing warnings in `EditorPane.tsx` / `TaskDetail.tsx` are expected)
- [ ] `pnpm exec vitest run --project node` → **≥ 1114** (background it; ~150–260s)
- [ ] `pnpm exec vitest run --project dom` → **≥ 207**
- [ ] from `packages/shared`: `pnpm exec vitest run` → **229**
- [ ] **Run the app** (ask the user — this environment cannot keep a GUI Electron alive) and do
      one of each: reply, reply-all, forward with an attachment, new message, save and reopen a
      draft, discard a draft.

### Task 16 — the living docs are law

- [x] ~~Amend the spec and D71 for all seven changes~~ — **done 2026-08-14, before the build.**
      The spec and the ledger are current; this plan's table is a summary of them, not a substitute.
- [ ] Record Task 0's and the Task 7 checkpoint's results under D70 and D71 — what was proven
      against a real account, and what remains unproven.
- [ ] Consolidate into `prd/_phase2-google-mail-calendar.md` once built, per the D67–D70 pattern.

---

## Landmines in this repo

- **Main-process edits do not hot-reload.** Anything under `src/main/` needs a `pnpm dev` restart.
- **Killing the dev app: kill the Electron child, not just the `electron-vite` parent.** An
  orphaned Electron holds `app.requestSingleInstanceLock()`, so the next `pnpm dev` calls
  `app.quit()` and you see the *old* window with a dead renderer — a blank white shell that looks
  exactly like a code bug. `pkill -f "better-holi-final.*Electron.app/Contents/MacOS/Electron"`
  as well as the parent.
- **`pnpm exec` always** — bare `node`/`npx` are broken. `cd` with absolute paths; the shell's cwd
  drifts between calls.
- **Never run `pnpm run format` / `prettier --write`** — it corrupts this repo (hand-formatted, no
  semicolons; root `.prettierrc.json` omits `"semi": false`).
- **Node tests are not typechecked** and live in `apps/desktop/test/`. Renderer tests are
  co-located and must be `.test.tsx`. Grep both when planning a change.
- **Run the full desktop suite after preload/`window.holi` changes** — typecheck misses fake-preload
  gaps because `installFakeHoli` is not typed against `window.holi`.
- **No personal name in code.** Fixtures use `Ada Holm` / `ada@syv.ai`; comments name a decision
  (a D-number or a date), never a person. `docs/` is exempt.
- Commit directly to `main`, trailer `Claude goes brr.. via Dash`. **The user approves pushes.**
