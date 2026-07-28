# Reminder Runtime — Design

**What this is.** The runtime shell that makes reminders actually fire. It realises `prd/tasks.md` §Recurrence & reminders and **D60 point 8** ("reminders are evaluated locally by a tray-resident app, with catch-up on launch; the delivered-watermark is machine-local and never committed"). The *math* is already ported and tested (`packages/shared/src/reminder.ts`); this design is only the shell — and how to shape it so it lands **deep** (architecture review, 2026-07-28).

**What already exists (do not rebuild).**
- `packages/shared/src/reminder.ts` — `parseReminder`, `resolveReminder`, `pendingFireTime(status, reminder, due, remindedAtLocal) → fireTime | null`, `shiftForRollover`. Tested. `pendingFireTime` already encodes the whole per-task predicate *including the fire-once watermark comparison*.
- `apps/desktop/src/main/reminders/notifications.ts` — `notificationsFor(event) → NotificationSpec[]`, pure, with coalescing (`SUMMARY_TITLES = 3`).
- `.gitignore` in every vault has `*.local.*`, so `.holi/settings.local.json` is machine-local by construction.

**What is missing:** the evaluator loop, the delivery watermark store, the Electron `Notification`/`Tray`/login-item adapters, keep-alive lifecycle, and a locally-produced event type (the current `reminders/types.ts` mirrors the deleted server bus).

---

## Settled decisions

From brainstorming (2026-07-28) and the architecture review:

