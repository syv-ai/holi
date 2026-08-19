# Large-binary / vault-size policy — design

**Date:** 2026-08-03
**Status:** approved, ready for planning
**PRD refs:** `docs/prd/vaults-sync.md` §Edge cases ("Large binaries in an adopted repo"); `docs/not-built.md` §Notes & editor, "Where large binaries live at scale" (the deferred vault-size question that survives D62; it was written in a since-deleted phase-2 stub); `docs/decisions.md` D62.

## Problem

`git add -A` in the autosave commit path commits any file, including large binaries. Git history is permanent and replicated to every clone, so **one 200 MB file committed once lives forever in everyone's clone**. Because push is automatic (D61), there is no un-stage window: a big file lands in a commit and rides to every collaborator before the author notices.

- **Primary concern (a):** git-history bloat / permanence.
- **The real fear (c):** accidental *publish* — the auto-push means an oversized binary is shared and permanent before anyone reacts.

D62 already settled what a binary *is* (an ordinary committed file — no convert-on-entry, no forced archival). This design does **not** revisit that. It adds the missing guard for the *large* case.

## Decision

**Hold-back, not warn-after.** A warning after the commit is too late — fear (c) has already happened. Instead, oversized files are **kept out of the commit** until the user explicitly decides. Two cooperating gates at one threshold:

1. **Holi autosave → selective add** — covers files the *user* drops in.
2. **Seeded git pre-commit hook → covers the agent** (and any direct `git`), which commits in the same clone (D60) and would otherwise bypass a Holi-only gate.

### Threshold

- Default **10 MB**. Legit notes-vault assets (images, PDFs) sit well under; 10 MB catches videos, datasets, exported binaries. (GitHub warns at 50 / blocks at 100 MB; a notes vault should be tighter.)
- Configurable per-vault in `.holi/settings.json` as `maxCommittedFileBytes` (an integer byte count). This is the **synced/shared** config (`.holi/settings.json` is a `VAULT_CONFIG_FILES` member) — one policy for the whole vault, so every collaborator's hook enforces the same limit. Documented — the users are developers. Absent/invalid → the 10 MB default.
- **Net-new reader.** There is no `.holi/settings.json` reader today (only `.holi/settings.local.json`, read by `reminders/delivered-log.ts` — mirror that JSON-read pattern). The file is not seeded and need not exist; the reader returns the default when it is absent. Establishing this reader is part of the work, and it is deliberately minimal (read one integer key), not a general settings framework — YAGNI.

## Mechanism

### Gate 1 — selective add (Holi's own commits)

Today `commitTick` (`active-vault.ts`) reads `status()` then calls `commitAll(msg)`, which runs `git add -A` + commit. Change:

- `commitTick` stats each path in `status.dirtyPaths`, and partitions via the pure `partitionBySize` helper into `commit` (≤ threshold, **plus all deletions** — a delete has no size and is always safe) and `heldBack` (> threshold).
- `commitAll` gains an explicit pathspec: it stages **only** the `commit` paths (`git add -A -- <paths>`) rather than `-A` over everything. Oversized files stay unstaged and uncommitted.
- The `heldBack` set is surfaced to the renderer (Gate 3). It is **derived every tick from current sizes**, never stored — a file drops off the instant it is resolved or shrinks.

### Gate 2 — seeded pre-commit hook (the agent + direct git)

- Git hooks live in `.git/hooks/`, which is **not** committed/synced, so this is a machine-local install, not a seeded repo file. Holi installs/regenerates a `pre-commit` hook into each clone's `.git/hooks/` on **open/clone** (alongside the existing clone setup).
- The hook rejects any commit that stages a file over the threshold, exiting non-zero with a clear message naming the file, its size, and the options (keep local / Git LFS). The agent (pure Claude Code) sees the failure and adapts.
- The resolved threshold is written into the generated hook at install time (regenerated on open, so a `.holi/settings.json` change re-installs with the new number — no runtime config read from inside the hook).
- **Bounded, not a prison:** `git commit --no-verify` bypasses it, consistent with D62/agent security ("bounded by native permission prompts and branch protection, not by trying to blocklist git"). The hook guards *accidents* — exactly fear (c).
- Holi's own selective-add never stages an oversized file, so its ordinary autosave commits never trip the hook (no `--no-verify` needed there).

