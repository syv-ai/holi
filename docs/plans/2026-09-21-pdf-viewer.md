# PDF viewer implementation plan

**Goal:** a `.pdf` in the vault opens in a tab through embedpdf's ready-made viewer, offline,
themed with Holi's tokens, and a highlight made there is saved into the file (D103).
**Approach:** main gains a two-procedure `files` router for bytes; the renderer wraps the
viewer in a lazy feature component that owns loading, saving, reload and the key guard; the
config that decides what the viewer may do is a pure module with node tests. Docs consolidate
last.
**Stack:** `@embedpdf/react-pdf-viewer` 2.15.1 (+ `@embedpdf/pdfium` 2.15.1 for the wasm
URL), React 19, Jotai, tRPC over IPC, Vitest 4 (node project for main and pure modules, dom
project for the component).
**Design of record:** [`../specs/2026-09-21-pdf-viewer-design.md`](../specs/2026-09-21-pdf-viewer-design.md).

## Read before starting

- `AGENTS.md`. Renderer layers: `primitives/` → `composites/` → `features/`; features cannot
  import each other; no `title=`; no colour literals in TSX (`var(--token)` strings in a
  `.ts` module are values, not literals).
- Never run the node and dom Vitest projects at once:
  `pnpm -C apps/desktop exec vitest run --project node` (~4 min) then `--project dom` (~20 s).
- Prettier only on files you touched; `Shell.tsx`, `test/helpers/fake-holi.ts`,
  `docs/decisions.md`, `docs/prd/notes-editor.md`, `index.css` are not clean at HEAD.
- Main changes reach the running dev app only after his restart; renderer changes hot-reload.
  The preload is untouched by this plan.
- The spike from the evaluation is in the tree, uncommitted: `features/files/PdfViewer.tsx`
  (exposes `window.__pdfRegistry`, hard-codes `log: true`, maps three tokens), the `PaneView`
  route, and the two dependencies in `apps/desktop/package.json`. Task 3 replaces the
  component; keep the dependencies and the route.
- The viewer's `openDocumentBuffer` option is `buffer`, not `content`. A wrong key rejects
  with `FPDF_LoadMemDocument failed` code 3, which reads as a corrupt file and is not.

## File map

