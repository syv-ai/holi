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

- [x] **Rename control appears.** `[data-rename="<path>"]` / `[data-delete="<path>"]` present for every note row (CDP DOM query, 2026-07-23 signed-in pass).
- [x] **Inline edit opens.** Clicking `✎` on `a.md` opened `[data-rename-input="a.md"]` pre-filled with `a.md`, `document.activeElement === input`.
- [x] **Rename commits on Enter.** `a.md` → `renamed-a.md` via Enter: tree row updated, `renamed-a.md` on disk, `a.md` gone. (CDP Enter needs `text:"\r"` to submit the implicit-submit form — a harness detail, not a product one.)
- [x] **Escape cancels.** Escape closed the input with no change.
- [ ] **Rename-is-move.** Not re-clicked in UI; the move (`target.md` → `sub/renamed.md`, folder created) is proven at the router level (see Already proven).
- [ ] **Open tab follows the file.** Not individually verified in this pass.
- [ ] **Inbound links rewrite live.** Not re-clicked in UI; router-proven (rename rewrites `a.md`/`b.md`, label preserved).
- [ ] **No `.md` typed still works.** Not re-clicked; `submitRename` appends `.md` in code.
- [ ] **Error surfaces.** Not re-clicked in UI; CONFLICT refusal is router-proven.
- [ ] **Buffer safety.** Not individually verified.

## FR-12 — Backref preview before delete (`FileTree.tsx` → `DeleteConfirm`)

- [x] **Dialog opens on delete.** Clicking `✕` on `target.md` opened `[data-delete-dialog="target.md"]` (in-app, not native).
- [x] **Referrers are named.** Dialog read: "4 links in 3 files will be left dangling (they become tombstones — no cascade)": `a.md ×2`, `b.md ×1`, `fm.md ×1`.
- [x] **Empty state.** Deleting `plain.md` (nothing links) showed "Nothing links to it."
- [x] **Cancel is a no-op.** Cancel closed the dialog; `target.md` still in the tree.
- [ ] **Confirm deletes.** Not exercised (cancelled to preserve the fixture); `notes.delete` is router-proven.
- [ ] **Tombstones survive.** Not individually verified.

## FR-2 / FR-16 — Frontmatter widget (`editor/frontmatter.ts`) — built blind, highest risk

Open a note whose body starts with `---\ntitle: x\ntags: [a, b]\n---\n` then real body text.

> **⚠ Two defects found and fixed here this session — see "Notes / defects found".** All boxes below are checked against the **fixed** widget (`17ddb8d`).

- [x] **Hidden by default.** `fm.md` renders `[data-frontmatter="collapsed"]` + `[data-frontmatter-pill]` reading "▸ frontmatter · 2 fields"; raw YAML not shown. (Screenshot captured.)
- [x] **livePreview does not fight it.** No HR/heading over the fence — just the pill, then the body.
- [x] **Body renders normally.** `# Heading` bolded, `**bold**` strong, `[[target.md]]` rendered as a blue wiki-link chip.
- [x] **Reveal on click.** Clicking the pill (mousedown) → `[data-frontmatter="expanded"]`, `[data-frontmatter-header]` "▾ frontmatter", nested `.cm-fm-body` showing raw YAML. (Screenshot captured.)
- [x] **Collapse on click.** Header chevron collapses back to the pill.
- [x] **Nested edit writes through.** Typed `status: draft` in the nested editor → disk `fm.md` gained `status: draft` inside intact `---…---` fences, body preserved, committed "Update fm.md".
- [x] **Focus is retained mid-edit.** Typed char-by-char in the nested editor; `activeElement.closest('.cm-fm-body')` stayed true through every keystroke (write-back maps, does not remount).
- [x] **Markdown keys are inert in frontmatter.** `⌘B` in the nested editor did not change its content (no `**` inserted).
- [x] **Caret cannot enter the region in the root.** Clicking the `# Heading` body line then ArrowUp×8 never placed the selection inside the collapsed widget; caret stayed in the root `.cm-content`.
- [x] **Field count / dot are correct.** "2 fields" for `title`+`tags`, green dot for valid YAML; "3 fields" after an external `author:` add; "4 fields" with the broken line.
- [x] **External reload updates the widget.** External write adding `author:` (clean buffer) updated the pill "2 fields" → "3 fields".
- [x] **Note with no frontmatter.** `plain.md` shows no widget — plain editor, content renders normally.

