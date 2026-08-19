# PRD — Vault Apps *(next; nothing here is built yet)*

Just-in-time interactive apps the vault assistant creates on demand: small, reusable tools that live **in the vault**, sync to every member, and open **inside Holi** as first-class tabs.

> **Nothing in this document describes code that exists**, which is why it is not in the PRD table — see [`../not-built.md`](../not-built.md). It is, however, **the next thing being built**, and D74 settled the trust model and the first slice below, so this is no longer a design waiting on an open question. What remains open is narrow and named: **where app state lives**.
>
> **What D74 killed:** this PRD's differentiator was a per-app **shared Yjs doc on the relay**, which gave every app live multiplayer for free. There is no relay ([`../vision.md`](../vision.md)). The replacement is *not* decided, and deliberately so — it is a per-app question rather than a platform one (a retro board's state is shared by nature; a CSV explorer's is nobody else's business), so it is worth deciding against real apps. **Slice 1 therefore ships no state API at all** and the apps it can host are genuinely ephemeral. See §State, deferred.

---

## Summary

A user asks the assistant for a retro board, a poll, a CSV explorer, a burndown chart over the vault's tasks — and the agent **writes an app** into `.holi/apps/<name>/` with its native tools (no custom authoring machinery), then opens it. The app renders in a frame of its own origin as a tab, and talks to Holi through a scoped **`holi.*` bridge** — which is the only channel it has, and therefore the only thing that decides what it can reach. **No runtime ships** with Holi or the vault — Chromium renders UIs, and apps that declare a backend get an Electron **`utilityProcess`**, the Node already bundled, so "each vault ships with Node" is satisfied with zero installs. Rejected: a Deno/Bun sidecar runtime — a second runtime to ship when Electron's built-ins suffice.

## Goals / Non-goals

**Goals**
- The agent can create, edit, and open an app **within one conversation** — no toolchain, no build step required for the common case.
- Apps are **vault content**: synced to all members, visible in a dedicated Apps surface, reusable by copying the directory.
- ~~**Live multiplayer app state** via a per-app shared Yjs doc on the existing relay~~ — **superseded** with the relay. Not replaced by another default: see §State, deferred.
- Apps can read/write **vault tasks and docs** — everything except the agent surface — and look **native** (theme tokens injected).
- Optional **backend** per app via `utilityProcess` — no separate runtime shipped.

