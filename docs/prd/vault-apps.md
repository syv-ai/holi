# PRD — Vault Apps *(post-v1, designed)*

Just-in-time interactive apps the vault assistant creates on demand: small, reusable tools that live **in the vault**, sync to every member, and open **inside Holi** as first-class tabs. Decision: **D31**. Ships **post-v1** (depends on the relay, the pane system, and the bridge existing) — designed now so v1 forecloses nothing.

---

## Summary

A user asks the assistant for a retro board, a poll, a CSV explorer, a burndown chart over the vault's tasks — and the agent **writes an app** into `.holi/apps/<name>/` with its native tools (D30), then opens it. The app renders in a sandboxed webview as a tab, talks to Holi through a scoped **`holi.*` bridge**, and — the differentiator — gets a **shared Yjs document as its state store**, riding the exact relay that syncs notes (D1). Every vault app is therefore **live-multiplayer, offline-capable, and snapshot-covered (D26) by default**: two teammates drag cards on the same retro board and watch each other do it. No runtime ships with Holi or the vault — Chromium renders UIs, and apps that declare a backend get an Electron **`utilityProcess`** (the bundled Node).

Prior art: old Holi's `.app.html` + `app_bridge` + theme-injected sandboxed iframes proved the model single-player; this design makes it multiplayer and first-class.

## Goals / Non-goals

**Goals**
- The agent can create, edit, and open an app **within one conversation** — no toolchain, no build step required for the common case.
- Apps are **vault content**: synced to all members (D1), visible in a dedicated Apps surface, reusable by copying the directory.
- **Live multiplayer app state** via a per-app shared Yjs doc on the existing relay (D26 snapshots included).
- Apps can read/write **vault tasks and docs** (membership-gated server-side, D7/D10) and look **native** (theme tokens injected).
- Optional **backend** per app via `utilityProcess` — no separate runtime shipped (D31).

**Non-goals**
- Note-embedded app widgets (the old `html-widget` fences) — deferred; keeps the editor lean (D22).
- An app store/registry, versioning, or permission-approval UX — trust is vault membership (D29/D31).
- Sandboxing against malicious teammates — full employee trust; revisit if external code enters vaults.
- npm dependency trees inside vaults — apps needing libraries get bundled to files by the agent (vault stays text-first, D28-adjacent).

## User stories

- *As a team*, we ask the assistant for a retro board in our shared vault; it writes the app and opens it; everyone sees it appear in their Apps section, and we move cards together in real time.
- *As an employee*, I ask for a one-off CSV cleaner; the agent builds it, I use it, it stays in my personal vault for next time.
- *As a PM*, I open a "task burndown" app side-by-side with a planning note; the app subscribes to the vault's tasks and updates live as people move cards on the board.
- *As the agent*, I `Read` a retro app's `data.json` after the session and write a summary note with action items as tasks.
- *As a team member*, I copy `apps/planning-poker/` from the org apps vault into our project vault and it just works.

## Anatomy (on disk)

```
.holi/apps/retro-board/
  manifest.json        ← name, icon, capabilities (transparency), optional backend entry
  index.html           ← the app (may inline everything)
  app.js / styles.css  ← optional split-out assets
  server.mjs           ← optional backend (utilityProcess)
```

- `manifest.json`: `{ name, icon, description, capabilities: ["data","tasks","docs","awareness","open"], backend?: "server.mjs" }`. Capabilities are **informational** (surfaced in the Apps list), not gates (D31).
- The directory syncs like any vault content; `.holi/apps/` is hidden from the file tree by default (managed content) but surfaced through the Apps UI.
- The authoring contract (this section + bridge API) is documented by a **skill in the vault's `.claude/`** so the agent scaffolds correctly without prompt-bolting (D30).

## Runtime & surfaces

- **UI:** `index.html` loads in a **sandboxed webview** (null-origin — the proven old-htmlBlock isolation), with the vault's **theme tokens injected** so apps look native, kept live via the theme postMessage channel.
- **Tabs:** an app opens as a tab in the pane system — split-screen with notes, same tab chrome. Launchers: **command palette**, a **sidebar Apps section** (from `.holi/apps/` metadata), and an **agent action** ("opening it now") — the pane system must accept non-note tab kinds (the one v1 accommodation this PRD asks for).
- **Backend (optional):** if the manifest declares one, Holi spawns `server.mjs` in an Electron **`utilityProcess`** while the app is open (lifecycle: spawn on open, kill on last tab close), wired to the frontend via the bridge. Node as-is — no permission flags (D31 trust).

