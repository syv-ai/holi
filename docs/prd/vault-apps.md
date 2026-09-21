# PRD — Vault Apps

Just-in-time interactive apps the vault assistant creates on demand: small, reusable tools that live **in the vault**, sync to every member, and open **inside Holi** as first-class tabs.

> **Slice 1 is built** (D74; §Slice 1 lists exactly what shipped) and **verified by hand on 2026-08-20** against a real vault — an app written into `.holi/apps/<id>/` opens as a themed tab, reads the vault's notes and tasks, refuses the agent surface, and holds nothing across a reload. The record, including what was *not* checked, is in [`../verification/2026-08-20-vault-apps-slice1.md`](../verification/2026-08-20-vault-apps-slice1.md).
>
> **Slice 2 is built** and verified by hand on 2026-08-20 ([record](../verification/2026-08-20-vault-apps-slice2.md)): registration now waits for an `app.yaml` manifest, a `holi` CLI gives the agent `app open` / `app init` / `seed refresh`, and a `PostToolUse` validator tells the agent on every write what will not work. Together they close the loop slice 1 left open, where the agent wrote an app blind and could only ask the user to go and look.
>
> **What is still absent** is additive against that surface rather than a change to it: `holi.data` and every write (§State, deferred), the `utilityProcess` backend, personal apps in `userData`, and auto-reload. The command-palette entry landed with D102 (2026-09-21): an app is a ⌘P row like any note ([`command-palette.md`](command-palette.md)).
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
  app.yaml             ← required: the registration marker, written LAST
```

- **The contract is "a directory containing `index.html` **and** `app.yaml`".** `appId` is still the directory name, and so are the tab title and the default label; the manifest only makes the label and icon overridable.
- **`app.yaml` is the registration marker, and slice 2 added it for a reason D74 did not have.** D74 rejected `manifest.json` and was right to: every field it was going to carry was derivable (`name` from the directory), defaulted (`icon`), or explicitly non-functional, and a file whose every field is derivable is one more thing the agent can write wrong for no benefit. **This file has a different job.** An agent writes an app one file at a time, so keying registration on `index.html` means the app appears in the sidebar the moment its first byte lands and opens onto half a page. The manifest is written **last**, and it is what says *finished* — which is why it is not sufficient on its own either: an app with no entry document is a promise with nothing behind it.

  Every key is optional (`name`, `icon`, `description`) and **an empty file registers the app**, because registering is the file's whole job. It is YAML rather than JSON so it takes comments and survives a trailing comma, and the parser is forgiving in exactly one direction: a typo inside the mapping costs the label, never the app. Silent non-appearance is the failure mode slice 1 proved worst, so the parser must never be the thing that causes it.

  Apps written before it get one automatically on vault open (`migrate-manifests.ts`), ahead of the first snapshot the renderer sees. A directory whose name cannot be an app id is skipped rather than renamed — renaming someone's directory is an edit to their vault made on their behalf, not a migration.
- **Personal apps live outside the vault**, in `userData/apps/<name>/`, and never touch the repo; vault apps live in `.holi/apps/<name>/` and sync like any content. The two are told apart by **location, not by naming** — D65's `.local.` marker is a *basename* rule (`isLocalOnlyPath` tests the file's own name, and the ignore glob is `*.local.*`), so it cannot mark a directory, and extending it to directories would amend a settled convention for one caller. The precedent is the Google cache, which sits in `userData` because "mail is account data and a vault is a shared git repo" — a personal app is the same claim. **Slice 1 resolves the vault location only**; adding the personal one is a second branch in the resolver and needs no URL change.
- The authoring contract (this section + bridge API) is documented by a **skill in the vault's `.claude/`** so the agent scaffolds correctly without prompt-bolting.

## Trust & isolation (D74)

**An app is a web app the user wrote.** That is the governing sentence: it gets broad access to the vault, because a tool you asked your own assistant to build is not a stranger. Two things bound it, and both are structural rather than advisory.

**A per-app origin.** Each app is served from **`holi-app://<appId>/`** by a protocol handler that resolves *only* inside that app's own directory — the same shape as the existing `holi-vault://` asset handler (`registerSchemesAsPrivileged` + `protocol.handle` + a containment check), with a narrower root. The frame is `sandbox="allow-scripts"` and **never also `allow-same-origin`**: granting both lets framed content drop its own sandbox, which is the footgun the mail reader already documents and avoids. Relative `<script src>` and `<img src>` therefore resolve, and every other file in the vault is unreachable except through the bridge — which is what makes the bridge a boundary rather than a convention.

