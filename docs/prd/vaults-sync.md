# PRD — Vaults & Sync

The vault lifecycle and the sync engine: what a vault is, where it lives, how it moves between machines, and what happens when two people change the same thing.

This replaces the former `vaults-collaboration.md`, whose subject — real-time CRDT collaboration over a hosted relay — is deferred ([`../vision.md`](../vision.md)).

---

## Summary

A vault is **a GitHub repository, cloned into a Holi-managed directory**. Its identity is its remote; its contents are markdown files; its history is git history. Holi owns the clone completely and is the only thing that writes to it besides you and your agent.

Sync is **automatic in both directions**:

- Your edits become **local commits** on an idle debounce or ⌘S.
- Holi **pushes** those commits on a short coalescing timer and on the moments you step away (⌘S, window blur, tab close, vault switch, quit), so your work is off-machine within seconds of your stopping — no button, no step.
- Holi **pulls automatically** on an interval and on window focus, **merging** (never rebasing).
- A merge that conflicts is **aborted immediately**, leaving a clean tree, and offers **Ask Claude to reconcile**.

**Why automatic push.** The old app's failure was auto-committing every 30 seconds and *never pulling* — so a teammate's work never arrived and every vault silently diverged. The pull half is what makes a shared vault shared. The push half is automatic for the same reason the commit is: choosing *when* a half-typed sentence reaches the remote has no value a human can perceive, and the two things a push actually buys — off-machine durability and teammates seeing your work — are both satisfied by a latency of tens of seconds, which a machine decides better than a person. The only time unpushed work is *shown* is when a push is failing.

---

## Goals / Non-goals

### Goals
- A vault feels like a local folder of markdown, because it is one.
- **A teammate's work arrives without anyone remembering anything.**
- **Your work reaches the remote without anyone remembering anything** — durable off-machine within seconds of stepping away.
- The working tree is **always clean**, so a pull can always merge.
- No edit is ever lost to a crash, a sleep, or a quit.
- A conflict is **reported, contained, and fixable** — never a broken vault and never a modal demanding a positional choice.
- Git remains legible: someone who knows git can open the clone and understand exactly what Holi did.

### Non-goals (v1)
- **Real-time co-editing, presence, cursors, awareness** — deferred with the relay.
- **A hosted sync service of any kind.**
- **Branches.** Holi works on the repo's default branch, always. Branching is a thing you may do in a terminal; Holi neither creates nor offers them.
- **A merge-conflict UI.** The agent is the resolver.
- **A Publish step, or selective staging of individual files.** There is no outbound gate: every commit is pushed, whole.
- **Submodules, LFS, or non-markdown-first repos** — supported only insofar as git handles them; not designed for.

---

## User stories

- I edit a note, stop typing, and a commit happens without my noticing — and reaches the remote a few seconds later, still without my noticing.
- I press ⌘S out of habit and it means something: my work is committed and pushed at that instant.
- I close the laptop mid-sentence and reopen it tomorrow; nothing is lost.
- A teammate makes a change; within a minute my vault has their work and my file tree updates.
- I've been offline on a plane; the vault says so and shows how much is waiting. I come back, it pulls, merges cleanly, and pushes what piled up.
- Someone edited the same paragraph I did; a banner tells me, my vault keeps working, and when I'm ready I press **Ask Claude to reconcile** and watch it resolve in the drawer.
- I open the clone in a terminal and everything looks like a normal repo, because it is.

---

## Functional requirements

### The clone
1. **FR-1** A vault is a clone of a GitHub repo under a **Holi-managed root** (e.g. `~/Holi/<owner>/<repo>`). Holi never adopts a user-maintained checkout — autosave-commit inside a tree where someone keeps WIP branches would destroy work.
2. **FR-2** Holi operates on the **default branch only**. If the clone is on another branch or in a detached/mid-operation state on open, Holi refuses to sync and says so plainly rather than "fixing" it.
3. **FR-3** The vault registry (which repos, cloned where) is **machine-local**.

