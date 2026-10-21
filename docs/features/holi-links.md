# Holi links

A Holi link points a teammate at a note, or a heading in it, from chat or email. Clicking it opens Holi on that vault and that note.

```
holi://open?vault=syv-ai/team-notes&path=projects/q3%20plan.md&heading=next-steps
```

## How it works

**Shape.** `vault` is the GitHub remote, the one name every machine shares for a vault. `path` is the vault-relative path. `heading` is optional: the heading's GitHub-style slug (`Next steps (Q3)` is `next-steps-q3`), or its words. Values are percent-encoded, except that `/` stays readable. `packages/shared/src/holi-link.ts` builds (`holiLink`) and reads (`parseHoliLink`) them; nothing else knows the shape.

**Copying.** The explorer's row menu has Copy Holi Link on any file. The palette has Copy Holi link for the active note, and Copy Holi link to this heading when the caret is on a heading's line. Local files (`.local.`, secrets) and `.holi/state/` get no link: they never sync, so a teammate's copy cannot have them.

**Arriving at the OS.** The packaged app claims the `holi` scheme (`protocols:` in `electron-builder.yml`, and `setAsDefaultProtocolClient`). macOS hands a click to `open-url`, which can fire before the app is ready, so main listens from its first line and holds links until it can answer. Windows and Linux pass the link in argv: at launch, and to the running Holi through `second-instance`, since only one Holi runs.

**Opening.** Main treats the link as untrusted. `parseHoliLink` refuses a malformed remote, a path `vaultRelPath` rejects, a local or machine-state path, and an over-long heading. Then the vault must be in this machine's registry and the file must exist in its clone, checked with `exactPath` so a symlink or case alias cannot reach outside it. Anything that fails is a native dialog saying why; a vault that is not cloned here says to add it with Add vault… and click again. A link only ever opens a tab.

**Into the window.** A link goes through the same `vault:open` push as a clicked reminder and `holi docs open`. Main holds each open until a renderer has landed its vault (`vault:open-ready`, sent after Home opens), so a cold start or a window recreated from the tray does not lose it or bury it under Home. In the open vault the path opens pinned, in the pane beside the agent's tab when that is the active one. In another vault the renderer switches through `switchVaultAtom`, which still asks when leaving would cost something, and opens the path once that vault has landed (`state/arrival.ts`).

**The heading.** The editor showing the path takes the heading request, now or once its document loads, and puts the caret on the first ATX heading whose slug matches (`findHeadingLine`, which skips frontmatter and fenced code), scrolled to the top. A heading that is not there leaves the note where it opened.

## Rules

- The vault is named by its remote, never by a clone path or a generated id.
- Every check happens in main. The renderer never receives a link that did not pass.
- A dev build does not register the scheme: on macOS it would register the bare Electron.app, and on any machine it would take `holi:` links away from an installed Holi.

## Rejected

- An https link to a hosted page that hands off to Holi. It needs a server Holi does not have, and a teammate who can open the note has Holi installed.

## Code

- `packages/shared/src/holi-link.ts`, `headings.ts` (`headingSlug`, `findHeadingLine`)
- `apps/desktop/src/main/index.ts` (`open-url`, `second-instance`, `openHoliLink`, `showPath`)
- `apps/desktop/src/renderer/src/state/arrival.ts`, `state/holi-link.ts`, `editor/caret-heading.ts`
- `apps/desktop/src/renderer/src/features/editor/EditorPane.tsx`, `features/explorer/RowMenu.tsx`
