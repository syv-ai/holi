# Auth cluster (Tier 2 #4) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four small auth/identity gaps the PRD already specifies: a copy button on the device user-code (FR-2), avatar + permission level in the members panel (FR-10), an explicit "also delete local clones" on sign-out with an unpushed-work warning (FR-15 / Open-Q3), and a fine-grained-PAT hint on the sign-in screen (§176).

**Architecture:** Three sub-items are renderer-only leaf edits (`SignIn.tsx`, `VaultSettings.tsx`). The fourth (clone deletion) adds a read-only main procedure that summarises unpushed commits across the registry's clones and a mutation that closes the active vault, deletes every clone directory, and clears the registry — driven from a confirm dialog in `VaultSettings`. The advisory unpushed warning is best-effort (Open-Q3 asks only that the warning be *enough*, not a guarantee); deletion is opt-in and confirmed.

**Tech Stack:** React + jotai + tRPC over the IPC link; Node `fs.rm` in main; `openRepo(...).status().ahead` for unpushed counts; Vitest (node project for pure/main logic under `apps/desktop/test/`, dom project for renderer).

---

## File structure

- `apps/desktop/src/renderer/src/features/auth/SignIn.tsx` — copy button (A) + PAT hint (D-hint).
- `apps/desktop/src/renderer/src/features/vault/VaultSettings.tsx` — avatar + permission (B); sign-out confirm dialog wiring (D).
- `apps/desktop/src/renderer/src/lib/unpushed-warning.ts` *(new, pure)* — formats the unpushed summary into the warning sentence; unit-tested.
- `apps/desktop/src/renderer/src/state/session.ts` — `signOutAtom` takes `{ deleteClones }`; new `unpushedSummaryAtom` reader.
- `apps/desktop/src/main/router.ts` — `vaults.unpushed` (query) + `vaults.deleteClones` (mutation).
- Tests: `apps/desktop/test/unpushed-warning.test.ts` *(new)*; extend `apps/desktop/test/collaborators-error.test.ts` neighbours as the pattern.

## Contracts

```ts
// packages/shared already has: Collaborator { accountId, login, avatarUrl?, permission }

// main router — new procedures under the existing `vaults` router:
vaults.unpushed(): Promise<{ remote: string; ahead: number }[]>
//   one entry per registry clone with ahead > 0; per-vault errors swallowed (best-effort, advisory).
vaults.deleteClones(): Promise<{ ok: true }>
//   closes the active host, rm -rf every registry clone path, clears the registry. Idempotent.

// renderer state:
signOutAtom = atom(null, async (_get, set, opts?: { deleteClones?: boolean }) => …)
//   deleteClones → await trpc.vaults.deleteClones before auth.signOut; then session := null.
unpushedSummaryAtom  // async reader over trpc.vaults.unpushed, resolved lazily when the dialog opens.

// pure formatter:
unpushedWarning(summary: { remote: string; ahead: number }[]): string | null
//   null when empty; else e.g. "owner/repo has 3 unpushed commits" / "2 vaults have unpushed commits (5 total)".
```

## Gotchas (the load-bearing ones)

