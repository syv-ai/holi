# PDF

Holi turns a markdown note into a branded PDF through a Typst template, and opens any `.pdf` in the vault in a tab where it can be read, marked up, commented on and signed. The agent can do both: render with the same engine, and read a PDF's comments with `holi pdf comments`.

## How it works

**Export.** Convert to PDF picks a template, renders a widget per declared field, asks for a destination in the native save dialog, and opens the result. Main composes a tiny wrapper in a temp dir that imports the template's `doc(notePath, meta: (…), assets: …)` and runs `typst compile wrapper.typ out.pdf --root /`, adding `--font-path` for `_brand/fonts` when present. Before compiling, the note is copied with every `[[wiki-link]]` replaced by its display text, using the shared wiki-link grammar.

**Templates** are committed vault content under `.holi/document-templates/<slug>/`: `template.json`, `template.typ`, optional `assets/`. A directory without a valid manifest is skipped; `_`-prefixed directories are shared foundation (`_brand/`: `brand.typ`, `figures.typ`, logo, fonts). Six are seeded once and are the vault's to edit: `plain`, `letter`, `memo`, `report`, `proposal`, `contract`.

**Fields.** Each `fields[]` entry has `key`, optional `label`, `type`, `required`, `default`, and `options` for `select`. Types: `text`, `textarea`, `number`, `date` (`"today"` default; reaches Typst as a `datetime`), `select`, `checkbox` (always present). Missing or unknown type is `text`; a `select` without options degrades to `text`. A blank optional field is omitted from `meta`, so templates read `meta.at(key, default: none)`. Manifest problems show in the dialog as warnings. A note's frontmatter prefills any field with the exact same key.

**Typst** resolves `TYPST_BIN` → a cached download under `userData/typst` → `PATH`, pinned to `TYPST_VERSION`. The agent gets `$TYPST_BIN` at spawn from a find-only lookup that never downloads on the spawn path; a background `ensureTypst` warms the cache for next time. The seeded `md-to-pdf` skill documents the templates, the field schema and the wrapper recipe, and writes output outside the vault.

**Viewing.** A `.pdf` opens in embedpdf's ready-made viewer (`@embedpdf/react-pdf-viewer` over PDFium wasm), loaded as a lazy chunk. Bytes cross the IPC seam as a `Uint8Array` and become a blob URL. It opens at 150%, or fit-width if the page would overflow, and takes focus. The chrome is themed, not replaced: a palette of `var(--token)` strings (no colour literals, test-enforced) crosses the shadow boundary, and a mode flip calls `setTheme` rather than remounting.

**Marks are saved into the file.** Highlight, underline, ink, shapes, free text and notes commit as drawn; one quiet second after the last annotation event the viewer exports the document and `files.write` replaces the file atomically, returning its mtime. That mtime is ignored when the snapshot reports it; any other mtime (a re-export, a pull) reloads the bytes, except while a save is pending. Marks are signed with the GitHub `login` as `/T`. Default mark colour is the theme's `--primary`, resolved to a hex when the viewer opens; highlighters stay yellow.

**Top bar additions:** Add comment (the viewer's pin-a-comment tool), Signatures, a read-only toggle, and Ask agent.

- **Signatures:** drawn, typed or uploaded; signature only, no initials. The list is kept in `userData/pdf-signatures.json`, one per machine and person, saved on every change. The panel states that a placed signature is committed to the vault and stays in history.
- **Read-only** sets or clears the PDF `readOnly` flag on every mark, comment and signature; the flags are the whole state. Links, form fields and popups are untouched.
- **Ask agent** opens the ask popover. With a comment selected it pastes that thread; otherwise it pastes the file path, the comment count and the `holi pdf comments` command, never the comments. Nothing is submitted.

**`holi pdf comments <path> [--json]`** reads a saved PDF's comment threads through PDFium running in main, so PDFs saved by other tools (compressed object streams, UTF-16) read too. The viewer and the command share one thread model and formatter in `packages/shared`: page, mark kind, covered text, author, local time, comment, replies (text notes linked by `/IRT`). The set matches the viewer's comments panel. The command is read-only and seeded into `permissions.allow`.

## Rules

- Markdown is the source; a PDF is an output. Nothing round-trips back.
- Typst is pinned to one version: templates are authored against it, and a committed template must render the same on every machine.
- The viewer makes no network request. Keep `fontFallback: null`, the bundled `@fontsource` signature faces and `stamp.manifests: []`.
- `holi-vault://` gets no CORS header. Opening it to renderer `fetch` would open it to the sandboxed vault-app frames too, which send the same `null` origin.
- The viewer's keys reach it only from inside it. A layout-effect guard stops a key the viewer would claim when the event started elsewhere.
- Colliding or out-of-scope command categories are disabled as one list (open, print, close, capture, export, protect, fullscreen, menu, redaction, stamps, forms, insert image/attachment/rubber stamp, the Insert tab). Names must be the viewer's own: an unknown name matches nothing and fails silently.
- Signatures never go in a vault: it is a shared repo, and an image of a signature there is a disclosure.
- Every mark rewrites the whole file and the diff is opaque. Accepted, and stated.
- Read-only guards against accidents, not collaborators: another tool or git can clear it.

## Rejected

- Server-side rendering: there is no server; pinning plus committed assets gives the same consistency.
- A WYSIWYG template designer: templates are code.
- Output targets other than PDF (`.typ`, Google Docs): nobody has asked.
- The headless embedpdf core with a Holi-built toolbar: far more code and worker/wasm-URL races; the ready-made toolbar covers the scope.
- A sidecar JSON for marks, or in-memory marks: only Holi would see them, and other readers are part of the point.
- A per-mark lock only its placer can clear: advisory inside Holi, trivially cleared elsewhere, and a local key locks its owner out on another machine.
- Parsing raw PDF bytes for comments, or relying on Claude Code's PDF reading: the first only works for Holi-saved files, the second has no authors or dates.

## Code

- `apps/desktop/src/main/pdf/`: `templates.ts`, `wrapper.ts`, `render.ts`, `typst-bin.ts`, `comments.ts`, `signatures.ts`.
- `apps/desktop/src/main/agent/templates/`: seeded templates and `_brand/` (`binary-assets.generated.ts` is generated).
- `apps/desktop/src/main/agent/skills/md-to-pdf/`, `skills/pdf-comments/`, `ops.ts` (`/pdf/comments`), `cli.ts`.
- `apps/desktop/src/renderer/src/features/pdf/ConvertToPdf.tsx`, `FieldWidget.tsx`; `lib/pdf-fields.ts`.
- `apps/desktop/src/renderer/src/features/files/PdfViewer.tsx`, `PdfDocument.tsx`, `PdfCommentField.tsx`; `lib/pdf-viewer-config.ts`, `lib/pdf-read-only.ts`, `lib/pdf-comments.ts`.
- `packages/shared/src/pdf-comments.ts`, `packages/shared/src/template-fields.ts`.
