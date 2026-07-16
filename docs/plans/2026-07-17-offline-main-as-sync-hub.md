# Offline: main as the machine's Yjs sync hub — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plan style is lean by project rule** (memory `holi-plan-style`, Nicolai 2026-07-13): contracts, decisions, wire shapes, test intent and gotchas — **not** full inline implementations. You are expected to derive the code. Exact strings appear only where the string *is* the decision.

**Goal:** An edit made offline survives quit and auto-merges on reconnect — the one gap in the system that destroys user work.

**Architecture:** The renderer stops connecting to the Syv relay and binds its `Y.Doc` to **main** over the preload bridge. Main already holds a `Y.Doc` + `HocuspocusProvider` for *every* doc in the active vault (`vault-mirror.ts:238`), so it becomes the machine's single sync hub: the renderer is just another writer into main's doc, `DocBridge` materializes it to disk, and main's provider carries it upstream. Main persists every doc's Yjs state locally so the hub survives a quit, and vault activation stops requiring the network.

**Tech Stack:** Electron (main/preload/renderer), Yjs, `@hocuspocus/provider` v2, `y-protocols/awareness`, `y-codemirror.next`, jotai, Vitest 4.

**Decision:** D59 — *the renderer does not speak to the relay; main is the sole upstream connection.* Allocate in `docs/decisions.md` (header says next free is D59 — **re-check before allocating**, D58 landed 2026-07-17).

---

## Why this shape (do not re-litigate)

- Nicolai chose this over `y-indexeddb`-in-the-renderer on 2026-07-17. The renderer holds a `Y.Doc` for the **open doc only**, so renderer-side persistence leaves edits to closed docs unreplayed until reopened, and leaves main's working copy stale. Main already holds *all* docs — persistence there replays the whole vault with no sweep.
- `architecture.md:70` framed this as "`y-indexeddb` in the renderer **or** leveldb-backed in main". That fork is now answered; `vaults-collaboration.md:219` carries the same open question and must be closed too.
- **leveldb-in-main *alone* was rejected and is not what this plan builds.** Main's offline view is the last-synced state — the renderer's offline edit never reaches it. Persisting main without the IPC binding faithfully persists the wrong thing. The binding is the plan; persistence is half of it.

## The four facts that shape the slices

1. **`await synced` (`vault-mirror.ts:260`) is the hard offline blocker.** It resolves only from the relay's `onSynced`. Offline, no entry reaches `started: true`, no bridge starts, **nothing materializes** — `bridgeForPath` returns null, `endOpenTurns` and `reconcileFromDisk` skip it.
2. **`refresh()` calls `api.listDocs()` over HTTP (`vault-mirror.ts:173`)**, so `mirror.start()` *throws* offline and `activate()` fails outright (`vault-manager.ts:199`). The doc list needs a local cache.
3. **Main is deaf to the relay.** Only `onSynced` is wired on each provider — no `onStatus`/`onDisconnect` anywhere in main. The renderer holds the only `SyncStatus` wiring (`collab/provider.ts:28-32`), and this plan deletes it. Status has to be re-sourced from main or the indicator starts lying (again).
4. **`BaseStore` is not a sync store.** It persists `{text, stateB64}` per doc (`base-store.ts`) but exists for *merge-base crash recovery*, is deleted on `closeEntry` (`vault-mirror.ts:277`), and its `state` is **never applied back into a Y.Doc**. Do not repurpose it; do model the new store on its tmp+rename discipline.

**"Main becomes a single point of failure" — considered and dismissed, don't spend time on it.** It was raised when scoping this. Main *is* the Electron app: if it dies, the renderer window dies with it, so routing the editor through main adds no failure mode that wasn't already fatal. The real availability risk this plan introduces is narrower and worth watching instead: a doc whose entry never opened (unsafe path, `vault-mirror.ts:229-234`) previously still opened in the editor via the renderer's own provider, and after slice 1 it will not — `holi:collab:open` must reject such a docId loudly rather than hand back an empty doc the user can type into.