**Why not reuse `holi-vault://`:** it serves any contained path with no extension gate and no `.local.` exclusion, which is correct for its one trusted consumer (the renderer drawing images) and wrong here — every app would share one origin, and any app could read `USER.local.md` directly.

**The agent surface is unreachable, read and write.** `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `USER.local.md` and all of `.claude/` are refused by the bridge ([`../glossary.md`](../glossary.md) §Agent surface). **The reason is escalation, not privacy:** `.claude/hooks/google-send-gate.mjs` *is* the gate that makes the agent ask before sending mail ([`agent.md`](agent.md) §Permissions), so an app that could write it would be an app that makes the agent send mail unprompted. `AGENTS.md` is the same argument one step slower. The rule is stated as one sentence — *an app cannot see or touch how the assistant is configured* — because a security boundary you can say in a sentence is the one that survives refactoring. Everything else in the vault is fair game, read and write.

**Network is allowed**, and the cost is recorded rather than hidden: an app can `fetch` anywhere, so any app is a channel out for anything the bridge hands it, with nothing in the way and no record that it happened. This was chosen deliberately — an app the user asked for should be able to reach an API, and the alternative (a CSP `connect-src 'none'`) would make a currency converter or a weather widget impossible. **The exposure this accepts is not a malicious teammate** — it is an agent that read a prompt injection out of a note or an email and wrote the exfiltration into the app itself. The agent-surface rule above is what keeps that blast radius to one app rather than to the assistant.

**No client-side storage, as a consequence.** An opaque origin has no `localStorage`, no `sessionStorage` and no `IndexedDB` — they throw. So an app cannot persist even a selected filter without a bridge call, and until there is a state API an app is blank on every open. This is not a limitation of the first slice that a later slice relaxes by accident; it is what makes "stateless" a real constraint rather than a stated intention.

**The refusal is enforced in main, not in the renderer.** The bridge *could* be pure renderer glue — the frame posts a message, the pane calls the existing `notes.read`, done, with no new IPC at all. It is not, because that would make the process that renders untrusted app code the same process that decides whether that code may read `AGENTS.md`, and a bug there is a silent bypass rather than a visible error. Every other security check in this product sits in main: path containment, the tokens, the send gate. So the app bridge gets its **own `apps.*` router namespace** whose procedures apply the agent-surface rule, and the renderer only forwards messages into it. The cost is one small namespace; what it buys is a boundary that holds even if the pane is wrong.

**`appId` is `[a-z0-9-]+`, and the reason is the URL.** The directory name becomes the **host** of a `holi-app://` URL, and hosts are case-folded — so `My_App/` and `my_app/` would collide, and a mixed-case directory would silently 404 in a way that looks like a path bug. Rather than canonicalize and explain it, the grammar is restricted: a directory whose name is not `[a-z0-9-]+` is **not an app** and does not appear in the Apps list. The authoring skill states it, so the agent names directories correctly by default.

**The bridge and the theme are injected on serve.** When the handler serves the entry document it prepends a `<style>` of theme tokens ([`../architecture.md`](../architecture.md) §9 — a whitelisted token map, never author-supplied CSS) and a `<script>` defining `window.holi` over `postMessage`. Every other file is served byte-for-byte. **Why inject rather than require a tag:** the app writes its own `index.html`, so a required `<script>` is one the agent can omit — and a missing bridge presents as an app that silently does nothing, which is the least diagnosable failure available.

**The `<style>` is Holi's own palette with the vault's theme laid over it**, not the vault's overrides alone. Injecting only the overrides is what shipped first, and it made an app in a vault with no theme — the ordinary case, since the seeded `theme.css` sets nothing — receive `:root{}`: every token the authoring skill tells authors to use resolved to nothing, and the app drew black text on a transparent page. Unit tests could not see it, because `:root{}` is a perfectly well-formed injection. The base lives in `main/apps/app-tokens.ts`, mirroring the renderer's dark defaults with the Tailwind palette references resolved to literals (a frame has no Tailwind build), and a test pins that every themeable token has one: a shade of drift is cosmetic, a missing token is an unreadable app.

## Runtime & surfaces

- **Tabs:** an app opens as an ordinary tab, split-screen with notes, same tab chrome. It is **keyed by `appId` and deduped like a note is by path** — opening an app that is already open focuses its tab.
  - **The tab union names its two categories**, rather than deriving one by subtraction: `SingletonTab` is the literal `'board' | 'agenda' | 'mail'`, and `Tab` is `{kind:'note';path}` | `{kind:'app';appId}` | `{kind:SingletonTab}`. The previous shape defined singletons as `Exclude<Tab, {kind:'note'}>` — "every non-note tab is unique" — under which `openSingleton(w, 'app')` would have typechecked and meant nothing. The accommodation this PRD asked for was *the pane system must not assume tabs are notes*; that had been honoured for notes and re-broken one layer down.
