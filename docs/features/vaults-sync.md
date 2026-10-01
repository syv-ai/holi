# Vaults and sync

A vault is a GitHub repository cloned into a directory Holi owns. Sync runs both ways with no button: edits become local commits within seconds, commits push on their own, and teammates' work is pulled and merged in the background. A conflict is announced, never left in the tree, and handed to Claude when you ask.

## How it works

**The clone.** Every vault lives at `~/Holi/<owner>/<repo>` (`HOLI_VAULT_ROOT` overrides it for dev and tests only). The registry of vaults is machine-local. Opening a vault clones it, or adopts a clone already at that path if its origin matches; anything else there is refused, never deleted. One vault is open at a time, owning its repo, watcher, snapshot and timers; a background vault does not sync.

**Leaving and deleting.** The vault picker only switches and adds. Settings → Vault ends in the open vault's way out: Leave, Remove from this machine, or Delete, offered there and nowhere else. **Leave** removes you as a collaborator on GitHub (anyone may remove themselves), then moves the clone to the Trash. An owner of a personal repo cannot leave; their way out is Delete. Access through an organization is the organization's, so Leave says so and only removes the clone. **Delete** is GitHub's to do: Holi opens the repo's settings, whose Danger Zone asks for the name, and moves the clone to the Trash only once GitHub answers 404 for the repo. Main checks that answer itself. A vault GitHub no longer shows you (deleted, or access removed) offers **Remove from this machine** instead. Leave and Delete push first; if work still will not reach the remote, nothing is removed and a new assistant session starts in that vault, asked to find out why and help push it. Delete names the other collaborators who lose the vault with you.

**Committing.** The watcher is a hint: a change triggers a rescan (200 ms quiet) and a commit check (3 s quiet). `git status` decides what commits, so a dropped event only delays work. A 30 s heal tick rescans and commits regardless, and a check runs as the vault opens. Messages are `Update <path>` or `Update N files`; a burst lands as one commit.

**Flush and leave points.** Window blur, tab close, vault switch and quit write dirty editor buffers to disk. Vault switch and quit then commit and push within a 1 s budget. ⌘S is window-wide: it saves every open buffer, commits and pushes at once.

**Pushing.** A landed commit arms a 15 s coalescing push. Opening a vault, a pull after window focus, and a clean merge also push. A non-fast-forward rejection pulls inline and retries once; a conflicting pull pushes nothing and goes to reconcile. A network failure is `offline`, a permission rejection `no write access`; either retries on the next commit, focus or pull.

**Pulling.** Every 3 minutes and on window focus (throttled to once per 30 s), Holi fetches and runs `git merge --no-edit origin/<default>`. A dirty tree is committed first. A clean merge is silent: the snapshot rescans and open editors reload (see [editor](editor.md)). A conflicting merge is aborted at once and the conflict becomes sticky: auto-pull and push stop for that vault until it is resolved. A conflict naming no paths (git refused because someone typed mid-pull) is transient and retried. While an agent turn runs, the sync loop pauses and lifts after it, capped at 10 minutes (see [agent sessions](agent-sessions.md)).

**Reconcile.** The sync item shows `N files conflict`, and its panel offers **Ask Claude to reconcile**; a conflict in vault config (`.holi/settings/…`, `.claude/settings.json`) gets a louder banner. Reconcile re-runs the merge without aborting, so markers and `MERGE_HEAD` are in the tree, and starts a session seeded with the conflicted paths. Those files are read-only in the editor; the rest stays editable. It ends when the agent's merge commit lands (the next status read sees no merge), not when a turn ends. **Abandon the merge**, in the same panel, runs `git merge --abort` and brings the conflict back. A vault app's records merge field by field through a driver Holi installs on open, so only the same field changed on both sides, or a record deleted against an edit, reaches reconcile ([vault apps](vault-apps.md)).

**Sync state.** One of: up to date, pulling, offline (with the unpushed count), no write access, N files conflict, reconciling, paused (with a reason). It is an item in the nav menu (`features/nav/SyncItem.tsx`) whose glyph carries it: quiet when up to date, the brand and turning while pulling, amber when it wants you, amber and turning while reconciling. Its panel says the state in words, offers the action when there is one, and opens the vault [history](history.md) tab. There is no window footer. Priority: reconciling, paused, conflict, pulling, no access, offline. Unpushed commits show only while a push fails.

