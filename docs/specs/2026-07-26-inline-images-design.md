# Design: Inline images + standalone image viewer

**Status:** Approved (2026-07-26) — ready for a plan.
**Decision:** D62 (`docs/decisions.md`) — the vault is text-first *by authorship*; binaries are assets it holds and emits. This is the first of D62's two near-term slices (the other is the `md-to-pdf` Typst vault skill, specced separately).

## Summary

Markdown notes reference images (`![](path)` and `[[img.png]]`); today those references render nothing and image files open a "preview coming soon" placeholder. This slice makes images **render** — inline in the editor's live-preview, and full-frame when an image file is opened from the tree.

The design rests on **one keystone and two thin consumers**. The keystone is a `holi-vault://` image source: once `<img src="holi-vault://<vaultRelPath>">` resolves to bytes off the active vault, the inline case is a small CodeMirror widget wrapping that `<img>`, and the viewer is a full-frame `<img>`. Everything else is a thin adapter over the primitive.

## Why a protocol, not base64

`notes.read` (`router.ts:636`) is UTF-8-only and unusable for binary. The two candidates for a bytes path:

- **A privileged `holi-vault://` protocol** (chosen). `<img src>` resolves synchronously; the browser caches by URL; no base64 in the document.
- A base64 tRPC procedure (rejected). The inline renderer is a CodeMirror `WidgetType` — **not** a React component — so it cannot use an async fetch/cache hook. base64 would force imperative fetch + a module-level cache + re-render-on-load inside the widget. The protocol removes async plumbing from the hardest place; a synchronous `img.src` is strictly simpler there.

## The keystone: `holi-vault://` protocol

Registered in `main` before window creation.

- **URL shape:** `holi-vault://vault/<vaultRelPath>` — path only. There is exactly one `ActiveVault` at a time, and a vault switch resets the workspace (`Shell.switchVault`), so the open note is always in the active vault. The handler resolves against the active vault's root; no remote is encoded in the URL.
- **Handler:** maps the URL's path → `absPathFor(activeVaultRoot, safe(path))` and streams the file. It **reuses the router's existing guard** — `safe()` / `vaultRelPath()` (`router.ts:292-298`) + `absPathFor` — so there is one validation path, not a duplicate. Path traversal (`../`) and any path escaping the managed root are rejected exactly as `notes.read` rejects them. No active vault, or a missing file → a 404-style empty response.
- **Root access:** the handler reads the current root from the `ActiveVault` host (the same `deps.host.active()` the router uses), so it is a thin adapter with no state of its own.
- **CSP:** there is currently **no** Content-Security-Policy in the app (no `<meta>` CSP in `renderer/index.html`, no `onHeadersReceived` CSP in main), so nothing blocks the load today. If a CSP is introduced later, its `img-src` must include `holi-vault:`.
- **Scheme privileges:** registered via `registerSchemesAsPrivileged` (`{ standard: true, secure: true, supportFetchAPI: true, stream: true }`) before `app.whenReady`, with the handler installed in/around `createWindow` (`main/index.ts:47`).

## Path resolution (one pure function)

A single pure helper in `@holi/shared` turns a raw reference + the containing note's path into a vault-relative path for the URL:

- **`![](target)` — note-relative.** Join `target` against the note's folder and normalize `./` / `../`. `![](img.png)` in `projects/proposal.md` → `projects/img.png`. This matches standard markdown and how GitHub renders the repo.
- **`[[img.png]]` — vault-relative.** Used as-is (identity), matching Holi's existing `[[wiki]]` semantics (`wiki-links.ts:49-76` already returns a vault-relative, `/`-separated target).
- **`http(s)://…` — external.** Passed straight through as the `<img src>`; not a vault asset.

