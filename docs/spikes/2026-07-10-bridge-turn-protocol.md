# Spike report — D25 file↔CRDT bridge turn protocol

**Date:** 2026-07-10 · **Verdict: HOLDS (with two harness-discovered hardening requirements and one documented reliance).** The frozen-base turn protocol survives everything the acceptance criteria threw at it; no fallback to gateway ops (rejected in D2) is needed. Two implementation subtleties surfaced that the real bridge MUST carry, and one D25 wording correction is warranted.

The bridge (D2/D25) is the only genuinely novel component in the rebuild; this spike built a throwaway harness (`spikes/bridge/`) and hammered the protocol before any other code, per the de-risk mandate in D25.

## What was built

- **Merge core** (`spikes/bridge/src/merge.ts`, ~45 lines — the promotable artifact): at turn end, fork a **shadow Y.Doc** from the frozen base state, apply `diff-match-patch(base → file)` as positioned `Y.Text` ops on the shadow (positions are valid there — the shadow IS the base), then merge the shadow's state-vector delta into the live doc. The shadow acts as a virtual client that went offline at the freeze point and made exactly the agent's edits; **Yjs's own CRDT merge performs the 3-way positional reconciliation**. Never blind-replace.
- **BridgeClient** (`src/bridge-client.ts`): chokidar watcher; first disk≠base event opens the turn (soft lock: CRDT→file re-materialization paused, base frozen); idle debounce ends it; new base = merge result.
- **Harness**: in-process Hocuspocus v2 relay, two `SimClient` humans applying concurrent Yjs edits through real WebSockets, `AgentSim` mimicking CC `Write` (full rewrite) and `Edit` (read → string-replace → write) on the materialized file.

## Acceptance results

| # | Criterion | Test | Result |
|---|---|---|---|
| a | non-overlapping human+agent edits both survive | `protocol.test.ts` "(a)" + `merge.test.ts` | **PASS** |
| b | same-range overlap converges, surroundings intact | `merge.test.ts` "(b)" | **PASS** (see finding 1) |
| c | mid-turn remote edits don't poison the diff | `protocol.test.ts` "(c)" — file provably frozen while the human edit buffers in the live CRDT | **PASS** |
| d | no lost updates under randomized hammer | `hammer.test.ts` — 94 markers, 8 agent turns, 2 uncoordinated humans: **0 missing, 0 duplicated**, all replicas + disk byte-identical; suite green 5/5 consecutive runs | **PASS** |
| e | watcher debounce/coalescing drops no turns | `protocol.test.ts` "(e)" — Write+Edit+Edit coalesce into exactly 1 turn, later burst lands as turn 2 | **PASS** (after finding 3) |

## Findings

1. **Same-range overlap is both-survive, not "last-writer".** Concurrent rewrites of the same range interleave: `start MIDDLE end` edited to `HUMAN` (human) and `AGENT` (agent) concurrently converged to `start AGENTHUMAN end\n` or `start HUMANAGENT end\n` (order decided by Yjs clientID comparison; all replicas agree). Concurrent **deletes** merge cleanly; concurrent **inserts** at the same spot both survive side by side. D25's prose ("character-level last-writer resolves it") should be corrected to "both edits survive adjacently, deterministically ordered" — this is precisely the garble class D26's safety net (overlap flag + agent reconcile) exists for, so no design change is needed, only wording.

2. **Turn end must advance the frozen base atomically — including the agent-still-writing case.** First harness version re-compared disk against the *stale pre-turn* base after merging, re-detected the bridge's own merge as a "new agent turn", and re-applied the same diff in a loop (BETA×13 corruption). The correct sequence, now proven: merge → **base = merge result** → re-materialize → release. And if the agent wrote *again* while the merge ran, the turn continues with **base = the agent's file lineage** (frozen file text + the shadow doc's post-op state), NOT the merge result — the agent's newest content derives from what *it* saw, and diffing it against the merge result would misread buffered remote edits as agent deletions. `applyAgentTurn` returns the shadow state for exactly this.

3. **Watcher events are advisory — coalescing can swallow a foreign write outright.** Observed on macOS/fsevents: an agent write landing immediately behind the bridge's own materialization write was coalesced into ONE change event whose read saw only the echo; the agent's write produced **no second event** and the turn never opened (deterministically reproducible). Content-equality echo suppression alone is therefore insufficient. Fix, now in the harness and mandatory for the real bridge: after any write the bridge makes or ignores, **re-verify disk against base** on a short one-shot timer. With that, acceptance (e) is solid.

4. **CC's read-before-edit guard is load-bearing, demonstrated.** `protocol.test.ts` "stale-write" deliberately writes file content derived from a read taken *before* a remote edit re-materialized: the diff legitimately reads the missing remote text as an agent deletion and reverts it everywhere (convergent, but the human's `h1#` is gone). The bridge *cannot* distinguish stale-revert from intentional delete — by design. Claude Code natively refuses `Write`/`Edit` when the file changed since its `Read` (the D2 reliance), which blocks exactly this window; D26's pre-agent-write snapshot is the recovery story if it ever slips through.

5. **Turn-end detection by watcher idle is workable but the real bridge should prefer an agent-side signal.** The idle debounce coalesces multi-tool turns correctly (test e), but "turn end" defined purely by file quiet means an agent op racing the debounce boundary extends into finding-2/finding-4 territory. The real implementation should end turns on a CC **Stop hook** (or PTY idle state) with the watcher debounce as fallback; turn *start* similarly benefits from a PreToolUse/PTY-busy signal, though the harness's disk≠base detection plus the materialize-time divergence check worked reliably.

## What to promote into `packages/shared` (when the real bridge is built)

`applyAgentTurn` as-is (shadow-fork + dmp diff + SV-delta merge + returned agent-lineage state), plus two invariants from the findings:
- **Base text and base Yjs state are captured atomically at every materialization** — a base whose text and state disagree poisons every subsequent diff.
- **Turn end advances the base before releasing the lock** (merge result, or agent lineage if the turn continues).

The `BridgeClient` shell (watcher wiring, debounce, recheck) is harness-grade; rebuild it properly around PTY/hook signals, but keep the disk-recheck defense (finding 3) regardless of signal source.

## Open questions for the real bridge

- Turn start/end signals: PreToolUse + Stop hooks vs PTY busy/idle vs watcher-only (finding 5) — affects how rare findings 2/4's race windows become, not correctness of the merge itself.
- Rename/delete/create of files during a turn — the spike only exercised content changes to one doc; the real bridge must compose with `note_rename` (D10/D12) and doc lifecycle.
- Very large docs: dmp diff cost and Yjs op fan-out under, say, 1 MB files — no problem at spike scale; measure before worrying (D28 keeps vaults small text).
- Atomic file writes: the harness used plain `writeFile` (truncate+write); the real bridge should consider write-temp-then-rename to keep CC `Read`s from ever seeing a torn file.
