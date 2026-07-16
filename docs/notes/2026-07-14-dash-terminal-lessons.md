# Dash terminal/PTY lessons — what we took, what we deferred

Source: `~/repos/syv/dash` (Electron; its whole product is xterm panes running interactive
`claude` in node-pty — the mature version of Holi's agent drawer). Reviewed 2026-07-14 while
hardening the slice-2 drawer. File references are Dash's.

## Adopted (in the drawer now)

- **`TerminalMirror`** — headless xterm + SerializeAddon in main, fed every PTY chunk (the VS Code
  pty-host pattern; `TerminalMirror.ts`). Main owns the record, the renderer is a view. Fixes
  scrollback loss across a renderer reload and output produced before the panel mounts.
  Ordering matters: **serialize before opening the data tap**, so no chunk is both replayed and
  streamed (`ptyManager.ts:490-494`). We gate streaming on an `attached` flag for exactly this.
- **Ink/TUI incantations** — Claude Code is an Ink TUI:
  - `\x1b[?25l` to hide xterm's cursor (Ink draws its own), **re-applied after startup** because
    Ink's init emits `\x1b[?25h` (`TerminalSessionManager.ts:636-643`).
  - `\x1b[?1004l` before focusing — focus reporting sends `\x1b[I` as PTY input, which lands in
    Claude's prompt box as stray characters (`:663-666`).
  - **Selection cache**: Claude's TUI rewrites cells continuously and drops xterm's live selection
    before the user can hit copy (`:93-97`).
  - **Resize dedupe**: a redundant resize is a SIGWINCH → full TUI redraw (`:1059-1060`).
- **Zero-size fit guard** — FitAddon clamps a 0×0 container to its 2×1 minimum instead of bailing,
  so fitting a hidden pane squashes the PTY (`FitScheduler.ts`). Our `display:none` currently
  doesn't fire the ResizeObserver at all, so this is insurance, not a live fix — but it's one CSS
  change (e.g. hiding via `height: 0`) away from being load-bearing.

- **Lazy terminal creation** (ours, not Dash's): the xterm is built on the drawer's *first show*,
  not on mount. `term.open()` against a `display:none` host leaves the renderer unmeasured, and the
  mirror is what makes deferring safe — anything the PTY printed first is replayed by `attach()`.

## Testing gotcha (cost an hour — write it down)

**xterm pauses its renderer when the page is hidden.** An Electron window launched in the
background (or simply occluded) reports `document.visibilityState === 'hidden'`, and xterm stops
painting to the DOM — the buffer still fills correctly, but `.xterm-rows` stays empty. A CDP probe
that scrapes the DOM will therefore report "the terminal shows nothing" for a perfectly working
panel.

When driving the drawer over CDP: assert on the **buffer** (`term.buffer.active.getLine(i)
.translateToString()`), not on DOM text — or bring the window to the front first. I chased this as a
regression in the attach/mirror wiring for far too long before checking `visibilityState`.

## Deferred, with the reasoning

### ~~Explicit `--resume <id>`~~ — rejected 2026-07-14

**Decision: we keep the bare `--resume` picker.** Nicolai wants CC's native session picker in the
terminal. Dash's reason for pinning an explicit id doesn't transfer: they need the resumed session
to match *their own* session UI, and we have no such list to keep in sync. Pinning an id would only
couple us to CC's on-disk layout. Kept below for the record.

Dash never uses `--continue` or a bare `--resume`. It resolves the newest-mtime `*.jsonl` in
`~/.claude/projects/<encoded-cwd>/` and resumes **that exact session id** (`ptyManager.ts:503-516`,
`claudeCli.ts:33-66`), because `--continue`'s selector is undocumented and they want the resumed
session to be deterministically the one the UI is showing. It still follows `/clear` and `/compact`
forks, since each is a newer file.

This rests on an invariant they call out explicitly: **one session per cwd**. Holi has that too
(one working copy per vault), so the technique ports directly.

**Blocked on:** the manual verdict on whether CC's native picker is usable inside our xterm (spec
open item). If it is, bare `--resume` is less code and less coupling to CC's on-disk layout.

### Packaging (not needed until we ship a build)

- `asarUnpack: ["node_modules/node-pty/**"]` and `npmRebuild: false` in electron-builder.
- CI runs `electron-rebuild -f -w node-pty` on every OS; their Windows job is **pinned to
  `windows-2022`** because `windows-latest` ships VS2026, which node-gyp can't detect.
- **macOS**: Electron's prebuilt binary has a hardened runtime enforcing library validation, which
  **SIGKILLs the process when it loads an adhoc-signed `.node`** ("Code Signature Invalid"). Dash
  re-signs the dev `Electron.app` from `postinstall` (`scripts/sign-dev-electron.mjs`, no `--deep`)
  with a `com.apple.security.cs.disable-library-validation` entitlement. We did not hit this on
  Electron 43, but it is the non-obvious one that will bite at package time.

### Kill semantics — we're already ahead

Dash's single most valuable scar: **node-pty's bare `kill()` sends SIGHUP, which Claude Code does
not trap**, so its in-memory session tail was lost on every quit and no `--resume` could recover
what never reached the jsonl (`ptyManager.ts:759-815`). They fixed it with SIGTERM → 3s → SIGKILL.

We already send explicit signals and go further (SIGTERM to the whole **process group**, which they
don't do — a SIGKILLed Dash orphans its `claude` children). Worth keeping.

One thing they have that we don't: **`killPtyAwait`** on the IPC boundary, awaited by the renderer
before respawning, so a new `claude --resume` can't race the dying one for the session jsonl. Our
`kill()` already awaits the reap, so we're covered — but the *reason* matters if we ever make kill
fire-and-forget.

### Not copied deliberately

- **`syncShellEnv`** (`ptyManager.ts:198-200`) inherits the full `process.env`, which would leak
  `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` if the app were launched from a Claude Code session. We
  strip both explicitly in `buildAgentEnv` — keep it that way.
- **Reading xterm's private `_core._renderService`** for cell metrics (`:878-919`) to avoid
  FitAddon's scrollbar reserve. Real problem, but a maintenance liability; only worth it if the
  gutter actually bothers us.
- **No orphan reaping** — see above; our process-group kill is the better answer.

## Related finding (Holi, not Dash)

Chased a suspected delete-swallowing race in `VaultMirror` and **disproved it**: when a file is
removed and re-created quickly, chokidar/fsevents **coalesces the unlink away entirely** — the
mirror never sees a delete, so it simply re-materializes the file. The doc and the file stay
consistent (no data loss); the agent's `rm` is just overridden by the concurrent remote edit, which
is defensible last-writer-wins. A guard keyed on the unlink event cannot help, because that event
never arrives. If we ever want "agent delete always wins", the signal has to come from somewhere
other than the watcher (e.g. a PreToolUse-style hook on the delete itself).

Separately: `vault-mirror.test.ts` is **flaky under `pnpm -r test`** (all four packages' vitest
running at once). Verified pre-existing — it reproduces on the committed slice-2 tree with all of
today's work stashed, and passes 3/3 when the desktop suite runs alone. The waits are 8s against
chokidar; under parallel load fsevents delivery exceeds that. Worth fixing before CI (raise the
allowance, or run the mirror suite with `--pool=forks --poolOptions.forks.singleFork`).
