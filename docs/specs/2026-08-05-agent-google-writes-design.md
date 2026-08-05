# The agent writes to mail and calendar — D70

**Status:** designed 2026-08-05, not yet built.
**Amends:** D67 §5 (the gate it specified could never have fired), D68 §6 (the deferred
decision, now taken), D69 (`GoogleApi.post` returns `void` — one caller now reads a body).

D68 §6 handed `createGoogleOpsServer` read functions and never `googleData`, and recorded
why in one sentence: *"giving an LLM archive and trash over a real mailbox is a decision
nobody has taken."* This is that decision.

---

## 1. The principle

> **The agent may do anything the user can undo. It may not do anything that reaches
> another human.**

The line is not "read versus write". It is **reversibility**, with a second cut for
things that leave the building. Sorting every operation by that rule:

| Tier | Operations | Enforced by |
| --- | --- | --- |
| **Impossible** | permanent delete | Google — the scope was never requested |
| **Reaches a human** | `send`, `reply`, any event carrying attendees | a `PreToolUse` hook returning `ask` |
| **Undoable** | `markRead`, `star`, `archive`, `trash`, `draft`, `schedule`, `reschedule`, `unschedule` | seeded `permissions.ask` rules |

Three tiers, three *different* mechanisms — deliberately. A single mechanism applied at
three strengths is one edit away from being applied at one strength.

**Why reversibility and not write-ness.** Every write in the undoable tier has a user-side
undo that costs one click: unarchive from All Mail, untrash within 30 days, delete a draft,
delete an event. `send` has none. The distinction that matters to the user is not whether
the agent changed something — it is whether they can put it back.

## 2. Attendees are the calendar's version of send

The ask was time-blocking: *"the user could ask the agent to plan out tasks for the day,
and the agent could slot them in."* A solo block on your own calendar emails nobody.

But `events.insert` carrying an `attendees` array **sends invitations**, and deleting such
an event **sends cancellations**. That is `send` wearing a different hat, and it would
otherwise arrive inside the undoable tier without anyone noticing.

**So main refuses attendee-bearing events to the agent, structurally.** The calendar write
functions handed to the ops server reject any event that has attendees — on create, and on
any edit or delete of an event that already has them. Not a rule in `SKILL.md` that the
agent might reason its way around: a refusal inside the function it was handed, which is
the same move D68 §6 made by passing functions instead of `googleData`.

Consequence: calendar write sits entirely in the undoable tier, and **the hook only ever
has to guard mail**.

## 3. Structure — the exclusion widens, it does not dissolve

`googleData` already exposes `markRead` / `setStarred` / `archive` / `trash` as bound
methods that write to Google **and** patch the cache, in that order (D68 §5). So the ops
server is handed **more functions, still never `googleData`**.

This resolves the open question of where agent writes should come from. Because the agent
calls the *identical* function the router calls, the renderer's cached list stays coherent
with no stale-until-next-sync window and no second cache path to keep in agreement. The
structural exclusion D68 §6 built survives verbatim; only the list of functions grows.

Two parts need building rather than wiring:

- **The ops server is GET-only.** It reads `url.searchParams` and nothing else. `send`,
  `reply` and `draft` carry a body that does not belong in a query string, so it needs
  POST with a JSON body. The token check must apply to POST identically.
- **`GoogleApi.post` returns `void`.** D69 narrowed it because no caller read the result.
  `drafts.create` and `messages.send` both return an id the agent should get back, so a
  body-returning variant is needed. Recording this because a return type that was narrowed
  for a good reason and is now widened looks like a regression to whoever reads it next.

**RFC-822 assembly is the real work in this section.** `messages.send` takes a
base64url-encoded raw MIME message. A reply must carry `In-Reply-To` and `References` from
the message it answers, or Gmail starts a **new thread** — which looks correct in every
fake, and is wrong in the mailbox.

## 4. The gate, built so it actually fires

D67 §5 specified gating a future send behind `Bash(holi-google send:*)`. **That rule could
never have matched.** `SKILL.md` tells the agent to invoke `"$HOLI_GOOGLE_BIN" send`, so
the literal command text contains no `holi-google` at all. The gate that was written down
as the plan was a no-op waiting for something to gate.

A hook is the right mechanism, and is genuinely stronger than a permission rule:
`hookSpecificOutput.permissionDecision: "ask"` **overrides `permissions.allow` and overrides
a prior "don't ask again"**. That is the property the wall needs — it survives a user who
allow-alwayed the command six weeks ago and has forgotten.

Since matching command text is what makes it fire, the command text is made predictable:

- the generated `bin/` directory is **prepended to the agent's `PATH`** in `buildAgentEnv`,
  and `SKILL.md` switches to the bare name: `holi-google send …`
- the seeded `PreToolUse` hook matches `Bash`, with `if` conditions covering both that form
  and the surviving `$HOLI_GOOGLE_BIN` form
