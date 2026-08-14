# The mail composer — D71

**Status:** designed 2026-08-14, not yet built.
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

**What the preview renders is the real thing.** A new markdown→HTML step (`marked`, the one
new dependency here) feeds the **existing** `dompurify` → sanitised-iframe path the reader
already uses, including D69's `bringsOwnDesign` paper decision. So the preview is not an
impression of a mail client; it is Holi rendering the exact HTML it is about to send, through
the renderer it already trusts for incoming mail.

## 3. The wire format

`multipart/alternative`:

| Part | Content |
| --- | --- |
| `text/plain` | **the markdown, verbatim** |
| `text/html` | the rendered, sanitised HTML |

Markdown was designed to read well unrendered, so the plain part is a genuinely good message
for a plain-text client rather than a degraded fallback. It is also what makes a draft
round-trip *exactly*: reopening reads the plain part and gets the source back byte for byte.

`mime.ts` currently emits a single `text/plain` body (D70). It gains a multipart branch. The
existing single-part path stays for the agent's `holi-google send`, which composes plain text
and has no markdown-vs-HTML question — **one function, two shapes, chosen by whether an HTML
part was supplied.**

## 4. Drafts live in Gmail, and carry a marker

`drafts.create` / `drafts.update`, autosaved on a **350ms debounce** with a **pristine
guard** — no autosave until the first real edit, so opening and closing a composer never
leaves a zombie empty draft. Both numbers and the guard are ultramail's, and the guard exists
there because they shipped without it first.

Every message Holi composes carries **`X-Holi-Source: markdown`**.

- Header present → open in the markdown editor.
- Header absent → **read-only, with "Open in Gmail".**

**Why a marker rather than sniffing for a `text/plain` part.** Gmail *derives* a plain part
from rich HTML, so a draft written on a phone would look editable and would silently lose its
styling the first time Holi saved it. A marker makes "is this ours?" answerable instead of
guessable, which is what keeps "markdown at its core" a fact rather than an aspiration.

**Reopening, in v1:** a thread already carries a `hasDraft` flag (D68), so a thread with a
draft offers *Continue draft*. There is no Drafts folder view — that is its own decision, and
Gmail is one click away meanwhile.

## 5. Reply, reply all, forward

Ultramail's table, which matches every mail client worth copying:

| | Subject | To | Cc |
| --- | --- | --- | --- |
| Reply | `Re:` — **idempotent**, never `Re: Re:` | parent's `From` | — |
| Reply all | as reply | parent's `From` | parent `To ∪ Cc` **minus the user's own addresses**, deduped |
| Forward | `Fwd:` | empty | — |

The quoted parent is a **markdown blockquote** under an `On {date}, {name} wrote:` line, so a
reply is markdown all the way down.

**Threading headers are resolved at send, not at composer-mount.** `replyToThread` already
reads the thread when it sends. Ultramail reached the same conclusion from the other
direction — *"storing it at mount would lock in a stale parent if the user picks a different
parent before sending"* — which is worth recording as independent confirmation rather than
coincidence.

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
existing `Input`.

## 7. The main-side surface

New procedures on the google router: `draft`, `updateDraft`, `send`, `reply`, `discardDraft`.

- They go through **`googleData`**, like the four triage writes, so the cached list learns
  about a sent reply at the moment Gmail does.
- They call the **same `gmail.ts` functions the ops server calls**. One implementation, two
  callers — the agent and the UI cannot drift into sending differently shaped mail.

**Sending from the UI is not hook-gated, and the record must say so explicitly.** D70's gate
intercepts the *agent's* `Bash` tool calls. A user pressing **Send** has already confirmed;
prompting again would be a dialog asking permission for the click that opened it. "Send always
asks" is a statement about the agent, and it must not leak into meaning the human is asked
twice.

## 8. Failure

`GoogleApiError`'s existing codes drive a per-variant action — ultramail's taxonomy, minus
everything SMTP-shaped:

| Code | Action |
| --- | --- |
| `scope`, `reconnect` | **Reconnect** — routes to vault settings |
| `rate-limit` | **Retry** |
| everything else | **back to the composer**, text intact |

**Never auto-retry a send whose outcome is unknown.** `postJson` returns `null` when Google
accepted the request and the body could not be read — that is a *success* with an unknown id
(D70). Ultramail landed on the same rule from the SMTP side: orphaned `sending` rows become
`failed` rather than retrying, *"since we cannot know whether SMTP completed."* Two different
transports, one conclusion: **the failure mode of a send is a duplicate, not a loss.**

## 9. Testing

- **The markdown→HTML step is pure and gets the exhaustive treatment** — it is the only new
  logic that can be tested completely without Google.
- **The marker round-trip**: compose → draft → reopen → the markdown is byte-identical.
- **Reply-all excludes the connected account's address**, and dedupes. **Send-as aliases are
  not handled** — Holi does not fetch them, so a reply-all to a thread that reached the user
  at an alias will copy that alias back in. Named here because it is a real, visible wart, and
  the fix (`settings.sendAs.list`) is a follow-up rather than a secret.
- **`Re:` is idempotent**; `Fwd:` on an already-forwarded subject.
- **The pristine guard**: mount a composer, close it, assert no draft was created.
- Fakes **refuse the way Google refuses** — the standing failure mode of this pillar (D69).

Unproven until run against a real account: whether Gmail preserves `X-Holi-Source` on a draft
round-trip, and how the rendered HTML actually looks in Gmail, Outlook and Apple Mail. The
first is load-bearing for §4 and is the first thing to check by hand.

## 10. Not in v1

Each is its own decision, not an oversight:

- **Attachments** — brings the whole MIME branching table, a size cap enforced in main rather
  than the UI, and base64 across the IPC seam.
- **Signatures**, **templates**, **send later** (needs a scheduler), **a Drafts folder view**.
- **Editing a foreign draft** — read-only with a handoff, per §4.
- **Rich-text authoring** — rejected outright rather than deferred: it would mean a second
  document model, and the request was explicitly to *see* the HTML, not to author it.
