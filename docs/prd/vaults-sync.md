# PRD — Vaults & Sync

The vault lifecycle and the sync engine: what a vault is, where it lives, how it moves between machines, and what happens when two people change the same thing.

This replaces the former `vaults-collaboration.md`, whose subject — real-time CRDT collaboration over a hosted relay — is deferred ([`../vision.md`](../vision.md)).

---

## Summary

A vault is **a GitHub repository, cloned into a Holi-managed directory**. Its identity is its remote; its contents are markdown files; its history is git history. Holi owns the clone completely and is the only thing that writes to it besides you and your agent.

Sync is **automatic inbound, explicit outbound**:

- Your edits become **local commits** on an idle debounce or ⌘S.
- Holi **pulls automatically** on an interval and on window focus, **merging** (never rebasing).
- Your work leaves the machine only when you **Publish**.
- A merge that conflicts is **aborted immediately**, leaving a clean tree, and offers **Ask Claude to reconcile**.

**Why auto-in / manual-out.** The old app's failure was auto-committing every 30 seconds and *never pulling* — so a teammate's work never arrived and every vault silently diverged. The pull half is the half that was missing, and it is the half that makes a shared vault shared. The push half is the one where a human being should decide what leaves their machine and when.

---

## Goals / Non-goals

### Goals
- A vault feels like a local folder of markdown, because it is one.
- **A teammate's work arrives without anyone remembering anything.**
- **Nothing leaves your machine unless you say so.**
- The working tree is **always clean**, so a pull can always merge.
- No edit is ever lost to a crash, a sleep, or a quit.
- A conflict is **reported, contained, and fixable** — never a broken vault and never a modal demanding a positional choice.
- Git remains legible: someone who knows git can open the clone and understand exactly what Holi did.

### Non-goals (v1)
- **Real-time co-editing, presence, cursors, awareness** — deferred with the relay.
- **A hosted sync service of any kind.**
- **Branches.** Holi works on the repo's default branch, always. Branching is a thing you may do in a terminal; Holi neither creates nor offers them.
- **A merge-conflict UI.** The agent is the resolver.
- **Selective publish** (staging individual files). Publish sends everything you have committed.
- **Submodules, LFS, or non-markdown-first repos** — supported only insofar as git handles them; not designed for.

---

## User stories

- I edit a note, stop typing, and a commit happens without my noticing.
- I press ⌘S out of habit and it means something: my work is committed at that instant.
- I close the laptop mid-sentence and reopen it tomorrow; nothing is lost.
- A teammate publishes; within a minute my vault has their work and my file tree updates.
- I finish a piece of work and press **Publish**; my commits go to GitHub.
- I've been offline on a plane; I come back, my vault pulls, merges cleanly, and I publish.
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
7. **FR-7** The working tree is **clean between commits by construction**. This is what lets a pull always merge, and it is why autosave commits locally rather than waiting for Publish.
8. **FR-8** Autosave **pauses** during a reconcile, and while paused the vault says so.

### Pulling
9. **FR-9** Holi **fetches and merges** on an interval and on window focus.
10. **FR-10** Pull uses **merge, never rebase**. With dozens of unpushed autosave commits, a rebase replays each one and can conflict *repeatedly on the same hunk* — a failure mode manufactured entirely by autosave granularity. Merge resolves the divergence once. Non-linear history is the accepted price.
11. **FR-11** A clean merge is **silent**. The file tree and any open editors update themselves ([`notes-editor.md`](notes-editor.md)); no notification, no dialog.
12. **FR-12** A merge that **conflicts is aborted immediately** (`git merge --abort`), restoring a clean tree. Auto-pull then **pauses for that vault** so it does not retry and re-abort in a loop.

### Publishing
13. **FR-13** **Publish** pushes local commits to the default branch. The control shows how many commits are waiting; nothing else is required of the user.
14. **FR-14** Publish **pulls first**. A non-fast-forward rejection is not something to surface as an error when the fix is the pull that was going to happen anyway.
15. **FR-15** If the pre-publish pull conflicts, publish stops and hands off to the reconcile path — the user's work stays local and intact.
16. **FR-16** A push rejected for **permissions** is reported as exactly that ([`auth-identity.md`](auth-identity.md) FR-13), never as a network or merge failure.

