# Reminder delivery — the missing leg, made durable

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** a reminder you set actually reaches you — as a native notification — including one that fired while the app was closed. At the end of this slice `tasks.md`'s headline user story ("the server fires a native notification the day before at 09:00, **even if my app was closed at the moment**") is true for the first time.

**The state of play:** the server side is *finished and excellent* — a sleep-until-earliest evaluator with coalescing, a missed-pass on boot, timezone anchoring, `remindedAt` re-arming, a `reminders` SSE frame. And it terminates in nothing: `vault-manager.ts`'s SSE handler covers `docs`/`tasks`/`presence`, and `reminders` falls off the end of the if/else. There is no `Notification` anywhere in `apps/desktop`. The subsystem is 95% built and 0% delivered.

**The trap this slice exists to fix:** `tick()` sets `fired: true` **and then** emits. The emit is a bare `EventEmitter` — with no SSE listener it is a no-op, and the flag is already persisted. `listPending` only returns `fired: false`. So **a fire with nobody listening is lost forever**, and no amount of client work recovers it. Adding the notification alone would deliver reminders only while the app is open on that vault — precisely when you least need one.

**Spec:** `prd/tasks.md` §Recurrence & reminders (owning doc) · SSE transport: `prd/server-data.md`.

---

## Decisions