### Gate 3 — the held-back surface (renderer)

A callout above the footer, reusing the config-conflict banner pattern (`Shell.tsx`). Lists the currently held-back files with sizes. Derived from the held-back set, so it clears itself as files are resolved. Per-file actions:

- **Commit anyway** — the user wants this big asset in git. Holi stages it and commits with `--no-verify` (the one deliberate hook override). Syncs from then on. *(main procedure)*
- **Keep local** — on disk but never in git. Holi appends the path to **`.git/info/exclude`** (git-native, machine-local, uncommitted — no shared-`.gitignore` pollution; another laptop decides for itself). Git stops seeing it as untracked, so it never re-triggers. The file stays on disk and still shows in the tree. *(main procedure)*
- **(default) leave it** — do nothing; stays uncommitted, keeps showing until decided. Nothing lost, nothing published.

### Sync-state interaction (load-bearing)

After the selective-add commit, held-back oversized files are **still** untracked in the working tree, so a naive `status.dirty` reads "never clean" — pegging the sync label at "not up to date" forever and spinning `commitTick` on a no-op commit.

Fix: partition `status.dirtyPaths` into `real-dirty` (dirtyPaths minus heldBack) and treat the tree as **clean / up-to-date when the only remaining dirty entries are held-back files**. `commitTick`'s "anything to commit?" check and the sync-state computation both key off `real-dirty`. The footer reads "up to date", optionally "· N held back".

## Components / file map

- **`partitionBySize(dirtyPaths, sizeOf, threshold) → { commit, heldBack }`** — pure, new. Home: a small main util (e.g. `main/vault/large-files.ts`) or `packages/shared` (no fs — takes an injected `sizeOf`). Unit-tested.
- **`main/git.ts`** — `commitAll` takes an explicit pathspec (stage only given paths); `changedFiles`/`status` unchanged.
- **`main/vault/active-vault.ts`** — `commitTick` stats + partitions + calls `commitAll` with `commit` paths; sync-state / "anything to commit" key off `real-dirty`; push held-back set to the renderer (extend the snapshot or a dedicated `vault:heldback` channel).
- **`main/vault/large-files.ts`** (or similar) — the pre-commit hook template + `installGitHook(root, threshold)`, called from the clone/open path.
- **`.holi/settings.json` reader** (net-new; mirror `reminders/delivered-log.ts`'s local-JSON read) — one key, `maxCommittedFileBytes`, default 10 MB when the file/key is absent or invalid.
- **`main/router.ts`** — `vaults.commitFile` (commit-anyway) and `vaults.keepFileLocal` (append to `.git/info/exclude`) procedures.
- **`renderer/.../components/Shell.tsx`** — the held-back callout + per-file actions; **`state/`** wiring for the held-back set.

## Testing

- **`partitionBySize`** — pure, node: deletions always commit; a >threshold file is held back; boundary at exactly the threshold; empty input.
- **Selective-add + sync-state** — router/active-vault rig (real git): oversized file not committed, ≤threshold changes committed, tree reports **clean/up-to-date** with the oversized file still on disk; `commitTick` does not spin.
- **Pre-commit hook** — run the generated script against a real repo: non-zero + message when an oversized file is staged; pass when nothing oversized is staged; respects the written threshold.
- **commit-anyway / keep-local** — commit-anyway lands the file (bypasses the hook); keep-local appends to `.git/info/exclude` and the file leaves the held-back set.
- **Threshold config** — parsed from `.holi/settings.json`; default when absent/invalid.

## Build order (tracer-bullet slices)

1. **Pure partition + threshold read** — `partitionBySize` + `maxCommittedFileBytes` config.
2. **Core hold-back** — selective-add in autosave + sync-state exclusion. *Shippable on its own: nothing large auto-publishes via Holi.*
3. **Held-back surface** — callout + commit-anyway / keep-local procedures.
4. **Agent coverage** — seeded pre-commit hook install.

## Out of scope (YAGNI)

- **Git-LFS auto-setup** — the hook message *points* at LFS; wiring it is a separate, larger decision.
- **Per-file tree badges** for held-back state — the callout suffices for v1.
- **Round-tripping / archival to object storage** — dead under D62.
- **Retroactively scrubbing already-committed large files** — this guards new commits; existing history is a separate cleanup.