| File                                                                                                                   | Responsibility                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/main/router.ts`                                                                                      | `files.read` (query, `Uint8Array`) and `files.write` (mutation, `{ updatedAt }`), mounted beside `notes` |
| `apps/desktop/test/router-files.test.ts` (new)                                                                         | Round trip, containment refusal, mtime returned, snapshot refreshed                                      |
| `apps/desktop/src/renderer/src/lib/pdf-viewer-config.ts` (new)                                                         | `PDF_DISABLED_CATEGORIES`, `pdfViewerTheme()`, `shortcutOf(event)`; pure                                 |
| `apps/desktop/test/pdf-viewer-config.test.ts` (new)                                                                    | The three functions above                                                                                |
| `apps/desktop/src/renderer/src/features/files/PdfViewer.tsx`                                                           | The lazy shell: `React.lazy` + `Suspense` around `PdfDocument`, fallback is the file name                |
| `apps/desktop/src/renderer/src/features/files/PdfDocument.tsx` (new)                                                   | Bytes → blob URL → viewer; save-back; external reload; theme; key guard                                  |
| `apps/desktop/src/renderer/src/features/files/__tests__/PdfDocument.test.tsx` (new)                                    | Behaviour with `@embedpdf/react-pdf-viewer` mocked                                                       |
| `apps/desktop/src/renderer/src/features/files/FilePlaceholder.tsx`                                                     | Drop the `pdf` case; `OpenableKind` becomes `'doc'`                                                      |
| `apps/desktop/src/renderer/src/components/PaneView.tsx`                                                                | `pdf` → `PdfViewer`, `doc` → placeholder (spike route, kept)                                             |
| `apps/desktop/src/renderer/src/components/__tests__/PaneView.test.tsx`                                                 | Mock `PdfViewer` the way `SessionTerminal` is mocked                                                     |
| `docs/prd/pdf-export.md`, `docs/prd/notes-editor.md`, `docs/architecture.md`, `docs/not-built.md`, `docs/decisions.md` | Consolidation (Task 5)                                                                                   |

## Tasks

### Task 1: bytes cross the seam

**Files:** modify `main/router.ts` (a `files` router beside `notes`, mounted in the root
router) · test: a `files` describe in `test/router.test.ts`, which owns the `rig` fixture

**Behaviour:** `files.read({ remote, path })` returns the file's bytes as a fresh `Uint8Array`
(not a pooled `Buffer` view); NOT_FOUND when absent; the path goes through `safe()` like
`notes.read`. `files.write({ remote, path, bytes })` validates by hand (`fields` cannot say
`Uint8Array`), writes through `writeAtomic`, and returns `{ updatedAt }` as the ISO mtime the
scanner will report. It is a `vaultMutation`, so the active vault rescans.

- [x] Write the test first: seed a clone with a small binary file (any bytes, `%PDF-1.7` head
      is enough); `read` returns equal bytes and an instance of `Uint8Array` whose
      `byteOffset` is 0; `read` of `../x` rejects; `write` of new bytes round-trips through
      `readFile` and returns an `updatedAt` equal to `stat(...).mtime.toISOString()`; after
      `write`, `vaults.snapshot` lists the path in `files` with that `updatedAt`.
- [x] Implement. Refuse a non-`Uint8Array` `bytes` with a plain `Error` (tRPC makes it
      BAD_REQUEST). Copy the read result with `new Uint8Array(buf)`.
- [x] Verify: `pnpm -C apps/desktop exec vitest run --project node router-files`.

### Task 2: what the viewer may do, as data

**Files:** create `lib/pdf-viewer-config.ts` · test `test/pdf-viewer-config.test.ts`

**Behaviour:** `PDF_DISABLED_CATEGORIES` is the list in design decision 4. `pdfViewerTheme()`
returns a `{ preference, light, dark }` object whose every colour is a `var(--…)` string over
Holi's whitelisted tokens (`background` → `background.app`, `card` → `background.surface`,
`popover` → `background.elevated`, `input` → `background.input`, `foreground` →
`foreground.primary`, `muted-foreground` → `foreground.secondary` and `.muted`, `primary` →
`accent.primary` and hover/active, `primary-foreground` → `accent.primaryForeground` and
`foreground.onAccent`, `accent` → `interactive.hover` and `.active`, `selection` →
`interactive.selected` and `accent.primaryLight`, `ring` → `interactive.focus`, `border` →
`border.default`, `divider` → `border.subtle`, `destructive` → `state.error`). `shortcutOf(e)`
mirrors the plugin's normaliser: modifiers `ctrl`/`shift`/`alt`/`meta` plus the lower-cased
key, `' '` → `space`, a bare modifier → `null`, all sorted and joined with `+`.

- [x] Test: the list contains `document-print`, `document-open`, `document-close`,
      `capture`; every value in the theme matches `/^var\(--[a-z-]+\)$/` and every token named
      is in `THEME_TOKENS` from `@holi/shared`; `shortcutOf` on `{ metaKey, key: 'P' }` is
      `meta+p`, on `{ key: 'h' }` is `h`, on `{ key: 'Shift', shiftKey }` is `null`, on
      `{ ctrlKey, shiftKey, key: 'Z' }` is `ctrl+shift+z`.
- [x] Implement; the file imports only from `@holi/shared` and has no React.
- [x] Verify: `pnpm -C apps/desktop exec vitest run --project node pdf-viewer-config`.

### Task 3: the viewer component

**Files:** rewrite `features/files/PdfViewer.tsx`; create `features/files/PdfDocument.tsx`;
test `features/files/__tests__/PdfDocument.test.tsx`; modify `FilePlaceholder.tsx`,
`components/__tests__/PaneView.test.tsx`

**Behaviour:** `PdfViewer({ path })` is `Suspense` around a `React.lazy` `PdfDocument`; the
fallback is the placeholder's centred file name. `PdfDocument`:

- reads `activeRemoteAtom`, calls `trpc.files.read`, builds `URL.createObjectURL(new Blob([bytes],
{ type: 'application/pdf' }))`, revokes it on unmount and on reload;
- renders `PDFViewer` with `config = { src, wasmUrl, worker: true, fontFallback: null,
tabBar: 'never', disabledCategories: PDF_DISABLED_CATEGORIES, theme: pdfViewerTheme(mode),
annotations: { annotationAuthor: <nothing: leave unset> } }`; `wasmUrl` is
  `new URL(pdfiumWasmUrl, window.location.href).href`;
- on `onReady(registry)`: subscribes `annotation.onAnnotationEvent`; each event restarts a
  1 s timer; on fire, `export.saveAsCopy().toPromise()` then `trpc.files.write`, storing the
  returned `updatedAt` in a ref; a save in flight when the tab unmounts still completes;
- on `activeModeAtom` change after mount: `ref.current.container.setTheme(pdfViewerTheme(mode))`;
- reads the file's `updatedAt` from `snapshotAtom.files`; when it changes and is not the
  ref's value and no save is pending, re-fetches bytes and swaps `src` by remounting the
  viewer (a `key` on the object URL);
- `useLayoutEffect`: `document.addEventListener('keydown', guard)` where `guard` calls
  `event.stopImmediatePropagation()` when `!event.composedPath().includes(hostRef.current)`
  and the registry's commands plugin `getCommandByShortcut(shortcutOf(event))` returns a
  command; removed on unmount.

- [x] Mock `@embedpdf/react-pdf-viewer` in the test: `PDFViewer` renders
      `<div data-pdf-src={config.src} />`, calls `onReady` with a fake registry whose
      `getPlugin(id).provides()` gives `annotation.onAnnotationEvent` (captures the listener),
      `export.saveAsCopy` (returns a Task-like `{ toPromise }` resolving to 4 bytes),
      `commands.getCommandByShortcut` (returns a command for `h` and `meta+f` only), and a
      `document` listener the fake registers on mount that records what reached it. Mock
      `@embedpdf/pdfium/pdfium.wasm?url` to a string. Use `installFakeHoli` for
      `files.read`/`files.write` and `pushSnapshot` for the mtime.
- [x] Tests: renders a `blob:` `src` after `files.read` resolves; no `files.write` before an
      annotation event; one `files.write` with the exported bytes ~1 s after an event (fake
      timers); a `pushSnapshot` whose `updatedAt` equals the write's result does not call
      `files.read` again; one with a different `updatedAt` does; a `keydown` `h` dispatched on
      `document.body` is not seen by the fake's listener while one dispatched inside the
      viewer host is; unmount revokes the URL (`vi.spyOn(URL, 'revokeObjectURL')`).
- [x] Implement. `PdfViewer.tsx` stays tiny so `PaneView` imports nothing from embedpdf.
- [x] `FilePlaceholder`: remove the `pdf` case and its `FileText` import if unused;
      `OpenableKind = 'doc'`; `PaneView` passes `kind="doc"`.
- [x] `PaneView.test.tsx`: `vi.mock('@/features/files/PdfViewer', …)` to a stub `div`, since
      the pane tests open `.pdf` tabs on purpose to avoid the editor stack.
- [x] Verify: `pnpm -C apps/desktop exec vitest run --project dom files PaneView`;
      `pnpm lint` 0 errors; `pnpm --filter @holi/desktop typecheck`.

### Task 4: live walkthrough

- [ ] His app on port 9333 has the new main only after he restarts it; until then
      `files.read` is "no such procedure". Ask him to restart, then over CDP: open `case.pdf`,
      confirm `[data-pdf-viewer] embedpdf-container` has page `<img>`s; focus the viewer and
      dispatch ⌘P, confirm the palette opened; make a highlight through the registry
      (`annotation.provides().createAnnotation` on page 0) and confirm `git -C <vault> status`
      shows `case.pdf` modified within ~2 s; open `case.md`, edit nothing, return to
      `case.pdf`, confirm the mark persisted.
- [x] Build: `pnpm --filter @holi/desktop build`; confirm the embedpdf chunk is separate from
      `index-*.js` and the main chunk is back near 4.2 MB.

### Task 5: consolidate D103

- [x] `docs/decisions.md`: row in the table pointing at the spec, plan and the four living
      docs; `next free is D104` in both the heading and the preamble sentence.
- [x] `docs/prd/pdf-export.md`: new `## Viewing a PDF` before §Dependencies, with the library,
      the bytes route, the theme route, the save-into-file rule and its cost, the disabled
      list's reason, and the rejected alternatives. Update the top callout's file list.
- [x] `docs/prd/notes-editor.md` §Images and other binaries: the "standalone image viewer"
      bullet gains the PDF viewer and points at `pdf-export.md`.
- [x] `docs/architecture.md` §9: a bullet on bytes over IPC for binaries and on theming a
      shadow root by token map; §10: `holi-vault://` stays CORS-less, and why.
- [x] `docs/not-built.md` line 120: rewrite around `.docx`; record that the PDF viewer shipped
      2026-09-21 and that "genuinely optional" was overtaken by his request.
- [x] Spec status line → `agreed and built`.
- [x] `pnpm exec prettier --check` on every file touched (`--write` on the new ones).

## End-to-end verification

```sh
pnpm -C packages/shared test
pnpm -C apps/desktop exec vitest run --project node
pnpm -C apps/desktop exec vitest run --project dom
pnpm typecheck
pnpm lint
pnpm --filter @holi/desktop build
```
