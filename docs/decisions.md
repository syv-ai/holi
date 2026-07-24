# Decision inbox

New load-bearing decisions land here first, as lightweight ADRs (context, decision, why, rejected alternatives). Once agreed with Nicolai, each entry is **consolidated natively into the owning living doc** — the relevant PRD, `architecture.md`, or `vision.md` — and purged from this file. The cycle then repeats.

The living docs are the truth; this file is only the staging area.

## D60 — The vault is a GitHub repo. There is no server.

**Context.** The rebuild was founded on two premises: that shared vaults require real-time co-editing, and that co-editing requires CRDTs over a Syv-hosted relay. Everything followed from there — Postgres as truth, Google SSO, a memberships table, a task *record* with a file projection, a server-side git mirror, snapshot history, an SSE fan-out, and a file↔CRDT bridge on every client. The premise held for the collaboration story and quietly took the rest of the product hostage: 4.7k LOC of server, and the desktop's most intricate subsystem, exist to reconcile files with a truth that isn't files. `vision2.md` withdraws the premise — **concurrent editing is deferred**, and a vault becomes what it looks like from the outside: a GitHub repo you clone.

**Decision.** Ten choices, agreed with Nicolai 2026-07-21, that stand or fall together:

1. **`apps/server` is deleted outright** — relay, Postgres, Drizzle, Google SSO, memberships, tasks table, reminder evaluator, snapshots, git mirror. v1 is a pure local Electron app talking to GitHub. Nothing needs a server: device-flow OAuth carries no client secret, and every query is a file read.
2. **Sync is auto-pull, explicit push.** Pull on an interval + on focus; your work leaves only when you **Publish**. Old Holi's failure was auto-committing and *never pulling* — the pull half is the half that was missing, and it is the half that makes a shared vault shared.
3. **Edits become local commits on idle or ⌘S.** The working tree is therefore always clean, so an incoming pull can always merge with no stash dance, a crash loses nothing, and the commit journal *is* the undo history that replaces snapshots.
4. **Pull merges, never rebases.** With ~30 autosave commits unpushed, a rebase replays each one and can conflict repeatedly on the same hunk — a failure mode manufactured entirely by autosave granularity. Merge resolves the divergence once. Non-linear history is the price, and nobody reads a vault's graph the way they read a codebase's.
5. **A conflicting merge is aborted immediately.** `git merge --abort` restores a clean tree; a banner reports the desync; **Ask Claude to reconcile** pauses autosave, re-runs the merge for real, and hands it to the agent in the drawer. The property that matters: *ignore the banner and you keep working on an unbroken vault* — the conflict never lands in a file you are typing into without your consent.
6. **The file is the task**, named `task.<name>.md`, living in the vault folder it is about. Its **path is its identity**, its **folder is its lane**, and its filename prefix is what makes it a task. This deletes the record/projection axis whole: `ProjectionStore`, version tokens, per-field patching, `RelatedRef`, `[[task:<id>]]` chips.
7. **External writes reconcile in the editor**: clean buffer reloads silently, dirty buffer takes a plain text 3-way merge, unmergeable overlap falls into the same Reconcile path as a git conflict. Needed regardless of the agent, because auto-pull can land on an open file. **Correction (2026-07-21, found during the deletion):** this was written assuming `shared/agent-merge` survived intact. It does not — its "3-way merge" forks a shadow `Y.Doc` and lets Yjs reconcile, so the merger *is* the CRDT. Only the 2-way diff survives; a conflict-reporting diff3 is new work.
8. **Reminders are evaluated locally by a tray-resident app**, with catch-up on launch. The delivered-watermark is machine-local and never committed — a fire that produced a commit is the same failure the version token was kept out of frontmatter to avoid. A reminder on a shared task notifies everyone; tasks have no assignee.
9. **GitHub is identity and access.** Device-flow OAuth, token in the OS keychain. The repo list is the vault switcher, the collaborator list is the members panel, and Holi enforces no access control of its own — if you can push, you are a member.
10. **The MCP server is deleted.** `task_list` is a glob, `task_set` is a file edit, `note_rename` becomes a vault skill in `.claude/`. Zero ops is the honest end state of "build only what Claude Code doesn't already do".

**Also settled:** clones live under a **Holi-managed root**, never an existing checkout you also use — because autosave-commit inside a tree where you keep WIP branches is destructive, and a managed clone makes that impossible by construction. **v1 keeps** daily notes (now a path check and a template), a read-only collaborators panel, and a **version-history surface over `git log`** — autosave commits are what give it material. **Google Drive is deferred**; adding an integration during the release whose purpose is removing one is how the release stops shipping.

**Why now.** The dial-back is not primarily about cost or scope — it is that the concurrency foundation had become the product's center of gravity while the things vision2 calls the product (a markdown vault, a task board, an agent that lives in it) were the parts most encumbered by it. Roughly half the codebase deletes, and the surviving half is the half you would describe to a customer.

**Rejected.** *Keep a thin server for scheduled reminders and Drive tokens* — you keep a deploy, a database and an auth seam for two features, and the ops burden survives the engine's death. *Strip Yjs but keep the server authoritative* — "truth lives on a Syv server" is precisely the model vision2 replaces. *Strangle behind the existing tRPC-over-IPC seam* — identity moves from `docId`/`vaultId` to paths, so nearly every signature changes anyway; a parallel implementation would be a rewrite pretending to be a migration, with two models alive at once. Execution is therefore **delete-first**: one commit removes the server and the CRDT stack, then main's router is rebuilt file-backed behind the seam the renderer already calls.

