# Reminder Runtime Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reminders fire — a tray-resident local evaluator that, on a timer and at launch, sweeps all vaults' tasks, raises native notifications for pending reminders, and never re-fires or produces a commit.

**Architecture:** A pure `sweep(vaultTasks, now, delivered) → { event, marks }` core (the whole fire decision) behind a `createReminderRuntime(deps)` factory that injects four seams — Clock, TaskCorpus, Notifier, DeliveredLog — mirroring the house `createRouter`/`createVaultHost` pattern. Electron (`Notification`, `Tray`, login item) lives in thin adapters at the edges. Full design: [`../specs/2026-07-28-reminder-runtime-design.md`](../specs/2026-07-28-reminder-runtime-design.md).

**Tech Stack:** Electron main, TypeScript, Vitest, `@holi/shared` (`pendingFireTime`), `registry.list()` + `scanVault`.

---

## Conventions & gotchas (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. Desktop commands from `apps/desktop/`.
- **Bash cwd drifts between calls** — use an absolute `cd` in *every* command.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline **6** (pre-existing `state/history.ts` — leave them). Anything above 6 is a regression.
- **Test baselines:** desktop **650** (`cd apps/desktop && pnpm exec vitest run`; backgrounded, exceeds 120s), shared **187** (`cd packages/shared && pnpm exec vitest run`). New tests add to these.
- **Electron surfaces are not unit-tested** (Notification/Tray/login/keep-alive) — matches how the codebase treats Electron shells; verify live over CDP + manually. These are **main-process** changes → **need a relaunch** to live-verify (not hot-reload; ask Nicolai or run via `! <cmd>`).
- **`toEqual` regression watch:** `reminder-notifications.test.ts` asserts on the event/spec shape — Task 1 changes it, so that test moves *with* the type in Task 1.
- **`closed`-flag teardown:** every timer callback must guard on a `closed` flag so a late tick can't fire into a torn-down runtime (the `active-vault.ts` pattern).

## File structure

- `apps/desktop/src/main/reminders/types.ts` — **replace** server-mirror with path-keyed local event.
- `apps/desktop/src/main/reminders/notifications.ts` — **modify** (re-key click target to `remote`+`path`).
- `apps/desktop/src/main/reminders/sweep.ts` — **new**, pure core.
- `apps/desktop/src/main/reminders/delivered-log.ts` — **new**, watermark store.
- `apps/desktop/src/main/reminders/runtime.ts` — **new**, `createReminderRuntime(deps)` factory + seam interfaces.
- `apps/desktop/src/main/reminders/notify.ts` — **new**, Electron `Notification` adapter.
- `apps/desktop/src/main/tray.ts` — **new**, tray + menu.
- `apps/desktop/src/main/index.ts` — **modify** (real adapters, wiring, `focusTask`, keep-alive, login prompt).
- `apps/desktop/src/preload/index.ts` + renderer `state/view.ts` subscription — **modify** (`reminders:open`).
- Tests: `apps/desktop/test/reminder-{notifications,sweep,delivered-log,runtime}.test.ts`.

---

### Task 1: Path-keyed local event type (retire the server mirror)

**Files:**
- Modify: `apps/desktop/src/main/reminders/types.ts`, `apps/desktop/src/main/reminders/notifications.ts`
- Test: `apps/desktop/test/reminder-notifications.test.ts`

**Contract** — replace the whole of `types.ts` (which cites `apps/server/src/bus.ts`) with locally-produced shapes:
```ts
export interface ReminderFire { remote: string; path: string; title: string; fireAt: string }
export interface RemindersEvent { fires: ReminderFire[]; coalesced: boolean; firedAt: string }
```
In `notifications.ts`: `NotificationSpec` drops `taskId`, gains `task?: { remote: string; path: string }` (absent on a coalesced summary — a summary speaks for several). `notificationsFor` sets `task: { remote: f.remote, path: f.path }` on the per-fire branch.

