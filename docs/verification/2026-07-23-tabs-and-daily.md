# Tabs + Daily Notes — Verification Checklist

Companion to `docs/plans/2026-07-23-tabs-and-daily.md`. Tracks the manual/visual checks that can't run autonomously (the UI is behind the sign-in gate). Update the boxes as each is confirmed in a signed-in session.

**Legend:** `[ ]` not verified · `[x]` verified in-app · `[!]` verified and **found broken** (note inline).

> **Note (2026-07-23):** a *persisted* session renders the Shell even when `auth.status` reads signed-out, so a visual pass may not need a fresh device-code sign-in — but a **working vault with notes** must be open in the renderer (adopt/open a local clone through the vault dropdown, not just trpc). The registry currently points at a deleted `/tmp` fixture; add a real local vault first.

---

## Already proven (headless / trpc — do NOT re-test)

- [x] `panes.ts` preview/pinned transitions — unit tests (`openPreview` reuses one tab, `openPinned`, `pinTab`, `pinActive`, `retargetTab` preserves preview).
- [x] App boots with the tab wiring on the boot path — Shell renders (vault dropdown, tree, tab strip), no renderer errors.
- [x] **Daily create + sweep, e2e on real git/fs** (`verify-tabs-daily.sh`, 2026-07-23): `getOrCreateDaily` made today's `DD-MM-YYYY.md` at root with the daily frontmatter; `sweepDaily` deleted the untouched unreferenced prior-day stub, archived the prior-day daily-with-body into `journal/`, and left today's note at root; re-run was a no-op. **Bonus:** the renderer's on-open effect (B5) ran the whole flow itself when the vault opened, so `openTodaysDailyAtom`/`sweepDailyAtom` are proven wired — the explicit proc calls afterwards were idempotent no-ops.

---

## Part A — Preview/Pinned Tabs (all behind sign-in) — verified 2026-07-23 signed-in pass

- [x] **Single-click previews.** Single-clicking `fm.md` opened an **italic** preview tab beside the pinned daily; single-clicking `plain.md` next **replaced** it (still one preview tab, now `plain.md` italic).
- [ ] **Already-open focus.** Not individually driven (the replace-preview behavior above exercises the same reducer path).
- [x] **Double-click pins (tree).** Double-clicking `b.md` opened it **pinned** (non-italic) beside the daily; a later single-click of `fm.md` opened a preview beside it (three tabs).
- [x] **Double-click pins (tab).** Double-clicking the `plain.md` preview tab pinned it (title went non-italic).
- [x] **Editing pins.** Opening `target.md` as an italic preview then typing one char promoted its tab to pinned (non-italic).
- [x] **Board tab.** The board button opens a `board` tab, non-italic (pinned), and BoardView renders (Todo/Doing/Done, "No tasks yet").
- [x] **Close still works.** The `✕` on `b.md` closed it (tab count 5 → 4, `b.md` gone).

> Note: over CDP, native `.click()` and `Input.dispatchMouseEvent` reliably trigger the React handlers; a synthetic `dispatchEvent(new MouseEvent('click'))` does **not** always — a harness detail, not a product one.

## Part B — Daily Notes

### Router procs (trpc-level, signed-out OK — via `verify-tabs-daily.sh`)
- [x] `notes.getOrCreateDaily` creates `DD-MM-YYYY.md` at root with the deterministic seed; a second call returns `created:false` (same file).
- [x] `notes.sweepDaily` deletes an untouched, unreferenced prior-day daily; archives a prior-day daily with body into `journal/` (link-rewritten); leaves today's and non-`type: daily-note` files alone; re-run is a no-op.

### UI (behind sign-in) — verified 2026-07-23 signed-in pass
- [x] **Land on today on personal-vault open.** On vault open the renderer created `23-07-2026.md` at root and opened it as the active (pinned) tab.
- [ ] **No daily in shared vaults.** Not driven — needs a >1-collaborator vault (requires GitHub, unavailable signed-out). Backed by the offline-defaults-personal proof below and `isPersonalVault` gating.
- [x] **Offline defaults personal.** The e2e ran signed-out — `github.collaborators` throws, `isPersonalVault` defaults to personal, and the daily was still created on open. Proven.
- [x] **Sidebar "Today".** The `today` button opened/focused today's daily (active tab `23-07-2026.md`).
- [x] **⌘⇧D shortcut** opens today's daily (from another active tab, `⌘⇧D` made `23-07-2026.md` active).
- [x] **Empty-state CTA.** The `today` button is always present in the sidebar and opens the daily — the recovery path works (verified via the button above).
- [ ] **Sweep on open commits once.** Not visually isolated this pass; the sweep (archive + GC as one commit) is router-proven (see Already proven).

---

## Notes / defects found

No defects in the tabs/daily code itself this pass — everything above behaved as specified.

**Cross-reference:** the two defects found this session were in the **frontmatter widget** (`editor/frontmatter.ts`), fixed in `17ddb8d` — see `docs/verification/2026-07-23-notes-editor-gaps.md`. They mattered here too: daily notes carry `type: daily-note` frontmatter, so before the fix **opening the daily note landed you on a blank editor**. After the fix the daily renders its frontmatter widget and body normally.
