# PDF

Holi turns a markdown note into a branded PDF through a Typst template, and opens any `.pdf` in the vault in a tab where it can be read, marked up, commented on and signed. The agent can do both: render through the same entry with `holi pdf render`, and read a PDF's comments with `holi pdf comments`.

## How it works

**Export.** Convert to PDF picks a template, renders a widget per declared field, asks for a destination in the native save dialog, which opens beside the note so the PDF lands in the vault unless the user picks elsewhere, and opens the result: in a tab when it is in the vault, revealed in Finder otherwise. Main composes a tiny wrapper in a temp dir that imports the template's `doc(notePath, meta: (…), assets: …)` and runs `typst compile wrapper.typ out.pdf --root /`, adding `--font-path` for `_brand/fonts` when present. Before compiling, the note is copied with every mermaid fence drawn as a diagram, at the fence's indent, and every `[[wiki-link]]` around the diagrams replaced by its display text, using the shared wiki-link grammar.

**Diagrams.** A ` ```mermaid ` fence comes out as its diagram, in both paths: Convert to PDF and `holi pdf render` are one capability, and main draws the diagrams itself in a hidden `BrowserWindow`. That window loads mermaid's own bundle from the app's dependencies, is sandboxed with no preload and no Node, cannot navigate, has every request cancelled and every permission denied, and keeps mermaid's strict security level. It is opened by the first note with a diagram, reused, and closed after a minute idle or when the plugin stops. Diagrams are drawn in mermaid's light theme, since a PDF is always light, with SVG text labels, because Typst's SVG reader does not draw HTML in a `foreignObject`. Each SVG goes into the note's copy as a `<!--raw-typst … -->` comment holding the image's bytes, not as `![](file.svg)`: cmarker evaluates a markdown image inside its own package, so no path reaches the disk, while raw Typst works in every template that renders through cmarker, unchanged. A diagram mermaid cannot draw keeps its fence and prints as code, and the render reports it: Convert to PDF keeps its dialog open to say which, and the command prints a line for it. One diagram never fails a PDF.

**Templates** are committed vault content under `.holi/document-templates/<slug>/`: `template.json`, `template.typ`, optional `assets/`. A directory without a valid manifest is skipped; `_`-prefixed directories are shared foundation (`_brand/`: `brand.typ`, `figures.typ`, logo, fonts). Six are seeded once and are the vault's to edit: `plain`, `letter`, `memo`, `report`, `proposal`, `contract`. A manifest may set `language` (a code such as `da` or `en`, else ignored with a warning), which reaches Typst as `--input lang=…`: it sets the text language, and the template writes its dates and its own labels (the report's contents, the memo's To/From, the signature lines) in it. The branded five say `da` ("21. oktober 2026") and `plain` says `en`. Typst's own `display` names months in English whatever the language, so the Danish months are spelled out in `_brand` and `plain`. A per-template key rather than a vault or per-render setting: a template is written for a language, and a vault that needs both keeps one of each.

**Fields.** Each `fields[]` entry has `key`, optional `label`, `type`, `required`, `default`, and `options` for `select`. Types: `text`, `textarea`, `number`, `date` (`"today"` default; reaches Typst as a `datetime`), `select`, `checkbox` (always present). Missing or unknown type is `text`; a `select` without options degrades to `text`. A blank optional field is omitted from `meta`, so templates read `meta.at(key, default: none)`. Manifest problems show in the dialog as warnings. A note's frontmatter prefills any field with the exact same key.

**`holi pdf render <note> [<template>]`** is the agent's way in: the template defaults to `plain`, `--out` takes a `.pdf` path (absolute, or relative to the vault), and each field is `--<key> <value>`. The note, the default PDF beside it and a relative `--out` are resolved with symlinks followed and must stay inside the vault; an absolute `--out` is the only way to write outside it, and a symlink already at the destination is refused, since the write would land wherever it points. A secret path (`isSecretPath`) or one under `.holi/state` is refused as the note and as the destination, as given and as resolved, so a secret never reaches a committable PDF and no PDF lands among machine state. Fields fill the way the dialog fills them, a value given, else the note's frontmatter, else the field's default, and an undeclared or missing required field is refused by name. It prints where the PDF went, its size, and any diagram that shows as code. It is not seeded into `permissions.allow`: `--out` can replace a PDF outside the vault, where no history keeps the earlier version.

**Typst** resolves `TYPST_BIN` → a cached download under `userData/typst` → `PATH`, pinned to `TYPST_VERSION`. The plugin begins the download in the background when it starts, and runs one download at a time. `holi pdf typst` ensures the binary and prints its path, for anything the render does not cover. The seeded `md-to-pdf` skill documents the templates and the fields, renders with `holi pdf render`, and puts the PDF next to its note too, unless the user asks otherwise or it is over about 10 MB, since the repository keeps every version of a binary.

**Viewing.** A `.pdf` opens in embedpdf's ready-made viewer (`@embedpdf/react-pdf-viewer` over PDFium wasm), loaded as a lazy chunk. Bytes cross the IPC seam as a `Uint8Array` and become a blob URL. It opens at 150%, or fit-width if the page would overflow, and takes focus. The chrome is themed, not replaced: a palette of `var(--token)` strings (no colour literals, test-enforced) crosses the shadow boundary, and a mode flip calls `setTheme` rather than remounting.

**Marks are saved into the file.** Highlight, underline, ink, shapes, free text and notes commit as drawn; one quiet second after the last annotation event the viewer exports the document and `files.write` replaces the file atomically, returning its mtime. That mtime is ignored when the snapshot reports it; any other mtime (a re-export, a pull) reloads the bytes, except while a save is pending. Marks are signed with the GitHub `login` as `/T`. Default mark colour is the theme's `--primary`, resolved to a hex when the viewer opens; highlighters stay yellow.

**Top bar additions:** Add comment (the viewer's pin-a-comment tool), Signatures, a read-only toggle, and Ask agent.

- **Signatures:** drawn, typed or uploaded; signature only, no initials. The list is kept in `userData/pdf-signatures.json`, one per machine and person, saved on every change. The panel states that a placed signature is committed to the vault and stays in history.
- **Read-only** sets or clears the PDF `readOnly` flag on every mark, comment and signature; the flags are the whole state. Links, form fields and popups are untouched.
- **Ask agent** opens the ask popover, and shows only while the agent service exists. With a comment selected it pastes that thread; otherwise it pastes the file path, the comment count and the `holi pdf comments` command, never the comments. Nothing is submitted.

**`holi pdf comments <path> [--json]`** reads a saved PDF's comment threads through PDFium running in main, so PDFs saved by other tools (compressed object streams, UTF-16) read too. The viewer and the command share one thread model and formatter in the plugin's `shared/`: page, mark kind, covered text, author, local time, comment, replies (text notes linked by `/IRT`). The set matches the viewer's comments panel. `holi pdf comments` and `holi pdf typst` are seeded into `permissions.allow`: one reads, the other only finds the engine.

## Rules

- Markdown is the source; a PDF is an output. Nothing round-trips back.
- One render for both doors. The agent's PDFs and Convert to PDF's must not differ, diagrams included: a diagram that draws in the editor and not in one of the two PDFs is worse than one that draws nowhere.
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
- Drawing diagrams in the renderer before Convert to PDF: cheap, but the agent's PDFs would still show code, and the two paths would disagree. Leaving mermaid out of PDFs altogether: honest, but it leaves the editor and the PDF disagreeing instead.
- Writing each diagram to a temp SVG and linking it: cmarker resolves image paths inside its own package, so the link would need every template to override `image`, and templates are vault content seeded once.
- The headless embedpdf core with a Holi-built toolbar: far more code and worker/wasm-URL races; the ready-made toolbar covers the scope.
- A sidecar JSON for marks, or in-memory marks: only Holi would see them, and other readers are part of the point.
- A per-mark lock only its placer can clear: advisory inside Holi, trivially cleared elsewhere, and a local key locks its owner out on another machine.
- Parsing raw PDF bytes for comments, or relying on Claude Code's PDF reading: the first only works for Holi-saved files, the second has no authors or dates.

## Code

PDF is a plugin (`apps/desktop/src/plugins/pdf/`, default on; [architecture](../architecture.md#plugins)). With it off, its capabilities answer "no such method" and its seeded files stay as inert vault content.

- `plugins/pdf/main/index.ts`: the plugin's main side; on start it registers the capabilities, opens the signature store and warms Typst.
- `plugins/pdf/main/`: `templates.ts`, `wrapper.ts`, `render.ts`, `mermaid.ts` (fences to diagrams, the drawing handed in), `mermaid-window.ts` (the hidden window, the plugin's only Electron import), `typst-bin.ts`, `comments.ts`, `signatures.ts`.
- `plugins/pdf/main/capabilities.ts`: `pdf.comments` and `pdf.typst` (CLI door); `pdf.render` (both); `pdf.templates`, `pdf.signatures`, `pdf.saveSignatures` (UI door).
- `plugins/pdf/main/seed.ts`, `main/vault/once/.holi/document-templates/`: seeded templates and `_brand/`, whose fonts and logo seed as bytes (`?inline`); `main/vault/shipped/.claude/skills/md-to-pdf/`, `skills/pdf-comments/`.
- `plugins/pdf/renderer/index.tsx`: the claims: a `.pdf` opens in `PdfViewer`, a markdown note's row menu offers Convert to PDF in the plugin dialog. With the plugin off, a `.pdf` opens in the file placeholder.
- `plugins/pdf/renderer/`: `ConvertToPdf.tsx`, `FieldWidget.tsx`; `PdfViewer.tsx`, `PdfDocument.tsx`, `PdfCommentField.tsx`, `pdf-sidebar-leave.ts`, `pdf-viewer-config.ts`, `pdf-read-only.ts`, `pdf-comments.ts`. They call the main side through `capClient` over a type import of its table.
- `plugins/pdf/shared/`: `pdf-comments.ts` (the thread model and formatter both sides use), `template-fields.ts`, `pdf-fields.ts` (frontmatter prefill and required fields).
- `plugins/pdf/test/`: the plugin's node and DOM tests.
