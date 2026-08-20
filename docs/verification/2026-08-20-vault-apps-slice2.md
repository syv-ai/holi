# Vault apps slice 2 — what was checked by hand

Companion to [`../plans/2026-08-20-vault-apps-slice2.md`](../plans/2026-08-20-vault-apps-slice2.md).
Verified **2026-08-20**, in the running dev app (`electron-vite dev --remote-debugging-port=9333`),
signed in, against the real `nthomsencph/privat` vault — driven over CDP, with a screenshot, and
with the generated `holi` CLI run from an ordinary terminal.

**Legend:** `[x]` verified in-app · `[~]` verified another way, named below · `[ ]` not verified.

Slice 1's lesson is the reason this file exists: every unit test passed while the feature was
visibly broken, because `:root{}` is a perfectly well-formed theme injection. A green suite is not
evidence that a user can see the thing.

## The migration

- [x] **A slice-1 app still appears after the registration change.** `vault-dashboard` had only
      `index.html`; on the first open of the rebuilt app, `.holi/apps/vault-dashboard/app.yaml`
      was written (timestamped at launch) carrying `name: vault-dashboard`, and the app stayed in
      the sidebar throughout. The sync loop committed the manifest.
- [x] **It does not blink.** The sidebar was read straight after launch and `vault-dashboard` was
      already there — the migration runs ahead of `host.open`, so the first snapshot the renderer
      sees already has the manifest in it.

## The CLI, against the running app

Run from a terminal with `HOLI_HOOK_PORT` / `HOLI_HOOK_TOKEN` taken from the live agent child's
environment, invoking the generated script at
`~/Library/Application Support/@holi/desktop/bin/holi` — the same file the agent gets on `PATH`.

- [x] **`holi app open vault-dashboard` opens the tab.** `{"ok":true}`, and the renderer grew a
      `vault-dashboard` tab with an `<iframe src="holi-app://vault-dashboard/index.html">`. The
      full chain — generated shell → hook-server ops route → main → `apps:open` push → renderer
      atom — works end to end.
- [x] **And it renders.** Screenshot: heading, `5 notes` / `15 open tasks`, four note links, and
      the five boundary checks, all in the vault's theme. Not the black-on-transparent page slice 1
      shipped.
- [x] **Refusals come back as values, exit 0, and name the fix.**
      - unknown app → `no app called nope — .holi/apps/nope/ does not exist`
      - invalid id → `My_App: an app id is lowercase letters, digits and dashes: [a-z0-9-]+`
      - unregistered → `scratch-check has no app.yaml, so it is not registered yet. Write one (it
        can be empty), or run \`holi app init scratch-check\`.`
- [x] **A directory with an entry document and no manifest does not appear** in the sidebar, and
      **appears the moment `holi app init` writes one** — checked by creating
      `.holi/apps/scratch-check/index.html`, confirming the APPS list was unchanged, running
      `holi app init scratch-check`, and seeing `scratch-check` in the list on the next rescan.
- [x] **`app init` does not clobber.** A second run answered `{"ok":true,"created":[]}` and left
      the manifest byte-identical.
- [x] **No subcommand prints usage naming exactly `app open`, `app init`, `seed refresh`**, exit 2.
- [x] **The scratch app was removed afterwards**, and the sidebar dropped it. `privat` carries only
      `vault-dashboard`, and its working tree is clean.

## D75 — the managed/once split, on a vault that predates it

This is the case that matters, because it is the case every existing vault is in.

- [x] **Nothing was rewritten on open.** `holi seed refresh` reported four files skipped as
      `unrecorded` — `google-send-gate.mjs`, and the `md-to-pdf`, `gmail-calendar` and `vault-apps`
      skills — and refreshed none. A vault with no hash history is left entirely alone.
- [x] **Files already byte-identical to what Holi ships were adopted**, not skipped:
      `user-prompt-submit.mjs` and `theme/SKILL.md` appear in `.holi/seed-state.local.json` after
      the first open, which is what lets the *next* version reach this vault without a `--force`.
- [x] **`--force` refreshes a managed file** — `holi seed refresh .claude/skills/vault-apps/SKILL.md
      --force` replaced the vault's stale copy with the one this slice ships (it now contains
      `holi app open`), and recorded its hash.
- [x] **An edited managed file is left alone and reported as `edited`.** A comment was appended by hand to `.claude/skills/theme/SKILL.md` — the one managed file this vault had a recorded hash for — and `holi seed refresh` on it answered `{"refreshed":[],"skipped":[{"reason":"edited"}]}` with the edit still on disk. `--force` then restored the shipped copy. Both halves of the hash gate, on a real vault.
- [x] **`--force` does not reach a once-file.** `holi seed refresh AGENTS.md --force` answered
      `{"refreshed":[],"skipped":[{"path":"AGENTS.md","reason":"not managed"}]}` and the file's
      sha1 was unchanged before and after.
- [x] **The acceptance check from the handoff holds:** after the split, the *skill* refreshes and
      `AGENTS.md` does not.
- [x] **The state file is machine-local.** `.holi/seed-state.local.json` matches `*.local.*` in the
      vault's `.gitignore` and is absent from `git ls-files`.

## The validator hook

- [x] **It is seeded into the live vault** at `.claude/hooks/vault-app-check.mjs`, and merged into
      an established vault's `settings.json` as a `PostToolUse` entry matching `Write|Edit|MultiEdit`
      — `privat`'s settings predate the hook and gained it on open, which is the merge path, not
      the creation path.
- [x] **It reports and exits 0.** Driven as a process against a deliberately broken file
      (`const a = (` + `localStorage.setItem` + a hex literal) it returned all three findings —
      `SyntaxError at line 3`, the opaque-origin reason for `localStorage`, and the colour nudge at
      the lower mark — with exit code 0.
- [x] **It is silent on a correct write.** No output at all for a valid script in a registered app.

## Not verified

- [ ] **The agent finding and using this by itself.** The plan's last check — ask the agent in the
      drawer to build an app and confirm it reads the skill, writes a manifest, opens the app and
      reacts to the validator — was **not** run. Starting a session over CDP reported
      `running: true` but produced no PTY output through `agent.onData`, and driving the drawer far
      enough to read a real turn was not attempted. Everything the agent *would* invoke was
      exercised by hand instead, from the same binary with the same environment, so what is untested
      is the agent's judgement rather than the machinery. **This is the one gap worth closing by
      hand.**
- [ ] **The validator firing as a real `PostToolUse` hook** inside a Claude Code turn. It was run as
      a process with a hand-built payload, and its seeded `settings.json` entry was read back, but
      no live turn triggered it.
- [~] **The renderer's `apps:open` subscription** is covered only by the live CLI call above (which
      did open the tab) — there is no unit test for `subscribeToVault`'s new listener, because the
      existing subscription has none either.
- [ ] **A second machine.** Everything about `seed-state.local.json` being per-clone is argued, and
      enforced by the `.local.` marker, but no second clone was set up to watch a teammate's vault
      not claim our file was untouched.

## Gates at the time of writing

`--project node` **1380** · `--project dom` **433** · `@holi/shared` **247** · `pnpm typecheck`
clean · `pnpm exec eslint src` — 0 errors, exactly the 2 known warnings (`EditorPane.tsx:240`,
`TaskDetail.tsx:348`).