### Committing
4. **FR-4** An edit produces a **local commit** after an **idle debounce**, and immediately on **⌘S**. Commit messages are generated and unremarkable (`Update projects/q2/roadmap.md`, or a count for multi-file changes).
5. **FR-5** Commits are debounced so a burst — a board drag across lanes, an agent turn touching ten files — is **one commit**, not ten.
6. **FR-6** A dirty buffer is flushed to disk and committed on: tab close, vault switch, window blur, and **app quit**. The unflushed buffer is the one way this design can lose data, so the flush points are a requirement, not an optimization.
7. **FR-7** The working tree is **clean between commits by construction**. This is what lets a pull always merge, and it is why an edit commits locally the moment it settles rather than staying dirty.
8. **FR-8** Autosave **pauses** during a reconcile, and while paused the vault says so.

### Pulling
9. **FR-9** Holi **fetches and merges** on an interval and on window focus.
10. **FR-10** Pull uses **merge, never rebase**. With dozens of unpushed autosave commits, a rebase replays each one and can conflict *repeatedly on the same hunk* — a failure mode manufactured entirely by autosave granularity. Merge resolves the divergence once. Non-linear history is the accepted price.
11. **FR-11** A clean merge is **silent**. The file tree and any open editors update themselves ([`notes-editor.md`](notes-editor.md)); no notification, no dialog.
12. **FR-12** A merge that **conflicts is aborted immediately** (`git merge --abort`), restoring a clean tree. Auto-pull then **pauses for that vault** so it does not retry and re-abort in a loop.

### Pushing
13. **FR-13** Local commits **push automatically** — there is no Publish step. A push fires on a short **coalescing debounce** (so a burst of commits is one push), and immediately on the leave points **⌘S, window blur, tab close, vault switch, and quit** (best-effort on quit, within a short budget so an unreachable remote never hangs it). A vault open, a window focus, and a clean merge each push too, draining anything left behind.
14. **FR-14** A push rejected **non-fast-forward** (the remote moved) recovers **optimistically**: pull inline, then retry the push. A clean recovery pull is invisible; a conflicting one routes into the reconcile path (FR-15/FR-12) — a rejection is just one more way to discover a conflict. Pushing does *not* pull first every time; the recovery is what keeps the common case a single network call.
15. **FR-15** If a recovery pull conflicts, the push stops and hands off to the reconcile path — nothing is pushed and the user's work stays local and intact.
16. **FR-16** A push rejected for **permissions** is reported as exactly that ([`auth-identity.md`](auth-identity.md) FR-13), never as a network or merge failure — it is its own state (**no write access**), because a lost-access problem and a network problem send someone to two entirely different places.

### Reconciling
17. **FR-17** A conflict surfaces as a **banner on the vault**, naming how many incoming changes conflict and with which files. It is **non-blocking**: ignore it and you keep working on a clean tree.
18. **FR-18** **Ask Claude to reconcile** (a) pauses autosave and auto-pull, (b) re-runs the merge so the conflict is really in the tree, (c) opens the agent drawer seeded with a prompt naming the conflicted paths, (d) resumes normal operation once the tree is clean.
19. **FR-19** During a reconcile, the conflicted files are **read-only in the editor**. Everything else in the vault stays editable.
20. **FR-20** The user can always **abandon** a reconcile: `git merge --abort` returns to the pre-merge state, which is a commit, so nothing is at risk.

### State display
21. **FR-21** Each vault shows exactly one sync state: **up to date**, **pulling**, **offline — N waiting**, **no write access**, **conflict**, **reconciling**, or **paused**. It lives in the vault dropdown, where you look to know which vault you are in. There is no "N to publish": because push is automatic, `ahead > 0` in normal operation is a bounded transient (the coalesced push has not fired yet) and is deliberately not surfaced — a counter flickering up and down every few seconds of typing reports nothing worth seeing.
22. **FR-22** The state must never say "synced" when it isn't. The unpushed count therefore appears **only when a push is failing** — `offline — N waiting` — which is the one time it is a fact the user needs rather than churn. The previous design shipped a sync indicator over a persistence layer that was never built, and the indicator made the gap worse than a blank would have.

---

## Why these choices