## File structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/main/vault/doc-store.ts` **(create)** | Yjs state persistence per doc: `load(docId) → Uint8Array \| null`, `save(docId, state)`, `remove(docId)`. Mirrors `base-store.ts` conventions (one file per doc, tmp+rename, `null` on any failure). |
| `apps/desktop/src/main/vault/collab-hub.ts` **(create)** | The hub: renderer↔main doc-update and awareness proxying for one docId. Owns origin tags and echo suppression. No IPC, no fs — takes a `Y.Doc`, an `Awareness` and a send callback. |
| `apps/desktop/src/main/vault/vault-mirror.ts` | Gains: persistence load/save on each entry, an offline-tolerant `openEntry`, relay status observation, and a `hubFor(docId)` accessor. |
| `apps/desktop/src/main/vault/vault-manager.ts` | Doc-list cache; activation must not require the network. |
| `apps/desktop/src/main/ipc.ts` | New `holi:collab:*` handlers. `holi:collab:auth` becomes dead surface — delete it. |
| `apps/desktop/src/preload/index.ts` + `renderer/src/global.d.ts` | New `window.holi.collab.*` surface. **First binary channel in the app.** |
| `apps/desktop/src/renderer/src/collab/provider.ts` | `openDoc` binds to main instead of constructing a `HocuspocusProvider`. `agentEditingIn` and `presenceColor` stay as-is. |
| `apps/desktop/src/renderer/src/components/EditorPane.tsx` | Consumes the new `DocSession`; `yCollab` wiring is unchanged if the session hands back a real `Awareness`. |

---

## Slice 1 — The IPC binding (hardest risk first, zero user-visible change)

**Intent:** the renderer stops touching the relay and everything still behaves *exactly* as before — co-editing, remote cursors, the "Claude is editing…" marker, sync status. No offline win yet. If this slice regresses cursors, stop and fix before slicing on.

### Contracts

**`DocSession` (renderer) keeps its shape** — `{ ydoc, text, provider, destroy() }` — except `provider` is replaced. `EditorPane` needs: `setAwarenessField('user', …)`, and an `Awareness` for `yCollab` and `agentEditingIn`. Give the session `awareness: Awareness` directly and drop `provider`; update the two call sites (`EditorPane.tsx:83`, `:91`, `:124`).

**IPC — request/response** (`ipcMain.handle`, the only renderer→main convention in this app; there is no `ipcMain.on` anywhere):

| Channel | Input | Returns |
|---|---|---|
| `holi:collab:open` | `{ docId }` | `{ state: Uint8Array, status: SyncStatus }` — main's current doc state as a full update, plus current relay status. Rejects if the docId is not in the active vault's mirror. |
| `holi:collab:update` | `{ docId, update: Uint8Array }` | `void` |
| `holi:collab:awareness` | `{ docId, update: Uint8Array }` | `void` |
| `holi:collab:close` | `{ docId }` | `void` |

**IPC — main→renderer push** (`pushChannel<T>` in `preload/index.ts:6-15`; channels are global broadcasts with **no correlation id**, so every payload carries `docId` and the renderer filters):

| Channel | Payload |
|---|---|
| `collab:update` | `{ docId, update: Uint8Array }` |
| `collab:awareness` | `{ docId, update: Uint8Array }` |
| `collab:status` | `{ docId, status: SyncStatus }` |

**Origins (echo suppression — get this wrong and you get an infinite loop or a silent drop):**
- `RENDERER_ORIGIN` — a module-level symbol/string in `collab-hub.ts`. Renderer updates enter main's doc as `Y.applyUpdate(doc, update, RENDERER_ORIGIN)`.
- Main→renderer: in `doc.on('update', (update, origin) => …)`, **skip when `origin === RENDERER_ORIGIN`** (it came from there).
- **Do NOT skip `BRIDGE_ORIGIN`.** An agent's file write enters the doc under `BRIDGE_ORIGIN` (`doc-bridge.ts`) and the renderer *must* see it — that is the agent's edit appearing live in the editor.
- Renderer side: apply main's updates with a distinct origin and skip it in the renderer's own `doc.on('update')` handler, or you will echo every keystroke back.

**Awareness proxying** (the fiddliest part — budget for it):
- The renderer builds its **own** `new Awareness(rendererDoc)` from `y-protocols/awareness`. `y-protocols` is currently a **transitive dep only** — add it to `apps/desktop/package.json` explicitly.
- Proxy both ways with `encodeAwarenessUpdate(awareness, changedClients)` / `applyAwarenessUpdate(awareness, update, origin)`.
- Renderer → main: on the renderer awareness's `'update'` event, encode `[...added, ...updated, ...removed]` and ship it. Main applies it into the mirror entry's awareness with an IPC origin.
- Main → renderer: on main's awareness `'update'`, **skip when origin is the IPC origin** (echo), else encode the changed clients and ship.
- clientIDs differ between the renderer's doc and main's doc; that is fine and expected. Awareness updates carry their clientID, so the renderer's client shows up in main's awareness as a remote state and gets rebroadcast upstream by the provider. `agentEditingIn` already skips the local clientID.

### Gotchas (found by reading; each one costs an hour if rediscovered)