- [ ] **Step 1: Update the failing test** — in `reminder-notifications.test.ts`, change the `event()` factory's fires from `{ taskId: 'tN' }` to `{ remote: 'o/r', path: 'task.tN.md', title: 'task N', fireAt: ... }`, and change the two assertions from `.taskId` to `.task` (single fire → `{ remote:'o/r', path:'task.t1.md' }`; coalesced → `.task` is `undefined`). Keep the title/coalesce/empty assertions.

- [ ] **Step 2: Run → FAIL** — `cd apps/desktop && pnpm exec vitest run test/reminder-notifications.test.ts` (type error / `.task` undefined).

- [ ] **Step 3: Implement** the `types.ts` replacement + `notifications.ts` re-key.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/reminders/types.ts apps/desktop/src/main/reminders/notifications.ts apps/desktop/test/reminder-notifications.test.ts
git commit -m "refactor(reminders): path-keyed local event, retire server-mirror type"
```

---

### Task 2: `sweep` — the pure fire decision

**Files:**
- Create: `apps/desktop/src/main/reminders/sweep.ts`
- Test: `apps/desktop/test/reminder-sweep.test.ts`

**Contract:**
```ts
export interface VaultTasks { remote: string; tasks: Task[] }
export type Delivered = Record<string, string>            // taskPath → lastFiredISO
export const COALESCE_THRESHOLD = 3
export function sweep(
  vaults: VaultTasks[],
  now: string,                                            // ISO instant
  delivered: (remote: string) => Delivered,
): { event: RemindersEvent | null; marks: { remote: string; path: string; fireAt: string }[] }
```
Logic: for each vault, `read = delivered(remote)`; for each task, `fire = pendingFireTime(task.status, task.reminder, task.due, read[task.path])`; if `fire !== null` **and** `fire <= now` (string compare is safe — both local `YYYY-MM-DDTHH:MM`; `now` must be passed as the **local** wall-clock string to match, see gotcha) → push a `ReminderFire { remote, path: task.path, title: task.title, fireAt: fire }` and a mark. `event` is `null` when no fires; else `{ fires, coalesced: fires.length > COALESCE_THRESHOLD, firedAt: now }`.

> **Gotcha — the clock frame.** `pendingFireTime` returns a **local** `YYYY-MM-DDTHH:MM` (no zone). Compare it against a local wall-clock string, not a UTC ISO instant. The Clock seam therefore yields **local** time (reuse `localToday`'s frame — a `localNow()` helper returning `YYYY-MM-DDTHH:MM`). Do **not** compare against `new Date().toISOString()` (UTC) — off-by-timezone fires. Put `localNow()` next to `sweep` or in `dates.ts`.

- [ ] **Step 1: Write failing tests** (`reminder-sweep.test.ts`) — a `task()` factory (path/status/due/reminder). Cases, each asserting on `sweep(...).event`/`.marks`:
  - **fires when due**: task due tomorrow, `reminder: '1d'` (fire = today 09:00), `now` = today 10:00, empty delivered → one fire, `fireAt` = today 09:00, one mark.
  - **not yet**: same task, `now` = today 08:00 (before fire) → `event` null.
  - **respects watermark**: same, `now` = today 10:00, `delivered` returns `{ [path]: today 09:00 }` → null (already delivered).
  - **catch-up**: fire time was 3 days ago, undelivered, `now` today → fires (past-due selected).
  - **inert**: `reminder` undefined, or relative with no `due`, or `status: 'done'` → no fire.
  - **coalesce**: 4 tasks all firing → `event.coalesced === true`; 3 → `false`.
  - **multi-vault**: two `VaultTasks` each with a firing task → 2 fires, correct `remote` on each.

- [ ] **Step 2: Run → FAIL** — `pnpm exec vitest run test/reminder-sweep.test.ts` (sweep not defined).

- [ ] **Step 3: Implement** `sweep.ts` + `localNow()` per the contract.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/reminders/sweep.ts apps/desktop/test/reminder-sweep.test.ts
git commit -m "feat(reminders): sweep — the pure fire decision across all vaults"
```