## FR-16 status dot + FR (save gate) — `frontmatter.ts` + `EditorPane.tsx`

- [x] **Dot goes red on broken YAML.** Typing `bad: [x, y` (unterminated) turns the header dot red **live** — this was DEFECT #2 (dot was frozen); fixed in `17ddb8d`.
- [x] **Autosave holds off while invalid.** With the dot red and the window kept focused (no blur), `fm.md` md5 was UNCHANGED after 2.5s.
- [ ] **⌘S holds off while invalid.** Not individually driven; ⌘S routes through the same gated `save()` as autosave (verified) plus `commitNow`.
- [x] **Recovery resumes saving.** Closing the bracket (`]`) turned the dot green again, live.
- [x] **Flush writes anyway (no lost keystrokes).** Closing the tab with the invalid buffer wrote the invalid text to disk (unmount flush) — edits not lost.
- [ ] **⌘S on a valid, already-saved buffer still commits.** Not individually driven.
- [~] **Body edits unaffected by the gate.** Typing in a note body autosaved/committed normally (observed via the tab-promotion test); not exhaustively isolated.

## Regression — external-write merge still holds (the load-bearing FR-5)

The frontmatter widget shares the single document with the merge machinery; confirm it's undisturbed:

- [x] **Clean-buffer reload.** External write to open `fm.md` (no unsaved edits) reloaded silently — the widget picked up the new field ("2 fields" → "3 fields").
- [ ] **Dirty-buffer merge.** Not re-driven this pass (proven a prior session); the shared-document path is unchanged by the fix (still one `EditorState`, `decideReload` untouched).
- [ ] **Unmergeable → reconcile banner.** Not re-driven this pass.

---

## Notes / defects found

### [!] DEFECT #1 (critical, FIXED `17ddb8d`) — frontmatter notes opened to a blank editor

The frontmatter widget provided its **block** `Decoration.replace({block:true})` from a **ViewPlugin**. CodeMirror forbids that — `RangeError: Block decorations may not be specified via plugins` — and the throw happens inside `new EditorView`, aborting construction. Result: **every note containing frontmatter (including all daily notes) opened to a blank editor** with no `.cm-editor`/`.cm-content` and no content; `plain.md` (no frontmatter) rendered fine. Found immediately on the first signed-in open of `fm.md` via the renderer console (`EditorPane.tsx:75`).

**Fix:** moved the decoration into a `StateField` (`EditorView.decorations.from(field)` + `atomicRanges` via `view.state.field`), the way the `codemirror-markdown-tables` widget it was modelled on provides its block decos. The map-don't-rebuild rule (preserve the nested caret on our own write-back) is carried over intact.

### [!] DEFECT #2 (FR-16, FIXED `17ddb8d`) — status dot never went red while editing frontmatter

Because the widget deliberately **maps rather than rebuilds** on its own write-back (to keep the nested caret), `statusDot` never recomputed while you typed in the nested YAML editor — broken YAML kept a **green** dot until an unrelated rebuild (collapse/expand, body edit). That defeats FR-16's whole point (live validity feedback). The save *gate* itself was correct (it reads the live root doc via `frontmatterValid`).

**Fix:** keep a reference to the header dot and repaint it in place from the nested editor's `updateListener` (`paintDot`). Verified live: green → (type invalid) → red → (fix) → green, focus retained throughout.

**Both fixes:** desktop suite 522 green, frontmatter tests 18 green, typecheck unchanged (36 quarantined, none in this code), `electron-vite build` succeeds.