1. **Scope: all registered vaults.** The evaluator scans every vault in `registry.list()` each tick — a reminder fires regardless of which vault is open. Glob-and-parse per vault is imperceptible at v1 scale (the PRD's own rejection of an index applies).
2. **Launch-at-login: first-run prompt.** Ask once, explicitly; record the answer machine-locally; call `setLoginItemSettings({ openAtLogin })` accordingly. Never touched silently.
3. **Tick: 60s interval + one immediate run on launch.** Minute granularity suits the 09:00 anchor; the launch run *is* the catch-up (missed fires while quit).
4. **Coalesce threshold: > 3 fires in one tick** → one summary (feeds the existing `coalesced` flag; `notificationsFor` already summarises).
5. **Keep-alive on all platforms.** Closing the window no longer quits — the app stays tray-resident (macOS already behaves this way; Windows/Linux change). A real Quit comes from the tray menu.
6. **Delivery watermark: per-task, path-keyed, machine-local.** `{ [taskPath]: lastFiredISO }` — this is the `remindedAtLocal` `pendingFireTime` consumes. Stored per vault in `.holi/settings.local.json` (gitignored). Behind a seam, so the storage location can switch (see `DeliveredLog`).
7. **Timezone: machine-local**, the frame `resolveReminder`/`localToday` already use. No other frame exists locally.

These are details *under* D60 point 8, not a new decision — no D-number.

---

## Architecture

Mirrors the house pattern the whole `main/` process uses: **a `createX(deps)` factory with injected clocks, timings, and callbacks; Electron behind injected functions so the core loads under vitest** (as `createRouter`/`createVaultHost` do). The pure/IO split is the one `notifications.ts` already names — *"decide here, let the adapter own Electron."*

### The deep core — `sweep` (pure)

**File:** `apps/desktop/src/main/reminders/sweep.ts` (pure — imports only `@holi/shared`, no Electron/FS).

```ts
type VaultTasks = { remote: string; tasks: Task[] }
type Delivered  = Record<string, string>            // taskPath → lastFiredISO, per vault
type ReminderFire = { remote: string; path: string; title: string; fireAt: string }
type RemindersEvent = { fires: ReminderFire[]; coalesced: boolean; firedAt: string }

function sweep(
  vaults: VaultTasks[],
  now: string,                                        // ISO instant (injected clock)
  delivered: (remote: string) => Delivered,           // read the watermark
): { event: RemindersEvent | null; marks: { remote: string; path: string; fireAt: string }[] }
```

`sweep` is the **whole fire decision**: for each vault, each task, call `pendingFireTime(status, reminder, due, delivered(remote)[path])`; a task whose fire time is `≤ now` and past its watermark becomes a `ReminderFire`. Collect across all vaults, set `coalesced` when `fires.length > COALESCE_THRESHOLD` (3), and return the fires plus the `marks` to write back. No IO, no timers — deterministic given `(vaults, now, delivered)`.

**Deletion test:** delete `sweep` and the coalesce logic, per-task selection, and watermark-advance reappear scattered through the timer loop.

### The seams the shell injects

`createReminderRuntime(deps)` (`apps/desktop/src/main/reminders/runtime.ts`) takes four seams — each an interface with a real adapter now and an in-memory adapter in tests (two adapters = real seam):

| Seam | Interface | Real adapter | Test adapter |
|---|---|---|---|
| **Clock** | `now(): string` | `() => new Date().toISOString()` (defaulted, like `createRouter`) | fixed string |
| **TaskCorpus** | `all(): Promise<VaultTasks[]>` | `registry.list()` → `scanVault(entry.path)` per vault | in-memory array |
| **Notifier** | `fire(event: RemindersEvent): void` | `notificationsFor` → Electron `Notification` (see adapter) | records calls |
| **DeliveredLog** | `read(remote): Delivered` / `mark(remote, path, at): void` | `.holi/settings.local.json` atomic write | in-memory map |

The runtime exposes `start()` (arms the 60s interval + runs one sweep immediately) and `close()` (clears the timer, guarded by a `closed` flag — the `active-vault` teardown pattern). `index.ts` calls `close()` in the existing `before-quit` block.

### `DeliveredLog` — the delivery watermark, named

**File:** `apps/desktop/src/main/reminders/delivered-log.ts`.

```ts
read(remote: string): Delivered                       // the whole { path → lastFiredISO } map
markDelivered(remote: string, path: string, fireAt: string): void
```

`read` is what `sweep` indexes per task (one file read per vault per tick, not per task); `markDelivered` advances it. Two verbs over the watermark. The "never re-fire / never commit / per-task last-fired" invariant lives behind this interface, not in the evaluator; the file format and atomic write (tmp + `rename`, mirroring `VaultRegistry`) are hidden. Backed by each vault's `.holi/settings.local.json` under a `reminders` key, leaving room for other machine-local settings (the login-item choice) under sibling keys.

### The notify adapter (Electron)

**File:** `apps/desktop/src/main/reminders/notify.ts`. Feeds the event through `notificationsFor`, shows each `NotificationSpec` via `new Notification(...).show()`. A spec's click (present only when not coalesced) calls **`focusTask(remote, path)`** — not vault-switching + push itself.

### `focusTask(remote, path)` — the click's one crossing

**File:** `apps/desktop/src/main/index.ts` (the only holder of `mainWindow`). Activates the vault if it isn't the open one, then pushes a new **`reminders:open`** channel carrying `path`; the renderer's preload fans it to `openTaskAtom(path)` (`state/view.ts`, the existing path-keyed entry point). One place owns the main→renderer navigation.

*(The event and the notification click both carry `path` — retiring the stale `taskId` from `types.ts`, which mirrored the deleted server bus. One identity vocabulary, file → click → board.)*

### Tray + lifecycle

- **`main/tray.ts`** — a `Tray` with **Open Holi** (create/focus the window via the existing `activate` path) and **Quit** (`app.quit()`).
- **Keep-alive:** `window-all-closed` no longer calls `app.quit()` on any platform.
- **First-run login prompt:** on first launch after this ships, a one-time dialog (or a small in-app prompt) asks about launch-at-login; the answer is stored machine-locally and applied via `setLoginItemSettings`. Re-changeable later from settings.

---

## Data flow

```
every 60s (and once at launch):
  vaults   = TaskCorpus.all()                 // registry → scanVault per vault
  { event, marks } = sweep(vaults, Clock.now(), DeliveredLog.read)   // PURE
  if event:
     Notifier.fire(event)                     // notificationsFor → Electron Notification
     for m of marks: DeliveredLog.mark(m.remote, m.path, m.fireAt)   // never re-fire; never a commit
```

The launch run reads the watermark, so a fire delivered before quitting is not re-shown; a fire whose time passed while quit *is* shown (catch-up).

---

## Edge cases

- **Inert reminders** (no reminder, or relative with no parseable `due`, or a `done` task) → `pendingFireTime` already returns `null`. Nothing special in `sweep`.
- **A fire produces no commit** — the watermark is machine-local and gitignored; that is the whole reason it is not in frontmatter (D60 pt8, same argument as the version token).
- **Shared task** — no assignee, so it notifies whoever's Holi is running. By design.
- **Coalesced batch** — one summary, no click target (it speaks for several); `notificationsFor` already branches on this.
- **Broken task file** — it's in `snapshot.broken`, not `snapshot.tasks`, so `sweep` never sees it; it surfaces on the board, not as a reminder.
- **Vault removed / path missing** — `TaskCorpus.all()` skips a vault whose `scanVault` throws (a stale registry entry must not stall the tick).

---

## Testing

- **`sweep`** — the bulk of the tests: fires-when-due, respects-watermark, coalesce-over-threshold, multi-vault aggregation, inert/done tasks excluded, catch-up (a past-due undelivered fire is selected). Pure — no Electron, FS, or timers.
- **`DeliveredLog`** — round-trip read/mark against a temp file; format stability; ignores a missing file.
- **`createReminderRuntime`** — drive a full tick with the four in-memory adapters; assert `Notifier` saw the event and `DeliveredLog` was stamped; assert a second tick with the same clock fires nothing (watermark holds).
- **Electron surface** (`Notify` realisation, `Tray`, login item, keep-alive, `focusTask` nav) — verified live over CDP + manually; not unit-tested, matching the codebase's treatment of Electron shells.

---

## File structure

- `apps/desktop/src/main/reminders/sweep.ts` — **new**, pure core.
- `apps/desktop/src/main/reminders/delivered-log.ts` — **new**, watermark store.
- `apps/desktop/src/main/reminders/runtime.ts` — **new**, `createReminderRuntime(deps)` factory (start/close, the seams).
- `apps/desktop/src/main/reminders/notify.ts` — **new**, Electron `Notification` adapter.
- `apps/desktop/src/main/reminders/types.ts` — **replace** the server-mirror with the path-keyed local event.
- `apps/desktop/src/main/reminders/notifications.ts` — **reuse** as-is (already pure, already coalesces).
- `apps/desktop/src/main/tray.ts` — **new**, tray + menu.
- `apps/desktop/src/main/index.ts` — **modify**: `focusTask`, `reminders:open` push, keep-alive `window-all-closed`, first-run login prompt, wire `runtime.start()` in `whenReady` / `runtime.close()` in `before-quit`.
- `apps/desktop/src/preload/index.ts` — **modify**: register the `reminders:open` push channel.
- `apps/desktop/src/renderer/.../` — **modify**: subscribe `reminders:open` → `openTaskAtom(path)`.

## Dependencies

- `prd/tasks.md` §Recurrence & reminders (the behaviour), **D60 pt8** (the decision this realises).
- `packages/shared/src/reminder.ts` (the ported math — unchanged).
- `apps/desktop/src/main/vault/registry.ts` + `vault/vault-store.ts` (`registry.list()` + `scanVault`).
- `apps/desktop/src/renderer/.../state/view.ts` (`openTaskAtom`, the click target).