**Non-goals**
- Note-embedded app widgets — deferred; keeps the editor lean. (Rejected for the feature's first cut precisely to avoid editor complexity.)
- An app store/registry, versioning, or permission-approval UX — trust is vault membership; manifest capabilities are transparency, not gates.
- Sandboxing against malicious teammates — full employee trust (a member's agent has no authority the member lacks); revisit if external code ever enters vaults. **This is not the same as no isolation:** the per-app origin and the agent-surface rule (§Trust & isolation) exist against a *mistake* — an agent that read a prompt injection and wrote it into an app — not against a colleague.
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
  index.html           ← required: the entry document
  app.js / styles.css  ← optional, any files, served byte-for-byte
  server.mjs           ← optional backend (utilityProcess) — post-slice-1
```

- **The whole contract is "a directory containing `index.html`".** `appId`, the display label and the tab title are all the directory name; the icon is a default.
- **No `manifest.json` in slice 1**, reversing this PRD's original "directory + manifest" call. The reason the manifest was specified — a uniform contract with room to grow — is real, but every field it was going to carry is derivable (`name` from the directory), defaulted (`icon`), or explicitly non-functional: the PRD's own words are that `capabilities` are "transparency, not gates", and `backend` is post-slice-1. A file whose every field is derivable or unused is one more thing the agent can write wrong for no benefit, plus a second name that can drift from its directory. It comes back when a backend entry or a real icon needs declaring, as its own decision.
- **Personal apps live outside the vault**, in `userData/apps/<name>/`, and never touch the repo; vault apps live in `.holi/apps/<name>/` and sync like any content. The two are told apart by **location, not by naming** — D65's `.local.` marker is a *basename* rule (`isLocalOnlyPath` tests the file's own name, and the ignore glob is `*.local.*`), so it cannot mark a directory, and extending it to directories would amend a settled convention for one caller. The precedent is the Google cache, which sits in `userData` because "mail is account data and a vault is a shared git repo" — a personal app is the same claim. **Slice 1 resolves the vault location only**; adding the personal one is a second branch in the resolver and needs no URL change.
- The authoring contract (this section + bridge API) is documented by a **skill in the vault's `.claude/`** so the agent scaffolds correctly without prompt-bolting.

## Trust & isolation (D74)

**An app is a web app the user wrote.** That is the governing sentence: it gets broad access to the vault, because a tool you asked your own assistant to build is not a stranger. Two things bound it, and both are structural rather than advisory.

**A per-app origin.** Each app is served from **`holi-app://<appId>/`** by a protocol handler that resolves *only* inside that app's own directory — the same shape as the existing `holi-vault://` asset handler (`registerSchemesAsPrivileged` + `protocol.handle` + a containment check), with a narrower root. The frame is `sandbox="allow-scripts"` and **never also `allow-same-origin`**: granting both lets framed content drop its own sandbox, which is the footgun the mail reader already documents and avoids. Relative `<script src>` and `<img src>` therefore resolve, and every other file in the vault is unreachable except through the bridge — which is what makes the bridge a boundary rather than a convention.

**Why not reuse `holi-vault://`:** it serves any contained path with no extension gate and no `.local.` exclusion, which is correct for its one trusted consumer (the renderer drawing images) and wrong here — every app would share one origin, and any app could read `USER.local.md` directly.

**The agent surface is unreachable, read and write.** `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `USER.local.md` and all of `.claude/` are refused by the bridge ([`../glossary.md`](../glossary.md) §Agent surface). **The reason is escalation, not privacy:** `.claude/hooks/google-send-gate.mjs` *is* the gate that makes the agent ask before sending mail ([`agent.md`](agent.md) §Permissions), so an app that could write it would be an app that makes the agent send mail unprompted. `AGENTS.md` is the same argument one step slower. The rule is stated as one sentence — *an app cannot see or touch how the assistant is configured* — because a security boundary you can say in a sentence is the one that survives refactoring. Everything else in the vault is fair game, read and write.

**Network is allowed**, and the cost is recorded rather than hidden: an app can `fetch` anywhere, so any app is a channel out for anything the bridge hands it, with nothing in the way and no record that it happened. This was chosen deliberately — an app the user asked for should be able to reach an API, and the alternative (a CSP `connect-src 'none'`) would make a currency converter or a weather widget impossible. **The exposure this accepts is not a malicious teammate** — it is an agent that read a prompt injection out of a note or an email and wrote the exfiltration into the app itself. The agent-surface rule above is what keeps that blast radius to one app rather than to the assistant.

**No client-side storage, as a consequence.** An opaque origin has no `localStorage`, no `sessionStorage` and no `IndexedDB` — they throw. So an app cannot persist even a selected filter without a bridge call, and until there is a state API an app is blank on every open. This is not a limitation of the first slice that a later slice relaxes by accident; it is what makes "stateless" a real constraint rather than a stated intention.

**The bridge and the theme are injected on serve.** When the handler serves the entry document it prepends a `<style>` of the vault's resolved theme tokens ([`../architecture.md`](../architecture.md) §9 — a whitelisted token map, never author-supplied CSS) and a `<script>` defining `window.holi` over `postMessage`. Every other file is served byte-for-byte. **Why inject rather than require a tag:** the app writes its own `index.html`, so a required `<script>` is one the agent can omit — and a missing bridge presents as an app that silently does nothing, which is the least diagnosable failure available.

## Runtime & surfaces

- **Tabs:** an app opens as an ordinary tab, split-screen with notes, same tab chrome. It is **keyed by `appId` and deduped like a note is by path** — opening an app that is already open focuses its tab.
  - **The tab union names its two categories**, rather than deriving one by subtraction: `SingletonTab` is the literal `'board' | 'agenda' | 'mail'`, and `Tab` is `{kind:'note';path}` | `{kind:'app';appId}` | `{kind:SingletonTab}`. The previous shape defined singletons as `Exclude<Tab, {kind:'note'}>` — "every non-note tab is unique" — under which `openSingleton(w, 'app')` would have typechecked and meant nothing. The accommodation this PRD asked for was *the pane system must not assume tabs are notes*; that had been honoured for notes and re-broken one layer down.
- **Discovery is free and live.** `.holi/apps/**` are non-markdown files, so they already land in `snapshot.files`, which the renderer subscribes to — the Apps list is derived from the snapshot with no new IPC, and an app the agent writes appears without a refetch. `isHiddenPath` (any dot segment) already keeps them out of the file tree.
- **Launcher: a sidebar Apps section**, below the file tree, listing each directory under `.holi/apps/`. **Hidden entirely when there are none**, the same rule the agenda and mail chips follow — a launcher whose only destination is "go make one" is a dead end wearing the clothes of a feature. The command palette is a later addition, not a slice-1 second surface to keep in agreement.
- **Backend (optional), and out of slice 1:** an app may later declare `server.mjs`, which Holi spawns in an Electron **`utilityProcess`** while the app is open (spawn on open, kill on last tab close), wired to the frontend via the bridge. Node as-is, no permission flags. Nothing in slice 1 needs it — the retro board, poll, CSV explorer and burndown are all frontend plus bridge — so it waits for an app that does.

## The `holi.*` bridge

`postMessage` RPC between the app frame and Electron main. It is the **only** channel: the frame has an opaque origin, so unlike the mail reader — which is same-origin without scripts, letting the renderer reach into its document directly — nothing outside the frame can touch it, and nothing inside it can reach the vault except through here.

| API | Slice 1 | What it does |
|---|---|---|
| `holi.docs` | **read / list** | Vault documents, path-safety enforced. Refuses the agent surface. |
| `holi.tasks` | **list** | Task files. `create` / `update` / `subscribe` follow. |
| `holi.open` | **yes** | Navigate Holi: open a note, a task, or another app. |
| `holi.theme` | **ambient** | Resolved tokens, injected as CSS vars on serve; a change event follows. |
| `holi.data` | **absent** | The app's state store. Deliberately not in slice 1 — see §State, deferred. |
| ~~`holi.awareness`~~ | — | **Deleted.** Presence rode the relay's awareness channel, which does not exist. |

- **Writes are allowed by the trust model and simply not in slice 1.** An app is a web app the user wrote, so it may write vault content that is not the agent surface. Slice 1 ships reads because every app it can host is ephemeral anyway, and a read-only first slice is the one that cannot corrupt a vault while the surface is still being learned.
- Backend processes, when they exist, get the same bridge over IPC.

## State, deferred

**The one open question, and it is deliberately open.** The relay is gone, so app state has no home. The two honest candidates answer different needs, which is exactly why neither is the platform answer:

- **Shared by nature** — a retro board, a poll. Two members must see one truth, so the state is vault content: a `data.json` in the app directory, merged by git like anything else, which also makes it inspectable and agent-readable with native tools. Its new cost is real and the relay design never had it: **an app that writes constantly writes commits**, and on a shared vault, pushes.
- **Nobody else's business** — a CSV explorer's open file and filter, a dashboard's collapsed sections. Syncing it means merging someone else's scroll position. This belongs in a machine-local store, and `node:sqlite` in `userData` is already proven here by the Google cache.

**Why not just decide it now:** every framing that picks one for all apps is wrong for half the examples in this document, and the per-app split (a declared `state: shared | local`, or two APIs) is a config space to document and police before a single app has asked for it. Slice 1's ephemeral apps are the evidence-gathering step — if apps feel crippled, *which* kind of state was missed is the answer, and that is a question real usage answers and speculation does not.

## Slice 1 — what ships first

The risky part of this feature is not any single capability; it is whether **an agent can write an app into a vault and have it open, themed, reading real vault data**. Slice 1 is exactly that and nothing else:

- The `holi-app://` handler, its containment check, and the injected theme + bridge.
- The `{kind:'app'; appId}` tab and the union reshape it forces.
- `holi.docs.read/list`, `holi.tasks.list`, `holi.open`, `holi.theme` — reads only.
- The sidebar Apps section, hidden when there are no apps.
- The authoring skill in `.claude/` documenting the directory contract and the bridge.

**Deliberately absent:** `holi.data` (§State), the `utilityProcess` backend, `manifest.json`, personal apps in `userData`, the command palette entry, and any write call. Each is additive against the surface above rather than a change to it.

**What slice 1 can host:** a task burndown, a CSV explorer over a committed file, a vault dashboard — apps that read and draw. **What it cannot:** the retro board and the poll, which are the two examples in this document that need shared state, and which therefore wait for §State to resolve.

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

1. **Hot-reload UX:** the working-copy watcher already sees an app's files change, so reloading the open frame is nearly free — and with no client-side state there is nothing to lose by doing it silently. The question returns *with* state: once an app holds something, a reload mid-interaction can discard it, and then "app updated — reload?" is a real prompt rather than a nuisance.
2. **App-data granularity**, if and when there is app data: one store per app, or per app *instance* (one retro board app, many retro sessions)? Leaning: the app decides — a `holi.data.open(key)` with a default key, so both work. Blocked behind §State.
3. **Backend bridge surface:** does `server.mjs` get `holi.*` too, or only its own Node powers? Leaning: yes, the same bridge over IPC. Blocked behind the backend existing at all.
