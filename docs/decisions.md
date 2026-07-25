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

**Verification 2026-07-25 (docs vs code).** Points 1–10 are all consolidated as prose in the living docs (`architecture.md` carries each; `glossary.md` and the PRDs carry the rest). The one docs gap has been closed: *Google Drive is deferred* was unstated and `vision.md` still framed Drive as a v1 integration — `vision.md` now moves it to *Beyond v1* with D60's own reasoning. What remains is **code that does not yet match**, and it is why this entry stays:

- **Reconcile → agent drawer (pt 5) — unbuilt.** `EditorPane.onConflict` raises only a banner (`Shell.tsx` wires it to a string); the pause-autosave → re-run-the-merge → hand-to-the-drawer path does not exist. The `pause` primitive is there (`active-vault.ts`, `sync.pause`); the drawer handoff is not.
- **Local reminder evaluator (pt 8) — unbuilt.** No tray evaluator, no catch-up-on-launch, no machine-local watermark. `main/reminders/` holds only a pure `notificationsFor()` formatter plus stale *server*-shaped types (`reminders/types.ts` still cites `apps/server/src/bus.ts`).
- **Version history over `git log` (also-settled) — unbuilt.** `git.log()` exists but is unexposed in the router; `state/history.ts` still calls the removed server `snapshots` API keyed on `docId`; `HistoryPanel.tsx` is defined but mounted nowhere.

Residue to retire when those land: the `[[task:<id>]]` chip grammar (`wiki-links.ts`, `wikiLinkChips.ts`) and the `mcp__holi__*` tool surface still exist, where pt 4 wanted `note_rename` shipped as a `.claude/` vault skill instead. The pt-7 diff3 that this entry flagged as *new work* has since **landed** (`packages/shared/src/merge3.ts`, wired via `lib/editor-reload.ts`).

*This entry stays in the inbox until the code matches it.*

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

**D61 was spent** on making push automatic — amending D60 point 2's "explicit push" to a coalescing auto-push with a leave-point set, an optimistic non-fast-forward recovery, and an `offline — N waiting` / `no write access` failure taxonomy. Consolidated 2026-07-24 into `prd/vaults-sync.md` (§Summary, §Pushing, §State display, §Why these choices, §Open questions), `architecture.md` §Sync, and `glossary.md` (§Push replaces §Publish); the Publish button, `publish()`, `sync.publish`, and the `publishing`/`ahead` sync states are deleted from the code. Its reasoning is the §Why-these-choices "why push automatically" paragraph. **Fully realized in code 2026-07-25:** an audit found two survivors, now cleaned up — the agent seed (`agent/seed-content.ts` `AGENTS.md`) still told the agent commits "stay on this machine until the user presses **Publish**", now corrected to auto-push; and a dead duplicate `SyncState` union carrying the removed `ahead` kind lingered in `packages/shared/src/types.ts` (imported nowhere — the live union is in `main/vault/active-vault.ts`), now deleted.