**Why local commits at all.** A dirty working tree cannot take a merge; every auto-pull would need `stash → merge → stash pop`, and a conflict inside a stash pop is the single worst place in git to land a non-git-thinking user. Committing locally keeps the tree clean, survives a crash, and gives the vault a free undo history — which is what replaces the deleted snapshot timeline. The commit is local; the push is a separate, slower cadence on top of it.

**Why push automatically, and why not on every commit tick.** Choosing when a half-typed sentence reaches the remote has no value a human can perceive, so the choice is the machine's. But pushing on the 3-second commit tick would mean ~1,200 pushes in a pathological hour of typing — not a rate-limit problem (`git push` over HTTPS does not consume GitHub's REST quota) but real *churn*: a process spawn each time, tiny commits piling onto the remote, and every teammate's pull loop merging them. A ~15-second coalescing debounce plus the leave points give "durable off-machine within seconds of stepping away" at roughly a tenth of the operations. The rejected alternatives — pushing on every commit tick, and pulling before every push to keep a strict ordering — both trade that churn for freshness nobody can perceive; the optimistic push-then-recover path is cheaper and lands a real conflict in the same reconcile machinery a pull does.

**Why merge rather than rebase.** See FR-10. The argument is entirely a consequence of autosave granularity: fine-grained commits are good for recovery and terrible for replay.

**Why abort rather than leaving the conflict in the tree.** A conflicted working tree means files containing `<<<<<<<` markers, and autosave would happily commit them. Aborting means the failure is *announced* rather than *inflicted*: if you ignore the banner, you keep working on an unbroken vault. The conflict is then re-created deliberately, once, when someone chooses to deal with it.

**Why an agent instead of a merge UI.** A three-pane merge editor resolves conflicts *positionally*, which is the wrong level for prose and for YAML frontmatter. An agent resolves on meaning, in a surface the user already has open, and can ask. And it operates inside git, mid-merge, on a repo whose pre-merge state is a commit — the worst case is `git merge --abort`.

**Why git is legible.** Everything Holi does is a normal git operation on a normal clone. A developer can inspect, fix, or take over at any point. That is a deliberate property: the previous design's failure mode was a system whose truth lived somewhere you could not open.

---

## How git is run

**Holi shells out to the system `git` binary.** Agreed with Nicolai 2026-07-21.

**Why not a JS implementation (isomorphic-git):** merge-with-honest-conflict-reporting is the load-bearing operation in this entire design — FR-12 and the whole reconcile path rest on git *refusing* rather than guessing — and that is precisely isomorphic-git's weakest area (no real recursive merge). Building the hardest requirement on the weakest feature is the trade to avoid. Shelling out also inherits credential helpers, hooks, `.gitignore` semantics, and — the part that matters for reconcile — **identical behaviour to what the user and the agent see in a terminal**, which they will both be looking at when a merge goes wrong.

**The cost, and the rule that contains it:** a process spawn per operation, and output that must be parsed. **Parse only plumbing commands and `--porcelain=v2`; never human-readable output** — porcelain text is explicitly not a stable interface, and a locale or version change would silently alter it.

The standing assumption that makes this safe is the one the whole product rests on: every user is a developer, so `git` is present. Holi should still fail with a clear message rather than a stack trace if it is not.

## History

The vault's history **is git history**, and autosave commits are what give it resolution. Two surfaces read the same `git log`, both presenting commits *as commits* — the audience is developers, so nothing is dressed up as an abstract "version":

