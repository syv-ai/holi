# Google Mail + Calendar — whole-pillar design

**Date:** 2026-08-04
**Status:** approved, ready for planning (decompose into slice plans)
**PRD refs:** `docs/prd/_phase2-google-mail-calendar.md` (the stub this fleshes out — do not duplicate it); `docs/prd/auth-identity.md` (the GitHub OAuth/keychain model a second provider slots beside); `docs/prd/agent.md` (§Tool surface, the "MCP returns here" line); `docs/prd/tasks.md` (§Deferred "Email/Calendar linking"); `docs/decisions.md` **D67**.
**Seams studied:** `apps/desktop/src/main/github/{device-flow,session,token-store,api}.ts`; `apps/desktop/src/renderer/src/components/Shell.tsx` (tab workspace + drawer idioms); `apps/desktop/src/renderer/src/features/*`.

## Problem

The largest deferred pillar. Employees want their **Gmail and Google Calendar** inside Holi — read mail/threads, see their agenda, and link an email or event to a task/note. Mailspring is dead; this is rebuilt natively on the **Gmail API + Google Calendar API**.

The PRD stub named five open questions and left the shape undecided. This document resolves all of them into one cohesive design and decomposes the pillar into build slices. It settles: how the desktop obtains a Google grant with no server, who holds and refreshes the token, how the agent (a separate process) reaches Google without breaking the "pure Claude Code, no MCP" stance, how a linked item is represented in a file, and what is in v1 versus deferred.

The pillar is designed **whole and top-down**, then built as four slices: **Connector → Calendar → Gmail → Agent skill.**

## The design at a glance

| Question | Decision |
|---|---|
| OAuth flow | Auth-code **+ PKCE**, **loopback `127.0.0.1`** redirect, in Electron **main**, built as a sibling of `device-flow.ts` |
| Token custody | **Main is the sole token authority** — only process that refreshes; everything else asks main |
| OAuth app | **External**, **reuse the existing registration**; ship `GOOGLE_CLIENT_ID` (+ non-confidential desktop `client_secret`) in the binary |
| Accounts | **Single** connected account in v1; token store **keyed by Google `sub`** so multi-account is additive later |
| Scopes | ~~Read-only both~~ **superseded by D68 (2026-08-05)**: mail is `gmail.modify` + `contacts.readonly`; calendar stays `calendar.readonly`. Compose = `mailto:`/deeplink |
| Verification | Calendar (sensitive) ships first; Gmail (restricted, CASA) is the long pole — build in **testing mode**, verify in parallel |
| Agent surface | **Skill + `holi-google` CLI**, proxying to main over a loopback channel. **No MCP.** |
| Link representation | **Markdown link in the file body**; UI chip via **render-time URL detection** (computed, not stored) |
| UI surface | Agenda + Mail as **workspace tabs** (peers of `board`); "Connect Google" in **global/app settings** |
| Freshness | **On-demand** (open/refresh/CLI) + short **in-memory** cache in main; nothing persisted |
| Disconnect | Independent of GitHub; **revoke at Google + clear keychain** |

## Connector & auth (slice 1)

**The flow.** Authorization-code with **PKCE** and a **loopback redirect** — Google's documented "Desktop app" pattern:

1. Main generates a PKCE `code_verifier` + `code_challenge`, binds a one-shot HTTP listener on `http://127.0.0.1:<random-free-port>`, and opens the system browser at Google's auth endpoint with `access_type=offline` + `prompt=consent` (so a **refresh token** is returned) and `redirect_uri` pointing at the loopback port.
2. The user consents in their real browser (reuses their Google session; credentials never touch the app's web context).
3. Google redirects to the loopback listener with `code`; main exchanges `code` + `code_verifier` at the token endpoint for `{ access_token, refresh_token, expires_in, scope, id_token }`.
4. The `id_token` (or a `userinfo` call) yields the account identity — **Google `sub`** (stable key) + email. Main persists the blob to the keychain and reports "connected as X" to the renderer.

**Build it as a sibling of `device-flow.ts`, not a reuse of it.** The GitHub flow is device-code; this is loopback+PKCE — a *different* grant. But the *shape* ports verbatim and is the contract to hold:

- Dependency-injected `fetch` / `now` / `sleep` / **`openBrowser`** / **`listen`** (the loopback server), so the state machine is pure and testable with **no live browser and no network**.
- A discriminated-union result — mirror `DeviceFlowResult`: `{ kind: 'granted'; tokens } | { kind: 'denied' } | { kind: 'cancelled' } | { kind: 'timeout' }`. A flow *outcome* never rejects; only a network/protocol fault throws.
- `cancel()` closes the listener and the browser wait.

**Gotchas** (carry these into the plan):
- **Loopback port must be random and free** (bind `:0`, read the assigned port) — a fixed port collides and is a weaker redirect match.
- **`prompt=consent` is required to re-obtain a refresh token.** Google returns a refresh token only on the *first* consent unless `prompt=consent` forces it; without it a re-connect yields an access token with no refresh token and the session silently can't renew.
- **The redirect response must close cleanly** — serve a tiny "you can close this tab" HTML page and shut the listener, or the browser hangs on a pending request.
- **PKCE `S256`**, not `plain`.

### Token store

New `GoogleTokenStore`, a **sibling of `token-store.ts`** (same `safeStorage` envelope, same "never write plaintext / a file it cannot read is a disconnect, not a crash" invariants, its own `VERSION`). Shape:

```ts
interface StoredGoogleAuth {
  sub: string            // stable Google account id — the identity/store key
  email: string          // display + account label
  refreshToken: string
  accessToken: string
  expiresAt: number      // epoch ms; refresh when now() >= this (minus a skew margin)
  scopes: string[]       // what was actually granted, for honest error messages
}
```

Stored **keyed by `sub`** (a map, even though v1 holds one entry) so adding accounts later is additive, never a rewrite. Separate keychain file from the GitHub token — the two providers are independent (see Disconnect).

### Main is the sole token authority

Only main ever calls Google's token endpoint. A `GoogleSession` (sibling of `GitHubSession`) exposes:

```ts
getAccessToken(): Promise<string>   // transparently refreshes if expired; single-flight
```

**Single-flight the refresh** — concurrent callers (the agenda tab + a `holi-google` invocation + a mail fetch) must share one in-flight refresh, never fire N parallel refreshes. This is *the* reason main is the sole authority: refresh tokens can be **rotated** by Google on use, so two independent refreshers racing on one refresh token invalidate each other — an intermittent, brutal-to-debug auth failure. One process, one refresher, one in-flight promise.

On a refresh failure that means the grant is gone (`invalid_grant`), main clears the entry and surfaces a "reconnect Google" state — the same shape as GitHub's `onUnauthorized` → `#forget()`.

### The loopback ops channel (main ↔ CLI)

The agent's `holi-google` CLI runs in a *separate process* and cannot reach Electron IPC. So main exposes a **localhost HTTP endpoint** that serves the *operations* (agenda, search, read-thread), never tokens:

- Main binds `127.0.0.1:<port>` and writes `{ port, secret }` to a **machine-local, gitignored** file (mirror `.holi/settings.local.json`'s locality; the exact path is a plan detail).
- The CLI reads that file, calls the endpoint with the secret in a header. Main authenticates the secret, calls Google with its own `getAccessToken()`, and returns the result. **Google tokens never leave main.**
- The secret gates against other local processes; the endpoint is loopback-only. This is the per-run-secret handshake the PRD said it did *not* port for the (deleted) vault-ops MCP server — reintroduced here, deliberately, for external data, which was always the stated exception.

The **UI** consumes the same main-side operations directly over the existing tRPC-over-IPC router — one implementation of each Google call, two front doors (tRPC for the renderer, loopback HTTP for the CLI).

## Scopes, OAuth app & verification

- ~~**Scopes (v1, read-only):**~~ **Superseded by D68, 2026-08-05.** As shipped: `gmail.modify`, `calendar.readonly`, `contacts.readonly`, plus `openid email` for identity. No calendar write. `gmail.modify` replaced `gmail.readonly` (a superset) to buy mark-read, star, archive and trash; `contacts.readonly` rode the same consent screen to put a real address book behind `@`-completion.
  - **`gmail.modify` also permits `messages.send`, and no lesser scope grants `threads.modify`** — so archive cannot be had without it. Holi does not send because no compose surface is built, *not* because the grant forbids one. `https://mail.google.com/` is **not** requested, so permanent deletion genuinely is impossible; trash is Gmail's recoverable trash. See D68 for why this distinction is recorded rather than glossed.
- **OAuth app:** **External**, **reuse the existing registration** (which already carries Gmail permissions). Introduce `GOOGLE_CLIENT_ID` as a constant beside GitHub's `CLIENT_ID`, value from the existing app. For a **Desktop-app** client the `client_id` and the `client_secret` Google issues are **not confidential** — PKCE is the protection — so both ship in the binary, exactly the reasoning `session.ts` already documents for the public client id.
- **Config dependency to confirm at build time:** the existing OAuth client must be a **"Desktop app"** type (loopback redirects allowed out of the box). If it is a **Web** client (server-era/Mailspring leftover), either add a Desktop client or register the `http://127.0.0.1` redirect URI on it. *This is the one external prerequisite the connector slice can't self-serve.*
- **Verification asymmetry drives the slice order.** `calendar.readonly` is a **sensitive** scope (lighter "brand" review); Gmail is **restricted**, requiring Google's **CASA security assessment** (slow — weeks to months). So: build and dogfood against the app in **testing mode** (≤100 explicitly-added test users, accepting the "unverified app" warning), ship Calendar to GA sooner, and run Gmail's restricted-scope verification **in parallel** while the Gmail slice is built. Verification is on the critical path for Gmail GA but **not** for building or internal use.

The PRD's "scope minimization + Google verification" open question is answered by "minimum scope for the job + reuse the verified/verifying external app + testing-mode dogfooding."

**D68 did not change the verification story.** `gmail.modify` is *restricted* — the same CASA tier `gmail.readonly` already sat in — and `contacts.readonly` is *sensitive*, the lighter tier. The testing-mode posture above carries over untouched. GCP-side the widening cost two changes: enabling the People API, and listing the two new scopes on the consent screen.

## Linking an email/event into a task or note

A Gmail/Calendar item is an **external URL, not a vault file**, so it cannot be a `[[wiki-link]]` (those resolve to files and would render as permanent tombstones). Decision: **a plain markdown link in the file body.**

- `[Re: Q2 budget](https://mail.google.com/...)` written into the body — exactly the tasks-PRD philosophy: "link to things by writing wiki-links/links in the body; backrefs are a grep; no machine-owned frontmatter; no second representation." No `related[]` ghost.
- The UI renders a **chip + "open" affordance** by **detecting** a Google URL in the body **at render time** — the same computed-not-stored trick the board uses for `overdue`/`pN` labels (`packages/shared/src/labels.ts`). Nothing is written to frontmatter.
- **"Linked tasks for this event"** = a grep for the URL, identical to backrefs.
- **Stable URLs** (gotcha): Gmail's `/mail/u/N/` slot is login-order-dependent and breaks across multi-login — use the account-portable **`https://mail.google.com/mail/u/0/#search/rfc822msgid:<message-id>`** form. Calendar uses the API-provided **`htmlLink`** per event.

## UI surface

The shell (`Shell.tsx`) has two idioms: **workspace tabs** (`board` opens as a tab from a nav button; notes are `note` tabs) and **right-hand resizable drawers** (agent ⌘J, history, settings). Decision: **Agenda + Mail are workspace tabs**, peers of the board.

- Extend the tab union `note | board` → **`note | board | agenda | mail`** (`state/panes.ts`), add **"agenda"** and **"mail"** nav buttons in the left aside beside "today"/"board", and branch the main render in `Shell.tsx` on the new kinds.
  - **As built (corrected after use):** they sit on a **second row**, not inline with "today"/"board". Five chips across the sidebar made it scroll horizontally — and `flex-1` alone does not fix that, because a flex item's default `min-width: auto` refuses to shrink below its own text. `min-w-0` on every chip is what forbids the overflow; the second row is what keeps them legible instead of truncated.
  - **They are hidden until Google is connected.** A chip whose only destination is "connect Google in vault settings" is a dead end wearing the clothes of a feature. Connectedness lives in `state/google.ts` — three states, because `undefined` ("not asked yet") must be distinguishable from `null` ("nothing connected") or the chips flash on every launch before hiding. `GoogleConnection` writes that atom rather than holding its own copy, so connecting lights the chips up on the same tick the panel says "connected as".
- **Agenda tab:** today/this-week list of events across the user's calendars, each with a **"create task"** action (writes `task.<slug>.md` with the event's markdown link + title in the body) and an "open in Google Calendar" link.
  - **Which calendars, corrected after first use.** Honouring Google's `selected` flag was not enough: a Workspace account is subscribed to colleagues' calendars, meeting rooms and birthdays, all of them `selected` because in Google Calendar they sit in their own columns. Flattened into one agenda they stopped it answering "what am I doing today". So: **the default is calendars you own** (`primary`, or `accessRole: 'owner'`), everything subscribed starts off, and a picker in the agenda header switches any of them on. The choice persists in `main/google/calendar-prefs.ts`.
  - **The overrides file lives in main, and that is load-bearing** — the agent's `holi-google agenda` resolves through the same store, so switching a colleague off hides them from the agent too. Held in the renderer it would have hidden them from the panel while the agent carried on reading four other people's days.
  - Overrides are stored **per calendar, not as "the enabled set"**, so a calendar created next month follows the default rule rather than arriving silently off because it was absent from a list written today.
  - Every event carries **`mine`** and the source calendar's **Google colour**. `mine` is what stops "you have four meetings tomorrow" when three of them are Jane's — it drives dimming on the row, and the skill tells the agent to read it before describing the user's day.
- **`GoogleApi.get` takes repeated query keys** (an array value → one parameter per item). Added to fix a silent failure worth remembering: `metadataHeaders` was sent comma-joined, Gmail read the whole string as a single header *name*, matched nothing, and returned **200 with no headers at all** — so every thread in the list rendered as "(no subject)" from an empty sender. Nothing errored; the field was simply absent.
- **Mail tab:** thread list (INBOX + Gmail search-query box) → thread reader (from/to/subject/sanitized body; attachments as "open in Gmail" links, no download in v1) → **"link to task/note"** (inserts the body markdown link) and **"reply"** = `mailto:`/Gmail-compose deeplink.
- **Account-scoped, not vault-scoped.** Mail/calendar are *your Google data* regardless of which vault is open (unlike notes/tasks/board, which are vault content). Rendering them in the vault shell is fine (the agent drawer is also per-user), **but "Connect Google" / "Disconnect" belong in global/app settings or the user menu — not per-vault `VaultSettings`.** (If no global-settings surface exists yet, establishing a minimal one is part of the connector slice.)

### HTML mail — sanitize and render

The build first shipped extracted plain text, arguing that it removed the XSS and tracking-pixel class *by construction*. **Nicolai overruled that the same day, and the original plan stands.** The argument against text was short and correct: a mail reader that cannot render mail is not a mail reader. "Designed newsletters read plainly" was the product being given away, not a footnote, and removing a feature is not the same as securing it.

What renders is sanitized HTML, and the work splits into three jobs that are worth keeping distinct:

1. **Execution — DOMPurify's job.** `renderer/src/lib/mail-html.ts`. Scripts, event handlers, `javascript:` URLs, and the mXSS shapes that defeat hand-rolled strippers. It runs in the **renderer, not main**, because DOMPurify needs a real DOM and the renderer has one — sanitizing in main would mean shipping `jsdom` and giving the main process a rendering concern. `sanitize-html` (node-side, string in/string out) and `isomorphic-dompurify` (drags in jsdom) were both considered and rejected for that reason.
2. **Remote content — ours, and the half that is easy to forget.** DOMPurify stops a script; it does nothing about `<img src="https://tracker/pixel.gif">`, which is a read receipt fired at the sender from the user's IP the moment the message is opened. So `src`/`poster` are stripped and **counted**, `srcset`/`background` are forbidden outright, and `url()` inside an inline style is dropped declaration-by-declaration (the surrounding colours and spacing survive). The count is what drives a per-message **"Load images"**, which re-sanitizes the original HTML with the flag flipped — one code path, never a re-injection of stashed URLs. `data:` images are kept: nothing is fetched, so nothing is disclosed. `cid:` and relative sources are dropped silently, because "load images" cannot fix them.
3. **Containment — a sandboxed frame, not a `<div>`.** `renderer/src/lib/mail-frame.ts`. Each message renders in **its own document**, written into an `<iframe sandbox="allow-same-origin">`. Sanitized markup therefore never enters the app's document at all, which is a structural guarantee rather than a list of forbidden tags. Three things follow:
   - **`allow-same-origin` and nothing else.** No `allow-scripts` — granting *both* is the well-known footgun, because framed content can then remove its own sandbox. Same-origin is needed so the app can write the document, measure it, and intercept clicks; that is all the *app's* script reaching in, never the message's script running out.
   - **The frame declares its own, far stricter CSP:** `default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'`. This is where remote blocking becomes structural rather than a matter of getting every attribute right — including routes an attribute pass cannot see, like `@import` inside a stylesheet. "Load images" widens exactly one directive, so the browser and the sanitizer always agree.
   - **The frame is written with `document.write`, not `srcdoc`.** The app needs a handle on the document anyway (height, links), and writing gives it on the same tick instead of after a load event. It is also the only one of the two that jsdom implements, so the behaviour stays testable rather than asserted-by-inspection.

   `<style>` **stays forbidden**, which looks like a rule that outlived its reason — the frame would contain a stylesheet perfectly well. It did not: DOMPurify strips stylesheet *contents* as an mXSS mitigation, and forcing them back (`ADD_TAGS: ['style']`) measurably changes how it parses. On the classic `<svg><style><img src=x onerror=…>` payload it stops neutralising the `<img>` and lets it into the document as a real element. That was measured, not assumed, and a parser-level regression is not worth nicer newsletters. Inline `style` attributes — how the large majority of mail is designed, since Gmail is itself hostile to `<style>` — are kept. The `<form>` family, `<base>`, `<link>` and `<meta>` go too: exfiltration, URL retargeting, and redeclaring the frame's own policy.

**The frame is themed.** A separate document gets no cascade, so the app's tokens (`--card`, `--card-foreground`, `--primary`, `--border`, `--muted-foreground`) are resolved to real values and written into the frame's base stylesheet, with `color-scheme` following the app's mode. `useMailPalette` observes `document.documentElement` directly — a vault switch rewrites custom properties there with no React state involved (`ThemeApplicator`) — and holds object identity when nothing changed, because the palette is a frame effect dependency and a fresh object per render would rewrite every open message. The base stylesheet is emitted *first* and specificity-free, so a sender's own styling still wins inside their own page: these are defaults for mail that brings none, not a restyling of mail that does. **The honest cost:** a dark theme will still read poorly for mail that hard-codes dark text on an assumed white background. That is inherent to rendering real mail, and it is the sender's markup winning, which is the correct outcome even when it is the uglier one.

**Both representations travel.** `MailMessage` carries `body` (plain text — the sender's own `text/plain` part where there is one) *and* `html` (raw, unsanitized, or `null`). The UI reads `html`; the agent reads `body`, projected by `textOnly()` at the ops server. That asymmetry is deliberate and explicit: an LLM wants prose, not a table layout, and unsanitized markup should exist on exactly one path — the one that sanitizes it.

**Links never navigate.** `target` is stripped, and a click handler on the frame's document hands `http(s):`/`mailto:` URLs to `window.holi.openExternal`. It calls `preventDefault` *before* checking the scheme, so an untrusted one still cannot navigate. This gate is load-bearing rather than decorative: a sandboxed frame may navigate *itself*, so an unintercepted click would replace the message with a live web page — precisely the remote content the whole feature keeps out. The test uses `ftp:` deliberately, because `javascript:` and `file:` are stripped by DOMPurify and a test using those would pass whether or not the gate existed.

**A renderer CSP** was added alongside — `object-src`/`base-uri`/`form-action` all `'none'` — closing a standing gap (`renderer/index.html` had no CSP at all). It is explicitly *not* an XSS defence: `script-src` is absent because Vite's dev server injects an inline module preamble, and the only policy that would work in dev carries `'unsafe-inline'`, which stops nothing while reading like protection. `frame-src`/`child-src` are deliberately absent too — the app now renders one iframe on purpose, and whether `frame-src` blocks an `about:blank` frame is exactly the kind of thing that works in dev and fails in a packaged build. Framing is constrained where it matters instead: inside the mail frame, where `default-src 'none'` means the message cannot frame anything at all.

## Freshness

**On-demand, no background polling in v1.** No server → no Gmail Pub/Sub or Calendar `watch` webhook to receive, so push is out regardless.

- Fetch on **panel-open**, **manual refresh**, and **CLI invoke**. Hold a short **in-memory** cache in main so toggling a tab doesn't refetch.
- ~~**Nothing persisted to disk** (PRD non-goal — Google stays source of truth).~~ **Overturned 2026-08-04 — see "Bounded local cache" below.** Offline still shows "reconnect to load your agenda" rather than pretending a cached day is today's.
- **Rely on Google's own apps** for proactive meeting/mail notifications — reinventing them is the "full email client" the PRD rules out. A light background poll on the existing reminder tray-tick (for "meeting in 10 min" inside Holi) is a clean **additive** slice *if* it earns its place.

### Bounded local cache + Gmail incremental sync (added 2026-08-04)

**Overturns "nothing persisted", on Nicolai's call.** A bounded last-N cache is not a mirror: it holds the last **500 threads per question asked**, in `userData/google-cache.db` on `node:sqlite`. Google still decides what is true; the cache decides only what is painted before Google answers.

**Why it was worth reversing a stated non-goal:** a mail refresh was `threads.list` + one `threads.get` per thread — **26 requests for 25 threads**. `history.list` deltas on top of the cache collapse an unchanged refresh to **one**.

| | Mail | Calendar |
|---|---|---|
| Cached | yes | yes |
| Incremental | **yes** — `history.list` delta | **no**, deliberately |
| What the UI does | `threads` is instant *and* current | `agendaCached` paints, `agenda` replaces |

**Calendar is not an oversight.** `events.list`'s `syncToken` **cannot be combined with `timeMin`/`timeMax`** (Google's reference lists both among the parameters that cannot accompany `nextSyncToken`; an expired token returns 410). Incremental calendar sync would therefore mean mirroring every event at every date, per calendar, to serve a seven-day view. Refused.

**Design points that must not be "fixed" later:**

- **`node:sqlite`** — built into Node 24 / Electron 43. No native module, no `electron-rebuild`. This is what made a database affordable.
- **Unencrypted, on purpose.** SQLCipher is a native module (the thing `node:sqlite` avoids) and hand-encrypting columns would foreclose FTS5 search. The protection is the OS account and disk encryption — the same protection the vault's own notes already rely on, sitting in the same place.
- **In `userData`, never in a vault.** Mail is account data; a vault is a shared git repo, so caching an inbox there would push a client's mail to teammates on the next sync.
- **`useAccount(sub)` before any read**, and **disconnect deletes the file** (plus `-wal`/`-shm`), not the rows. Both hang off `googleSession.onChange`, which also fires for a dead grant.
- **The agent never reads it.** The ops server gets `listAgenda`/`listThreads`, which take no cache and so cannot consult one.
- **The Gmail history cursor is stored per cached list, not per mailbox** — one shared cursor asks "what changed since 200?" against a list written at 100 and silently loses everything between.
- A `history.list` **404 means resync**, not failure: Gmail keeps roughly a week.

## Agent surface (slice 4)

**Skill + CLI, not MCP.** The agent gets a `.claude/skills/gmail-calendar/` skill documenting a stateless **`holi-google`** CLI (`holi-google agenda`, `holi-google mail search "<q>"`, `holi-google mail read <id>`, …) that the agent runs via native `Bash`. The CLI proxies to main's loopback ops channel (above); it never touches Google tokens.

This keeps `holi-agent-pure-claude-code` **fully intact** — the phase-2 "MCP returns" prediction is *declined* in favour of the pure-CC idiom. The principle's reasoning ("vault state is files, discover it natively") never argued against a tool surface for *external* data; skill+CLI honours both the letter and the spirit better than an MCP server would, at the cost of unstructured (text) output the agent parses from the skill's documented format.

- **Permission granularity is recovered via Bash rules:** the seeded `.claude/settings.json` can auto-allow the read subcommands while gating any future `send` behind approval. So "send" stays a distinct, gated capability when it lands — without a per-tool MCP surface. **No longer moot, and the reasoning inverted — see D68.** This was written when the read-only scope made sending impossible, so the Bash rule was a second line of defence behind the grant. Under `gmail.modify` the token *can* send, so if a `send` subcommand is ever added to `holi-google`, the permission rule is the **only** wall rather than the second. The CLI is still handed read functions only.
- **As built:** the CLI is a **generated `/bin/sh` script** written to `userData/bin/holi-google` on launch, not a shipped binary — no packaging entry, readable on the machine it runs on, and it re-reads the port/token each invocation so it survives restarts that move the port. Its absolute path reaches the agent as **`$HOLI_GOOGLE_BIN`**, mirroring `$TYPST_BIN` (`prd/agent.md` §Rendering PDFs); the channel reaches it as `$HOLI_GOOGLE_PORT`/`$HOLI_GOOGLE_TOKEN`. All three are **stripped from the inherited env** before being set, so a vault's own env cannot redirect the agent at another mailbox. The script uses `curl -G --data-urlencode` rather than hand-rolled percent-encoding — a mangled search query fails silently by searching for something else.
- **The ops channel is modelled on `agent/hook-server.ts`** (ephemeral port, per-instance token, `127.0.0.1` only) rather than being a second bespoke transport.

## Disconnect

- **"Disconnect Google"** calls Google's **`/revoke`** endpoint, then clears the keychain entry. Revoking server-side (not just deleting the local token) is the hygienic default — a lingering grant is a standing liability.
- **Independent of GitHub sign-out.** Google is a *data connector*, not identity (identity is GitHub, `auth-identity.md`). GitHub sign-out leaves the Google token alone, and disconnecting Google touches no clones and no GitHub session. (No clone-trashing question here — unlike GitHub sign-out, no clones are tied to the Google token.)

## Slice decomposition

Each slice gets its own plan; this is the spine and the per-slice exit contract.

1. **Connector** — loopback+PKCE flow (sibling of `device-flow.ts`), `GoogleTokenStore`, `GoogleSession` with single-flight `getAccessToken()`, "Connect/Disconnect Google" in settings. **Exit:** connect as an @-account and make one raw authenticated Google API call end-to-end (a unit-tested flow + a live-check of the browser round-trip). *The **ops channel moved to slice 4**, where its only consumer is built — a localhost server with no caller is machinery bought before it is needed.*
2. **Calendar read** — main-side calendar ops (list calendars, list events/agenda) exposed over tRPC + loopback; the **agenda workspace tab**; **create-task-from-event**. First because its scope verifies lightly. **Exit:** agenda renders live; a task is created from an event with the event link in its body.
3. **Gmail read** — main-side gmail ops (list/search threads, read thread) with HTML **sanitization**; the **mail workspace tab**; **link-into-body** + `mailto`/deeplink compose. Restricted-scope verification submitted during slices 1–2. **Exit:** search + read a thread; link it into a task/note as a body link that renders a chip.
4. **Agent skill** — the loopback ops channel, the generated `holi-google` command over it, and the seeded `gmail-calendar` skill. **Exit:** the agent answers "what's on my calendar today?" and "find the thread about X" via the CLI.

## Build status (2026-08-04)

All four slices are **implemented and green** (typecheck clean; node 869, dom 98, shared 229; boundaries gate clean). What is *not* verified, and cannot be from here:

**Live as of 2026-08-04 — Nicolai confirmed "the integration works"** after supplying the credentials, which is the first time any of this has touched Google. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are embedded in `main/google/session.ts`, both committed on purpose: a desktop client's pair is not a credential — it ships in every binary, PKCE is what protects the grant, and no token exists without the user completing consent in their own browser. `HOLI_GOOGLE_CLIENT_ID` / `HOLI_GOOGLE_CLIENT_SECRET` still override.

Still worth knowing what that confirmation does and does not cover — it was a user's report of the feature working, not an enumerated check:

- **Not independently verified from here**, and not verifiable: no suite in this repo talks to Google, by design.
- **The mail frame under real mail.** Its behaviour is pinned in jsdom, which is not Chromium. Worth a deliberate look at a heavily-designed newsletter: blocked-image banner, frame height, and a link opening in the OS browser rather than inside the frame.
- **The agent's CLI path** (`holi-google agenda|search|read`) — exercised only against fakes.

## Deferred (fast-follow slices, explicitly out of v1)

- **`gmail.send`** (real send from Holi/agent) — deeplink compose only in v1.
- **Calendar-event write** (create/edit events, "block focus time").
- **Recurring-event "task lights up for a series"** — underspecified; needs the agenda proven first.
- **Background polling + in-app "meeting soon"/new-mail notifications** — Google's own apps cover this.
- **Multiple accounts at once / personal alongside work** — store is keyed by `sub` so this is additive; the External app already permits any *single* Google account.
- ~~**Disk-persisted cache / offline agenda viewing** — contradicts the "don't persist mail" non-goal.~~ **The cache was built 2026-08-04** (see Freshness); *offline viewing* is still deferred — the cache paints a launch, it does not claim to be today.
- **An MCP surface** — declined in favour of skill+CLI; revisit only if the CLI's unstructured output proves painful.

## Open dependencies (not blockers to planning)

- Confirm the existing OAuth client is **Desktop-type** (or register the loopback redirect) — see Scopes. **Still open**, and the last thing between here and a live connect.
- ~~Supply the real `GOOGLE_CLIENT_ID` (+ desktop `client_secret`)~~ — done 2026-08-04, embedded in `main/google/session.ts`.
- Submit Gmail restricted-scope verification (CASA) early, in parallel with slices 1–2.

## Rejected alternatives

- **Google device flow (like GitHub).** Reusing the device-code shape is tempting, but Google's limited-input device flow is **not approved for sensitive/restricted Gmail-Calendar scopes** in general — a likely dead end at verification. Loopback+PKCE is the sanctioned desktop grant.
- **Each consumer refreshes its own token.** Simpler wiring (no loopback channel) but two refreshers against one **rotating** refresh token race and invalidate each other. The loopback channel is the price of correctness.
- **An MCP server for mail/calendar** (the PRD's anticipated shape). Gives typed tools + per-tool permission prompts, but reintroduces a long-running server + handshake lifecycle and contradicts the deliberately-held pure-CC stance. Skill+CLI recovers send-gating via Bash rules and keeps the agent surface native.
- **A frontmatter field for links** (the `related[]` ghost). Stronger typing, but a second representation the tasks PRD killed on purpose; a body link + render-time chip gives the affordance without the invariant cost.
- **Internal (Workspace-only) OAuth app.** Erases verification entirely, but bakes "@syv.ai only" in at the app level — incompatible with the External/reuse-existing-registration reality.
- **Persist mail/calendar to disk for offline viewing.** Contradicts "Google is source of truth"; offline-agenda is a niche want not worth a cache-invalidation story in v1.