**How git runs.** System `git`, token via `GIT_ASKPASS`, `LC_ALL=C`. Only plumbing, `--porcelain=v2 -z` and `push --porcelain` are parsed; the permission case, which exists only in stderr, is the one exception. An index-lock failure retries 5 times and is never called offline. A missing `git` is a clear error.

**Commit hooks.** Each open writes `.git/hooks/pre-commit`: the large-file guard, then a `curl` to the running Holi on loopback with a per-vault token from `.holi/state/hook-endpoint.local.txt` (0600, removed on close), then `exit 0`. Holi reads the staged set (`git diff --cached -M -z`, deletions included) and runs the enabled transforms in order: `relink` (rewrite `[[links]]` for renames git detected), `archive-done` (off by default; see [tasks](tasks.md)), `scaffold-md` (see [frontmatter](frontmatter.md)), `normalize-md` (invisible tidy), `memory-index` (see [agent memory](agent-memory.md); last, because it reads the whole tree). Rewritten files are restaged into the same commit. Every run appends to `.holi/state/hooks.local.log`, capped at 2000 lines.

**Large files.** Autosave stages only files at or under `maxCommittedFileBytes` (default 10 MB, re-read on every commit); deletions always commit. Oversized files stay on disk, unpushed, and a tree holding only those reads as clean. A callout at the window's foot offers **Commit anyway** (`--no-verify`) or **Keep local** (`.git/info/exclude`). The hook applies the same cap to the agent and terminal commits and points at Git LFS without setting it up.

## Rules

- Holi never adopts a checkout the user made elsewhere. Autosave in a tree with WIP branches destroys work.
- Default branch only; on another branch, detached, or mid-merge, sync pauses and the vault stays usable. Holi refuses rather than fixes.
- The working tree is clean between commits. That is what lets every pull merge.
- A transform never blocks a commit: a throw is logged and the commit proceeds; three failures in a row disable it for the session. The size guard is the one veto, because an oversized blob pushed once is in everyone's history forever.
- Settings say which transforms run, never what one is. The script ships in the binary and lives in `.git/hooks/`, which nothing can push.
- The sync state never says up to date when it is not.
- A clone is only ever moved to the Trash, never deleted, and never while it holds work the remote lacks.

## Rejected

- Rebase on pull: dozens of autosave commits replay one by one and conflict repeatedly on the same hunk.
- Leaving a conflict in the tree: autosave would commit the markers.
- A merge-conflict UI: resolves positionally, the wrong level for prose and YAML.
- isomorphic-git: its merge is its weakest part, and honest conflict reporting is the load-bearing operation.
- A Publish button, pushing every commit tick, or pulling before every push: churn for freshness nobody perceives.
- Stash, merge, pop around a dirty tree: a stash-pop conflict is the worst place to land.
- `core.hooksPath` into a tracked folder: a teammate's push would run code on your laptop, and it disables the size guard.
- Relinking from watcher events: a move arrives as an unpaired delete and add; only the commit boundary has the rename map.
- Warning after a large file commits: by then it is pushed.
- Deleting the repo from Holi: it needs the `delete_repo` scope on every token, for an act GitHub already guards with a typed name.

## Code

- `apps/desktop/src/main/vault/active-vault.ts`: the sync loop, timings, sync state, reconcile, abandon
- `apps/desktop/src/main/git.ts`: every git command and output parser
- `apps/desktop/src/main/vault/clone.ts`, `registry.ts`, `watcher.ts`: clone, registry, watcher
- `apps/desktop/src/main/vault/large-files.ts`: size partition, hook script, endpoint file
- `apps/desktop/src/main/vault/hooks/`, `main/vault/git-routes.ts`: staged set, runner, transforms, run log, the hook's route
- `apps/desktop/src/main/router.ts` (`vaults.membership`, `settle`, `leave`, `forgetDeleted`), `renderer/src/features/vault/RemoveVault.tsx`, `state/vault-removal.ts`: leaving and deleting
- `apps/desktop/src/renderer/src/lib/sync-label.ts`, `lib/reconcile-lock.ts`, `components/Shell.tsx`, `features/nav/SyncItem.tsx`: sync item, callouts, read-only lock