- the hook script returns `ask` for `send`/`reply`, and **`defer`** for everything else —
  `defer` removes the hook's opinion and lets the normal permission flow apply, which is
  precisely the "not my business" answer and avoids the hook silently widening anything

`$HOLI_GOOGLE_BIN` stays set. It is what the skill has always used, removing it would break
a working path for no gain, and the hook covers both spellings.

**The honest limit, stated because nobody re-derives it later.** This gates a *cooperative*
agent, not an adversarial one. Command text can be obfuscated — `eval`, a variable, `sh -c`
— and no string match survives that. The claim this design supports is **"the agent never
sends without you seeing it"**, not "the agent cannot send". Those are different sentences,
and only the first one is true.

## 5. The command surface

```sh
# mail — read (existing, unchanged)
holi-google search '<gmail query>'
holi-google read <id>

# mail — undoable writes
holi-google mark-read <id> [--unread]
holi-google star <id> [--off]
holi-google archive <id>
holi-google trash <id>
holi-google draft --to <a> --subject <s> [--thread <id>]   # body on stdin

# mail — reaches a human, hook-gated
holi-google send  --to <a> --subject <s>                   # body on stdin
holi-google reply --thread <id>                            # body on stdin

# calendar — read (existing) and undoable writes
holi-google agenda [fromISO] [toISO]
holi-google schedule --title <t> --start <iso> --end <iso> [--all-day]
holi-google reschedule <eventId> --start <iso> --end <iso>
holi-google unschedule <eventId>
```

Bodies arrive on **stdin**, not as an argument: a multi-line email in a shell argument is a
quoting accident waiting to happen, and it would put the entire message text into the
command line that the hook and the permission prompt display.

`draft` is the surface the skill should teach as the default for anything outbound. It
reaches nobody, it needs no confirmation, and it leaves the user one click from sending.

## 6. Scopes and consent

One new scope: `https://www.googleapis.com/auth/calendar.events`. Mail needs nothing —
`gmail.modify` already permits `messages.send` and `drafts.*` (D68's uncomfortable part).

`calendar.events` is *sensitive*, the same tier as the existing `calendar.readonly`, so
there is **no new verification burden** — GCP-side this is a consent-screen edit and
nothing more.

It does cost **one re-consent**, and `GoogleSession.missingScopes()` (D68) already handles
the trap: widening `GOOGLE_SCOPES` does not invalidate the existing grant, so without a
reconnect the calendar writes would 403 while everything else kept working. Vault settings
already offers Reconnect on that condition. Per the user's instruction, everything lands
together and consent is given **once, at the end**.

## 7. What `SKILL.md` has to stop saying

It currently states, as its second paragraph, that the agent cannot send mail or change the
calendar and that *"there is nothing to call"*. Its §Rules repeats it. Both become false.

`test/seed-content.test.ts` pins the true claim and the absence of the old false one — that
test is the mechanism, and it is updated in the same commit as the text. The replacement
must teach the tiering rather than a flat capability list: prefer `draft`, expect a
confirmation prompt on `send`, and know that attendee-bearing events will be refused.

## 8. Testing, against this pillar's standing failure mode

D69 named it: *a test that asserts what the code assumes, rather than what the external
system does, passes while the feature is broken.* It has now happened three times in this
pillar. Nothing in this repo has ever talked to Google.

So the fakes must **refuse the way Google refuses**:

- `messages.send` rejects a raw message that is not valid base64url
- a reply asserted on `In-Reply-To` **and** `References`, not on "a send happened"
- `events.insert` with attendees never reaches the fake at all — the refusal is ours, and
  the test asserts main refused rather than that Google did
- the CLI's generated-shell tests get `send`/`reply` cases, because stdin plumbing through
  generated `sh` is exactly the kind of thing no unit test covers

**Unproven until run against the real account, and to be treated as broken until then:**
RFC-822 assembly and threading, `drafts.create`'s response shape, `events.insert`/`patch`/
`delete` shapes, and whether the hook's `if` conditions match real command text. The last
one is testable immediately and by hand, and should be — a gate that does not fire is worse
than no gate, because it is believed in.

## 9. Rejected

- **Withholding `send` entirely** — the structurally safest answer, and it was on the table
  as the recommended option. Declined in favour of a hook that always asks: an agent that
  can draft but never send makes the user the transport layer for its own output.
- **A main-side confirmation dialog** — the strongest wall, living outside the agent's
  process entirely. Declined as bespoke machinery where a supported mechanism exists; the
  hook's `ask` already survives allow-listing, which was the property the dialog was for.
- **`permissions.ask` alone for `send`** — defeated by one "don't ask again" click, six
  weeks before the send that mattered. This is D68 §6's "a defence that quietly became
  single-layered" arriving on schedule.
- **Letting the agent write via `googleData` directly** — dissolves the D68 §6 exclusion
  for a convenience already available by passing four more functions.
- **A skill rule forbidding attendees** — the agent is the thing being bounded; a bound it
  can read and reason about is not a bound.
- **Bodies as command arguments** — quoting accidents, and it puts the whole email into the
  text of the confirmation prompt.
