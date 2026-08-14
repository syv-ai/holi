# The mail composer — D71

**Status:** designed 2026-08-14, **revised the same day** after a grilling that overturned seven
of its clauses; not yet built. Plan: `docs/plans/2026-08-14-mail-composer.md`.
**Builds on:** D67 (the connector), D68 (mail became read-write), D69 (the sanitised-HTML
reader and the paper decision), D70 (`send`/`draft`/`reply` in `gmail.ts`, and the agent's
gate). **Prior art:** `syv-ai/ultramail` `docs/prds/PRD-04-composer.md` — abandoned, Tauri +
Rust + IMAP, so nothing ports as code; several of its conclusions port as reasoning and are
credited inline.

---

## 1. The gap

**The agent can send mail. The user cannot.** D70 added `sendMessage`, `createDraft` and
`replyToThread` to `gmail.ts` and exposed them through the ops server — to the agent only.
The tRPC router has no send procedure at all, and `MailView.tsx` says so in its own module
note: *"Replying opens Gmail because no compose surface is built, **not** because the scope
forbids one."*

That sentence has been true and uncomfortable since D68. This closes it.

## 2. The principle

> **Markdown is the source. HTML is an artifact of sending.**

Holi is agent-driven first, and an agent writes markdown. Everything else follows from
refusing to let a second authoring format exist:

- The user edits markdown, in the CodeMirror setup the note editor already uses.
- **Preview is a preview, not a WYSIWYG.** GitHub-style `Edit | Preview` tabs. There is no
  rich-text document model, so there is no lossy round-trip to manage and no second editor
  stack beside CodeMirror.
- HTML is produced *at send*, from the markdown, and is never edited by hand.

**What the preview renders is the real thing.** A new markdown→HTML step (`marked`) feeds the
**existing** `dompurify` → sanitised-iframe path the reader already uses, including D69's
`bringsOwnDesign` paper decision. So the preview is not an impression of a mail client; it is
Holi rendering the exact HTML it is about to send, through the renderer it already trusts for
incoming mail.

**And "exact" is meant literally, which decides where the rendering happens.** The preview needs
HTML in the renderer; the MIME needs it in main. If both rendered, they could drift and the
claim above would quietly become *nearly* true — this pillar's standing failure mode wearing a
different coat. So **the renderer renders once and hands main the bytes it just previewed**;
main assembles the MIME around them and validates rather than trusts. Main gains no jsdom, no
second sanitiser, and no opinion about markdown. The agent's `holi-google send` is untouched: it
composes plain text and takes the single-part path it always did.

**Markdown is also the direction of travel back.** `turndown` converts HTML to markdown, which
is what lets a draft written anywhere else open in this editor (§4) and what keeps a quoted
table a table instead of prose (§5). Two dependencies, one in each direction, and no third
representation between them.

## 3. The wire format

`multipart/alternative`:

| Part | Content |
| --- | --- |
| `text/plain` | **the markdown, verbatim** |
| `text/html` | the rendered, sanitised HTML |

Markdown was designed to read well unrendered, so the plain part is a genuinely good message
for a plain-text client rather than a degraded fallback. It is also what makes a draft
round-trip *exactly*: reopening reads the plain part and gets the source back byte for byte.

A forward wraps that in `multipart/mixed`, with the original attachments passed through beside
it (§5).

`mime.ts` currently emits a single `text/plain` body (D70). It gains a multipart branch. The
existing single-part path stays for the agent's `holi-google send`, which composes plain text
and has no markdown-vs-HTML question — **one function, three shapes, chosen by what was
supplied**: an HTML part makes it `alternative`, attachments make it `mixed`, neither leaves it
exactly as D70 built it. That last case is a regression test, not a leftover: the agent depends
on those bytes.

## 4. Drafts live in Gmail, and every one of them opens