---

### Task 3: `DeliveredLog` — the delivery watermark store

**Files:**
- Create: `apps/desktop/src/main/reminders/delivered-log.ts`
- Test: `apps/desktop/test/reminder-delivered-log.test.ts`

**Contract:**
```ts
export interface DeliveredLog {
  read(remote: string): Delivered
  markDelivered(remote: string, path: string, fireAt: string): void
}
export function createDeliveredLog(rootFor: (remote: string) => string | null): DeliveredLog
```
`rootFor(remote)` resolves the vault's on-disk clone path (the runtime passes a `registry`-backed resolver). State lives in `<root>/.holi/settings.local.json` under a top-level `reminders` key: `{ reminders: { [path]: fireAt } }` — siblings (e.g. a future login-item key) are preserved on write. **Atomic write** (write tmp + `rename`, mirroring `VaultRegistry`). `read` returns `{}` for a missing/omitted file or a `null` root. In-memory cache is fine but re-reading the small file per tick is also acceptable (glob-and-parse scale).

- [ ] **Step 1: Write failing tests** (`reminder-delivered-log.test.ts`) — use `mkdtemp` for a fake vault root; a `rootFor` returning it. Cases:
  - `read` on a fresh root → `{}`.
  - `markDelivered` then `read` → `{ [path]: fireAt }`.
  - `markDelivered` twice (two paths) → both present; the on-disk JSON has them under `reminders`.
  - a pre-existing `.holi/settings.local.json` with an unrelated key survives a `markDelivered` (sibling preserved).
  - `read` for a remote whose `rootFor` returns `null` → `{}`.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `delivered-log.ts` (reuse `writeAtomic`/`mkdir` helpers from `vault/vault-files.ts` if they fit; else a small tmp+rename).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/reminders/delivered-log.ts apps/desktop/test/reminder-delivered-log.test.ts
git commit -m "feat(reminders): DeliveredLog — machine-local, gitignored delivery watermark"
```

---

### Task 4: `createReminderRuntime` — the injected-seam shell

**Files:**
- Create: `apps/desktop/src/main/reminders/runtime.ts`
- Test: `apps/desktop/test/reminder-runtime.test.ts`

**Contract:**
```ts
export interface ReminderRuntime { start(): void; close(): void }
export interface ReminderRuntimeDeps {
  now?: () => string                                       // Clock, defaults to localNow()
  corpus: { all(): Promise<VaultTasks[]> }                 // TaskCorpus
  notifier: { fire(event: RemindersEvent): void }          // Notifier
  delivered: DeliveredLog
  tickMs?: number                                          // default 60_000
}
export function createReminderRuntime(deps: ReminderRuntimeDeps): ReminderRuntime
```
`start()`: run one `tick()` immediately (catch-up), then `setInterval(tick, tickMs)`. `tick()` (async): `vaults = await corpus.all()`; `{ event, marks } = sweep(vaults, now(), delivered.read)`; if `event` → `notifier.fire(event)` and `for (const m of marks) delivered.markDelivered(m.remote, m.path, m.fireAt)`. `close()`: set `closed = true`, `clearInterval`. Every `tick` guards `if (closed) return` at its async re-entry (a `corpus.all()` may resolve after `close`).

- [ ] **Step 1: Write failing tests** (`reminder-runtime.test.ts`) — in-memory adapters: `corpus.all` returns a fixed `VaultTasks[]` with one firing task; `notifier.fire` pushes to an array; `delivered` is a `Map`-backed `DeliveredLog`; `now` fixed to a time after the fire; `tickMs` large. Cases:
  - `start()` then `await` a microtask → `notifier` recorded one event with the fire; `delivered` was marked.
  - a **second** manual `tick` (or a second `start` cycle) with the same `now` → `notifier` sees nothing new (watermark holds).
  - `close()` before an in-flight `corpus.all()` resolves → no `notifier.fire` (closed guard). *(Model with a `corpus.all` that resolves on a deferred promise; call `close()` before resolving.)*

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `runtime.ts`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/reminders/runtime.ts apps/desktop/test/reminder-runtime.test.ts
git commit -m "feat(reminders): createReminderRuntime — sweep behind injected seams"
```

