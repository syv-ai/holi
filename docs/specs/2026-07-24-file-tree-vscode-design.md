# File tree — VS Code-style explorer + CRUD

**Date:** 2026-07-24
**Status:** Delivered — Phase 1 (`docs/plans/2026-07-24-file-tree-vscode.md`) + Phase 2 (`docs/plans/2026-07-25-file-tree-vscode-phase2.md`)
**Area:** `apps/desktop` renderer (file tree) + `main/router.ts` notes procedures

## Goal

Bring the sidebar file tree to VS Code's file-explorer experience as closely as
the vault's constraints allow: right-click context menus, an explorer header with
New File / New Folder / Collapse All, inline create and rename, multi-select,
drag-and-drop to move, cut/copy/paste/duplicate, and keyboard navigation — while
preserving Holi's existing link-aware operations (rename/move rewrites inbound
`[[links]]`; delete previews backrefs and leaves tombstones; every write keeps the
flush→commit ordering).

VS Code (Code – OSS, MIT) is used as the **behavioral reference** — the source of
truth for what the context menu offers, the keybindings, the rename edit-range,
selection semantics, and drop-target rules. Its CSS is **adapted** (row height,
indent, twisty behavior, hover/selected tints ported into our Tailwind idiom),
not copied — VS Code's stylesheet is bound to its own DOM, theming tokens, and
icon font. No VS Code source is vendored.

## Decisions (locked during brainstorming)

- **Scope:** full parity (context menu, inline CRUD, multi-select, DnD,
  cut/copy/paste, keyboard).
- **Engine:** `@headless-tree/react` (MIT) in controlled/external-data mode. It
  supplies selection, focus, keyboard, DnD, typeahead, and ARIA; we own all DOM,
  CSS, and every mutation handler.
- **Empty folders:** **transient**. New Folder is a UI affordance; an empty folder
  lives only in client state and becomes real when the first note is created
  inside it. This preserves the existing invariant that a folder exists iff a file
  is inside it (git cannot track an empty directory — see `lib/tree.ts`).