- **Discovery is free and live.** `.holi/apps/**` are non-markdown files, so they already land in `snapshot.files`, which the renderer subscribes to — the Apps list is derived from the snapshot with no new IPC, and an app the agent writes appears without a refetch. `isHiddenPath` (any dot segment) already keeps them out of the file tree.
- **Launcher: a sidebar Apps section**, below the file tree, listing each directory under `.holi/apps/`. **Hidden entirely when there are none**, the same rule the agenda and mail chips follow — a launcher whose only destination is "go make one" is a dead end wearing the clothes of a feature. The command palette (D102, [`command-palette.md`](command-palette.md)) is a second launcher now, derived from the same snapshot, so there is nothing to keep in agreement.
  - **It sits directly under the tree, not at the bottom of the sidebar.** The tree is sized by its rows (`min-h-0` + the default `flex: 0 1 auto`), not stretched to fill the column; it grows to its content, caps at the space available, and scrolls past that. Stretched, it pushed the Apps list down against the chip rows, where it read as one more chip row rather than as a second list of things the vault holds.
- **Reload is manual in slice 1**, a button in the tab. The watcher already sees an app's files change, so auto-reload is nearly free — and wrong during the case that matters most: the agent writes `index.html`, then `app.js`, so an auto-reload fires on the intermediate state and shows a broken app. A 200 ms debounce delays that rather than fixing it. With no client-side state a reload costs nothing, so an explicit button is both simpler and more predictable than a heuristic about when the writing has stopped. §Open questions keeps auto-reload for when state exists and a reload can actually lose something.
- **An app whose directory disappears leaves a tombstone**, not a vanishing tab: the tab stays, says the app is gone, and closes on click. Same choice notes make for a deleted file — a tab that evaporates while you are looking at it reads as a crash, and a teammate deleting an app during a pull is exactly when that would happen.
- **Backend (optional), and out of slice 1:** an app may later declare `server.mjs`, which Holi spawns in an Electron **`utilityProcess`** while the app is open (spawn on open, kill on last tab close), wired to the frontend via the bridge. Node as-is, no permission flags. Nothing in slice 1 needs it — the retro board, poll, CSV explorer and burndown are all frontend plus bridge — so it waits for an app that does.

## The sidebar's app menu

Right-clicking an app row gives **Open · Edit Source · Rename… · Delete · Copy Path · Reveal in Finder**. It deliberately does *not* mirror the file tree's row menu. Most of that menu — New File, New Folder, Cut, Copy, Paste, Duplicate — is about **paths**, and an app is not a path: it is a directory whose name is also a `holi-app://` host. Duplicating one would need a second id nobody chose; pasting into one is just editing a file, which the tree already does better. What survives is what has a meaning at the level of *an app*.

**An unfinished app is now visible.** A directory with an entry document and no manifest — half-written, or hand-written by someone who did not know the manifest was the marker — appears **dimmed**, below the finished ones, with a tooltip naming what it lacks and a menu whose first item is **Finish this app**. That item writes the manifest and nothing else (the same op as `holi app init`, which never overwrites), so finishing an app costs a right-click rather than a round-trip through the agent. It does not open on click: `openAppOp` would refuse it, and a row that opens a refusal is worse than a row that does not open.

This closes the gap slice 2 left open. `unregisteredAppIdsAtom` was computed and rendered nowhere, which is precisely the failure mode slice 1 proved is worst — the app does not appear and there is nowhere to look.

**Rename is a directory rename, and everything downstream follows from that.**

- It is **one `rename` of the directory**, not the file list expanded into `from`→`to` pairs. An app is a tree with nested directories and binary assets in it; a file-by-file move drops the empty directories and costs N syscalls to do worse. One syscall is also atomic on the same filesystem: the app is at the old id or the new one, never half at each.
- **Main is the authority** — it stats the directory, because a teammate's pull can occupy an id between the keypress and the mutation. The renderer checks the same things (`isValidAppId`, and the set of directories under `.holi/apps/`) only so the common refusals land under the field instead of after a round-trip. A refusal is a **value, not a throw**: the field has somewhere to put the reason.
- **The `[[link]]` rewrite is a second pass, and it runs *after* the directory has moved.** A crash between the two leaves the app renamed with stale links — dangling wiki-links that render as tombstones — rather than live links pointing at bytes that are gone. Same no-transaction contract as `moveNotes`.
- **The open tab follows by id, not by path.** `retargetTabs` keys on `path` and an app tab has none, so a rename that only ran it would leave the tab pointing at an id with nothing behind it, and the frame would render the "was deleted" tombstone for an app that is very much alive. `retargetAppTab` is the missing half.
- **Buffers are flushed first.** An app file open in the editor has an unsaved buffer keyed by its old path; without the flush that buffer would later save itself back into a path the rename has already emptied, recreating the old directory with one stale file in it.