---

### Task 5: Real adapters + wire into `index.ts` → reminders fire natively (tracer slice)

**Files:**
- Create: `apps/desktop/src/main/reminders/notify.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Contracts:**
- `notify.ts`: `export function createNotifier(onClick: (remote: string, path: string) => void): { fire(event: RemindersEvent): void }` — `notificationsFor(event)` → for each spec `const n = new Notification({ title, body }); if (spec.task) n.on('click', () => onClick(spec.task.remote, spec.task.path)); n.show()`.
- `index.ts` (`whenReady`, after `registry`/`host` exist): build the three real adapters and start the runtime:
  - `corpus.all` = `(await registry.list())` mapped to `{ remote: e.remote, tasks: (await scanVault(e.path).catch(() => null))?.tasks ?? [] }` — **a vault whose `scanVault` throws is skipped, never stalls the tick** (filter the nulls).
  - `delivered` = `createDeliveredLog((remote) => registry.list-derived path)` — reuse the router's `rootFor`-style resolution (registry entry `.path` by `remote`).
  - `notifier` = `createNotifier((remote, path) => focusTask(remote, path))` — `focusTask` is a stub for now (Task 6 fills it): `const focusTask = (remote: string, path: string) => {}`.
  - `const reminders = createReminderRuntime({ corpus, notifier, delivered }); reminders.start()`.
- `before-quit` block: add `reminders.close()` alongside the existing teardown.

- [ ] **Step 1: Implement** `notify.ts` + the `index.ts` wiring above (with the stub `focusTask`).

- [ ] **Step 2: Typecheck** — `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → **6**.

- [ ] **Step 3: Full suites green**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/packages/shared && pnpm exec vitest run
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop && pnpm exec vitest run   # backgrounded
```
Expected: shared 187+, desktop 650 + new (Tasks 1–4) passing, 0 failing.

- [ ] **Step 4: Live check (relaunch; with Nicolai).** Build + relaunch (`electron-vite build` then relaunch). Create a task with `due` today and `reminder` resolving to a moment just passed (e.g. `reminder: <a minute ago as YYYY-MM-DDTHH:MM>`); within ~60s (or immediately on next launch) a **native notification** appears. Confirm re-launching does **not** re-fire it (watermark), and that `git status` in the vault shows **no** change (`.holi/settings.local.json` is gitignored).

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/reminders/notify.ts apps/desktop/src/main/index.ts
git commit -m "feat(reminders): wire the runtime in main — reminders fire natively"
```

---

### Task 6: Notification click → open the task (`focusTask` + `reminders:open`)

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (implement `focusTask`), `apps/desktop/src/preload/index.ts`, renderer `state/view.ts` subscription (wherever `vault:snapshot` is subscribed — `state/vaults.ts` `subscribeToVault`).

**Contract:**
- `index.ts` `focusTask(remote, path)`: if `remote !== activeRemote`, switch the active vault (the same path a vault-switch takes); then `mainWindow?.show()` / focus, and `send('reminders:open', path)`.
- `preload/index.ts`: `const onReminderOpen = pushChannel<string>('reminders:open')`, exposed on `window.holi`.
- Renderer: subscribe `window.holi.onReminderOpen((path) => set(openTaskAtom, path))` where the other push subscriptions live.

- [ ] **Step 1: Implement** the three edits. (No unit test — Electron nav; verified live.)

- [ ] **Step 2: Typecheck → 6.**