Resolution lives in the renderer (the note's path is known there); `main` only ever sees a resolved vault path. The function is I/O-free and unit-tested (join, normalize, `..` escape → rejected/clamped, http passthrough).

## Consumer 1 — inline rendering (`editor/livePreview.ts`)

`buildDecorations` walks the Lezer tree and emits widget decorations (the model already used for HR and, separately, wiki-link chips). Two additions, both producing the **same** `ImageWidget`:

- **`case 'Image':`** in the node switch (near the existing `Link` handling, ~`livePreview.ts:153`) for `![alt](path)`. Resolve note-relative → `ImageWidget(url, alt)`.
- **A branch in the wiki-link loop** (`livePreview.ts:181-196`): when `fileKind(link.target) === 'image'`, emit `ImageWidget` (vault-relative) instead of `WikiLinkChip`.

`ImageWidget` is modeled on `WikiLinkChip` (`editor/wikiLinkChips.ts:18-50`): extends `WidgetType`, `eq()` compares the resolved URL, `toDOM()` builds a single bounded `<img>` (`max-width: 100%`, capped height, `alt` set), `ignoreEvent() → false`. The existing **active-line reveal** (`isActive(node.from)`) keeps the raw markdown editable when the cursor is on that line — identical to every other widget, so editing an image link behaves like editing any other syntax.

A missing/broken file falls back to the native `<img>` alt text — no custom fallback component.

## Consumer 2 — standalone viewer (`components/ImageViewer.tsx`)

A new component, routed in the pane-content switch at `Shell.tsx:200` by adding a `fileKind(tab.path) === 'image'` branch **before** the generic `FilePlaceholder` branch. No new tab kind — an image opens as a `kind: 'note'` tab (as it already does) and the switch keys off `fileKind`.

Renders a single `<img src="holi-vault://vault/<tab.path>">` fit-to-window (`object-fit: contain`) on the dark canvas, with a filename caption. Minimal: no zoom, no pan. `FilePlaceholder` keeps its `text` / `pdf` / `doc` cases; only the `image` case moves to the viewer.

## Data flow

```
scanVault (main)  →  snapshot.files: [{path, mtime}]   (already; no bytes)
        │
        ▼
FileTree click → openPreview → tab {kind:'note', path}
        │
        ├─ fileKind==='image' → ImageViewer → <img holi-vault://vault/{path}>
        └─ markdown note in EditorPane
                 └─ livePreview: ![]()/[[img]] → resolve → ImageWidget → <img holi-vault://vault/{resolved}>
                                                                              │
        holi-vault:// handler (main): safe(path) → absPathFor(activeRoot) → stream bytes
```

Images never enter the snapshot as bytes; they are fetched on demand by URL and cached by the browser.

## SVG

Renders through the same `<img>` path (SVG is already in `fileKind`'s image set — `file-kind.ts`). No special case. Editing SVG source is out of scope.

## Security

The one new attack surface is the protocol handler reading arbitrary paths. It is contained by reusing `safe()`/`vaultRelPath()`: the requested path is normalized and confined to the active vault root, rejecting traversal and absolute escapes — the same guarantee `notes.read` provides today. `contextIsolation`/`nodeIntegration` are unchanged. The scheme serves read-only bytes and nothing else.

## Testing

- **Pure, test-first:** the path resolver (`@holi/shared`) — note-relative join, `./`/`../` normalization, `..`-escape rejection, `http` passthrough, `[[]]` identity.
- **tmpdir integration:** the protocol handler's path-safety — a request for `../../etc/passwd` (or any path outside the root) is rejected; an in-vault image streams its bytes. Mirrors the existing `notes.read` main tests.
- **UI (CDP/manual, per repo norm):** the `ImageWidget` renders inline and reveals raw on the active line; `ImageViewer` fits an image to the window.

## Scope / non-goals (v1)

- **Viewing/rendering only.** No paste/drag-to-insert authoring — assets arrive via the agent or the filesystem (D62: committed files).
- **No zoom/pan** in the viewer; **no custom broken-image UI** (native alt).
- **No relative resolution beyond note-relative** for `![]()`; no vault-wide image search.
- **In-place PDF/doc rendering stays deferred** (D62) — `FilePlaceholder` keeps those.

## Integration points (file:line)

- Route to viewer: `apps/desktop/src/renderer/src/components/Shell.tsx:200-204`.
- Placeholder image case it supersedes: `apps/desktop/src/renderer/src/components/FilePlaceholder.tsx:15-16`.
- Inline `![]()`: new `case 'Image':` in `apps/desktop/src/renderer/src/editor/livePreview.ts` (~:153).
- Inline `[[img.png]]`: branch in the wiki-link loop, `livePreview.ts:181-196`.
- Widget template: `apps/desktop/src/renderer/src/editor/wikiLinkChips.ts:18-50`.
- Bytes/protocol: register in `apps/desktop/src/main/index.ts` (~:47, `createWindow`); reuse `safe()`/`vaultRelPath()`/`absPathFor` from `apps/desktop/src/main/router.ts:292-298`; root via the `ActiveVault` host.
- CSP: none exists today (`renderer/index.html` has no `<meta>` CSP; main sets none) — no change needed now.
- Kinds: `fileKind()` in `packages/shared/src/file-kind.ts:15-24`; resolver added alongside `wiki-links.ts` in `packages/shared/src`.
