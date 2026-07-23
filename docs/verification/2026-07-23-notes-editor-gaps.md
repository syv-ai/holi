# Notes-Editor Gaps — Verification Checklist

Companion to `docs/plans/2026-07-23-notes-editor-gaps.md`. Tracks the manual/visual checks that could **not** be run autonomously, because the whole UI sits behind the GitHub sign-in gate and the CI/agent keychain is signed-out (see the `holi-ui-verification-ceiling` memory). Update the checkboxes as each is confirmed in a signed-in session.

**Legend:** `[ ]` not yet verified · `[x]` verified in-app · `[!]` verified and **found broken** (note the defect inline).

---

## How to run the visual pass

1. **Sign in.** Launch the dev app and approve the device code by hand:
   `cd apps/desktop && pnpm exec electron-vite dev -- --remote-debugging-port=9333`
   (The keychain persists the session afterwards.)
2. **Get a vault with linked notes.** Either open a real vault, or use the local-bare-repo rig (`apps/desktop/verify-focus-pull.sh` shows the fixture: bare origin → clone → `vaults.add` adopts the pre-cloned path, no token). Seed at least: `target.md`, and `a.md`/`b.md` that each contain `[[target.md]]` links.
3. **Drive/inspect** either by hand or over CDP (`node cdp.mjs "<js>"`, `--type "<text>"`). Signed-in, `cdp.mjs` can read the rendered DOM (`document.querySelector('[data-frontmatter]')`, etc.) and `--type` inserts real input at the caret.

---

## Already proven (do NOT re-test)

These were verified end-to-end against the real built main process over CDP on 2026-07-23 (trpc layer, real git + fs) — they need no visual pass:

- [x] `notes.backrefs` returns each referrer + count (`{a.md,2},{b.md,1}`).
- [x] `notes.rename` moves the file, rewrites both referrers, preserves `|Label`, leaves `[[task:*]]` chips untouched.
- [x] `notes.rename` refuses an existing destination (`CONFLICT`).
- [x] App boots cleanly with all changes on the boot path (window opens, `#root` renders, no renderer errors).
- [x] Full headless suites: desktop 510, shared 155; `electron-vite build` succeeds.

---

## FR-11 — Rename from the file tree (`FileTree.tsx`)

- [ ] **Rename control appears.** Hovering a note row shows a `✎` (rename) button beside the `✕` (delete) — `[data-rename="<path>"]` / `[data-delete="<path>"]` present in the DOM.
- [ ] **Inline edit opens.** Clicking `✎` replaces the row with an input pre-filled with the note's full path (`[data-rename-input="<path>"]`), autofocused.
- [ ] **Rename commits on Enter.** Editing the name and pressing Enter moves the file; the tree row updates to the new name.
- [ ] **Escape cancels.** Pressing Escape (or blurring) closes the input with no change.
- [ ] **Rename-is-move.** Changing the path to a new folder prefix (e.g. `target.md` → `sub/renamed.md`) relocates the note into `sub/`, creating the folder; the tree shows it nested.
- [ ] **Open tab follows the file.** With the renamed note open as the active tab, after rename the tab points at the new path (no "file not found" / blank editor).
- [ ] **Inbound links rewrite live.** After renaming `target.md`, opening `a.md`/`b.md` shows their wiki-link chips now pointing at the new path (and still clickable to the moved note).
- [ ] **No `.md` typed still works.** Renaming to a value without `.md` (e.g. `renamed`) produces `renamed.md`.
- [ ] **Error surfaces.** Renaming to a path that already exists shows the CONFLICT message inline rather than silently doing nothing.
- [ ] **Buffer safety.** With unsaved edits in the note being renamed, the edits are flushed first (not lost) and the rename lands as a clean commit.

## FR-12 — Backref preview before delete (`FileTree.tsx` → `DeleteConfirm`)

- [ ] **Dialog opens on delete.** Clicking `✕` on a note opens the in-app dialog (`[data-delete-dialog="<path>"]`), not a native `window.confirm`.
- [ ] **Referrers are named.** Deleting `target.md` lists `a.md` and `b.md` with per-file counts (`×2`, `×1`) and a total; copy says they'll become dangling tombstones (no cascade).
- [ ] **Empty state.** Deleting a note nothing links to shows "Nothing links to it."
- [ ] **Cancel is a no-op.** Clicking Cancel (or the backdrop) closes the dialog; the note is still present.
- [ ] **Confirm deletes.** Clicking Delete (`[data-delete-confirm="<path>"]`) removes the note; the tree row disappears.
- [ ] **Tombstones survive.** After deleting `target.md`, the `[[target.md]]` links in `a.md`/`b.md` remain in the files and render as **missing** chips (not removed, not cascaded).