- **A per-file timeline** — a right-hand drawer, opened by a header button on a note. A **flat** `git log --follow` for the open file: every commit, newest-first, each showing its short sha, message and author. Selecting a commit shows, inline, the diff that commit made to *this* file (vs its parent) in a read-only [`@codemirror/merge`](https://github.com/codemirror/merge) view; the sha opens the commit on GitHub; **Restore** writes that version's content back as a new commit.
- **A whole-vault commit browser** — a dialog opened from the footer sync state. Every commit in the vault (left) → the files it changed (middle) → that file's diff (right), the same merge view and sha-links. Where the drawer is file-first, this is commit-first.
- **Restore writes the old content as a new commit — never a rewrite of history.** Same argument as the machine-local reminder watermark: history is append-only, so restoring is an ordinary edit that lands as `Update <path>`, and the version you left is still in the log.
- **No custom snapshot store.** `yjs_snapshots`, `snapshots.take`, `pre-agent-write` labels, the reason taxonomy, and the retention question they raised are all deleted. Git's object store is the snapshot store, and it already handles retention.
- **A flat log, not a curated one.** An earlier plan folded consecutive `Update …` autosave commits away and surfaced only the landmarks (merges, reconciles, deliberately-authored commits). That fold was **dropped**: these are real commits and the user is a developer, so the timeline is the straight `git log` — autosave messages shown as what they are. A push leaves no commit, so the log has no push in it; making the shared journal terser is *squashing* (Open questions), not a display filter.

---

## Edge cases & risks

- **Autosave committing something half-written** — by design; the journal is the autosaves, shown in the timeline as the commits they are. If the flat log proves too noisy to read, the lever is squashing the autosave journal (Open questions), not a coarser debounce that risks losing work.
- **A pull landing while the agent is mid-turn.** The agent's `Edit`/`Write` will fail their read-before-edit guard on a file that moved, which is the correct outcome. Consider pausing auto-pull during an agent turn; measure before deciding, because the pause has its own failure mode (a long turn blocking sync).
- **The `.git` directory is reachable by the agent.** It has `Bash` and the clone is a repo, so `reset --hard` and `push --force` are expressible ([`agent.md`](agent.md) §Security). Bounded by native permission prompts and branch protection, not by trying to blocklist git.
- **Two Holi instances on one clone** (the app opened twice) would race on commits. Take a lock on the clone.
- **Large binaries in an adopted repo.** Holi commits what changes; it does not curate. A vault with PDFs will commit PDFs. Worth deciding whether Holi warns on large files, because git punishes this permanently.
- **A repo with a non-default primary branch, or protected branches requiring PRs.** FR-2 refuses rather than improvises; a protected default branch makes the automatic push fail in a way that must be reported honestly rather than retried in a loop.
- **Clock skew between machines** affects nothing — git orders by parentage, not time.
- **Very large vaults.** A full filesystem walk on open and a watcher over thousands of files is fine at Syv's scale and is the first thing to measure if it isn't.
- **A conflict in `.holi/settings.json` or `.claude/settings.json`** is a conflict in config, not content, and can leave the vault misconfigured while it lasts. The reconcile path handles it like any file, but these are the ones worth showing prominently.

---

## Dependencies

- **[`auth-identity.md`](auth-identity.md)** — the GitHub token this engine pushes and pulls with, and the managed clone root.
- **[`notes-editor.md`](notes-editor.md)** — the editor's autosave and its 3-way reload of files this engine changes underneath it.
- **[`agent.md`](agent.md)** — the drawer that hosts a reconcile.
- **[`tasks.md`](tasks.md)** — task files are ordinary files in the repo and get these semantics for free.

---

## Open questions

1. **The idle debounce.** Short enough that a crash loses nothing, long enough that a sentence isn't three commits. Start around 2–3 seconds and tune against real use.
2. **The push coalesce debounce**, and the quit/switch budget. Start around 15 seconds and 1 second respectively, tuned against real use — long enough to batch a burst, short enough that stepping away lands the work promptly. Same status as the idle debounce.
3. **The pull interval**, and whether it should back off when a vault is quiet. Focus-triggered pull may make the interval nearly irrelevant.
4. **Squashing the autosave journal?** It would make the shared history readable at the cost of the fine-grained local timeline. Leaning no — the timeline is the history feature — but it is the obvious lever if the log becomes unusable. (Note there is no publish to squash *at* any more; it would be a periodic or on-push fold.)
5. **Should a clean merge that changes the open file be announced at all?** Silence is calm but can be surprising mid-paragraph.
6. **Pause auto-pull during an agent turn?** See Edge cases.
7. **Offline → online detection.** v1 retries a failed push on the coalesce tick, on focus, and after a pull; it has no OS network-status listener. Add one only if that retry latency proves annoying.
