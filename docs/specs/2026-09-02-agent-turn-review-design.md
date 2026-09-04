# Agent turn review (D88) — design

**Date** 2026-09-02 · **Status** designed, not built
**Source of the idea** `syv-ai/ailex-but-better-private` @ `f75e931`, whose document panel stages the
agent's edits as a pending diff with per-change accept and reject.

## The gap

The agent writes a file. The watcher reports it, `decideReload` reloads a clean buffer silently, and
the sync loop commits within three seconds. That is the whole of it: **there is no moment at which
you see what changed.** Git has the answer, but only if you go looking, per file, in a panel you open
deliberately, without knowing which files to open.

Ailex closes this by holding the edit out of the document until the user accepts it. Holi cannot copy
that, and the reason is a decision already made: [`../prd/vaults-sync.md`](../prd/vaults-sync.md)
§Non-goals states that there is no outbound gate, that every commit is pushed whole, and that there is
no Publish step or selective staging. A gate in front of the agent's writes would argue with that,
and it would also duplicate Claude Code's own permission prompts, which already ask before `Write`
and `Edit`.

So the Holi shape is not *accept or reject before it lands*. It is **see what landed, and take back
the parts you did not want** — which git makes cheap, because a rejection is a revert commit.

## The unit is the turn, and a turn is a commit range

Holi already brackets a turn: the seeded `UserPromptSubmit` and `Stop` hooks post to the hook server,
and `agent-manager.setTurnActive` suspends the vault's sync loop between them
([`../prd/agent.md`](../prd/agent.md) §Git coexistence). That bracket is the whole mechanism this
feature needs.

- **Turn start** — record `base = repo.head()`. Sync is suspending at the same instant, so nothing
  moves HEAD except the agent's own commits.
- **Turn end** (`Stop`, or the existing safety cap when `Stop` never fires) — resume the loop,
  commit the catch-up explicitly, and record `end` as the resulting sha.
- The turn's changes are exactly `base..end`. When `base === end` the turn changed nothing and there
  is no chip.

**Why a range rather than a diff against the working tree.** A working-tree diff keeps growing: open
the review tomorrow and it attributes a day of your own writing to the agent. The range freezes at
the settle commit and stays true forever, which is what makes "review is a lens on git" more than a
slogan.

**What the range honestly contains.** Everything committed between turn start and the settle commit,
including keystrokes you made while watching the agent work. Attributing hunks within a turn is not
answerable from git and is not worth a second mechanism, so the panel's header says the turn, not the
author, and the copy never claims every hunk is Claude's.

## Storage

`.holi/turns.local.json` — a capped list (50) of `{ base, end, at }`, newest first.

Local by the `.local.` convention (D65), so it never syncs; capped and machine-local exactly as
`.holi/hooks.local.log` already is. Two shas per turn is the entire record. A range whose commits
have since been dropped (a branch switch, a reset) resolves to nothing readable, and the panel says
the turn's history is gone rather than erroring.

## The surface

**A footer chip.** `Shell.tsx`'s footer already carries the sync state and the quiet reconcile
affordance; the chip joins them, reading `Claude changed 4 files`. It appears when a turn's range is
non-empty. It does not block, does not toast, and does not take focus. A config conflict still
outranks it, as it outranks everything else in that region.

**A side panel**, same shape as `HistoryPanel` and sitting beside it: the changed paths with their
added and removed line counts, each expanding to that file's diff across the range, with per-hunk
controls live.

Per-file banners were the alternative and lose: a turn touching eight files says it eight times, and
files you do not have open say nothing at all.

## Reverting a hunk

`composites/DiffView.tsx` already wraps `@codemirror/merge`'s `unifiedMergeView`, and passes
`mergeControls: false` because the history panel is a view of the past. This feature is the same view
with the controls on: `original` is the file at `base`, the doc is the file at `end`, and the
package's own reject action reverts a chunk to `original`.

When a file's chunks are settled, the resulting text is written through `writeAtomic` and committed
with `commitNow` — the same two calls `history.restore` already makes. **A revert is a new commit,
never a rewrite of history**, which is the rule §History already sets for restore.

**A file open in an editor needs no special case.** The write hits disk, the watcher reports it, and
`decideReload` decides: a clean buffer reloads, a dirty one 3-way merges, an overlap routes to
reconcile. That machinery exists and this is precisely the case it was built for.

## Rejected

- **Gating writes with a `PreToolUse` hook**, in the shape D70 uses for Google sends. It duplicates
  Claude Code's own permission prompts, an agent making twenty edits would ask twenty times, and it
  contradicts the no-outbound-gate decision.
- **Recording touched paths from a `PostToolUse` hook** on `Write|Edit|MultiEdit`. The git range is
  strictly better: it catches files the agent changed through `Bash` (a `sed`, an `mv`, a script),
  which a tool matcher never sees.
- **Per-file banners in the `ConflictBanner` slot.** Repeats itself per file and misses closed ones.
- **A queue of unreviewed turns with an unread count.** State to persist and invalidate, in exchange
  for a badge people learn to ignore. Every turn stays reviewable anyway, because the record is two
  shas.

## Not adopted from Ailex, and why

Named here because they are the tempting parts. Ailex keeps its document in three places at once —
the model's memory, the browser panel, and a replay of persisted tool records — and the machinery
below exists to keep those three agreeing:

- `DocumentStreamParser`, which renders the document as it is written by parsing partial JSON out of
  streamed function-call arguments. Claude Code's `Write` is one atomic write; there is no stream.
- `missing_edits_lines`, `numbering_read`, `check_line_numbers_current`, `recover_document`,
  `replay_document`. Holi keeps the document in one place, on disk, and read-before-edit is Claude
  Code's own guard.
- Line-numbered `read_document` / `update_document` / `delete_from_document`. `Edit` matches on
  strings and is the better tool.

## Dependencies

`main/git.ts` gains `head()` and a range name-status (neither exists). Everything else is wiring over
`agent-manager.setTurnActive`, the `history` router's shape, `SidePanel`, `DiffView` and the footer.
