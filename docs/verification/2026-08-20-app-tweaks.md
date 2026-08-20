# Four tweaks around vault apps — what was checked by hand

Verified **2026-08-20**, in the running dev app (`electron-vite dev --remote-debugging-port=9333`),
against the real `nthomsencph/privat` vault, driven over CDP.

**Legend:** `[x]` verified in-app · `[~]` verified another way, named below · `[ ]` not verified.

The four came in as symptoms, not diagnoses. Every one was **reproduced in the running app before
anything was changed**, because two of them had more than one plausible cause and the cheap reading
was not always the right one.

## 1. Apps sit under the file tree

Not a JSX ordering problem — `AppsSection` was already the next sibling of `FileTree`. The tree's
root was `flex-1`, so it absorbed every spare pixel in the sidebar column and pushed the apps list
down onto the chip rows.

- [x] **Reproduced first.** The sidebar measured 44 / 576 / 49 / 70 px: a tree box of 576 px
      holding ~264 px of rows, with the apps list stranded at y=620, directly above the chips.
- [x] **Fixed.** Same vault, same 10 rows: the tree is now 264 px — its actual content — and the
      apps list sits at y=308, immediately under the last row. The chips stay on the floor at
      y=669 (`mt-auto`), so the spare height collects *between* apps and chips instead of above
      apps.
- [x] **It still scrolls.** Expanded to 77 rows / 1738 px of content, the tree caps at 576 px and
      the inner scroller reports `scrollHeight 1738 > clientHeight 576`. The apps list is still
      visible at y=620 and the chips still at y=669. Growing to content and capping at the space
      available are the same rule, not two.

The trap, recorded because it is not obvious: the inner scroller had to lose `flex-1` too.
`flex-1` means `flex-basis: 0`, and with the root no longer stretched a zero basis collapses the
tree to nothing.

## 2. Apps have a context menu

- [x] **The menu renders with the intended items**, live on `vault-dashboard`:
      Open · Edit Source · Rename… · Delete · Copy Path · Reveal in Finder.
- [x] **An unfinished app is visible and dimmed.** A hand-made
      `.holi/apps/scratch-probe/index.html` (entry document, no manifest) appeared in the sidebar
      within one watcher pass, italic and below the finished app, with a tooltip naming what it
      lacks. It had been computed by `unregisteredAppIdsAtom` and rendered nowhere since slice 2.
- [x] **Finish this app works, live.** Its menu offered `Finish this app` in place of `Open`;
      selecting it wrote `.holi/apps/scratch-probe/app.yaml` and the row went from dimmed to
      registered with no restart and no refresh.
- [x] **Rename, end to end, with the app open in a tab.**
      - The field is seeded with the current id, not empty.
      - `Probe Renamed` → refused inline: *an app id is lowercase letters, digits and dashes only*,
        and nothing was sent.
      - `vault-dashboard` → refused inline: *vault-dashboard already exists*. Escape put the row
        back intact.
      - `probe-renamed` → the directory moved on disk, the sidebar row changed, and the open tab's
        frame followed from `holi-app://scratch-probe/index.html` to
        `holi-app://probe-renamed/index.html`. That last one is the whole reason `retargetAppTab`
        exists: `retargetTabs` keys on `path`, and an app tab has none.
- [x] **Delete.** The confirm dialog named `.holi/apps/probe-renamed` and reported no inbound
      links; confirming removed the files, dropped the row, and closed the tab (no `<iframe>` left).
      The empty directory remains, as designed and as folder-delete in the tree already behaves.
- [x] **Copy Path / Reveal in Finder** target the app directory, not a file inside it (unit test;
      the menu items were exercised in-app, `openPath` not clicked to avoid opening Finder).

**Not built: Open in a new pane.** `Workspace` is `panes[] → tabs[]`, but `Shell` renders
`panes[workspace.active]` and nothing else, and there is no split UI anywhere. That menu item is a
pane system, not a menu item, and it is out of scope for a tweak.

## 3. `.js` / `.html` / `.css` render

The symptom had two plausible readings — *unhighlighted* or *genuinely blank* — with different
fixes. It was the first.

- [x] **Reproduced first.** Opening `.holi/apps/vault-dashboard/app.js`, `style.css` and
      `index.html` gave a populated editor with **zero** highlight spans, while `app.yaml` in the
      same directory gave four. So the files reached the editor fine; `languageForPath` returned
      `[]` for them. The `.holi/` hidden-path filter was not involved.
- [x] **Fixed.** Same three files: `app.js` 328 spans, `style.css` 190, `index.html` 104.
      `app.yaml` unchanged at 4, and `.gitignore` still 0 — it has no language and is not supposed
      to grow one.

TypeScript is deliberately still absent. An app ships unbuilt, so nothing would compile a `.ts`
file under `.holi/apps/`, and highlighting it would advertise a language the runtime does not have.

## 4. The `.json` files in `privat/.holi/`

- [x] **`templates/plain/` was a leftover and is gone.** Byte-identical (`diff -r`) to
      `document-templates/plain/`, which D66 renamed it to on 2026-08-04; it was still tracked in
      git. Nothing in the source refers to `.holi/templates` — `TEMPLATES_REL` is
      `.holi/document-templates` and the only other mentions are in a historical plan doc. Deleted
      on disk; Holi's own sync loop committed the removal (2 files, 57 deletions).
- [x] **Everything else in `.holi/` is current** and was checked against the code that writes it:
      `vault.json` (marker), `settings.json` (D76 hooks list), `theme.json` + `theme.local.json`
      (D64), `context.local.json`, `seed-state.local.json` (D75), `hook-endpoint.local.txt` (D76).

**No theme folder, and none proposed.** D64 defines a theme as one whitelisted token map, so it is
two flat files rather than a directory. Grouping the `*.local.*` runtime files was considered and
not done: `isLocalOnlyPath` keys on the `.local.` marker in the **basename** (D65) and cannot mark
a directory, so the marker would have to stay on every filename anyway and the grouping would buy
nothing but a level of nesting.

## Found along the way, not fixed

**`moveNotes` deletes every `from` but only writes back `.md`.** `main/vault/move.ts:29` skips any
path that is not markdown, so a non-markdown file never reaches `planned`; line 39 then removes
every `from` unconditionally. A batch move of, say, a `.png` would delete it and write nothing.

It is **latent, not live**: every caller expands its target through `filesUnder(docPaths, …)`, and
`docPaths` is markdown only, so nothing in the product can currently reach it. It is recorded here
because it is exactly the trap an app rename would have fallen into — routing an app directory
through `notes.move` would have destroyed the app — which is why `renameAppOp` renames the
directory itself instead. Fixing `moveNotes` to carry non-markdown files verbatim is a small change
and its own decision.

## What was not verified

- [ ] **The agent has still never used any of this by itself.** Everything above was driven by
      hand over CDP. This is the same gap slice 2 and the hooks work both left open.
- [ ] **Rename with real inbound `[[link]]`s in the running app.** The link rewrite is covered by
      a node test against real files (`test/app-ops.test.ts`), but the vault had nothing linking
      into `.holi/apps/`, so the in-app path exercised the zero-link case.
- [ ] **A rename or delete on a vault with a collaborator mid-pull.** Main stats the directory and
      refuses a collision, which is the guard; the race itself was not staged.

## Cost worth naming

Verifying §2 in the real vault left four commits in `nthomsencph/privat`'s history
(`scratch-probe` created, finished, renamed, deleted). The working tree ended clean and the app is
fully gone, so this is history noise rather than residue — but it is on the remote.