- **Skin:** Holi-native — monochrome inline-SVG icons, `neutral-800` selection, a
  sky accent on the open-in-editor file, faint indent guides. No icon-font
  dependency (consistent with the app's deliberately lean, no-icon-library ethos).
- **Virtualization:** deferred (YAGNI for a notes vault; headless-tree stays
  virtualization-ready).

## Architecture

The tree remains a **pure projection of `snapshotAtom`** — no second source of
truth. Under D60 there is no server pushing per-entity events, so a second cache
would only be a second chance to disagree.

headless-tree runs in controlled mode: `useTree` is given a synchronous data
adapter that reads the current snapshot (plus a small client-only `pendingNodes`
set for transient folders and inline-create rows), and is re-driven when the atom
changes. The engine's internal state is **selection/focus/expansion only** — never
the vault data.

### Component units

- **`FileTree`** — container. Wires `useTree` to `snapshotAtom` + `pendingNodes`;
  hosts the context menu and keyboard command dispatch.
- **`ExplorerHeader`** — vault name + New File / New Folder / Collapse All actions.
- **`TreeRow`** — twisty, icon, name, inline-edit input; renders
  selected / focused / open-in-editor / cut states in the Holi-native skin.
- **`TreeContextMenu`** — self-contained right-click popover (no menu library).
- **`lib/tree.ts`** — `buildTree` extended to merge pending folders; `HIDDEN_ROOTS`
  unchanged.
- **State (`state/vaults.ts`)** — the mutation atoms in "Backend" below, each
  keeping the flush→commit→op→commit ordering.

## Interaction spec

### Selection model

Two independent notions, as in VS Code:

- **Selected / focused row** — what commands act on. Driven by headless-tree.
  Multi-select via ⌘-click (toggle) and ⇧-click (range).
- **Open-in-editor file** — the note currently in the editor pane (`activePath`,
  already passed into the tree). Rendered with the sky accent, distinct from
  selection.

Single-click selects **and** opens a preview tab (browsing costs one tab).
Double-click pins. Editing a preview promotes it (existing `EditorPane` behavior).

### Keyboard

| Key | Action |
|---|---|
| ↑ / ↓ | move focus |
| → / ← | expand / collapse folder, or descend / ascend |
| Enter | open focused file |
| F2 | rename (inline) |
| ⌫ / Delete | delete selection (with backref preview) |
| typeahead | jump to matching name |
| ⌘X / ⌘C / ⌘V | cut / copy / paste |

### Inline create & rename

- **New File / New Folder** insert an editable input row at the target folder (the
  selected folder, or the parent of the selected file, or root). Escape cancels;
  Enter commits.
- **Rename** edits in place with the **basename pre-selected and the extension
  excluded** (VS Code behavior).
- New files auto-append `.md` when no extension is typed.
- Create/rename refuse to clobber an existing path (CONFLICT surfaced inline).

### Context menu

`New File` · `New Folder` — — `Rename` (F2) · `Delete` (⌫) — — `Cut` · `Copy` ·
`Paste` · `Duplicate` — — `Copy Path` · `Copy Relative Path` · `Reveal in Finder`.

- **Cut + Paste** = move (path change → link rewrite). **Copy/Duplicate + Paste** =
  new note(s), no link rewrite (a copy's `[[links]]` keep pointing at the
  originals, matching VS Code). Duplicate suffixes ` copy` before the extension.
- **Copy Path** = absolute clone path; **Copy Relative Path** = vault-relative
  path. Both via clipboard.
- **Reveal in Finder** reuses the `holi:openPath` IPC (`shell.showItemInFolder`).

### Drag-and-drop

Dragging file(s) or a folder onto a folder = **move** (path-prefix change →
`notes.move`). Multi-drag moves the whole selection. Hidden roots are never valid
drop targets. Dropping onto the tree background moves to vault root.

## Backend / tRPC changes

Generalize the three existing note procedures to batches and add one. Each
operation is wrapped by the renderer with the existing flush→commit→op→commit
ordering, so a batch lands as **one** commit-pair.

| Procedure | Replaces / adds | Covers | Notes |
|---|---|---|---|
| `notes.move({ moves: [{from,to}] })` | generalizes `notes.rename` | rename, drag-move, multi-drag, folder rename/move | **single-pass** link rewrite over the whole from→to map. Doing N independent renames would double-rewrite or miss links that reference a path affected by two moves at once, so the rewrite must know the full map. The renderer expands a folder to its contained file list from the snapshot before calling. |
| `notes.copy({ copies: [{from,to}] })` | new | Duplicate, Copy/Paste, folder copy | reads source, creates at destination; **no** link rewrite. Refuses to clobber. |
| `notes.deleteMany({ paths })` | generalizes `notes.delete` | file, folder, multi-select delete | one commit; clears the editor if an open note is among them. |
| `notes.backrefs({ paths })` | generalizes `notes.backrefs` | delete preview for file **and** folder | returns external inbound links, **excluding** links originating from within the deleted set (internal links to a folder being deleted wholesale are not "left dangling"). |

`notes.rename` / `notes.delete` may be kept as thin single-item wrappers or
removed in favour of the batch forms — the plan decides. **New Folder needs no
backend**: transient folders are client `pendingNodes` state and only touch disk
when the first note is created inside (existing `notes.create`).

### The move link-rewrite (highest-risk logic)

`notes.move` must, in one pass over the vault:
1. Build the full `from→to` map (may contain many entries for a folder move).
2. For every note **not** being moved, rewrite inbound `[[links]]` whose target is
   any `from` to the corresponding `to`.
3. For every note **being** moved, rewrite its own inbound-and-outbound links
   consistently with the map, then move the file.
4. Refuse if any `to` already exists (outside the moved set).

This is the existing `renameNote` link-rewrite generalized from one pair to a map.
It is the piece that most needs focused unit tests.

## Data flow

1. User acts (click / key / drag / menu).
2. headless-tree updates selection/focus/expansion (engine state only).
3. A mutation handler (atom) runs: flush buffers → `commitNow` → batch proc →
   retarget open tabs → reload snapshot → `commitNow`.
4. `snapshotAtom` replaces wholesale; the tree re-projects. A note that arrives by
   pull or agent appears the same way — nobody refetches.

Transient-folder lifecycle: a pending folder renders as an empty expandable row;
creating a note inside makes it real (snapshot now carries it, pending entry
dropped). A snapshot replace with nothing inside drops it — honest to git.

## Edge cases

- **Hidden roots** (`.holi`, `.claude`, `AGENTS.md`, `MEMORY.md`, `CLAUDE.md`)
  stay filtered and are invalid move/drop destinations.
- **Conflicts:** create / move / copy refuse to clobber; surfaced inline.
- **Folder delete** shows a summarized preview: "N notes · M inbound links across
  K files become tombstones (no cascade)."
- **Open tab follows** a moved/renamed note (existing `retargetTab`); a deleted
  open note clears the pane.
- **Daily note / board** integration unchanged.

## Testing

- **Unit (vitest, node env):**
  - `lib/tree.ts` projection, including merged pending folders and hidden-root
    filtering.
  - Batch backend procs against a tmpdir vault — especially `notes.move`'s
    single-pass link rewrite (single rename, folder move, multi-move, and a move
    whose target path references another moved path).
  - `notes.backrefs({ paths })` excluding internal links of a deleted set.
- **CDP (live app):** context menu, DnD, keyboard, inline create/rename, and
  multi-select — matching how the rest of the tree is verified (no jsdom).
- Existing `collaborators-error` / router tests must stay green; typecheck error
  count must not rise above its current baseline.

## Phasing (for the implementation plan)

- **Phase 1 — chrome + single-file parity.** Swap in headless-tree; ExplorerHeader
  (New File / New Folder / Collapse All); Holi-native skin (icons, selection,
  indent guides, twisties); context menu; inline create/rename; keyboard
  (F2 / ⌫ / Enter / arrows / typeahead); transient folders. Single-file ops on
  today's backend (`create`, `rename`, `delete`, `backrefs`).
- **Phase 2 — batch + DnD.** Multi-select; drag-and-drop move; cut/copy/paste/
  duplicate; folder rename/delete/move; the batch backend (`move`, `copy`,
  `deleteMany`, multi-`backrefs`) with the single-pass link rewrite and its tests.

Phase 1 ships a visibly VS Code-like tree early; the risky batch link-rewrite is
isolated in Phase 2 with focused tests.

## Out of scope

- Virtualization (deferred until a vault's size measurably demands it).
- Non-note file types (the vault is markdown; New File creates notes).
- OS-trash delete (git history is the recovery path; the backref preview is the
  safeguard).
- A full file-icon theme (a small monochrome SVG set covers folder + markdown).
