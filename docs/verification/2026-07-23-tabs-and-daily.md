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

## Part A — Preview/Pinned Tabs (all behind sign-in)

- [ ] **Single-click previews.** Single-clicking a note in the tree opens it in a tab whose title is **italic**; single-clicking a *second* note **replaces** that tab (still one preview tab), not add a second.
- [ ] **Already-open focus.** Single-clicking a note that's already open (pinned or preview) just focuses its tab — no duplicate.
- [ ] **Double-click pins (tree).** Double-clicking a note in the tree opens it **pinned** (non-italic); a subsequent single-click of another note opens a preview *beside* it (two tabs).
- [ ] **Double-click pins (tab).** Double-clicking a preview tab in the strip pins it (title stops being italic).
- [ ] **Editing pins.** Typing in a preview note promotes its tab to pinned (title stops being italic) — you can't lose it by clicking away.
- [ ] **Board tab.** The board tab opens pinned (never italic/preview) and behaves as before.
- [ ] **Close still works.** The `✕` closes tabs; active-tab-follows-document behavior unchanged.

## Part B — Daily Notes

### Router procs (trpc-level, signed-out OK — via `verify-tabs-daily.sh`)
- [x] `notes.getOrCreateDaily` creates `DD-MM-YYYY.md` at root with the deterministic seed; a second call returns `created:false` (same file).
- [x] `notes.sweepDaily` deletes an untouched, unreferenced prior-day daily; archives a prior-day daily with body into `journal/` (link-rewritten); leaves today's and non-`type: daily-note` files alone; re-run is a no-op.

### UI (behind sign-in)
- [ ] **Land on today on personal-vault open.** Opening a personal vault creates today's daily (if absent) and navigates to it.
- [ ] **No daily in shared vaults.** Opening a vault with >1 collaborator does NOT create a daily.
- [x] **Offline defaults personal.** The e2e ran signed-out — `github.collaborators` throws, `isPersonalVault` defaults to personal, and the daily was still created on open. Proven.
- [ ] **Sidebar "Today".** The Today entry opens today's daily (creating if needed).
- [ ] **⌘⇧D shortcut** opens today's daily.
- [ ] **Empty-state CTA.** With zero tabs, "Open today's daily note" recovers.
- [ ] **Sweep on open commits once.** The archive/GC on open lands as a single `Archive daily notes`-style commit, not scattered autosaves.

---

## Notes / defects found

_(Record anything a check surfaces here, with the box marked `[!]`.)_
