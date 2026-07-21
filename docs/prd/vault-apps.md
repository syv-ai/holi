# PRD — Vault Apps *(post-v1, designed)*

Just-in-time interactive apps the vault assistant creates on demand: small, reusable tools that live **in the vault**, sync to every member, and open **inside Holi** as first-class tabs. Ships **post-v1** — designed now so v1 forecloses nothing.

> **Status: the state model needs redesign.** This PRD's differentiator was a per-app **shared Yjs doc on the relay**, giving every app live multiplayer for free. There is no relay ([`../vision.md`](../vision.md)), so that mechanism is gone and its replacement is undecided. The *rest* of the design — the on-disk anatomy, the sandboxed webview, the `holi.*` bridge shape, the `utilityProcess` backend, reuse-by-copy — is unaffected, because those never depended on the sync engine. **The likely replacement:** app state is a **file in the app directory** (`data.json`), synced like any vault content, with git as the merge mechanism — which makes an app's state as inspectable and as agent-readable as everything else in the vault, and drops "live multiplayer by default" to "eventually consistent, like the rest of the vault". Sections below that assume the relay are marked.
>
> **The one v1 accommodation this PRD still asks for is unchanged and still load-bearing:** the pane/tab system must not assume tabs are notes.

---

## Summary

A user asks the assistant for a retro board, a poll, a CSV explorer, a burndown chart over the vault's tasks — and the agent **writes an app** into `.holi/apps/<name>/` with its native tools (no custom authoring machinery), then opens it. The app renders in a sandboxed webview as a tab, talks to Holi through a scoped **`holi.*` bridge**, and — the differentiator — gets a **shared Yjs document as its state store**, riding the exact relay that syncs notes. Every vault app is therefore **live-multiplayer, offline-capable, and snapshot-covered by default**: two teammates drag cards on the same retro board and watch each other do it. **No runtime ships** with Holi or the vault — Chromium renders UIs, and apps that declare a backend get an Electron **`utilityProcess`**, the Node already bundled, so "each vault ships with Node" is satisfied with zero installs. Rejected: a Deno/Bun sidecar runtime — a second runtime to ship when Electron's built-ins suffice.

## Goals / Non-goals

**Goals**
- The agent can create, edit, and open an app **within one conversation** — no toolchain, no build step required for the common case.
- Apps are **vault content**: synced to all members, visible in a dedicated Apps surface, reusable by copying the directory.
- ~~**Live multiplayer app state** via a per-app shared Yjs doc on the existing relay~~ — **superseded**; see the status note. Replacement: app state as a synced file.
- Apps can read/write **vault tasks and docs** and look **native** (theme tokens injected).
- Optional **backend** per app via `utilityProcess` — no separate runtime shipped.