**There is no read-only state.** That is the governing rule of this section, and it is what
separates the revised design from the one first written: *"we need the integration to be
seamless — no 'read-only, open in Gmail' state ever."* A composer that refuses to open the
thing it is a composer for has failed at the only job it has.

`drafts.create` / `drafts.update`, autosaved on a **2s idle debounce**, plus an unconditional
save on blur, on close and before send. A visible state sits next to Send: *Saving… / Saved
14:32 / Not saved*. Offline or refused means **Not saved** with the text untouched, retried on
the next edit or on Send — never a silent drop, and never a lie about durability.

*2s is a departure from ultramail's 350ms, and the reason is that ultramail autosaved to a local
SQLite file.* Against Gmail every save is a full RFC-822 upload, so 350ms turns a slow paragraph
into a dozen round-trips. What does port unchanged is the **pristine guard** — no save until the
first real edit, so opening and closing a composer never leaves a zombie empty draft. That guard
exists in ultramail because they shipped without it first.

**One save at a time, latest wins.** While a `create` is in flight, every further save queues: a
second `create` makes a second draft and the user watches their message fork. While an `update`
is in flight, saves coalesce into one trailing write.

### The marker is an optimisation, not a gate

Every message Holi composes carries **`X-Holi-Source: markdown`** — written **unconditionally**
in `buildRfc822`, so the agent's drafts carry it too. §2's premise is that an agent writes
markdown, which means the header states a fact that was already true.

**That is not a detail.** With the marker written only by the composer, a draft the *agent* had
written would have been unmarked, and therefore — under the original rule — read-only. The
pillar's flagship loop is *agent drafts it, user reads it and presses Send*, and D71 came within
one conditional of forbidding it.

Opening a draft:

- **Marker present** → the `text/plain` part *is* the markdown, taken verbatim. The round trip is
  byte-exact.
- **Marker absent** → `turndown` converts the HTML, above a notice reading *written outside Holi,
  converted to markdown; saving replaces the original formatting*, with an Open-in-Gmail link for
  when that is not acceptable. **Editable either way.**

**Why a marker rather than sniffing for a `text/plain` part.** Gmail *derives* a plain part from
rich HTML, so sniffing would take Gmail's flattening as the source and silently rewrite a phone
draft's styling on the first save. The marker makes "is this ours?" answerable instead of
guessable.

**And why it no longer carries the design on its back.** Whether Gmail preserves an unknown
header across a draft round-trip has never been checked against a real account. In the original
§4 that unverified fact gated the entire feature. Now it decides only whether a reopened draft is
*byte-exact* or *well converted* — because the conversion path had to exist anyway, for drafts
Holi never wrote. **A load-bearing assumption became a performance characteristic**, which is the
better place for anything unproven to sit.

### Reopening

A thread carries a `hasDraft` flag (D68), so a thread with a draft offers *Continue draft* and
opens the newest one.

**There is also a Drafts view**, beside the category tabs, backed by `drafts.list`. It was out of
v1 in the first draft of this spec and came back for the same reason the read-only state went
away: a new message has no thread, so `hasDraft` cannot surface it, and a half-written message
closed at the wrong moment would have been saved to Gmail and then unreachable from Holi. Pointing
at the browser is the punt being removed. It also answers, without ceremony, what *Continue draft*
means on a thread carrying two: the newest opens, and the other one is in the list.

## 5. Reply, reply all, forward

Ultramail's table, which matches every mail client worth copying:

| | Subject | To | Cc |
| --- | --- | --- | --- |
| Reply | `Re:` — **idempotent**, never `Re: Re:` | parent's `From` | — |
| Reply all | as reply | parent's `From` | parent `To ∪ Cc` **minus the user's own addresses**, deduped |
| Forward | `Fwd:` — idempotent | empty | — |

"The user's own addresses" means the connected account **and every send-as alias** — see §7.

