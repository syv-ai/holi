# Google

A vault can connect a Google account to read and triage Gmail, read its calendar, block out the user's own time, compose mail, and turn a thread or event into a task. Mail and Agenda open as tabs; the agent gets the same surface through `holi google <verb>`. Google is a data connector, not identity: without it Holi works fully.

## How it works

- **Connect** with authorization code + PKCE over a one-shot `127.0.0.1` listener, in the system browser. The client id and desktop secret ship in the binary; for an installed app neither is secret, and PKCE protects the grant. Scopes: `openid`, `email`, `gmail.modify`, `calendar.readonly`, `calendar.events`, `contacts.readonly`, `contacts.other.readonly`.
- **Main is the sole token authority.** Refresh tokens rotate on use, so only main refreshes, single-flighted per account. Tokens are `safeStorage`-encrypted in `userData/google-auth.enc`, keyed by the account's `sub`.
- **Each vault names its account** in `userData/google-vault-accounts.json` (`owner/repo` → `sub`), outside the clone. One account may serve several vaults; linking a stored account needs no consent. _Disconnect this vault_ drops the mapping; _Remove account_ revokes at Google, deletes tokens and cache, and unlinks every vault. A new vault is never mapped automatically.
- **Scope drift:** an old grant keeps working and 403s only the newly added calls. `missingScopes()` compares stored scopes in Google's vocabulary (`email` returns as `.../userinfo.email`) and settings offers **Reconnect**.
- **Mail cache:** one `node:sqlite` file per account, `userData/google-cache-<sub>.db`, last 500 threads, reconciled by `history.list` deltas. The key carries every filter that narrows a list; the history cursor is per key; archive and trash arrive as label changes and land in a _left_ bucket. Bump `SHAPE_VERSION` when a cached type changes. A removed or dead account deletes the file and its sidecars.
- **Writes:** the renderer paints first and reverts on refusal; main calls Google first and updates the cache only on success. Every thread action takes that one path.
- **Calendar** shows calendars the user owns by default; per-calendar overrides live in main so the agent honours them. Events carry `mine`. Joining uses `conferenceData`, then the body, then the location, matching a join-link shape. A thread with an `.ics` is joined to its event by the invite's `UID`.
- **The agenda is a month** to look at and create in (`renderer/MonthView`, `month-days.ts`): six weeks, Monday first, ISO week numbers down the side, today in a red disc, weekends shaded and the neighbouring months' days faded. An event is drawn on each day it covers: a timed one as its calendar's colour bar and title, an all-day one as a tinted pill; a day with more than three shows two and "+N more", which lists the day. ‹ Today › pages by month and the month asks for its own six weeks (`monthWindow`, always under the 92 days one call may ask). A **Month | List** switch reaches the list, the next week with each invitation beside it. Which one the Agenda *opens* on is the **Calendar view** switch under Settings → Agenda, off by default and this machine's (`agendaMonthAtom`, in the browser's storage, not the vault). Pressing an event opens it (the same detail the list's pane shows); **pressing a day's empty space starts an event on it** (`NewEventDialog`), made by `google.createEvent` at the UI door, which is the agent's `schedule` call, so it is on the primary calendar and has no attendees and mails nobody. An all-day event's `end` is the day after, as Google's is.
- **Composer:** markdown with a preview through the reader's sanitiser and frame; main sends exactly the previewed HTML as `multipart/alternative`, the markdown as the plain part, marked `X-Holi-Source: markdown`. Drafts live in Gmail and all of them open (unmarked ones via `turndown`). Autosave from the first edit, 2 s idle, single-flight. Reply is sender-only unless reply-all.
- **Linking** a thread or event makes a task with the permalink as a plain markdown link in its body ([tasks](tasks.md)).
- **One set of capabilities, three doors** (`google.*`, [architecture](../architecture.md)): the views call them at the UI door, the agent as `holi google <verb>` through the core bridge, which already authenticates per vault and names the caller's remote, and a vault app reads `google.agenda` and `google.search` at the app door behind its `appGrant`. Every call resolves the account from the caller's remote, never the vault on screen. Reads and writes go through the account's data layer, which is never stale: mail is the cache brought current by a delta, the agenda is always fetched. The agent's `read` is prose only (`textOnly`), a separate entry from the reader's `thread`, so unsanitised HTML reaches only the renderer. `send` takes a composed message with its body on stdin, or `--draft <id>`, which reads no stdin. Google's error kinds cross as refusal codes (`UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `NOT_FOUND`), so the UI picks Reconnect or Retry by code.

## Rules

- **Mail bodies and event descriptions are hostile markup, handled by three separate layers.** DOMPurify decides what survives. A per-message iframe with `sandbox="allow-same-origin"` and never `allow-scripts` (together they let content lift its own sandbox) decides what document it lives in; nothing inside runs. The frame's `default-src 'none'` CSP catches fetches the sanitiser cannot see. Sanitised markup never enters the app's document.
- The sanitiser always drops the `<form>` family (phishing), `<base>` (retargets URLs) and `<link>`/`<meta>` (could redeclare the frame CSP).
- `<style>` stays a forbidden tag, since admitting it changes DOMPurify's parse and frees `<svg><style><img onerror>`. The sheet is lifted out as text, stripped of `@import`, of remote `url()` while images are blocked, and of `</`, then written into a `<style>` the app builds.
- Remote content is blocked and counted until allowed once or always per sender. `data:` is never counted. Allowing it builds a new frame, because a `<meta>` CSP cannot be loosened by rewriting.
- Links never navigate in the frame; only `https:`, `http:`, `mailto:` reach `openExternal`.
- The renderer's own CSP (no `script-src`, no `frame-src`) is not an XSS defence and must not be described as one.
- **The agent may do what the user can undo.** Permanent delete is impossible by scope. Calendar writes refuse attendee events inside the functions main hands over, since they email people. `holi google send|reply` always ask via a seeded `PreToolUse` hook: its `ask` beats allow rules and "don't ask again", it matches all `Bash` plus `mcp__.*[Gg]mail.*` because an `if` on one spelling fails open, it matches the bare `holi`, `$HOLI_BIN` and an absolute path with any word quoted, and it fails closed. The bridge refuses any word before the verb, so nothing can be slipped between `holi` and `google send`. It gates a cooperative agent, not an adversarial one ([agent-config](agent-config.md)).
- Never write "the agent cannot send": `gmail.modify` permits it; the gate is the wall. Do not widen past `gmail.modify`.
- A send with unknown outcome is never retried. UI send is not gated.
- Mail data stays in `userData`, per account, never in a vault.
- Treat a new Google call as broken until it has run against a real account; fakes written from docs have passed on broken code, and Gmail answers some bad requests with an empty 200.

## Rejected

- Google's device flow: not approved for these scopes.
- An MCP server: a lifecycle and handshake to deliver JSON a command already returns.
- A Google loopback server and `holi-google` script of its own: the core bridge already authenticates per vault and supplies the remote.
- Plain-text mail: a mail reader must render mail.
- Encrypting the cache: needs a native module and forecloses FTS5.
- Per-vault cache or wipe-on-switch: mail is account data, and wiping refetches on every switch.
- Calendar `syncToken`: incompatible with `timeMin`/`timeMax`.
- Parsing join links from the `.ics`: a second, drifting source of truth.
- `labels.get` for tab counts: counts archived mail.
- A refcounted single disconnect: one button with hidden meanings.
- Rich-text composing or a local draft store: a second model, a second home.
- Withholding `send`, or `permissions.ask` alone for it.

## Code

- The `google` plugin, on by default (nothing shows until an account is connected on this machine): `apps/desktop/src/plugins/google/`.
- `main/`: `index.ts` (activation: the accounts manager, each account's cache, the capabilities), auth (`loopback-flow`, `pkce`, `credentials`, `session`, `accounts`, `vault-accounts`, `token-store`, `electron`, loaded only at activation), data (`gmail`, `mail-sync`, `cache`, `data`, `calendar`, `invite`, `people`, `mime`), `capabilities` (every door) and `seed.ts` with `vault/shipped/.claude/hooks/google-send-gate.mjs` and `skills/gmail-calendar/`, plus the gate's hook entries and ask rules.
- `renderer/`: the `mail` and `agenda` surfaces and their nav items (shown once an account is connected, `account.ts`, whose atoms follow the open vault and a refresh nonce), the Connections settings section, the compose dialog (opened as the plugin dialog), `mail-html.ts` and `mail-frame.ts`. Making a task from a thread or event types only the `tasks.create` slice it calls (`tasks.ts`) and shows only while `useHasCapability('tasks.create')`; Summarize hands the agent a prompt through the agent service (`useAgentService`), and shows only while there is one.
