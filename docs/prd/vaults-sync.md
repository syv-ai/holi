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
4. **FR-4** An edit produces a **local commit** after an **idle debounce** — **3 seconds** (`commitQuietMs`) — and immediately on **⌘S**, which is bound **window-wide** rather than per editor: the board, a task's detail and the agenda are all places you have just changed something and would press it. It saves **every open buffer**, not the focused one, and a buffer whose syntax is mid-edit holds off on its own (`notes-editor.md` FR-16) while the commit still lands for everything else. Commit messages are generated and unremarkable (`Update projects/q2/roadmap.md`, or a count for multi-file changes).
    - **The number is tuned, not derived**: short enough that a crash loses nothing, long enough that a sentence is not three commits. A **30-second heal interval** commits and rescans as a backstop, whatever the watcher did or did not report.
5. **FR-5** Commits are debounced so a burst — a board drag across lanes, an agent turn touching ten files — is **one commit**, not ten.
6. **FR-6** A dirty buffer is flushed to disk and committed on: tab close, vault switch, window blur, and **app quit**. The unflushed buffer is the one way this design can lose data, so the flush points are a requirement, not an optimization.
7. **FR-7** The working tree is **clean between commits by construction**. This is what lets a pull always merge, and it is why an edit commits locally the moment it settles rather than staying dirty.
8. **FR-8** Autosave **pauses** during a reconcile, and while paused the vault says so.
9. **FR-9** A **`pre-commit` hook runs five vault-wide transforms** at the commit boundary — `relink` (rewrite `[[links]]` for a file moved outside Holi), `archive-done` (off by default), `scaffold-md`, `normalize-md` and `memory-index`. They rewrite and **restage**, so the fix is in the commit being made rather than the next one.

   **`scaffold-md` gives a note the frontmatter it arrived without** ([`#17`](https://github.com/syv-ai/holi/issues/17)). Only one creation path used to scaffold — the file-tree `+` — so an agent's `Write`, a drag-and-drop import and a file made in another editor all landed a `.md` with no `created` and no `tags`. It runs on the **added set only**, never on modified or renamed files, and that is the whole answer to "may Holi rewrite a note somebody else wrote": a file arriving on `git pull` is committed by the pull and never appears in a staged set at all, and one that has been in the vault for a year is `modified`. What is left is exactly the list the issue asked for, all of them local creations. It also makes `created:` honest without asking git anything — a file being added has no first commit yet, so its creation date is today. **Markdown is not the same as a note**, and `wantsScaffold` in `@holi/shared` is where that is decided: the agent surface is excluded because `CLAUDE.md` and a skill are read verbatim as instructions and a block on top of one is prompt text rather than metadata (the argument D82 already made when it refused to put a note's icon there); task files because `serializeTaskFile` owns their frontmatter outright; and anything hidden, which is Holi's own config. It is the one transform whose change is **visible**, which is why it is its own transform rather than a fourth rule inside `normalize-md`, whose contract is "changes the author would not have noticed being made".
   **`memory-index` keeps `memory/index.md` current** (D89, and see [`agent.md`](agent.md) §Memory). It is the one transform that reads the whole **tree** rather than the staged set, so it is registered **last** — it has to see the tree the other four left behind, including a file `relink` has just rewritten links in. It is gated on the diff and indexed from the tree: `StagedChanges` decides *whether* to run, since this fires on every commit and most commits are note edits, and `listFiles` then decides *what* goes in, because indexing from the diff alone would drop every memory the commit did not happen to touch. It writes only when the text differs, since a `changed` entry the runner dutifully restages for a file nothing rewrote is an empty commit.

    **It is also why `StagedChanges` carries deletions.** Until it, the staged set dropped `D` outright, on the sound grounds that "there is nothing to rewrite in a file that is going away" — true of all four transforms that rewrite the changed file themselves. `memory-index` is the first whose output is a list of what *exists*, so a deleted memory that did not re-index would leave the index naming a file that is gone. The field is populated and the other four go on ignoring it. And it lists **shared memories only** — the index is committed, and a `memory/x.local.md` must appear in no committed file.

    - **The commit boundary is the only place the transforms can live**, because `git diff --cached -M` is the only source of a rename's `from → to` map. To the watcher a move is a delete plus an add, arriving as two unrelated events with nothing pairing them. `memory-index` is the exception that proves the rule and stays there anyway, for the other two reasons: the **restage**, which is what puts the index in the same commit as the memory rather than in a follow-up commit forever, and **coalescing**, so a burst of memory writes in one agent turn is one commit with a correct index.
    - **A transform can never block a commit.** Holi's auto-commit *is* the user's save, and a transform is an opinion about formatting or link hygiene; an opinion does not outrank someone's words. A transform that throws is caught, logged, and the commit proceeds — as do the transforms after it. A failure repeated three times running disables that transform for the session and says so. The **large-file guard is the one exception and stays a veto**: git history is permanent and push is automatic, so an oversized blob committed once is published to everyone, forever. That is an integrity check, not an opinion.
    - **The vault's `.holi/settings/app.json` says which transforms run; it can never say what one is.** Data, never code. The script body ships in the binary and is written to `.git/hooks/`, which git never commits and nothing can push — so a teammate cannot land a hook that runs on your laptop. Pointing `core.hooksPath` at the tracked tree would be exactly that, and it would also silently disable the large-file guard, since git consults only `core.hooksPath` once it is set.
    - The hook script itself is a `curl` and an `exit 0`: it hands the commit to the running Holi over the loopback ops port and the real work happens in TypeScript, where it is tested. A commit typed in a terminal with the app closed finds no endpoint and proceeds untouched. Every run appends to a capped, machine-local `.holi/state/hooks.local.log`.

### Pulling
9. **FR-9** Holi **fetches and merges** on an interval — **3 minutes** (`pullIntervalMs`) — and on window focus, throttled to once per **30 seconds** so alt-tabbing does not fetch in a loop.
    - **No backoff for a quiet vault**, deliberately: focus-triggered pull makes the interval nearly irrelevant for a vault someone is actually using, and a fetch on an idle repo is cheap enough that varying it would be machinery serving nothing.
    - **Auto-pull pauses for the duration of an agent turn** (the same suspend Git coexistence uses), because a file moving under the agent fails its read-before-edit guard. The pause is capped, so a turn that never signals its end cannot strand the vault paused.
10. **FR-10** Pull uses **merge, never rebase**. With dozens of unpushed autosave commits, a rebase replays each one and can conflict *repeatedly on the same hunk* — a failure mode manufactured entirely by autosave granularity. Merge resolves the divergence once. Non-linear history is the accepted price.
11. **FR-11** A clean merge is **silent**. The file tree and any open editors update themselves ([`notes-editor.md`](notes-editor.md)); no notification, no dialog. **Including a merge that changes the file you have open** — which is the uncomfortable case, and it stays silent: an announcement mid-paragraph interrupts to report something already handled correctly, and the editor's reload preserves the caret precisely so it does not need announcing. If it proves surprising in practice, the fix is a quieter signal than a notification, not a dialog.
12. **FR-12** A merge that **conflicts is aborted immediately** (`git merge --abort`), restoring a clean tree. Auto-pull then **pauses for that vault** so it does not retry and re-abort in a loop.

### Pushing
13. **FR-13** Local commits **push automatically** — there is no Publish step. A push fires on a **coalescing debounce of 15 seconds** (`pushQuietMs`, so a burst of commits is one push), and immediately on the leave points **⌘S, window blur, tab close, vault switch, and quit** — best-effort on those last two, within a **1-second budget** (`pushBudgetMs`) so an unreachable remote never hangs a quit. A vault open, a window focus, and a clean merge each push too, draining anything left behind.
    - **Why the push debounce is five times the commit debounce:** a landed commit is already durable on disk, so batching a burst of them costs nothing that matters. Both numbers are tuned against real use rather than derived, and both are overridable (`SyncTimings`) so tests do not wait out a real one.
14. **FR-14** A push rejected **non-fast-forward** (the remote moved) recovers **optimistically**: pull inline, then retry the push. A clean recovery pull is invisible; a conflicting one routes into the reconcile path (FR-15/FR-12) — a rejection is just one more way to discover a conflict. Pushing does *not* pull first every time; the recovery is what keeps the common case a single network call.
15. **FR-15** If a recovery pull conflicts, the push stops and hands off to the reconcile path — nothing is pushed and the user's work stays local and intact.
16. **FR-16** A push rejected for **permissions** is reported as exactly that ([`auth-identity.md`](auth-identity.md) FR-13), never as a network or merge failure — it is its own state (**no write access**), because a lost-access problem and a network problem send someone to two entirely different places.
    - **A failed push retries on the coalesce tick, on window focus, and after a pull.** There is no OS network-status listener, so a machine coming back online waits for one of those three rather than being told. That is a deliberate omission — three independent triggers already cover the case, and the laptop-on-a-plane path hits the failure every interval, so it is a flag rather than an error.

### Reconciling
17. **FR-17** A conflict surfaces as a **banner on the vault**, naming how many incoming changes conflict and with which files. It is **non-blocking**: ignore it and you keep working on a clean tree.
18. **FR-18** **Ask Claude to reconcile** (a) pauses autosave and auto-pull, (b) re-runs the merge so the conflict is really in the tree, (c) opens the agent drawer seeded with a prompt naming the conflicted paths, (d) resumes normal operation once the tree is clean. ([`agent.md`](agent.md) §The agent as merge resolver names the parts.) (a) needed no code of its own: a merge in progress is already a `blockedReason`, so (b) is what stops the loops. (d) is `settleReconcile` — see §A reconcile is a state, below.
19. **FR-19** During a reconcile, the conflicted files are **read-only in the editor**. Everything else in the vault stays editable — a reconcile is a lock on the files holding markers, not a mode the vault enters. Both halves of the lock are set (`EditorState.readOnly` and `EditorView.editable`): the first stops the commands, the second takes the caret away, and a caret in a document that silently swallows input reads as a broken editor rather than a locked one. It reaches the plain stack too, because a conflicted `.holi/settings/app.json` is at least as common as conflicted prose.
20. **FR-20** The user can always **abandon** a reconcile: `git merge --abort` returns to the pre-merge state, which is a commit, so nothing is at risk. Offered as **Abandon**, beside the sync state in the footer, for as long as the reconcile runs. What it returns to is the state the reconcile started from — a clean tree with the conflict **still waiting** — so the banner comes back with it. Clearing the conflict instead would report a teammate's change as dealt with because you changed your mind about who should resolve it.

**A reconcile is a state, and it ends on a signal nobody sends.** `reconciling` is the seventh state in FR-21, and until the reconcile flow was finished it was a kind in the union that nothing could produce. Three facts had to be told apart, and all three are "a merge exists": a **conflict banner** over a clean tree (the auto-pull aborted — FR-17, non-blocking), a **reconcile** Holi materialised for the agent, and a **merge someone started in a terminal**, which is FR-2's refusal and none of Holi's business. The middle one is the only one that locks files, so it is the only one that needed its own name.

Its end is the part with no event behind it: **the agent's merge commit is the signal**, and the only place a fresh `git status` is read on every tick is where the state is computed — so that is where the end gets noticed. Without it the vault stayed latched after the merge landed, with autosave and auto-pull off and a banner over a repo with nothing wrong with it, until the user clicked reconcile a second time to clear a conflict that was already gone.

**A turn ending is not the reconcile ending.** Git coexistence pauses the vault for each assistant turn and lifts it afterwards, and lifting it also clears the sticky conflict pause (FR-12's escape). A reconcile runs *through* the agent, so its first turn ending would otherwise read as "done" and take the editor's locks off files that still hold markers. The reconcile outlives the turns it is made of.

Checked by hand, and what was left unchecked: [`../verification/2026-08-21-reconcile-lock-and-abandon.md`](../verification/2026-08-21-reconcile-lock-and-abandon.md) (2026-08-21).

### State display
21. **FR-21** Each vault shows exactly one sync state: **up to date**, **pulling**, **offline — N waiting**, **no write access**, **conflict**, **reconciling**, or **paused**. It lives **bottom-left in the window footer**, where it doubles as the entry to the whole-vault commit history — "where am I, and is my work elsewhere" in one glance. (It was specified for the vault dropdown, and the footer won: the dropdown answers *which vault*, and the footer is also where a conflict's quiet reconcile affordance belongs.) There is no "N to publish": because push is automatic, `ahead > 0` in normal operation is a bounded transient (the coalesced push has not fired yet) and is deliberately not surfaced — a counter flickering up and down every few seconds of typing reports nothing worth seeing.
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
- **A whole-vault commit browser** — a **tab**, opened from the footer sync state. Every commit in the vault on the left; picking one gives **one collapsible per changed file with that file's diff inside it, expanded**, so the whole commit is on screen and scrolls as one thing. Where the drawer is file-first, this is commit-first, and a commit is one act rather than a list to click through. It was a full-screen modal with a third pane for the selected file, and became a tab for the reason settings did (#16): a modal blocks the window exactly while you are comparing a commit against the note it changed. Each file asks for its own diff as it opens, so a thirty-file commit fetches in parallel and a file you collapse and reopen costs nothing.
- **Restore writes the old content as a new commit — never a rewrite of history.** Same argument as the machine-local reminder watermark: history is append-only, so restoring is an ordinary edit that lands as `Update <path>`, and the version you left is still in the log.
- **No custom snapshot store.** `yjs_snapshots`, `snapshots.take`, `pre-agent-write` labels, the reason taxonomy, and the retention question they raised are all deleted. Git's object store is the snapshot store, and it already handles retention.
- **A flat log, not a curated one.** An earlier plan folded consecutive `Update …` autosave commits away and surfaced only the landmarks (merges, reconciles, deliberately-authored commits). That fold was **dropped**: these are real commits and the user is a developer, so the timeline is the straight `git log` — autosave messages shown as what they are. A push leaves no commit, so the log has no push in it; making the shared journal terser is *squashing* (below, §Edge cases), not a display filter.

---

## Edge cases & risks

- **Autosave committing something half-written** — by design; the journal is the autosaves, shown in the timeline as the commits they are. If the flat log proves too noisy to read, the lever is squashing the autosave journal — a periodic or on-push fold, **leaning no** because the fine-grained timeline *is* the history feature — not a coarser debounce that risks losing work.
- **A pull landing while the agent is mid-turn.** The agent's `Edit`/`Write` would fail their read-before-edit guard on a file that moved, which is the correct outcome but a wasted turn. **Resolved by pausing sync for the turn** (FR-9), which has its own failure mode — a long turn blocking sync — contained by capping the pause, since Claude Code's `Stop` hook is not guaranteed on an interrupt or a crash.
- **The `.git` directory is reachable by the agent.** It has `Bash` and the clone is a repo, so `reset --hard` and `push --force` are expressible ([`agent.md`](agent.md) §Security). Bounded by native permission prompts and branch protection, not by trying to blocklist git.
- **Two Holi instances on one clone** (the app opened twice) would race on commits. Take a lock on the clone.
- **Large binaries in an adopted repo.** Git history is permanent and replicated to every clone, and push is automatic — so a big binary committed once is published to everyone, forever, before anyone reacts. **Holi holds oversized files back** rather than warning after the fact: the autosave commit skips any file over the cap (it stays on disk, unstaged, unpushed), and a footer callout offers *commit anyway* or *keep local* (git-ignored machine-locally via `.git/info/exclude`). The same gate covers the agent's own commits through a seeded `.git/hooks/pre-commit`. The cap is `maxCommittedFileBytes` in `.holi/settings/app.json` (synced; default **10 MB**); `git commit --no-verify` is the deliberate override. Git-LFS auto-setup is deferred — the hook only points at it. Design: [`docs/specs/2026-08-03-large-binary-policy-design.md`](../specs/2026-08-03-large-binary-policy-design.md).
- **A repo with a non-default primary branch, or protected branches requiring PRs.** FR-2 refuses rather than improvises; a protected default branch makes the automatic push fail in a way that must be reported honestly rather than retried in a loop.
- **Clock skew between machines** affects nothing — git orders by parentage, not time.
- **Very large vaults.** A full filesystem walk on open and a watcher over thousands of files is fine at Syv's scale and is the first thing to measure if it isn't.
- **A conflict in `.holi/settings/app.json` or `.claude/settings.json`** is a conflict in config, not content, and can leave the vault misconfigured while it lasts. The reconcile path handles it like any file, but these are the ones worth showing prominently.

### `.holi/settings/app.json` has a schema (D85)

It used to be parsed by two independent hand-rolled readers with nothing shared between them: one for `maxCommittedFileBytes`, one for the `hooks` block. Both now call `resolveVaultSettings` in `packages/shared`, which parses the whole file once, validates every field, and answers the default for anything absent or malformed. Nothing on this path can throw, because a typo in an unrelated key must never break the commit path or stop a vault opening.

*Data, never code* (FR-9) is unchanged and is now enforced by a whitelist rather than by convention: the resolver builds a fresh narrow object per key and never returns what it parsed, so a committed file written by a collaborator cannot carry anything else through. The same validator guards the one write there is (the onboarding step), which is why that procedure takes JSON strings rather than objects: `fields` accepts only strings and booleans, so a patch has to be parsed in main, and the check cannot be skipped.

A machine-local `.holi/settings/app.local.json` overrides it **per key**, the layering theme (D64) and icons (D82) already use. It never syncs, and it is where `colorScheme` lives: a collaborator's committed choice flipping your app to light mode is the failure that layer exists to prevent. Unknown top-level keys are ignored **without a warning**, because the reminder delivery watermark already keeps a `reminders` block in the local file.

### Settings are a tab (2026-09-09, [`#16`](https://github.com/syv-ai/holi/issues/16))

Until now **no setting was editable from the running app**: the onboarding ritual was the only writer and it is a one-shot flow you cannot get back to, so changing a hook or the editor font meant hand-editing JSON. Settings is now an ordinary singleton tab — splittable beside the note you are changing it for, closable, one per window — and **a tab rather than a modal on purpose**, because a modal blocks the window exactly while you want to compare a setting against the vault it applies to.

**One list, three readers.** The pane renders `VAULT_SETTING_DESCRIPTORS` and writes through `settings.write`, which is the ritual's only writer, so the two surfaces structurally cannot drift into writing different shapes. The ritual renders `RITUAL_SETTING_DESCRIPTORS` — the subset whose `askedAtBirth` is true — and the seed writes that same subset. **Not every setting is a question for a stranger**: the ritual is four acts long and every row is one more thing between somebody and their first note, so a preference with a good default and no consequence at birth stays out of it. `editorFont` is the case that forced the distinction (D87 deliberately gave it no ritual row) and it is a first-class row in the pane.

**Each row says which layer it writes**, `vault` or `this machine`, because a pane that silently committed a machine-local preference would defeat the layer it was writing to.

**Changes apply now, and that question is settled rather than dodged.** The resolved settings are cached per vault, and the cache's own docstring said re-reading them mid-session would mean answering "what happens to the tab you are looking at". The answer turned out to be that most of them already apply: `hooks` and `maxCommittedFileBytes` are read by main on every commit, `colorScheme` re-applies through `useVaultTheme` (D85), and `editorFont` is a CSS custom property. So a write forces the cache and the app follows. **`landing` is the exception and its row says so**: it describes what happens when a vault opens, and this one already did.

**The resolver's `warnings[]` are shown**, each beside the setting it names, which nothing displayed before — a malformed value was replaced by a default and never mentioned. And the files stay the interface: the pane offers `.holi/settings/app.json`, its `.local` sibling and `.holi/settings/theme.json` as tabs, the same escape hatch "Edit Icon…" gives its map.

**What it does not do yet.** `maxCommittedFileBytes` has no control: D85 argued a number should not be frozen into every vault, and that argument was about the *seed* rather than about an explicit choice in a pane — it has not been re-argued, so the file remains that setting's interface. Theme tokens (D64) have no controls either; the pane links the file. And the other `.holi/*.json` files are deliberately left where they are — `vault.json`, `icons.json`, `seed-state.local.json` and `context.local.json` are state or data that happen to be JSON, not settings, and moving config files in a committed vault breaks every vault that exists to buy tidiness.

---

## Dependencies

- **[`auth-identity.md`](auth-identity.md)** — the GitHub token this engine pushes and pulls with, and the managed clone root.
- **[`notes-editor.md`](notes-editor.md)** — the editor's autosave and its 3-way reload of files this engine changes underneath it.
- **[`agent.md`](agent.md)** — the drawer that hosts a reconcile.
- **[`tasks.md`](tasks.md)** — task files are ordinary files in the repo and get these semantics for free.