The quoted parent is a **markdown blockquote** under an `On {date}, {name} wrote:` line, so a
reply is markdown all the way down. It is inserted **into the editor at mount**, below a `---`,
with the cursor above it: it is the source, so it round-trips byte-exact, and the user can trim
it to the one paragraph they are answering — which is what people actually do.

**The quote is `turndown` of the parent's HTML**, not of `bodyTextOf`. The reader's text
extraction falls back to flattening HTML, so quoting through it would turn a table into prose and
a list into a paragraph — a wart with no upside once the converter exists for §4 anyway. Falling
back to the plain body when the parent has no HTML costs nothing.

**A forward carries the original attachments.** Passed through main — `messages.attachments.get`,
re-embedded into `multipart/mixed` — so the bytes never cross the IPC seam and there is no file
picker, no size cap in the UI and no base64 in renderer state. Forwarding is the operation people
perform *in order to* move an attachment, so a forward that silently dropped them would be worse
than not offering forward at all. Picking a file from disk remains out of v1 (§10); this is
passthrough only, which is a far smaller thing than the attachment table §10 defers.

**Threading headers are resolved in main, never in the renderer, and never baked at mount.**
Ultramail reached the same conclusion from the other direction — *"storing it at mount would lock
in a stale parent if the user picks a different parent before sending"* — which is worth recording
as independent confirmation rather than coincidence.

*With one correction the original wording got wrong:* they are resolved **per save as well as per
send**. `drafts.update` replaces the whole message, and a saved draft can be sent from a phone, so
a draft whose raw carried no `In-Reply-To` would send fine and start a new thread. "At send, not
at mount" was the right principle stated as the wrong rule; the principle is that the renderer
never holds them.

## 6. Where it lives

**Reply composes inline, at the foot of the thread reader.** When you are replying, the thing
you are replying to is the context you need; a modal hides it. **New message is a dialog**,
via the existing dialog block + registry, because a fresh message has no context to preserve.

```
┌──────────────┬────────────────────┐
│ thread list  │ ─── thread ───     │
│              │ Ada: …             │
│              │ you: …             │
│              ├────────────────────┤
│              │ Edit │ Preview     │
│              │ [markdown editor]  │
│              │ To: [Ada ×] …      │
│              │      [Send] [Discard]
└──────────────┴────────────────────┘
```

Recipient fields are **chips with autocomplete over `google.contacts`**, which already ranks
real senders ahead of address-book entries (D68). Native `<input>` is banned outside
`primitives/` by the boundaries gate, so the chip field is a new primitive or composes the
existing `Input`. A malformed address is refused **when the chip is committed**, not at send —
the typo gets fixed where it was made.

**Dismissal, because losing a half-written mail is the least forgivable bug a mail client has.**
The `Dialog` shell gives Escape and backdrop-close for free, and free is wrong here. A **pristine**
composer closes on either, exactly as any dialog should — the pristine guard already knows the
difference. A **dirty** one refuses both; the exits are Send and an explicit Discard, and Discard
asks once: *Discard* deletes the Gmail draft, *Keep* forces a save. Combined with the Drafts view
(§4), nothing written is lost and nothing goes missing quietly.

**A sent reply appears immediately.** The message is appended to the open thread and the composer
collapses before the request returns; `google.thread` and the thread list are invalidated behind
it, and a failure removes the appended message and reopens the composer with the text intact. This
is the rule `MailView` already follows — optimism in the renderer, never on disk (see the note on
`write` in `main/google/data.ts`) — and it survives an `id: null` success, because painting a
message needs no id.

## 7. The main-side surface

New procedures on the google router: `drafts`, `draft`, `sendAs`, `saveDraft`, `discardDraft`,
`send`. **One `send` for every case** — a `draftId` sends the stored draft via `drafts.send`
(atomic, so no orphaned draft survives a half-failure), a `threadId` sends into the thread, and
neither sends a new message.

