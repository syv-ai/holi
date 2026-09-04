# Vault hooks — what was checked by hand

Companion to the spent `2026-08-20-vault-hooks` plan (deleted 2026-09-05; recoverable from git history).
Verified **2026-08-20**, in a scratch vault (`apps/desktop/verify-hooks.mts`), never in a real one —
these transforms rewrite files, and the point of the exercise is watching them do it. No network, no
token, no GitHub.

**Legend:** `[x]` verified by hand · `[~]` verified by an end-to-end test through every real
component · `[ ]` not verified.

## What the plan got wrong, and what changed

Two findings stopped execution at Task 7 and amended D76. Both were verified rather than argued.

- **`core.hooksPath` would have silently disabled the large-file guard.** Holi already installs a
  `.git/hooks/pre-commit` (`installGitHook`, from the 2026-08-03 large-binary work). Git looks
  **only** at `core.hooksPath` when it is set — confirmed in a throwaway repo — so pointing it at
  `.holi/git-hooks/` removes the gate that keeps an oversized blob out of a permanent, auto-pushed
  history.
- **`.holi/git-hooks/` is tracked, which is the hole D76 exists to close.** D76's own reason for
  shipping the hook body in the binary is that `core.hooksPath` into the tracked tree lets a
  teammate's push run code on your laptop. Seeding there and syncing it *is* that hole: their edit
  would arrive by pull, D75 would decline to overwrite it (the hash no longer matches), and it would
  run on every commit. Confirmed: under the seeded `.gitignore` (`*.local.*`), the file is committed.

**Both are answered by `.git/hooks/`**, where the guard already lives. It is machine-local by
construction — never committed, impossible to push, and invisible to the vault store
(`IGNORED_DIRS`), so an app cannot reach it without a rule. `.holi/git-hooks/` and `core.hooksPath`
are dropped; Task 1's agent-surface entry was reverted as dead.

## The chain, by hand

A plain `git mv` and `git commit` typed in a terminal, against the real hook, the real server, and
the real transforms.

- [x] **The referring note was rewritten inside the same commit as the rename.** `git mv
      projects/roadmap.md projects/plan.md` then `git commit`; the commit git made contains
      `notes.md | 2 +-` alongside the rename, and `git show HEAD:notes.md` reads
      `see [[projects/plan.md]] and [[projects/plan.md|the plan]]` — label intact. **The working
      tree was clean afterwards**, so the rewrite was staged rather than left for the next commit,
      which is the whole point of restaging.
- [x] **The log names what changed, and reads sensibly.**
      `2026-08-20T10:50:39.740Z  relink: rewrote links in 1 file(s) for 1 rename(s)`
- [x] **The log is not committed.** `git ls-files` does not list it; `*.local.*` covers it.
- [x] **The endpoint file is two lines and mode 0600** (`-rw-------`), port then token.
- [x] **A commit against a dead Holi is instant and succeeds.** The rig was killed leaving a stale
      endpoint behind — the crash case, not the clean quit — and the next commit exited 0 in under a
      second. The `--max-time 10` never even engaged, because a closed port refuses immediately.
- [x] **A transform that cannot read a file skips it rather than failing.** A directory named
      `trap.md` where a note was expected: relink skipped it and the commit carried the other
      rewrites.

## The chain, end to end in the suite

`hook-precommit-e2e.test.ts` drives the same path with nothing faked but Electron — real `git
commit`, real generated hook script, real loopback server, real ops route, real transforms, and the
assertion is on the commit git actually made. It exists because the pieces are joined by a shell
script, a port and a two-line file, none of which appears in a unit test.

- [~] relink rewrites the referring note in the same commit, and the working tree is left clean.
- [~] **The settings gate is live**: with `relink: false`, the same rename commits with the link
      untouched. This is the control that proves the first assertion is not vacuous.
- [~] normalize-md tidies a staged file and the tidied version is what gets committed.
- [~] The commit succeeds when the ops route itself throws, and when the endpoint is gone.
- [~] The large-file guard **still vetoes** (`hook-precommit-script.test.ts`) — it is the integrity
      check D76 allows, and the only thing in the script that may say no.

## Things the plan expected that turned out to be false

- **A hand-rewrite plus the hook does NOT double-rewrite a link.** The plan wanted AGENTS.md's
  "grep and fix by hand" instruction removed on those grounds. The rewrite map is keyed on the
  **old** path, so after a hand-fix that path appears nowhere and the rewrite matches nothing.
  Tested (`hook-relink.test.ts` §"a second actor doing the same job"), and AGENTS.md now says a
  hand-rewrite is harmless rather than forbidding it.
- **`rewriteWikiLinksMulti` does not skip fenced code blocks**, and `relink` deliberately does not
  start. `parseWikiLinks` has never skipped them, so `moveNotes` rewrites them too — sparing them
  only here would make the same move produce different files depending on whether it happened in
  Holi or in a terminal. There is a test asserting the current behaviour so the choice is visible.

## Not verified

- [ ] **Nothing ran inside the real Electron app.** Everything above used the real modules wired by
      hand or by test; no vault was opened in Holi, so `openActiveVault` writing the endpoint on open
      and clearing it on close is covered only by its own code path being trivial. **Worth one pass
      in the running app.**
- [ ] **`archive-done` has never run outside a test.** It is off by default, so nothing exercised it
      by hand — deliberately, since it moves task files.
- [ ] **No push to a live agent.** The plan's Task 6 wanted the run pushed to a running agent over
      the ops seam. **That seam does not exist**: ops is agent→main, and Holi has no way to inject
      text into a live Claude Code session short of typing into its PTY, which would put words in
      the user's input box. `notify` is supported by the runner and left unwired in main. The log is
      the agent-readable surface, and it reads it when asked. Recorded in `not-built.md`.
- [ ] **The status-bar floor.** D76 point 4 wanted `pause(reason)` to surface a hook failure when no
      agent session is open. Not built; the log is the only surface.
- [ ] **A second machine**, for the claim that the endpoint file and the hook never travel.

## Gates at the time of writing

`--project node` **1485** · `--project dom` **433** · `@holi/shared` **248** · `pnpm typecheck`
clean · `pnpm exec eslint src` — 0 errors, exactly the 2 known warnings (`EditorPane.tsx:240`,
`TaskDetail.tsx:348`).