## The `holi.*` bridge

postMessage RPC between the webview and Electron main (a preload-style shim inside the app frame provides the `holi` global):

| API | What it does |
|---|---|
| `holi.data` | The app's **shared Yjs doc** (Y.Map/Y.Array via a provider proxied over the bridge to the relay). Live-multiplayer state, offline queue, D26 snapshots. Doc identity: `(vaultId, app:<name>)`. |
| `holi.tasks` | list / create / update / subscribe — proxied to the Syv tRPC API, gated by the **user's** membership (D7/D10). |
| `holi.docs` | read / write / list vault docs — same gating; writes flow through the same server authority as everything else. |
| `holi.awareness` | presence in the app (who has it open, ephemeral cursors/selections) — the relay's awareness channel scoped to the app doc (D20). |
| `holi.open` | navigate Holi: open a note, task, or another app. |
| `holi.theme` | current resolved theme tokens + change events (also auto-injected as CSS vars). |

- **Agent inspection:** `holi.data` optionally materializes as a read-only `data.json` in the app dir (debounced), so the assistant can `Read` app state with native tools — apps and agent compose (D30).
- Backend processes get the same bridge over IPC.

## Reuse

An app is a directory: **reuse = copy it** (the agent can, across vaults the user is a member of). Convention: an org-wide **"apps" shared vault** acts as the library. No registry, no versioning machinery — if two vaults' copies drift, that's fine; they're independent (D31).

## Lifecycle & flows

- **Create:** user asks → agent `Write`s the dir (scaffold from the skill) → agent calls open-app → tab appears; other members see the app in their Apps section on sync.
- **Iterate:** agent (or user) edits files → Holi hot-reloads the open webview on file change (working-copy watcher already exists for the bridge).
- **Open:** palette / sidebar / agent → new tab; backend spawns if declared.
- **Delete:** remove the directory (file-tree or agent); open tabs close with a tombstone message; the app's Yjs data doc is archived with the vault's snapshot retention (D26), not silently destroyed.

## Edge cases & risks

- **Concurrent app-code edits while open:** the app's *files* are synced content — a teammate's edit hot-reloads your open tab. Acceptable (same trust as the code itself); debounce reloads.
- **Backend runaway:** a `utilityProcess` that spins — cap lifetime to tab-open, surface CPU in the Apps section, kill on close. No orphaned processes.
- **App data growth:** app Yjs docs are unbounded by design (like notes); snapshot retention (D26/server-data) applies. Flag per-app doc size in the Apps section if it becomes real.
- **Schema drift:** app code evolves but old `holi.data` state persists — apps own their migrations (document the pattern in the skill); Holi guarantees only the doc, not its shape.
- **v1 accommodation (the only one):** the pane/tab system must not assume tabs are notes; the bridge API design should keep app-scoped docs addressable (`app:<name>` doc ids in the docs table or a sibling kind).

## Dependencies

- **vaults-collaboration** — the relay, app-scoped Yjs docs, offline cache, snapshots (D26).
- **server-data** — doc kinds (`app-data`), membership gating on bridge-proxied tRPC calls, snapshot retention.
- **agent** — authoring skill in `.claude/`, the open-app action, `data.json` inspection.
- **notes-editor / app shell** — the pane system accepting app tabs; palette + sidebar launchers.

## Open questions

1. **App-data doc granularity:** one Yjs doc per app, or per app *instance* (e.g. one retro board app, many retro sessions)? Leaning: the app decides — `holi.data.open(key)` with a default key, so both work.
2. **Hot-reload UX:** reload silently vs. a "app updated — reload?" toast when state could be lost mid-interaction.
3. **Backend bridge surface:** does `server.mjs` get `holi.*` too, or only frontend + its own Node powers? Leaning: yes, same bridge over IPC.
4. **Apps section placement:** sidebar section vs. palette-only for the first cut.