- They go through **`googleData`**, like the four triage writes. A sent *message* is not a label
  delta and `patchThread` cannot express one — but a draft appearing and disappearing **is**, so
  saving a draft sets `DRAFT` on the thread row and sending or discarding clears it, and
  *Continue draft* appears and vanishes without a refetch. `patchThread` stays label-only. A
  thread that had two drafts is briefly wrong and the next sync repairs it, exactly as `archive`
  already over-reaches on purpose: this is a cache, not a mirror.
- They call the **same `gmail.ts` functions the ops server calls**, so the agent and the UI cannot
  drift into sending differently shaped mail — with one deliberate exception. `replyToThread`
  *derives* its recipients, which is right for an agent and wrong for a composer that has already
  shown the user editable chips. The UI's threaded send takes its recipients and derives only the
  threading headers. `replyToThread` is left exactly as it is.

**Send-as aliases are fetched, and they cost nothing.** `settings.sendAs.list` is permitted by
`gmail.modify`, which Holi already holds — Google lists four accepted scopes for that method and
`gmail.modify` is one of them. The first draft of this spec shipped reply-all-copies-your-own-alias
as a named wart and proposed `gmail.settings.basic` to fix it; both were unnecessary, and the
correction came from reading Google's reference rather than from reasoning about it. Cached once
per connected account, like `contacts()`.

**Scope policy, recorded so it stops being re-derived.** Holi holds `gmail.modify` and does not
widen it. Google's own description of that scope is *"Read, compose, and send emails (no permanent
delete)"* — it is already "everything except the irreversible thing", which is the shape that keeps
being asked for. OAuth has no negative scope, so **that bound lives in the token, not in a code
path**: there is nothing to review, nothing to regress, and nothing an agent can talk around. It is
the same guarantee D70 tier 1 rests on, and taking `https://mail.google.com/` would demote it from
*the token cannot* to *the code does not*. Widening needs a decision that names what it buys; the
two things it would buy today are settings-editing (`gmail.settings.basic`) and permanent deletion.

**Sending from the UI is not hook-gated, and the record must say so explicitly.** D70's gate
intercepts the *agent's* `Bash` tool calls. A user pressing **Send** has already confirmed;
prompting again would be a dialog asking permission for the click that opened it. "Send always
asks" is a statement about the agent, and it must not leak into meaning the human is asked twice.

## 8. Failure

`GoogleApiError`'s existing codes drive a per-variant action — ultramail's taxonomy, minus
everything SMTP-shaped:

| Code | Action |
| --- | --- |
| `scope`, `reconnect` | **Reconnect** — routes to vault settings |
| `rate-limit` | **Retry** |
| everything else | **back to the composer**, text intact |

A failed *save* is not a failed send and does not interrupt: the state chip reads **Not saved**
and the next edit retries. A failed **send** is the table above.

**Send refuses two things and only two.** No recipients disables Send outright — a message with
no recipient is not a message. An empty subject asks once and remembers nothing, because sending
without one is a real choice people make and Gmail permits it without comment. An empty body
sends: *see attached* and one-word replies are normal, and a client that argues about them is
wrong more often than it is right.

**Never auto-retry a send whose outcome is unknown.** `postJson` returns `null` when Google
accepted the request and the body could not be read — that is a *success* with an unknown id
(D70). Ultramail landed on the same rule from the SMTP side: orphaned `sending` rows become
`failed` rather than retrying, *"since we cannot know whether SMTP completed."* Two different
transports, one conclusion: **the failure mode of a send is a duplicate, not a loss.**

## 9. Testing

Four pieces of pure logic carry this feature and none of them needs Google, which matters in a
pillar where almost nothing else can be tested at all (D69): **markdown→HTML**, **HTML→markdown**,
**MIME assembly**, and the **compose intent** that derives subject, recipients and quote.

