# Design — Sync pushes automatically; "publish" is gone

**Status:** agreed with Nicolai 2026-07-24. Amends D60 point 2 ("auto-pull, explicit push"). Allocated **D61**.

**One-liner:** A vault's local commits leave for the remote on their own — on a short coalescing timer and on the moments a user steps away — so there is no Publish button, no "N to publish" state, and no `publish()` operation. The only time unpushed work is *shown* is when a push is actually failing.

---

## Why

D60 landed sync as "auto-pull, **explicit** push": edits become local commits, but they only reach the remote when the user clicks **Publish**. That was the right shape for the pivot, but it leaves the user holding a chore whose value is near-zero: nobody benefits from choosing *when* their half-typed sentence reaches the remote. The two things a push actually buys — off-machine durability and teammates seeing your work — are both happy with a latency of *tens of seconds*, which a machine can decide better than a person.

Removing publish also removes a class of confusion the version-history slice would otherwise inherit: a publish leaves **no commit of its own** (a push creates no object), so it can never be a row in a `git log`-based timeline. With publish gone as a concept, the timeline is just the log, with no phantom landmark to reconcile.

**Rate limits are not the binding constraint.** `git push`/`git fetch` over HTTPS ride the git smart-HTTP protocol and do **not** consume the REST/GraphQL 5,000-req/hour quota; our pushes go through `GIT_ASKPASS` and never touch the REST API. Git's own secondary/abuse limits target concurrency and bandwidth, far above what a single editor generates. The real cost of over-eager pushing is **churn** — local process spawns, tiny commits piling onto the remote, and every teammate's pull loop merging them — which is what the coalescing cadence below is designed to bound, not a rate ceiling.

---

## The two cadences (decoupled)

Commit cadence and push cadence are now separate timers.

- **Commit** — unchanged from D60. 3s idle debounce (`commitQuietMs`) + the FR-6 leave points + ⌘S. Local, keeps the working tree clean between commits (FR-7), crash-safe.
- **Push** — a new coalescing debounce (target **~15s** of quiet) fires a background push. Continuous typing therefore collapses into a handful of pushes rather than one every few seconds, while anything you *finish* leaves immediately via the leave points below.

**Immediate best-effort push on:**
- **⌘S** — an explicit "save this" gesture; commit-then-push, non-blocking.
- **Leave points** (window **blur**, **tab close**, **vault switch**) — fire-and-forget in the background; failure is caught by the coalesce timer / offline state.
- **Quit** — best-effort with a **~1s courtesy budget**, reusing the shape of the existing flush-on-quit path (`onFlushRequest`/`flushDone` — "a courtesy, not a lock"). Online → last edits reach the remote before the window closes. Slow/offline → silently deferred to next launch. The commit on quit (FR-6) already made the work durable on disk, so nothing is at risk either way.
- **Vault open** — drains anything a killed quit or a prior offline session left unpushed.
- **After a successful pull** and **on window focus** — so coming back online flushes the backlog.

---

## Push-failure taxonomy

This is what makes an unattended push safe. A push's outcome is classified (extending the existing `classifyPushFailure`, which already distinguishes `permission` from `non-fast-forward`):

| Outcome | Handling | User sees |
|---|---|---|
| **Pushed** | Done. `ahead` returns to 0. | `up to date` |
| **Can't reach remote** (network) | Leave the commits local; retry on the next coalesce tick, focus, or pull. | `offline — N waiting` |
| **Non-fast-forward** (remote moved) | **Optimistic recovery**: pull inline, then retry the push. Clean merge → invisible. Conflict → drops into the **existing** `conflict`/reconcile path (FR-12/FR-18). | nothing, or `conflict` |
| **Permission** (write access lost) | Surfaced as *exactly that* (FR-16 survives) — its own state/banner, never conflated with `offline`. | permission refusal |

A non-fast-forward rejection thus becomes simply *one more way to discover a conflict*, funnelling into machinery that already exists rather than new code.

---

## State display (FR-21 rewritten)

- **Resting: `up to date`.** The transient ahead-window during coalescing is **not** shown — it flickers and resolves itself in seconds, and showing a counter that ticks up and down while you type is the churn we're avoiding.
- **`offline — N waiting`** — only when a push is actually failing on the network. This is the honest reading of FR-22 ("never say synced when it isn't"): synced unless something is stopping you, and then it says exactly what and how much.
- **`pulling`, `conflict`, `reconciling`, `paused`** — unchanged.
- **Removed:** `N to publish` and `publishing`.

`SyncState` vocabulary loses `{ kind: 'publishing' }`; `{ kind: 'ahead'; count }` is retained but now means *offline/failing with N unpushed*, rendered as "offline — N waiting" (the resting ahead>0 window is not surfaced as this state).

---

## Code changes

- **`main/vault/active-vault.ts`**
  - Remove `publish()` from `ActiveVault` and the `publishing` `SyncState`.
  - Add a **push coalescer**: a debounce timer, plus triggers on the leave points / focus / open / post-pull / ⌘S.
  - Add `pushNow()` (best-effort, used by ⌘S, quit, leave points) and internal `ahead`/offline tracking that drives the state.
  - Non-fast-forward → inline pull → retry; a conflicting pull routes to the existing conflict handling.
- **`main/git.ts`**
  - `GitRepo.publish()` (the pull-then-push combo) is no longer the entry point and is removed; the optimistic push-then-maybe-pull logic lives in `active-vault.ts`. `pull`, `push`, `classifyPushFailure`, `status`, `log`, `commitAll`, `abortMerge` all stay.
- **`main/router.ts`**
  - Remove the `sync.publish` procedure. `sync.commitNow`, `sync.state`, `sync.pause`, `sync.resume` stay.
- **`renderer` (`Shell.tsx` + sync-label)**
  - Remove the **Publish** button and its publish-conflict banner. The footer reflects sync state only.
  - `lib/sync-label.ts` loses the `publishing`/`N to publish` cases, gains the `offline — N waiting` rendering.

---

## Docs

1. **`decisions.md`** — add **D61** (this decision + reasoning), bump next-free to D62.
2. **`prd/vaults-sync.md`** — fold natively:
   - **§Publishing → removed**; its surviving content (pull-before-push ordering as *optimistic recovery*, the permission-vs-network distinction) merges into a renamed **§Pushing** beside §Committing.
   - **FR-13–FR-16** rewritten: FR-13 becomes "commits push automatically on a coalescing timer + leave points"; FR-14 becomes the optimistic non-fast-forward recovery; FR-15 folds into the conflict path; FR-16 (permission reported as permission) survives verbatim.
   - **FR-21 / §State display** rewritten per above; `N to publish`/`publishing` removed from the vocabulary.
   - **§Why these choices** — the "why local commits rather than staying dirty until publish" paragraph updates: local commits are still the mechanism, but "until publish" is gone.
3. Purge the D61 inbox entry once the code matches (D60 convention).

---

## Scope boundary

This does **not** build the version-history timeline. That is the next slice, now unblocked to be built against this model — a plain `git log --follow` with no publish rows to account for.

## Open questions (deferred, not blocking)

- **Exact push debounce.** ~15s is the starting point; tune against real use, same as the commit debounce (vaults-sync §Open questions).
- **Offline→online detection.** v1 relies on the coalesce tick + focus + pull to retry; no OS network-status listener. Add one only if the retry latency proves annoying.