| # | Decision |
|---|---|
| **D47** | **Reminder delivery is tracked per `(vault, user)` on the server, and `reminders.fired` becomes `fired_at`.** A fire is durable: `fired_at` records *when* it fired, a `reminder_deliveries` watermark records *how far each user has been notified*, and catch-up on connect replays the gap. **Why the column change:** `fired` and a delivery timestamp would be redundant state (`fired` ≡ `fired_at IS NOT NULL`) that can drift — set one, forget the other, and catch-up silently skips a fire. One column, one source of truth; pending ⇔ `fired_at IS NULL`. **Why not `per_user_state`:** it already exists and is per-`(user, vault)` — but `userState.set` is a **client-writable** `vaultProcedure`. A client could set its own watermark to the future and silently disable its own reminders, or to the epoch and flood itself. Delivery state is correctness-critical and server-owned; it does not belong in a bag the client can write. **Duplicates beat loss:** every advance is `max(seen_at, fired_at)` and only ever moves forward, so the worst case (a crash between send and advance) re-notifies one reminder. The failure we are fixing is silent loss. |
| **D48** | **Reminders are delivered for the vault you have open; cross-vault delivery is deferred, not designed out.** Main opens **one** SSE connection, for the active vault, so a fire in vault B while you work in vault A cannot arrive live. Catch-up-on-activate makes it **correct but late** — you get it when you open B, and it is never lost (that is D47's whole point). **Why not fix it here:** live cross-vault firing needs a **user-scoped** event stream replacing the per-vault one — the transport `docs`, `tasks` and `presence` all ride. That is an architectural change with a blast radius across every real-time feature, and it deserves its own slice rather than being bolted onto a delivery fix. Specced in `prd/tasks.md` §Recurrence & reminders. Agreed with Nicolai 2026-07-16. |

## Contract

**Schema** (`apps/server/src/db/schema.ts` + a generated Drizzle migration):
- `reminders.fired boolean` → **`reminders.firedAt timestamptz` (nullable)**. Pending ⇔ `fired_at IS NULL`. The partial index becomes `reminders_pending_idx on (fire_at) where fired_at is null`.
- **New `reminder_deliveries`**: `{ vaultId, userId, seenAt timestamptz not null }`, PK `(vaultId, userId)`, both FKs `on delete cascade`. Written **only** by the server (no router exposes a setter — that is the point).

**Server:**
- `reminders/evaluator.ts` `tick(now)`: `set({ firedAt: now })` (was `{ fired: true }`); the two remaining `fired = false` predicates become `isNull(firedAt)`.
- `reminders/projection.ts` `recomputeReminder`: the upsert's `set` clears the fire — `{ fireAt, firedAt: null, computedFrom }`. **Load-bearing:** re-arming must drop the old fire, or catch-up would replay a fire the task has since moved past. A superseded fire is *meant* to be dropped: the task changed, the fire is moot.
- **`RemindersEvent` gains `firedAt: string` (ISO UTC)** — the tick's instant, shared by every fire in the batch. `fires[].fireAt` is the *scheduled local* time and is the wrong clock for a watermark; don't reuse it.
- `events.ts` `onReminders`: after `send`, advance that `(vaultId, user.id)` watermark to `event.firedAt`. The SSE handler already has `user` in scope. This is what stops a live-delivered fire being replayed by the next catch-up.
- **New `reminders.catchUp`** (`vaultProcedure.mutation`) → `RemindersEvent | null`. Fires where `vaultId = ctx.vaultId AND fired_at > seen_at`, joined to `tasks` for the title, ordered by `fired_at`. Advance `seen_at` to `max(fired_at)` of exactly what it returned — **not** `now()`, or a fire landing between the query and the update is skipped. **First-ever connect** (no row): insert `seen_at = now()` and return `null` — a new member gets no backlog of historical fires.

**Desktop (main owns this — `Notification` is a main-process API, and main owns the SSE):**
- New `main/reminders/notifier.ts`: `raise(event: RemindersEvent)`.
  - `coalesced` (the evaluator sets it above 5 fires): **one** summary notification — "N reminders" + the first few titles. Otherwise one per fire: title = task title, body = the local `fireAt`.
  - Click → focus the window, push `reminders:open` `{ taskId }`. A notification you cannot act on is half a feature.
- `vault-manager.ts`: route the frame — `else if (channel === 'reminders') notifier.raise(data as RemindersEvent)`. Then call catch-up **after `events.start()`**, and again from the existing **`onReconnect`** hook (a stream gap means missed events — the same self-healing the mirror and projector already do there; join it, don't invent a second mechanism).
- `preload/index.ts`: `reminders.onOpen(cb)` via the existing `pushChannel` helper.
- Renderer: on `reminders:open`, set `viewAtom` to `board` and `selectedTaskIdAtom` to the task.

## Tasks

- [x] **1** Schema + migration: `fired` → `fired_at`, new `reminder_deliveries`. Update the 6 `fired` call sites (`evaluator.ts` ×3, `projection.ts`, `routers/reminders.ts`, the index) and `evaluator.test.ts`. Green before moving on — this is a pure refactor and must stay one.
- [x] **2** `reminders.catchUp` + the `events.ts` live-advance + `RemindersEvent.firedAt`. TDD, `daily.test.ts`/`evaluator.test.ts` are the templates. Test: a fire with no listener is returned by the next catch-up; a **live-delivered** fire is **not** returned again; catch-up is idempotent (second call returns nothing); a first-ever connect gets no backlog; a **re-armed** reminder drops its stale fire.
- [x] **3** Desktop: `notifier.ts` + the `vault-manager` routing + catch-up on start/reconnect + the preload channel + the renderer's open handler.
- [x] **4** `pnpm -r test` + `pnpm -r typecheck` + desktop build. Then the **real app**: set a reminder ~1 min out, watch the notification fire; click it and land on the task. Then **close the app**, let one fire, reopen → the missed notification arrives. That last one is the whole slice.
- [x] **5** `prd/tasks.md`: record delivery durability + the cross-vault gap (D48) as prose. Record D47/D48 in `docs/decisions.md` (next free is D47 → after this, **D49**). **Never `git add` anything under `docs/`.**

## Gotchas

- **Connect the SSE *before* catching up.** The other order loses a fire landing in the gap; this order can at worst duplicate one (and the live-advance means it usually won't). Duplicates beat loss.
- **`fires[].fireAt` is a local wall-clock string** (`utcToLocal`), not an instant — it is for display. The watermark runs on `firedAt` (UTC). Mixing them silently breaks delivery for anyone not in `config.timezone`.
- **The evaluator's "missed pass on boot" is about the *server* being down**, not the client. It re-fires reminders never marked fired. It is not the mechanism this slice adds and does not overlap with it.
- **Don't add a client-side scheduler.** The PRD is explicit: no client fire loop, no client missed-pass. The client raises what the server tells it to, and `catchUp` is a server query, not client bookkeeping.
- **`Notification.isSupported()`** — guard it; a headless/CI or unsupported desktop must not throw into the SSE handler and take the stream down with it.
- **Reminders are per *vault*, not per assignee** — `Task` has no assignee field, so a fire concerns every member. Per-user watermarks are therefore per-member delivery of the *same* fire, which is why the watermark is keyed `(vault, user)` and not stored on the reminder.