**Consolidated 2026-07-21** into `vision.md`, `architecture.md`, `glossary.md`, `prd/vaults-sync.md` (new, replacing `vaults-collaboration.md`), `prd/auth-identity.md`, `prd/tasks.md`, `prd/notes-editor.md`, `prd/agent.md`, `prd/daily-notes.md`, `prd/vault-apps.md`, and the phase-2 stubs. **Deleted:** `prd/server-data.md`, `prd/vaults-collaboration.md`, both `specs/`, the offline sync-hub plan, and the bridge spike.

*This entry stays in the inbox until the code matches it.*

---

## D61 — Sync pushes automatically. There is no Publish.

**Context.** D60 point 2 landed sync as "auto-pull, **explicit** push": edits become local commits, but they only reach the remote when the user clicks **Publish**. That leaves the user holding a chore whose value is near-zero — nobody benefits from choosing *when* a half-typed sentence reaches the remote. The two things a push actually buys, off-machine durability and teammates seeing your work, are both satisfied by a latency of *tens of seconds*, which a machine decides better than a person. Removing publish also removes a phantom from the version-history slice: a publish leaves **no commit of its own** (a push creates no object), so it could never be a row in a `git log` timeline; with publish gone, the timeline is just the log.

**Decision.** Agreed with Nicolai 2026-07-24. D60 point 2 is amended from "explicit push" to **automatic push**:

1. **Commit and push cadences are decoupled.** Commit stays as D60 set it (3s idle debounce + leave points + ⌘S, local, clean tree). Push runs on its **own coalescing debounce (~15s quiet)** as a background operation, so continuous typing collapses into a handful of pushes.
2. **Immediate best-effort push on the moments a user leaves work behind**: ⌘S (an explicit "save this"), window blur / tab close / vault switch (fire-and-forget), quit (**~1s courtesy budget**, reusing the flush-on-quit shape), vault open (drains a killed quit or an offline session), after a successful pull, and on focus.
3. **Push-failure taxonomy.** *Network* → stay local, retry next tick, show `offline — N waiting`. *Non-fast-forward* → **optimistic recovery**: pull inline then retry; a conflicting pull routes to the existing conflict/reconcile path (so a rejection is just one more way to discover a conflict). *Permission* → surfaced as exactly that (FR-16 survives), never conflated with offline.
4. **The Publish button, the `publish()` operation, the `sync.publish` procedure, the `publishing` SyncState, and the `N to publish` state are all deleted.** The only time unpushed work is shown is when a push is *failing* — the honest reading of FR-22.

**Why the cadence and not push-on-every-commit-tick.** Sub-second freshness on the remote has no user value, and pushing on the 3s commit tick means ~1,200 pushes in a pathological hour of typing — not a rate-limit problem (git-over-HTTPS doesn't consume the REST quota) but real *churn*: process spawns, tiny commits piling on the remote, every teammate's pull loop merging them. The ~15s coalesce + leave points give "durable off-machine within seconds of stepping away" at ~1/10th the operations.

**Rejected.** *Push literally on the commit tick* — the churn above for freshness nobody can perceive. *Always pull before every push (keep FR-14 ordering literally)* — a fetch+merge every push tick makes the pull interval meaningless; optimistic push-then-recover is cheaper and lands in the same conflict path. *Keep Publish as an optional manual "sync now"* — it re-introduces the concept and the button we're deleting for a reassurance the automatic cadence + vault-open drain already provide. *Record pushed shas to mark publishes in history* — costs machine-local state that would make each teammate's timeline for the same file differ; there is nothing to mark once publish is not a concept.

*This entry stays in the inbox until the code matches it. Design detail in `specs/2026-07-24-auto-push-drop-publish-design.md`.*

---

## Number allocation — **next free is D62**

Living docs carry decisions as **prose, never as numbers**. D-numbers exist for two purposes only: **code comments** and **git history**. So this ledger is the one place that records which numbers are spent. Check it before allocating.

**D1–D59 are spent, and D60 supersedes all of them.** They are not listed here any more, and that is deliberate: their subjects — the CRDT doc store, the file↔CRDT bridge, the task record and its file projection, the SSE event stream, server-side membership, snapshot history, the git mirror — do not exist. A ledger of decisions about a deleted system is archaeology pretending to be law, and the docs are law.

The reasoning is not lost. Every one of them was written up in full in this file and is recoverable from git history (`git log -p docs/decisions.md`); the ones whose *lessons* outlive their mechanism were carried into the rewritten docs as prose, unattributed to a number:

- **The task file is the whole task** — the projection's parser, serializer, and file grammar survive in `prd/tasks.md`, minus the record they reconciled against.
- **A store loaded by whoever renders it fails silently** (was D58) — `architecture.md` §9. The second consumer cannot tell an unloaded store from an empty one.
- **Machine tokens do not belong in a file a human edits** (was D33) — the same argument now keeps the reminder watermark out of the repo, because a write that fires on a timer becomes a commit.
- **Select by an explicit marker, never by filename shape** (was D46) — `prd/daily-notes.md`, and the reason `task.` is a filename prefix rather than a frontmatter key.
- **The client passes its local date; nothing else computes "today"** (was D44) — `prd/daily-notes.md`.
- **A rename must reject a colliding destination before moving anything** — `prd/notes-editor.md` FR-11.

**D59 was spent** on the offline main-as-sync-hub work (commits `f1584f6`…`9bc7eef`) without this ledger being updated. It is the clearest casualty of the pivot: four slices building a Yjs sync hub inside a machine that no longer has Yjs.
