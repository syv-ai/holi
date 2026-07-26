# Design: show/hide hidden files in the explorer

**Status:** Approved (2026-07-26). Small, self-contained renderer feature — implemented directly with TDD (no separate plan doc).

## Summary

A per-vault toggle in the file-tree header that shows or hides **hidden entries**, replacing today's fixed, un-toggleable `HIDDEN_ROOTS` list.

## Behavior

- **Hidden = dot-prefixed.** An entry is hidden if **any path segment starts with `.`** — `.gitignore`, `.holi/…`, `.claude/…`, and nested cases like `sub/.foo`. One pure rule at every depth.
- **Managed markdown is always surfaced.** `AGENTS.md`, `CLAUDE.md`, `MEMORY.md` are **not** dot-prefixed, so they are always visible now (an intended change — Nicolai: "we want CLAUDE.md, AGENTS.md etc surfaced always"). This removes the old `HIDDEN_ROOTS` special-casing. That code cited `(D6)`, a **spent** pre-D60 decision (`decisions.md`: D1–D59 no longer exist), so nothing live is being amended.
- **Toggle:** an eye / eye-off icon button in `ExplorerHeader`, 4th button beside Collapse-All, same styling.
- **State:** `showHidden` persisted **per vault** (localStorage keyed by the vault's `remote`), **defaulting to hidden** for a vault never toggled.
- **Display-only.** Scanning, opening, rendering, and link-aware ops are unchanged — the snapshot still contains every file. A hidden file already open in a tab stays open. Toggling only re-filters the tree.

## Components

- **`isHiddenPath(path): boolean`** — pure; true iff any `/`-segment starts with `.`. Lives in `@holi/shared` beside `isLocalOnlyPath` (`path-safety.ts`); unit-tested.
- **`showHiddenAtom`** — per-vault UI state in the renderer, persisted to `localStorage['holi:showHidden:<remote>']`, default `false`.
- **`ExplorerHeader`** — new `hiddenShown` + `onToggleHidden` props → the eye button.
- **`FileTree`** — read the per-vault flag; filter `docPaths` through `isHiddenPath` before `buildTreeData` when hidden; wire the header button. Remove `HIDDEN_ROOTS` from `tree-data.ts`.

## Data flow

`snapshot → all paths → (showHidden ? all : paths.filter(p => !isHiddenPath(p))) → buildTreeData → tree`. Toggling flips the per-vault flag; the `useMemo` over paths re-filters and the tree rebuilds.

## Testing

- **Unit:** `isHiddenPath` — root dotfile, nested dotfile, `.holi/…`, a plain note, and the three managed md files (asserted *not* hidden).
- **UI:** the toggle button, per-vault persistence, and reveal/hide are CDP/manual per repo norm.

## Non-goals

A global (cross-vault) setting; hiding non-dot files by pattern; changing what the scanner excludes (`.git`, `node_modules`, `*.local.*`, `USER.md`, OS junk stay out of the tree entirely).