**Delete removes the app's files and closes its tab** — it does not leave the tombstone. `AppFrame`'s tombstone is for an app that vanished *from under* you, a teammate's pull; answering "it was deleted" to the person who just chose to delete it is noise. The now-empty directory is left behind, matching what deleting a folder in the tree does, and an empty directory is an app by no definition — it has no entry document, so it appears in neither list.

**Open in a New Pane — built 2026-08-20.** This section carried it as *not built* on the grounds that "a split-pane menu item is a pane system, not a menu item", which was true and is now spent: `Shell` renders every pane ([`notes-editor.md`](notes-editor.md) §Split panes), so the item is one call to `openInNewPane`. It dedupes across panes like every other opener — an app already open elsewhere is focused there, never run twice, which is the same rule `openApp` has always applied within a pane.

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

## Slice 1 — what shipped

The risky part of this feature was not any single capability; it was whether **an agent can write an app into a vault and have it open, themed, reading real vault data**. Slice 1 is exactly that and nothing else:

- The `holi-app://` handler, its containment check, and the injected theme + bridge.
- The `{kind:'app'; appId}` tab and the union reshape it forces.
- `holi.docs.read/list`, `holi.tasks.list`, `holi.open`, `holi.theme` — reads only.
- The sidebar Apps section, hidden when there are no apps.
- The authoring skill in `.claude/` documenting the directory contract and the bridge.

**Deliberately absent from slice 1:** `holi.data` (§State), the `utilityProcess` backend, the manifest, personal apps in `userData`, the command palette entry (since built, D102), and any write call.

**What slice 1 can host:** a task burndown, a CSV explorer over a committed file, a vault dashboard — apps that read and draw. **What it cannot:** the retro board and the poll, which are the two examples in this document that need shared state, and which therefore wait for §State to resolve.

## Slice 2 — closing the authoring loop

Slice 1 proved an agent can write an app that opens and reads real vault data. What it could not do was **find out whether the app worked**: no console, no screenshot, no way to open it. Its only move was to ask the user to go and look, and a syntax error surfaced as a blank tab and a puzzled user. Slice 2 is three pieces that only make sense together:

- **`app.yaml`** (§Anatomy) makes registration explicit, so an app becomes real when the agent says it is finished rather than when its first file lands.
- **A `holi` CLI** — the `holi-google` shape (D67), a generated `sh` script over the hook server's loopback port with its per-instance token — gives the agent `app open <id>`, `app init <id>` and `seed refresh [path] [--force]`. All three are reversible, which is why none is gated: that is D70's rule reaching the opposite conclusion, not a different rule.
- **A `PostToolUse` validator** reports, on every write under `.holi/apps/`, what will not work — a syntax error and its line, a `.ts` file no bundler will build, a `localStorage` call that throws, a missing manifest. It is **advisory and never blocks**: the one hook here that says no is the send gate, and it says no about mail reaching a person who cannot un-receive it. It is also **silent when there is nothing wrong**, because a hook that talks every time is one the agent learns to skim.

The validator is what makes the manifest safe. A forgotten manifest would otherwise be silent non-appearance, and silence is the failure mode slice 1 proved is worst.

**`app open` is the only thing that opens a tab.** Nothing opens when an app merely *appears* in the snapshot: apps sync, so a tab arriving because a teammate finished writing one is a pull deciding what is on your screen. Local authorship, and only local authorship, opens a tab.

**Deliberately still absent:** everything in the slice-1 list above except the manifest.

## Reuse

An app is a directory: **reuse = copy it** (the agent can, across vaults the user is a member of). Convention: an org-wide **"apps" shared vault** acts as the library. No registry, no versioning machinery — if two vaults' copies drift, that's fine; they're independent.

## Lifecycle & flows

- **Create:** user asks → agent `Write`s the dir (scaffold from the skill) → agent calls open-app → tab appears; other members see the app in their Apps section on sync.
- **Iterate:** agent (or user) edits files → Holi hot-reloads the open webview on file change (working-copy watcher already exists for the bridge).
- **Open:** palette / sidebar / agent → new tab; backend spawns if declared.
- **Rename:** sidebar menu → the row becomes a field seeded with the current id → the directory moves, inbound `[[link]]`s are rewritten, and the open tab follows. See §The sidebar's app menu for why each of those is a separate step.
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