- [ ] **Step 3: Live check (relaunch).** Fire a reminder (as Task 5), **click** the notification → the app focuses and the task opens (board detail / task-file editor), switching vault first if the task lives in another one.

- [ ] **Step 4: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer
git commit -m "feat(reminders): notification click opens the task (focusTask + reminders:open)"
```

---

### Task 7: Tray + keep-alive (tray-resident)

**Files:**
- Create: `apps/desktop/src/main/tray.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Contract:**
- `tray.ts`: `export function createTray(deps: { openWindow(): void }): Tray` — a `Tray` (app icon) with a menu: **Open Holi** → `deps.openWindow()` (create-or-focus, the `activate` path), **Quit** → `app.quit()`.
- `index.ts`: create the tray in `whenReady`; change `window-all-closed` to **not** quit on any platform (delete the `if (process.platform !== 'darwin') app.quit()` — the app stays resident so the reminder timer keeps running). A real Quit is the tray menu (or ⌘Q → `before-quit`).

- [ ] **Step 1: Implement** `tray.ts` + the `window-all-closed` change + tray creation.

- [ ] **Step 2: Typecheck → 6.**

- [ ] **Step 3: Live check (relaunch).** Close the window → the app stays in the tray (does not quit); a reminder still fires with the window closed; **Open Holi** from the tray reopens it; **Quit** exits.

- [ ] **Step 4: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/tray.ts apps/desktop/src/main/index.ts
git commit -m "feat(reminders): tray + keep-alive — reminders fire while the window is closed"
```

---

### Task 8: First-run launch-at-login prompt

**Files:**
- Modify: `apps/desktop/src/main/index.ts` (+ a small machine-local flag store — reuse `DeliveredLog`'s file or the `userData` app-settings file; keep it out of any vault-synced path).

**Contract:** On the first `whenReady` where the "asked about login" flag is unset, show a one-time prompt (Electron `dialog.showMessageBox` with "Launch Holi at login so reminders fire?" / Enable / Not now). Record the flag machine-locally and call `setLoginItemSettings({ openAtLogin: <answer> })`. Never re-ask (flag set regardless of answer); the choice stays changeable later (a settings toggle is out of scope for this task — note it).

- [ ] **Step 1: Implement** the first-run prompt + flag persistence + `setLoginItemSettings`.

- [ ] **Step 2: Typecheck → 6.**

- [ ] **Step 3: Live check (relaunch).** First relaunch after this ships → the prompt appears once; choosing Enable registers the login item (`app.getLoginItemSettings().openAtLogin === true`); a second relaunch does **not** re-prompt.

- [ ] **Step 4: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/index.ts
git commit -m "feat(reminders): first-run launch-at-login prompt"
```

---

## Self-review (coverage vs. the spec)

- **All-vaults scope** → Task 5 `corpus.all` maps `registry.list()`. ✓
- **60s tick + launch catch-up** → Task 4 `start()` (immediate + interval); Task 2 catch-up test. ✓
- **`>3` coalesce** → Task 2 `COALESCE_THRESHOLD`; Task 1 event carries `coalesced`. ✓
- **Per-task path-keyed watermark, machine-local, no commit** → Task 3 `DeliveredLog`; Task 5 live check asserts clean `git status`. ✓
- **Native notifications** → Task 5 `notify.ts`. ✓
- **Click → open task (path identity)** → Task 1 (path-keyed) + Task 6 (`focusTask`/`reminders:open`/`openTaskAtom`). ✓
- **Tray keep-alive** → Task 7. ✓
- **First-run login prompt** → Task 8. ✓
- **Pure `sweep` behind injected seams** → Tasks 2 + 4. ✓
- **Inert reminders / broken tasks / stale vault** → Task 2 inert tests; broken never in `snapshot.tasks`; Task 5 skips a throwing vault. ✓
- **Not in scope (correctly):** a settings toggle for launch-at-login (Task 8 notes it deferred); an app-icon asset for the tray uses the existing window icon.