- **`y-codemirror.next` reaches through to `awareness.doc.clientID`** (`y-remote-selections.js:130,182`). Any stand-in must expose a real `doc`. Handing it a real `Awareness` bound to the renderer's `Y.Doc` satisfies this — do not hand it a duck-typed object.
- **Remote cursor relative positions must resolve against the *same* `Y.Text` instance the view holds** (`y-remote-selections.js:189-191` rejects `anchor.type !== ytext`). This works through the awareness encoders; it will *not* work if you hand-roll JSON for cursor state.
- **`Uint8Array` over `contextBridge` is the app's first binary channel.** Everything today is JSON (verified: zero `Uint8Array`/`Buffer` hits in preload/renderer/ipc). Structured clone handles typed arrays — but assert it end-to-end early; a silent `{0:1,1:2,…}` object coercion is exactly the kind of bug that eats a session.
- `y-sync.js:11` allocates an extra `Y.UndoManager` unconditionally regardless of the option passed at `EditorPane.tsx:124`. Pre-existing, harmless, do not "fix" it.
- Delete `holi:collab:auth` (`ipc.ts:81-85`), its preload export (`:46`) and its type (`global.d.ts:23`). After this slice `RELAY_URL` is consumed only by `vault-manager.ts:189`. Leaving it is a live token-to-renderer path with no consumer.

### Steps