- **markdown→HTML gets the exhaustive treatment.** Including the case that decides §2: raw HTML in
  the markdown is **escaped**, not passed through. `marked` passes it through by default and
  `dompurify` then makes it safe — which would quietly make HTML authorable, and would eat a stray
  `<` in ordinary prose. Escaping keeps markdown the only authoring language and keeps the
  `text/plain` part a message a human can read. `dompurify` stays in the pipeline as defence in
  depth rather than as the mechanism; it still has to handle the quoted parent, which is
  third-party text.
- **The marker round-trip**: compose → draft → reopen → the markdown is byte-identical.
- **The conversion path**: a draft with no marker opens as markdown, with the notice, and is
  editable — the rule from §4 asserted rather than assumed.
- **Reply-all excludes every address the user sends from**, aliases included, and dedupes
  case-insensitively.
- **`Re:` is idempotent**; `Fwd:` on an already-forwarded subject.
- **The pristine guard**: mount a composer, close it, assert no draft was created. And the race
  it does not cover: type while a `create` is in flight, assert exactly one draft exists.
- **The single-part path is unchanged**, byte for byte. The agent depends on those bytes.
- Fakes **refuse the way Google refuses** — the standing failure mode of this pillar (D69). A
  malformed `raw` is a 400; `drafts.update` on an unknown id is a 404; a missing scope is a 403.
  A fake that accepts everything passes a real bug straight through.

Unproven until run against a real account: whether Gmail preserves `X-Holi-Source` on a draft
round-trip, and how the rendered HTML actually looks in Gmail, Outlook and Apple Mail. **Neither
is load-bearing any more** — the first decides byte-exact versus well-converted (§4), and the
second is a fidelity question rather than a correctness one.

**What is load-bearing is the outbound path, and only the outbound path.** Mail read, the four
triage writes and the calendar agenda are proven in real use, so `GoogleApi.post`, `modifyThread`
and `googleData`'s Google-first ordering sit under this feature as facts. D70's `messages.send`,
`drafts.create`, reply threading and `postJson`'s unreadable-2xx path have never run. Verifying
them by hand is the first task of the plan, before any composer code exists — and it is a
narrower, more honest ask than "verify Google", which is what the plan first said.

**One inbound call is also unproven and hides it well:** the People contacts fetch behind
recipient autocomplete. `listContacts` never rejects and caches `[]` on refusal, so a scope or
`readMask` failure is indistinguishable from an empty address book. Chips will still work; they
will simply never suggest anyone, which reads as a design choice rather than a bug.

**On what the preview claims.** It renders through Holi's sanitiser and D69's paper decision, so
it is exactly what *Holi* would show — which is to say, exactly what will be sent. It is not a
promise about what Gmail or Outlook will make of the same bytes; those mangle CSS in their own
ways and no preview can speak for them. The claim is "this is what you are sending", not "this is
what they will see". One visible consequence: the preview holds back remote images the way the
reader does, and the existing *Load images* banner makes the two identical on one click.

## 10. Not in v1

Each is its own decision, not an oversight:

- **User-added attachments** — picking a file from disk brings a size cap enforced in main rather
  than the UI, and base64 across the IPC seam. *Forward's passthrough is in* (§5): the bytes stay
  main-side, so it needs none of that.
- **Signatures**, **templates**, **send later** (needs a scheduler).
- **A From-picker.** Fetching send-as aliases (§7) makes choosing one possible; nothing has asked
  for it, so aliases are used for exclusion only.
- **Rich-text authoring** — rejected outright rather than deferred: it would mean a second
  document model, and the request was explicitly to *see* the HTML, not to author it.

**Two things that were on this list and are not any more**, both for the same reason — each was a
punt to the browser, and the browser is what this feature exists to stop needing. **A Drafts view**
is in v1 (§4), because without it a new-message draft is written to Gmail and then unreachable
from Holi. **Editing a foreign draft** is in v1 (§4), because "read-only with a handoff" is the
state that was ruled out in one sentence: *no 'read-only, open in Gmail' state ever.*
