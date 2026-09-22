# A PDF opens in a tab, and a mark is saved into the file

**Date** 2026-09-21 · **Decision** D103 · **Status** agreed and built 2026-09-21

> Implement PDF viewing inside Holi, and first decide whether embedpdf is the right library.

The scope was fixed before the evaluation: a `.pdf` in the vault opens in a tab instead of
the "coming soon" placeholder, and the output of Convert-to-PDF (the seven Typst templates,
the brand fonts and logo) renders exactly. Read-only viewing (scroll, zoom, pages, text
selection, search) plus annotations and highlights if the library makes them cheap. No live
preview beside a note, no coupling to the templates beyond rendering their output. No
fallback library was pre-chosen.

## What the evaluation found

Measured in the running dev app over CDP, with a throwaway spike in `features/files/`, against
two Typst 0.14.1 PDFs from the `privat` vault and one Quartz PDF as a control.

- **Licence.** Every `@embedpdf/*` 2.15.1 package on npm is MIT; the PDFium build inside
  `@embedpdf/pdfium` carries PDFium's BSD-3 licence file. The project's `main` branch is a v3
  under Apache-2.0, with a fair-source licence only on an optional server product Holi does
  not use. Nothing here conflicts with the OSS, no-lock-in stance in `prd/pdf-export.md`.
- **Offline.** The `.wasm` ships in the package. Imported with Vite's `?url`, it is emitted as
  an app asset in both dev and the production build (`pdfium-*.wasm`, 4.6 MB, beside a
  0.7 MB worker chunk). With `fontFallback: null` the viewer made **zero** network requests.
  The CDN strings left in the bundle are unused defaults: CJK font fallback packs and stamp
  packs, neither of which is enabled.
- **Workers.** The worker engine runs in dev and in the build. The old Holi's hang on
  "Loading PDF…" came from a root-relative wasm URL resolved against a `blob:` worker base;
  an absolute URL avoids it. The main-thread engine works too and is not needed.
- **Fidelity.** Both Typst PDFs render pixel-clean in a pane, dark mode: brand logo, embedded
  fonts, Danish text, page navigation, zoom, search (one hit for "pull request" on the first
  try) and a text layer that the selection plugin drives.
- **Bytes.** A renderer `fetch` of `holi-vault://` fails on CORS, which `<img>` never needed.
  The protocol is `standard` + `secure` + `supportFetchAPI`, but its responses carry no
  `Access-Control-Allow-Origin`, and a `localhost:5173` (dev) or `file://` (packaged) page is
  cross-origin to it. A blob URL built from bytes loads a 9-page Typst PDF in 24 ms.
- **Theme.** The viewer's UI is Preact inside a shadow root, but its palette is a token map
  (`theme.dark.background.app`, `accent.primary`, …) written as `--ep-*` custom properties on
  that root. A value of `var(--background)` is accepted verbatim and resolves, because custom
  properties inherit across the shadow boundary. D64 tokens flow through with no colour
  literal in TSX.
- **Annotations.** The ready-made toolbar already has Annotate and Shapes tabs: highlight,
  underline, strikeout, squiggly, ink, shapes, free text, sticky note. With `autoCommit`
  (the default) a mark is committed into the in-memory PDFium document as it is made.
  `export.saveAsCopy()` returns the whole document as an `ArrayBuffer`; `exportAnnotations()`
  returns a JSON list instead. `annotation.onAnnotationEvent` fires on create, update and
  delete.
- **Keys.** The commands plugin binds shortcuts on `document` keydown and calls
  `preventDefault` + `stopPropagation` when one matches, so a mounted viewer would eat ⌘P
  (its print) before Holi's palette saw it, and ⌘O would open a file picker. It ignores
  `INPUT`, `TEXTAREA` and contenteditable targets, so CodeMirror and xterm are safe; the
  file tree and the body are not.
- **React 19, StrictMode.** The React wrapper is a thin `forwardRef` around a web component;
  it survived StrictMode's double mount with the registry ready in about 100 ms warm. Its
  effect has no dependencies, so a config change after mount does nothing; theme changes go
  through `container.setTheme()`.
- **Size.** Static import grew the renderer's main chunk from 4.2 MB to 5.6 MB. A lazy
  `import()` moves the viewer into its own chunk. The wasm and worker load on the first PDF.

**Verdict: embedpdf is the library, in its ready-made shape.** The old Holi's 1550 lines came
from the headless route, and the shipped toolbar covers the whole read-only scope plus the
annotations he asked for.

## Decisions

Agreed 2026-09-21, each from an `AskUserQuestion` fork.

1. **The ready-made viewer**, `@embedpdf/react-pdf-viewer` over `@embedpdf/snippet`, with
   `@embedpdf/pdfium` as a direct dependency so the wasm can be imported by URL. Rejected:
   the headless core plus plugins with a Holi toolbar in `primitives/` (full control of the
   chrome, and the route that cost the old app 1550 lines and a StrictMode hang); anything
   other than embedpdf (nothing disqualified it).
2. **Bytes cross the IPC seam, and the renderer builds a blob URL.** A `files.read` query
   returns the file as a `Uint8Array`; structured clone carries it, and the existing rule that
   nothing base64 crosses the seam holds. The renderer wraps it in a `Blob` and hands the
   viewer an object URL as `src`. `holi-vault://` is untouched. Rejected: a CORS header on
   the protocol response, one line in main, because the protocol would then be fetchable
   from a sandboxed vault-app frame as well: a packaged `file://` renderer sends the same
   `null` origin those frames do, so no origin check can tell them apart, and D74's claim
   that an app cannot fetch `holi-vault://` rests on exactly this absence.