- [ ] **1.1** Add `y-protocols` to `apps/desktop/package.json`. Create `collab-hub.ts` with no IPC/fs dependency (takes doc, awareness, `send`), so it is unit-testable headlessly.
- [ ] **1.2** Test-first, `apps/desktop/test/collab-hub.test.ts`. **Test intent** (headless, two real `Y.Doc`s + two real `Awareness` wired through a fake `send`): a renderer update reaches main's doc; a main update reaches the renderer; **neither echoes back** (assert the send callback is not re-invoked for a round-tripped update — this is the loop guard and it must be able to fail); a `BRIDGE_ORIGIN` update *does* reach the renderer; awareness round-trips both ways and a remote `agentEditing: true` is visible to `agentEditingIn`.
- [ ] **1.3** Mutation-check 1.2 before moving on (project discipline — `holi-shell-and-tooling-quirks`, and this session's own lesson): break the origin check and confirm a test fails. An echo-suppression test that cannot fail is worse than none.
- [ ] **1.4** Wire `hubFor(docId)` on `VaultMirror` and the four `holi:collab:*` handlers in `ipc.ts`. Add the three push channels to preload + `global.d.ts`.
- [ ] **1.5** Rewrite `renderer/collab/provider.ts` `openDoc` to bind over IPC. Update `EditorPane.tsx` (`:83`, `:91`, `:124`) for the new session shape. Delete `holi:collab:auth` and its surface.
- [ ] **1.6** Re-source `SyncStatus`: wire `onStatus`/`onDisconnect`/`onSynced` on main's per-doc provider (`vault-mirror.ts:238-244`, today only `onSynced`) → push `collab:status`. Map exactly as the renderer did (`collab/provider.ts:28-32`) so the indicator's meaning does not drift.
- [ ] **1.7** `pnpm -r typecheck && pnpm --filter @holi/desktop test`. Commit.
- [ ] **1.8** **Verify live — this slice is a re-architecture of the editing path and tests cannot cover cursors.** Two clients on one doc: co-edit and watch both remote cursors and names render; run an agent turn and watch "Claude is editing…" appear and clear; watch the sync indicator. Recipe in memory `holi-electron-e2e-via-cdp`; probe goes in `apps/desktop/e2e/`, run with `pnpm exec tsx`, **delete after**.

---

## Slice 2 — Persistence + offline-capable activation (the payoff)

**Intent:** quit offline, relaunch offline, edit, reconnect → the edit replays and merges. This is the slice that closes the gap.

### Contracts

**`doc-store.ts`** — model on `base-store.ts` exactly: one file per doc under `join(dataDir(), 'vault-docs', vaultId)`, `{ stateB64 }`, tmp+rename, `null` on any read failure. **Do not** delete it in `closeEntry` the way `bases.remove()` is called (`vault-mirror.ts:277`) — that would defeat the whole point. It is removed only when the *doc* is deleted.

**`openEntry` must not require the relay.** Today: `new Y.Doc()` → provider → `await synced` (`:260`) → `bridge.start()`. New order:
1. `new Y.Doc()`; if `docStore.load(docId)` returns state, `Y.applyUpdate(doc, state)` **before** the provider connects — the doc is usable immediately, offline.
2. Construct the provider (it connects when it can; the shared socket handles reconnect internally).
3. **Do not `await synced` before `bridge.start()`.** Start the bridge off local state. When `onSynced` later fires, the relay's state merges in as ordinary Yjs updates — that is the whole point of a CRDT.
4. Persist on `doc.on('update')`, debounced. Reuse the mirror's existing debounce discipline rather than inventing a third timer.

**Doc-list cache.** `refresh()`'s `api.listDocs()` (`:173`) must not be able to fail activation. Cache the last-known list per vault (same store discipline); on `listDocs` rejection, fall back to the cache and log. **Gotcha:** `refresh()` closes entries not in server truth with `removeFromDisk: true` (`:181-183`) — if a cache miss or an empty offline list ever reaches that path it will **delete the user's working copy**. Guard explicitly: never reconcile-to-absent from a cached or failed list.

**Quit.** `before-quit` does **not** await teardown (`index.ts:99-102`) — the app can exit before `mirror.stop()` finishes. A debounced save will lose the last edit on quit. Either `event.preventDefault()` + flush + `app.quit()`, or a synchronous final flush. **Verify this specifically — it is the exact bug this whole plan exists to fix.**

### Steps

- [ ] **2.1** Create `doc-store.ts`. Test-first (`apps/desktop/test/doc-store.test.ts`): save→load round-trips a real Yjs state; a corrupt/absent file loads as `null`, never throws.
- [ ] **2.2** Wire load-before-connect and debounced save into `openEntry`. Remove the `await synced` gate.
- [ ] **2.3** Doc-list cache + the reconcile-to-absent guard. Test intent: a failed `listDocs` must not close entries or remove files — assert `removeDocFile` is never called on the offline path. Build the degenerate state by hand; do not trust a mock's default.
- [ ] **2.4** Flush-on-quit. Then **verify by actually quitting**: edit offline → quit → relaunch offline → the edit is there.
- [ ] **2.5** `pnpm -r typecheck && pnpm -r test`. Commit.
- [ ] **2.6** **Verify live, offline, end-to-end.** Stop the server (`pkill -f "better-holi-final/apps/server"` — **not** a port-based kill; see memory `holi-shell-and-tooling-quirks`, port kills leak `tsx watch`). Edit → quit → relaunch → confirm the edit survived → restart the server → confirm it replays upstream and reaches a second client. This is the acceptance test for the entire plan.

---

## Slice 3 — The offline-merge snapshot

**Intent:** `prd/vaults-collaboration.md` §Merge safety net promises an auto-labeled snapshot before a long-offline reconcile. Nothing can write one today.

### Contracts

- **Server change required.** `snapshots.take` (`apps/server/src/routers/snapshots.ts:34-49`) hardcodes `reason: 'pre-agent-write'` and accepts **no `reason` input**. Widen its input to accept a `SnapshotReason`, defaulting to today's value so no caller changes behaviour. `pre-offline-merge` already exists in the enum (`yjs/snapshots.ts:11`) with zero writers; `decisions.md:108` calls it "aspirational, not a contract" — this slice makes it a contract, so **update that line**.
- **Trigger:** main takes the snapshot when a doc that has unsynced local state reconnects — i.e. it had local updates while the relay was away. Label: `'before your offline changes merged'` (the PRD's words).
- **Do not** invent overlap detection or the "let Claude reconcile" flow here. Both are specified in the PRD and are separate work. YAGNI.

### Steps

- [ ] **3.1** Server: widen `snapshots.take` input with a `reason`, defaulted. Test-first, `apps/server/test/`. **Positive control required** — this session's lesson: a `rejects.toMatchObject({code:'NOT_FOUND'})` passes against a procedure that does not exist, so assert the valid call *succeeds* too.
- [ ] **3.2** Main: track "has local updates while disconnected" per entry; on reconnect, take the snapshot before the merge lands.
- [ ] **3.3** `pnpm -r typecheck && pnpm -r test`. Commit.

---

## Closing out (per the docs regime — `docs/README.md`)

- [ ] Allocate **D59** in `docs/decisions.md` (re-check the "next free" header first) and bump it.
- [ ] Consolidate into the living docs and **purge the inbox entry**: `architecture.md:70-71` (delete the "NOT BUILT (verified 2026-07-16)" block and the unresolved renderer-vs-main fork — it is answered), `prd/vaults-collaboration.md:93` (§Offline) and **`:219`, which is the open question this plan closes**.
- [ ] **Delete this plan file** once its reasoning is in the living docs. Plans are throwaway; a plan holding something the living docs do not is a docs bug (`docs/README.md`).
- [ ] Commit messages end with `Claude goes brr.. via Dash`.