**Non-goals**
- Note-embedded app widgets — deferred; keeps the editor lean. (Rejected for the feature's first cut precisely to avoid editor complexity.)
- An app store/registry, versioning, or permission-approval UX — trust is vault membership; manifest capabilities are transparency, not gates.
- Sandboxing against malicious teammates — full employee trust (a member's agent has no authority the member lacks); revisit if external code ever enters vaults.
- npm dependency trees inside vaults — apps needing libraries get bundled to files by the agent (the vault stays text-first).

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

- `manifest.json`: `{ name, icon, description, capabilities: ["data","tasks","docs","awareness","open"], backend?: "server.mjs" }`. Capabilities are **informational** (surfaced in the Apps list), not gates — full employee trust.
- **Why a directory + manifest** (rejected: single-file apps): a uniform contract for every app and room to grow — split-out assets, an optional backend — without a format change.
- The directory syncs like any vault content; `.holi/apps/` is hidden from the file tree by default (managed content) but surfaced through the Apps UI.
- The authoring contract (this section + bridge API) is documented by a **skill in the vault's `.claude/`** so the agent scaffolds correctly without prompt-bolting.

## Runtime & surfaces

- **UI:** `index.html` loads in a **sandboxed webview** (null-origin — port the isolation model from the old htmlBlock sandbox), with the vault's **theme tokens injected** so apps look native, kept live via the theme postMessage channel.
- **Tabs:** an app opens as a tab in the pane system — split-screen with notes, same tab chrome. Launchers: **command palette**, a **sidebar Apps section** (from `.holi/apps/` metadata), and an **agent action** ("opening it now") — the pane system must accept non-note tab kinds (the one v1 accommodation this PRD asks for).
- **Backend (optional):** if the manifest declares one, Holi spawns `server.mjs` in an Electron **`utilityProcess`** while the app is open (lifecycle: spawn on open, kill on last tab close), wired to the frontend via the bridge. Node as-is — no permission flags (full employee trust).

## The `holi.*` bridge

postMessage RPC between the webview and Electron main (a preload-style shim inside the app frame provides the `holi` global):

| API | What it does |
|---|---|
| `holi.data` | The app's state store. **Mechanism undecided** (see the status note) — likely a synced `data.json` in the app directory, merged by git like any vault content. |
| `holi.tasks` | list / create / update / subscribe — task files in the vault. |
| `holi.docs` | read / write / list vault docs — files in the vault, path-safety enforced. |
| ~~`holi.awareness`~~ | **Deleted** — presence rode the relay's awareness channel, which does not exist. |
| `holi.open` | navigate Holi: open a note, task, or another app. |
| `holi.theme` | current resolved theme tokens + change events (also auto-injected as CSS vars). |

- **Why a file for app state** (the replacement for the Yjs doc): it is the same argument the rest of the pivot runs on — the vault already syncs files, so an app that stores its state as a file inherits sync, history, and portability with no new machinery. It loses live multiplayer, which is the deferred property everywhere else too.
- **Agent inspection comes free** rather than being bolted on: state *is* `data.json`, so the assistant reads it with native tools. The old design had to materialize a read-only copy to achieve this.
- Backend processes get the same bridge over IPC.

## Reuse

An app is a directory: **reuse = copy it** (the agent can, across vaults the user is a member of). Convention: an org-wide **"apps" shared vault** acts as the library. No registry, no versioning machinery — if two vaults' copies drift, that's fine; they're independent.

## Lifecycle & flows

- **Create:** user asks → agent `Write`s the dir (scaffold from the skill) → agent calls open-app → tab appears; other members see the app in their Apps section on sync.
- **Iterate:** agent (or user) edits files → Holi hot-reloads the open webview on file change (working-copy watcher already exists for the bridge).
- **Open:** palette / sidebar / agent → new tab; backend spawns if declared.
- **Delete:** remove the directory (file-tree or agent); open tabs close with a tombstone message. The app's state is not "archived" by any special mechanism — it is in git history, like everything else that was ever committed.

## Edge cases & risks

- **Concurrent app-code edits while open:** the app's *files* are synced content — a teammate's edit hot-reloads your open tab. Acceptable (same trust as the code itself); debounce reloads.
- **Backend runaway:** a `utilityProcess` that spins — cap lifetime to tab-open, surface CPU in the Apps section, kill on close. No orphaned processes.
- **App data growth:** app state is committed vault content, so an app that writes constantly writes commits. This is a **new** risk the relay-backed design did not have, and it is the main thing the replacement state model must answer: a debounce, or state deliberately excluded from git.
- **Schema drift:** app code evolves but old state persists — apps own their migrations (document the pattern in the skill); Holi guarantees only the store, not its shape.
- **v1 accommodation (the only one):** the pane/tab system must not assume tabs are notes.

## Dependencies

- **[`vaults-sync.md`](vaults-sync.md)** — app directories are vault content and sync like anything else; the state-store decision lands against this engine.
- **[`agent.md`](agent.md)** — authoring skill in `.claude/`, the open-app action, state inspection.
- **[`notes-editor.md`](notes-editor.md)** — the pane system accepting app tabs; palette + sidebar launchers.

## Open questions

0. **The state model itself** (see the status note) — a synced `data.json` is the leading candidate; decide before this PRD is picked up.
1. **App-data granularity:** one store per app, or per app *instance* (e.g. one retro board app, many retro sessions)? Leaning: the app decides — `holi.data.open(key)` with a default key, so both work.
2. **Hot-reload UX:** reload silently vs. a "app updated — reload?" toast when state could be lost mid-interaction.
3. **Backend bridge surface:** does `server.mjs` get `holi.*` too, or only frontend + its own Node powers? Leaning: yes, same bridge over IPC.
4. **Apps section placement:** sidebar section vs. palette-only for the first cut.