### Reconciling
17. **FR-17** A conflict surfaces as a **banner on the vault**, naming how many incoming changes conflict and with which files. It is **non-blocking**: ignore it and you keep working on a clean tree.
18. **FR-18** **Ask Claude to reconcile** (a) pauses autosave and auto-pull, (b) re-runs the merge so the conflict is really in the tree, (c) opens the agent drawer seeded with a prompt naming the conflicted paths, (d) resumes normal operation once the tree is clean.
19. **FR-19** During a reconcile, the conflicted files are **read-only in the editor**. Everything else in the vault stays editable.
20. **FR-20** The user can always **abandon** a reconcile: `git merge --abort` returns to the pre-merge state, which is a commit, so nothing is at risk.

### State display
21. **FR-21** Each vault shows exactly one sync state: **up to date**, **N to publish**, **pulling**, **offline**, **conflict**, or **reconciling**. It lives in the vault dropdown, where you look to know which vault you are in.
22. **FR-22** The state must never say "synced" when it isn't. The previous design shipped a sync indicator over a persistence layer that was never built, and the indicator made the gap worse than a blank would have.

---

## Why these choices

**Why local commits rather than staying dirty until publish.** A dirty working tree cannot take a merge; every auto-pull would need `stash → merge → stash pop`, and a conflict inside a stash pop is the single worst place in git to land a non-git-thinking user. Committing locally keeps the tree clean, survives a crash, and gives the vault a free undo history — which is what replaces the deleted snapshot timeline.

**Why merge rather than rebase.** See FR-10. The argument is entirely a consequence of autosave granularity: fine-grained commits are good for recovery and terrible for replay.

**Why abort rather than leaving the conflict in the tree.** A conflicted working tree means files containing `<<<<<<<` markers, and autosave would happily commit them. Aborting means the failure is *announced* rather than *inflicted*: if you ignore the banner, you keep working on an unbroken vault. The conflict is then re-created deliberately, once, when someone chooses to deal with it.

**Why an agent instead of a merge UI.** A three-pane merge editor resolves conflicts *positionally*, which is the wrong level for prose and for YAML frontmatter. An agent resolves on meaning, in a surface the user already has open, and can ask. And it operates inside git, mid-merge, on a repo whose pre-merge state is a commit — the worst case is `git merge --abort`.

**Why git is legible.** Everything Holi does is a normal git operation on a normal clone. A developer can inspect, fix, or take over at any point. That is a deliberate property: the previous design's failure mode was a system whose truth lived somewhere you could not open.

---

## History

The vault's history **is git history**, and autosave commits are what give it resolution.

- A **version timeline** for the open file, from `git log --follow`, with preview and restore. Restore writes the old content as a new commit — never a rewrite of history.
- **No custom snapshot store.** `yjs_snapshots`, `snapshots.take`, `pre-agent-write` labels, the reason taxonomy, and the retention question they raised are all deleted. Git's object store is the snapshot store, and it already handles retention.
- **Milestones fall out for free.** The old timeline needed a display-level split between meaningful and automatic snapshots because interval snapshots buried the ones that mattered. The same problem exists here — a wall of autosave commits — and the same fix applies: fold consecutive autosave commits and surface publishes, merges, and reconciles as the landmarks.

---

## Edge cases & risks

- **Autosave committing something half-written** — by design; the journal is autosaves and the landmarks are publishes. If it proves ugly, the answer is squash-on-publish, not a coarser debounce that risks losing work.
- **A pull landing while the agent is mid-turn.** The agent's `Edit`/`Write` will fail their read-before-edit guard on a file that moved, which is the correct outcome. Consider pausing auto-pull during an agent turn; measure before deciding, because the pause has its own failure mode (a long turn blocking sync).
- **The `.git` directory is reachable by the agent.** It has `Bash` and the clone is a repo, so `reset --hard` and `push --force` are expressible ([`agent.md`](agent.md) §Security). Bounded by native permission prompts and branch protection, not by trying to blocklist git.
- **Two Holi instances on one clone** (the app opened twice) would race on commits. Take a lock on the clone.
- **Large binaries in an adopted repo.** Holi commits what changes; it does not curate. A vault with PDFs will commit PDFs. Worth deciding whether Holi warns on large files, because git punishes this permanently.
- **A repo with a non-default primary branch, or protected branches requiring PRs.** FR-2 refuses rather than improvises; a protected default branch makes Publish fail in a way that must be reported honestly.
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
2. **The pull interval**, and whether it should back off when a vault is quiet. Focus-triggered pull may make the interval nearly irrelevant.
3. **Squash on publish?** It would make the shared history readable at the cost of the fine-grained local timeline. Leaning no — the timeline is the history feature — but it is the obvious lever if the log becomes unusable.
4. **Should a clean merge that changes the open file be announced at all?** Silence is calm but can be surprising mid-paragraph.
5. **Pause auto-pull during an agent turn?** See Edge cases.