## FR-2 / FR-16 — Frontmatter widget (`editor/frontmatter.ts`) — built blind, highest risk

Open a note whose body starts with `---\ntitle: x\ntags: [a, b]\n---\n` then real body text.

- [ ] **Hidden by default.** The frontmatter renders as a **collapsed pill** (`[data-frontmatter="collapsed"]`, `[data-frontmatter-pill]`) reading e.g. "▸ frontmatter · 2 fields" — the raw `---`/YAML is NOT shown as text.
- [ ] **livePreview does not fight it.** No horizontal-rule / heading / stray decoration renders on or around the fence — just the pill, then the body below.
- [ ] **Body renders normally.** Markdown below the frontmatter (headings, bold, wiki-links) live-previews as usual.
- [ ] **Reveal on click.** Clicking the pill expands to a header (`[data-frontmatter="expanded"]`, `[data-frontmatter-header]`, "▾ frontmatter") above a nested editing surface (`.cm-fm-body`) showing the raw YAML.
- [ ] **Collapse on click.** Clicking the header chevron collapses back to the pill.
- [ ] **Nested edit writes through.** Typing in the nested YAML editor changes the note's frontmatter on disk (autosave writes the reconstructed `---…---` block back into the file).
- [ ] **Focus is retained mid-edit.** Typing several characters in the nested editor does NOT lose focus / drop the caret after each keystroke (the write-back must map decorations, not remount the widget).
- [ ] **Markdown keys are inert in frontmatter.** With the caret in the nested editor, `⌘B`/`⌘I`/`⌘E` do NOT insert `**`/`*`/`` ` `` (no markdown/formatting keymap there).
- [ ] **Caret cannot enter the region in the root.** Clicking/arrowing in the body cannot place the caret inside the collapsed block (atomic range); navigation skips over it.
- [ ] **Field count / dot are correct.** The pill's "N fields" matches the top-level keys; the status dot is green for valid YAML.
- [ ] **External reload updates the widget.** An external write changing the frontmatter (clean buffer) updates the pill/nested content (widget rebuilds, not stale).
- [ ] **Note with no frontmatter.** A note with no leading `---` shows no widget at all — plain editor.

## FR-16 status dot + FR (save gate) — `frontmatter.ts` + `EditorPane.tsx`

- [ ] **Dot goes red on broken YAML.** In the nested editor, type `tags: [` (unterminated) → the status dot turns red.
- [ ] **Autosave holds off while invalid.** With the dot red, wait past the autosave debounce (~600ms + commit) → the file on disk is UNCHANGED (invalid frontmatter not persisted).
- [ ] **⌘S holds off while invalid.** With the dot red, press ⌘S → still no write, no commit; the dot stays red.
- [ ] **Recovery resumes saving.** Fix the YAML → dot green → the next idle autosave (or ⌘S) writes normally.
- [ ] **Flush writes anyway (no lost keystrokes).** With the dot red, close the tab / switch vault / quit → the flush DOES write the (invalid) text to disk; the edits are not lost. Reopening shows them, dot still red until fixed.
- [ ] **⌘S on a valid, already-saved buffer still commits.** With valid frontmatter and nothing new to write, ⌘S still triggers `sync.commitNow` (FR-4 — it's a real commit point, not gated by "nothing changed").
- [ ] **Body edits unaffected by the gate.** Editing only the body (frontmatter valid) autosaves and ⌘S-commits normally.

## Regression — external-write merge still holds (the load-bearing FR-5)

The frontmatter widget shares the single document with the merge machinery; confirm it's undisturbed:

- [ ] **Clean-buffer reload.** External write to an open note (no unsaved edits) silently reloads.
- [ ] **Dirty-buffer merge.** External write + an unsaved edit → `merge3` keeps both sides (the case verified in the prior session — must still pass with frontmatter present in the file).
- [ ] **Unmergeable → reconcile banner.** Overlapping edits still surface the conflict banner.

---

## Notes / defects found

_(Record anything a check surfaces here, with the box marked `[!]`.)_