3. **A mark lives inside the PDF file.** After an annotation event the viewer waits one
   second of quiet, asks the export plugin for the document bytes and writes them back to
   the same vault path through a `files.write` mutation, which uses `writeAtomic` and returns
   the new mtime. The file then syncs like any binary: autosave commits it, git carries it,
   Preview and every other reader see the marks. Cost, stated: each mark rewrites the whole
   file, and the diff is opaque. Rejected: a sidecar JSON beside the PDF (the original never
   changes, but only Holi shows the marks); in-memory only (cheap and surprising); read-only
   first (the toolbar already has the tabs and disabling them is a config line either way).
4. **The viewer disables what does not belong in a pane** through `disabledCategories`,
   which removes the command and its shortcut together: `document-open` (⌘O, a file picker),
   `document-print` (⌘P, Holi's palette), `document-close` (⌘W is a menu accelerator and the
   tab is Holi's to close), `document-export`, `document-protect`, `document-capture`,
   `document-fullscreen`, `document-menu`, `capture` (⌘⇧S), `redaction`, `signature`,
   `stamp`, `form`, `security`. What stays: zoom, pan, rotate, scroll, search, selection,
   annotation, history, sidebar, comments.
5. **The viewer's own keys stay in the viewer and reach it only from the viewer.** ⌘F, ⌘= and
   ⌘-, ⌘0 and ⌘1, the arrow keys, `h` and `p`, ⌘Z are document-scoped like the mail view's
   ⌘F and do not join the commands table. Because the plugin listens on `document`, a
   keydown whose target is outside the viewer (the file tree, the body) would still reach it,
   so `PdfViewer` registers a `document` keydown listener **before the viewer mounts** (a
   layout effect, which React runs before any child's effect) that calls
   `stopImmediatePropagation` for a key the viewer would claim when the event's path does not
   include the viewer's host. Holi binds none of the surviving keys, so nothing of Holi's is
   lost. Rejected: toggling the viewer's categories on focus (the toolbar would grey out
   whenever you click elsewhere); a `window` capture listener (it would also stop the tree's
   own arrow handling).
6. **Theme is a token map, not a stylesheet.** A pure function maps Holi's whitelisted theme
   tokens onto the viewer's palette as `var(--token)` strings, identical for light and dark
   because the variables already flip. The mode comes from `activeModeAtom` and is applied
   with `setTheme`, not a remount, so a flip does not reload the document.
7. **The file on disk stays the truth.** The viewer keeps the mtime `files.write` returned; a
   snapshot tick whose mtime differs is an external change (a re-export from Convert-to-PDF,
   a pull) and the viewer reloads the bytes. Its own write never triggers a reload. A reload
   while a save is pending is skipped, so at most one quiet second of marks is ever at risk.
8. **The viewer is a lazy chunk.** `React.lazy` around the module that imports embedpdf,
   with the existing placeholder body as the fallback. The main chunk stays where it was.
9. **The `doc` placeholder stays.** `FilePlaceholder`'s `pdf` case goes, its `OpenableKind`
   narrows to `doc`, and `not-built.md` records that the viewer's "genuinely optional"
   framing is dead: he asked for it.

## Out of scope

- Live preview of a note's PDF beside the editor.
- Search across PDFs from the palette. ⌘P quick-opens the file; search inside is the
  viewer's ⌘F.
- Forms, redaction, signatures, stamps, printing, export to disk. All exist in the library
  and are disabled by one list; each is a decision on its own day.
- `.docx` viewing. The `doc` placeholder is unchanged.
- Rendering the viewer's toolbar from Holi's primitives. The shadow-DOM chrome is themed,
  not replaced.

## Consolidation

D103's prose lands in `prd/pdf-export.md` as a new §Viewing a PDF (the viewer's subjects are
that document's outputs), a bullet in `prd/notes-editor.md` §Images and other binaries
replaces the "typed placeholder" sentence for PDFs, `architecture.md` §9 gains the
bytes-over-IPC and shadow-DOM theme notes and §10 the reason `holi-vault://` stays without
CORS, and `not-built.md`'s "Viewing a binary Holi cannot render" entry is rewritten around
`.docx`. The row goes in `decisions.md`'s table with `next free is D104`.

## Verification

- Node: `files.read` returns the bytes of a vault PDF and refuses a path outside the vault;
  `files.write` writes atomically, returns the file's mtime, and the active vault's snapshot
  lists the new mtime.
- Node: the disabled-category list contains every category whose command carries a shortcut
  Holi binds; the theme map names no colour literal; the shortcut normaliser agrees with the
  plugin's on a table of events.
- Dom: `PdfViewer` fetches bytes for its path, passes a blob URL as `src`, saves after an
  annotation event and not before, ignores a snapshot tick carrying its own mtime, reloads on
  a foreign one, and stops a bare `h` keydown from the body before the viewer's listener
  while letting one from inside the viewer through.
- Live, over CDP with his app: `case.pdf` renders; ⌘P with the viewer focused opens Holi's
  palette; a highlight made in the viewer changes the file on disk and `git status` shows it.