1. **Deleting the active clone out from under a live watcher.** The open vault's host runs a file watcher + autosave/push timers on its clone dir. `vaults.deleteClones` MUST `await deps.host.close()` (commits-then-releases, see `index.ts` teardown) BEFORE `fs.rm`, or the watcher fires into a deleted tree. Order: close host → rm dirs → `registry.remove` each → return. Sign-out (`auth.signOut`, keychain drop) happens AFTER, from the renderer.
2. **`ahead` needs `origin/<branch>` locally.** Managed clones are auto-pushed so it exists; a local-fixture vault may throw — wrap each vault's `status()` in try/catch and skip on error (best-effort). Do not let one bad clone break the whole summary.
3. **Remote avatar images + Electron.** No CSP is set today, so `https://avatars.githubusercontent.com/...` should load — but this is a **live-check** item (UI ceiling: I can't drive the dev app). Fallback: if `avatarUrl` is absent, render a neutral initial circle, never a broken `<img>`.
4. **`navigator.clipboard` in the renderer.** Available in the Electron renderer (secure context). Guard the write in a try/catch and toggle a transient "Copied" state; never throw into the sign-in flow.
5. **PAT hint is a *hint*, not a paste-flow.** The device flow yields an OAuth token; there is no PAT-paste sign-in and this plan does NOT add one. The hint is informational text + an `openExternal` link to GitHub's fine-grained-PAT docs, explaining the broad-grant tradeoff (§176). A functional PAT sign-in is an out-of-scope follow-up.
6. **Permission label.** Map `Collaborator.permission` to a short badge; `write`/`maintain`/`admin` mean "can push", `read`/`triage` mean "read-only" — the one distinction FR-13 says is the whole access model. Show the raw level as the badge text (`admin`/`write`/`read`…), muted.

---

## Task 1 — Copy button on the device user-code (FR-2)

**Files:** Modify `features/auth/SignIn.tsx`.

- [ ] Add a `copied` state (`useState(false)`); a small `Button variant="ghost" size="icon-xs"` beside the `<code>` user-code, lucide `Copy` → `Check` when `copied`. onClick: `await navigator.clipboard.writeText(phase.userCode)` in try/catch, set `copied`, reset after ~1.5s via a `setTimeout` (cleared on unmount). Tooltip "Copy code".
- [ ] Live-check note: manual (dom test infra doesn't render SignIn; the logic is a one-line clipboard call). No unit test — the behaviour is a platform call with no pure seam.
- [ ] Commit: `feat(auth): copy button on the device user-code (FR-2)`.

## Task 2 — Fine-grained-PAT hint on the sign-in screen (§176)

**Files:** Modify `features/auth/SignIn.tsx`.

- [ ] Under the idle/"Sign in with GitHub" button, add one muted line: "Holi requests broad repo access. Prefer a fine-grained token? " + a `Button variant="link"` that `openExternal`s `https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token`. Keep it subordinate to the CTA (text-xs, muted). Only render in the non-`waiting` branch.
- [ ] Commit: `docs(auth): sign-in screen notes the fine-grained-PAT alternative (§176)`.

## Task 3 — Avatar + permission in the members panel (FR-10)

**Files:** Modify `features/vault/VaultSettings.tsx`.

- [ ] In the collaborators `<li>`, prepend an avatar: `avatarUrl` → rounded `<img className="size-4 rounded-full" src={c.avatarUrl} alt="" />`; else a `size-4 rounded-full bg-muted` circle with the login's first letter (`text-[9px]`, centred). Keep the existing `ExternalLink` to the profile as the login.
- [ ] Append the permission as a muted badge on the right of the row: `<span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">{c.permission}</span>`; make the `<li>` a `flex items-center gap-2`.
- [ ] Live-check note: remote avatar load is manual (Gotcha 3).
- [ ] Commit: `feat(vault): members panel shows avatar + permission level (FR-10)`.

## Task 4 — Pure unpushed-warning formatter

**Files:** Create `renderer/src/lib/unpushed-warning.ts`; Test `apps/desktop/test/unpushed-warning.test.ts` (node project).

- [ ] **Failing test** — cases: empty → `null`; one vault `{remote:'a/b', ahead:3}` → mentions `a/b` and `3`; multiple → a summary naming the vault count and total commits. Assert the exact strings the implementation will produce (write test + impl together to fix wording).
- [ ] Run `pnpm exec vitest run --project node test/unpushed-warning.test.ts` → FAIL (module missing).
- [ ] Implement `unpushedWarning(summary)`: `null` when empty; single → `` `${remote} has ${ahead} unpushed commit${s}` ``; many → `` `${summary.length} vaults have unpushed commits (${total} total)` ``.
- [ ] Run → PASS.
- [ ] Commit: `feat(auth): pure unpushed-work warning formatter`.

## Task 5 — Main procedures: `vaults.unpushed` + `vaults.deleteClones`

**Files:** Modify `main/router.ts` (in the `vaults` router). Reuse `openRepo` (`../git`) and `rm` (already imported from `node:fs/promises`, see line 310).

- [ ] `vaults.unpushed`: query. `for (const e of await deps.registry.list())` → try `openRepo(e.path).status()`; if `ahead > 0` push `{ remote: e.remote, ahead }`; catch → skip. Return the array.
- [ ] `vaults.deleteClones`: mutation. `await deps.host.close()` (guard: only if `deps.host.active()` is non-null); then `for (const e of await deps.registry.list()) { await rm(e.path, { recursive: true, force: true }); await deps.registry.remove(e.remote) }`; return `{ ok: true as const }`. Order per Gotcha 1.
- [ ] Typecheck: `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → 0.
- [ ] Commit: `feat(vaults): unpushed summary + delete-clones procedures (FR-15)`.

## Task 6 — Wire sign-out: state + confirm dialog

**Files:** Modify `state/session.ts`, `features/vault/VaultSettings.tsx`.

- [ ] `session.ts`: change `signOutAtom` to accept `opts?: { deleteClones?: boolean }`; when `opts?.deleteClones`, `await trpc.vaults.deleteClones.mutate()` before `trpc.auth.signOut.mutate()`. Add `unpushedSummaryAtom` = an async reader calling `trpc.vaults.unpushed.query()` (or expose a plain fetch the dialog awaits on open — simplest: fetch in a `useEffect` when the dialog opens; no atom needed if that's cleaner).
- [ ] `VaultSettings.tsx`: replace the direct `onClick={() => void signOut()}` with `setConfirmSignOut(true)`. Add a confirm `Dialog` (mirror the reset-theme one): a `Checkbox` "Also delete local clones on this machine" (default off); on open, fetch `vaults.unpushed` and, if non-empty, render `unpushedWarning(summary)` in a `text-destructive` line above the checkbox; the confirm button calls `signOut({ deleteClones })`. When the box is unchecked the copy states the clones are left on disk (current FR-15 behaviour).
- [ ] Typecheck → 0; `pnpm exec vitest run --project dom` → green.
- [ ] Live-check note (UI ceiling): sign-out dialog, checkbox default off, warning appears when a clone is ahead, delete actually removes the folder.
- [ ] Commit: `feat(vault): sign-out confirm with optional clone deletion + unpushed warning (FR-15)`.

## Task 7 — Full verification sweep

- [ ] `apps/desktop`: typecheck (`tsc --noEmit`), dom (`vitest run --project dom`), node (`vitest run --project node`, ~120s, background it); `packages/shared`: `vitest run`. All green.
- [ ] Hand the user the consolidated live-check list (copy button, avatar/permission render, PAT link opens, sign-out dialog + delete + warning).

---

## Self-review

- **Spec coverage:** FR-2 → T1; FR-10 → T3; FR-15/Open-Q3 → T4–T6; §176 PAT hint → T2. All four sub-items covered.
- **Type consistency:** `signOutAtom({ deleteClones })`, `vaults.unpushed(): {remote,ahead}[]`, `unpushedWarning(summary)` used consistently across T4–T6.
- **Out of scope (flagged):** functional PAT-paste sign-in (T2 is a hint only); a guaranteed (vs advisory) unpushed check (Gotcha 2, best-effort per Open-Q3).
