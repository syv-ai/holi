# Inline images + standalone image viewer — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render images in Holi — inline in the markdown live-preview editor (`![](path)` and `[[img.png]]`) and full-frame when an image file is opened from the tree — replacing the "preview coming soon" placeholder.

**Architecture:** One keystone, two thin consumers. The keystone is a privileged `holi-vault://` protocol registered in main: `<img src="holi-vault://vault/<vaultRelPath>">` streams bytes off the **active** vault, validated by the same `vaultRelPath()` guard the router uses. The standalone viewer is a full-frame `<img>`; the inline case is a CodeMirror `ImageWidget` wrapping the same `<img>`. A pure resolver in `@holi/shared` turns `![](target)` (note-relative) and `[[img.png]]` (vault-relative) into vault paths. See `docs/specs/2026-07-26-inline-images-design.md`.

**Tech Stack:** Electron (`protocol.handle`), React 18, TypeScript, Tailwind v4, CodeMirror 6 (`@codemirror/view` widgets/facets, lezer-markdown), `@holi/shared`, Vitest 4 (node env), CDP for live UI.

**Decision:** D62 (`docs/decisions.md`) — the vault is text-first by authorship; binaries are assets it holds and emits. This is the first of D62's two near-term slices (the other is the `md-to-pdf` Typst vault skill, specced separately).

**User decisions (locked this session):**
- `![](path)` resolves **note-relative** (standard markdown / GitHub-compatible); `[[img.png]]` resolves **vault-relative** (Holi's existing `[[]]` semantics).
- Delivery via a `holi-vault://` **protocol**, not base64 (a CodeMirror widget is not a React component; synchronous `img.src` is simplest).
- Viewer is **minimal** — fit-to-window, no zoom/pan. **No** image-authoring (paste/drag-insert) in v1. SVG renders as an image.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. Desktop tests from `apps/desktop/`; shared from `packages/shared/`.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` — baseline **36**, must not rise. (Do NOT use bare `pnpm exec tsc`; grep `"error TS"`, not `error`.)
- **Test baselines:** desktop **584** (`cd apps/desktop && pnpm exec vitest run`), shared **160** (`cd packages/shared && pnpm exec vitest run`). Must not drop.
- **Live app:** dev instance on CDP 9333, driver `/tmp/holi-drive.mjs`. **Renderer edits hot-reload; main edits (protocol registration, Task 2) need a relaunch** — ask the user to relaunch. HTML5 drag can't be driven via CDP.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.
- **Absolute paths in Bash** — the tool's cwd drifts between calls.

## File Structure

- **Create** `packages/shared/src/image-ref.ts` — pure `resolveImageRef(notePath, target): ImageRef`.
- **Create** `packages/shared/test/image-ref.test.ts` — resolver tests.
- **Modify** `packages/shared/src/index.ts` — export `resolveImageRef` / `ImageRef`.
- **Create** `apps/desktop/src/main/vault/asset-protocol.ts` — pure `assetAbsPath(root, requestUrl): string | null` + `mimeFor(path): string`.
- **Create** `apps/desktop/test/asset-protocol.test.ts` — path-safety tests.
- **Modify** `apps/desktop/src/main/index.ts` — register the `holi-vault` scheme (top level) + `protocol.handle` (in `main()`).
- **Create** `apps/desktop/src/renderer/src/lib/vault-asset.ts` — `vaultAssetUrl(path): string`.
- **Create** `apps/desktop/src/renderer/src/components/ImageViewer.tsx` — full-frame image pane.
- **Modify** `apps/desktop/src/renderer/src/components/Shell.tsx:200` — route `fileKind === 'image'` → `ImageViewer` before `FilePlaceholder`.
- **Create** `apps/desktop/src/renderer/src/editor/imageWidget.ts` — `ImageWidget` (CodeMirror `WidgetType`).
- **Modify** `apps/desktop/src/renderer/src/editor/livePreview.ts` — `notePathFacet`; `case 'Image':`; wiki-link image branch.
- **Modify** `apps/desktop/src/renderer/src/editor/extensions.ts` — `notePath` on `EditorDeps`, provide `notePathFacet`.
- **Modify** `apps/desktop/src/renderer/src/components/EditorPane.tsx:142` — pass `notePath: path`.

---

## Task 1: `assetAbsPath` + `mimeFor` — the protocol's pure core (main)

The security-critical URL→path mapping, isolated from Electron so it is unit-testable. Reuses `vaultRelPath` (`@holi/shared`) + `absPathFor` (`vault-files.ts`).

**Files:**
- Create: `apps/desktop/src/main/vault/asset-protocol.ts`
- Test: `apps/desktop/test/asset-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/asset-protocol.test.ts`:

```ts
import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetAbsPath, mimeFor } from '../src/main/vault/asset-protocol'

const ROOT = '/vault/root'

describe('assetAbsPath', () => {
  it('maps a vault-relative image path to an absolute path under the root', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/projects/logo.png')).toBe(
      `${ROOT}${sep}projects${sep}logo.png`,
    )
  })

  it('rejects percent-encoded traversal (vaultRelPath throws on "..")', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/%2e%2e/%2e%2e/etc/passwd')).toBeNull()
  })

  it('rejects an empty path', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/')).toBeNull()
  })

  it('never returns a path outside the root (raw ".." is URL-normalized, then re-validated)', () => {
    // The URL parser clamps raw "../" to the host root, so this resolves to an
    // in-root path; the guarantee we assert is the invariant, not a specific file.
    const out = assetAbsPath(ROOT, 'holi-vault://vault/../../../etc/passwd')
    expect(out === null || out.startsWith(`${ROOT}${sep}`)).toBe(true)
  })

  it('decodes percent-encoded spaces in a legitimate name', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/my%20image.png')).toBe(`${ROOT}${sep}my image.png`)
  })
})

describe('mimeFor', () => {
  it('maps known image extensions', () => {
    expect(mimeFor('a.png')).toBe('image/png')
    expect(mimeFor('a.JPG')).toBe('image/jpeg')
    expect(mimeFor('a.svg')).toBe('image/svg+xml')
  })
  it('falls back to octet-stream', () => {
    expect(mimeFor('a.unknown')).toBe('application/octet-stream')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/asset-protocol.test.ts`
Expected: FAIL — cannot resolve `../src/main/vault/asset-protocol`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/vault/asset-protocol.ts`:

```ts
import { vaultRelPath } from '@holi/shared'
import { absPathFor } from './vault-files'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** Content-type from a path's extension; octet-stream when unknown. */
export function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

/**
 * Absolute file path for a `holi-vault://vault/<vaultRelPath>` request, or null
 * when the path is malformed or escapes the vault. Two guards compose: the URL
 * parser normalizes raw `../` (clamped to the host root), and `vaultRelPath`
 * rejects any residual `..` / absolute / empty path — the same boundary
 * `notes.read` enforces. `root` is the ACTIVE vault's root.
 */
export function assetAbsPath(root: string, requestUrl: string): string | null {
  let rel: string
  try {
    rel = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
  try {
    return absPathFor(root, vaultRelPath(rel))
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/asset-protocol.test.ts`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/vault/asset-protocol.ts apps/desktop/test/asset-protocol.test.ts
git commit -m "feat(assets): pure holi-vault:// url→path mapping + mime, guarded by vaultRelPath

Claude goes brr.. via Dash"
```

---

## Task 2: register the `holi-vault://` protocol (main)

Wire Task 1 into Electron. Scheme privileges MUST be registered before `app.whenReady` (top-level); the handler is installed inside `main()` where the vault `host` exists.

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Register the scheme at module top level**

In `index.ts`, add `protocol` to the electron import (line 16) and register the scheme's privileges *before* the single-instance block (both must run before `whenReady`):

```ts
import { app, BrowserWindow, ipcMain, protocol } from 'electron'
```

Immediately above the `if (!app.requestSingleInstanceLock())` block (~line 41):

```ts
// Privileged custom scheme for vault binary assets (images). `standard` so URLs
// parse with a host + path; `secure`/`supportFetchAPI`/`stream` so <img> and
// fetch treat it like https and can stream large files. Must be declared before
// app-ready, so it lives at module top level, not in main().
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'holi-vault',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])
```

- [ ] **Step 2: Install the handler in `main()`**

Add the import at the top:

```ts
import { readFile } from 'node:fs/promises'
import { assetAbsPath, mimeFor } from './vault/asset-protocol'
```

In `main()`, after `const host = createVaultHost({...})` (~line 94) and before `createRouter`, install the handler:

```ts
// Serve `holi-vault://vault/<vaultRelPath>` from the active vault, read-only.
// Resolving against the active vault (not a remote in the URL) is safe: there is
// exactly one ActiveVault and a vault switch resets the workspace, so the open
// note is always in the active vault.
protocol.handle('holi-vault', async (request) => {
  const vault = host.active()
  if (vault === null) return new Response(null, { status: 404 })
  const abs = assetAbsPath(vault.root, request.url)
  if (abs === null) return new Response(null, { status: 403 })
  try {
    const bytes = await readFile(abs)
    return new Response(bytes, { headers: { 'content-type': mimeFor(abs) } })
  } catch {
    return new Response(null, { status: 404 })
  }
})
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36` (unchanged). `Response` and `URL` are Node/Electron globals — no import needed.

- [ ] **Step 4: Build check (main path must resolve — see the index.ts header warning)**

Run: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -5`
Expected: builds without an unresolved-import error.

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/index.ts
git commit -m "feat(assets): register holi-vault:// protocol serving active-vault bytes

Claude goes brr.. via Dash"
```

---

## Task 3: `vaultAssetUrl` + `ImageViewer` + route (renderer) — tracer bullet

The simplest consumer, proving the keystone end-to-end: open an image file → it renders.

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/vault-asset.ts`
- Create: `apps/desktop/src/renderer/src/components/ImageViewer.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx:200-204`

- [ ] **Step 1: The URL helper**

Create `apps/desktop/src/renderer/src/lib/vault-asset.ts`:

```ts
/**
 * A vault-relative path → a `holi-vault://` URL for `<img src>`. Each segment is
 * percent-encoded (spaces, `#`, …) but the `/` separators are preserved. The
 * host is a fixed `vault`; the main-process handler resolves it against the
 * active vault (see main/vault/asset-protocol.ts).
 */
export function vaultAssetUrl(vaultRelPath: string): string {
  const encoded = vaultRelPath.split('/').map(encodeURIComponent).join('/')
  return `holi-vault://vault/${encoded}`
}
```

- [ ] **Step 2: The viewer**

Create `apps/desktop/src/renderer/src/components/ImageViewer.tsx`:

```tsx
import { vaultAssetUrl } from '../lib/vault-asset'

/**
 * Full-frame view for an image file opened from the tree. Fit-to-window
 * (`object-contain`), no zoom/pan (spec §Scope). Replaces FilePlaceholder's
 * `image` case; text/pdf/doc still go to the placeholder.
 */
export function ImageViewer({ path }: { path: string }): JSX.Element {
  const name = path.split('/').at(-1) ?? path
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-950 p-6">
      <img
        src={vaultAssetUrl(path)}
        alt={name}
        className="max-h-[calc(100%-2rem)] max-w-full object-contain"
      />
      <span className="text-sm text-neutral-500">{name}</span>
    </div>
  )
}
```

- [ ] **Step 3: Route it in the Shell**

In `Shell.tsx`, import the viewer (near the other component imports, ~line 22):

```tsx
import { ImageViewer } from './ImageViewer'
```

Replace the placeholder branch at lines 200-204 so image routes to the viewer *first*:

```tsx
          ) : tab?.kind === 'note' && fileKind(tab.path) === 'image' ? (
            <ImageViewer path={tab.path} />
          ) : tab?.kind === 'note' && fileKind(tab.path) !== 'markdown' ? (
            // Non-image, non-markdown files open a typed placeholder for now — a
            // real per-type viewer replaces it later (spec §Arbitrary files).
            <FilePlaceholder path={tab.path} kind={fileKind(tab.path) as 'text' | 'pdf' | 'doc'} />
          ) : (
```

Note the `FilePlaceholder` kind cast drops `'image'` — the image case can no longer reach it.

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`. (If `FilePlaceholder`'s prop type requires `'image'` in its union, that's fine — narrowing the cast to a subset still satisfies it.)

- [ ] **Step 5: Verify live (renderer hot-reloads; main from Task 2 needs a relaunch)**

Ask the user to relaunch the dev app (Task 2 is a main edit). Then open an image file from the tree (or, in the renderer console via the driver, open a known image path). Expected: the image renders fit-to-window with its filename caption, not the "preview coming soon" placeholder. If it's blank, check the console for a `holi-vault://` load error and confirm the app was relaunched.

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/lib/vault-asset.ts apps/desktop/src/renderer/src/components/ImageViewer.tsx apps/desktop/src/renderer/src/components/Shell.tsx
git commit -m "feat(assets): standalone image viewer over holi-vault://

Claude goes brr.. via Dash"
```

---

## Task 4: `resolveImageRef` — note-relative / vault / external (shared)

The pure resolver for inline `![](target)`. Note-relative unless the target is absolute (`/…`, vault-root) or `http(s)`.

**Files:**
- Create: `packages/shared/src/image-ref.ts`
- Test: `packages/shared/test/image-ref.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/image-ref.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resolveImageRef } from '../src/image-ref'

describe('resolveImageRef (markdown ![](target))', () => {
  it('passes http(s) targets through as external', () => {
    expect(resolveImageRef('a/note.md', 'https://x.com/i.png')).toEqual({
      kind: 'external',
      url: 'https://x.com/i.png',
    })
  })

  it('resolves a bare name relative to the note folder', () => {
    expect(resolveImageRef('projects/proposal.md', 'logo.png')).toEqual({
      kind: 'vault',
      path: 'projects/logo.png',
    })
  })

  it('resolves a name in the vault root', () => {
    expect(resolveImageRef('note.md', 'logo.png')).toEqual({ kind: 'vault', path: 'logo.png' })
  })

  it('resolves ./ and ../ against the note folder', () => {
    expect(resolveImageRef('a/note.md', './img.png')).toEqual({ kind: 'vault', path: 'a/img.png' })
    expect(resolveImageRef('a/b/note.md', '../img.png')).toEqual({ kind: 'vault', path: 'a/img.png' })
  })

  it('treats a leading slash as vault-root-absolute (GitHub semantics)', () => {
    expect(resolveImageRef('a/b/note.md', '/assets/logo.png')).toEqual({
      kind: 'vault',
      path: 'assets/logo.png',
    })
  })

  it('resolves a nested relative target', () => {
    expect(resolveImageRef('a/note.md', 'sub/img.png')).toEqual({ kind: 'vault', path: 'a/sub/img.png' })
  })

  it('clamps ".." that would escape the vault root', () => {
    expect(resolveImageRef('note.md', '../../x.png')).toEqual({ kind: 'vault', path: 'x.png' })
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/shared && pnpm exec vitest run test/image-ref.test.ts`
Expected: FAIL — cannot resolve `../src/image-ref`.

- [ ] **Step 3: Implement**

Create `packages/shared/src/image-ref.ts`:

```ts
/** Where a markdown `![](target)` points. */
export type ImageRef = { kind: 'external'; url: string } | { kind: 'vault'; path: string }

/**
 * Resolve a markdown image target against the note that contains it.
 * - `http(s)://…`         → external, used as the `<img src>` verbatim.
 * - `/foo/bar.png`        → vault-root-absolute (leading slash), GitHub semantics.
 * - `foo.png` / `../x.png`→ note-relative, normalized (`.`/`..` collapsed).
 * `..` that would climb above the root is clamped (the main-process handler
 * re-validates with `vaultRelPath`, which rejects any residual `..`).
 * Pure; no filesystem access. Wiki embeds `[[img.png]]` are vault-relative and
 * do NOT go through here — they are used as-is.
 */
export function resolveImageRef(notePath: string, target: string): ImageRef {
  const t = target.trim()
  if (/^https?:\/\//i.test(t)) return { kind: 'external', url: t }

  const base = t.startsWith('/')
    ? [] // vault-root-absolute: ignore the note's folder
    : notePath.split('/').slice(0, -1) // the note's folder
  const stack = [...base]
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return { kind: 'vault', path: stack.join('/') }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd packages/shared && pnpm exec vitest run test/image-ref.test.ts`
Expected: PASS.

- [ ] **Step 5: Export it**

In `packages/shared/src/index.ts`, add the re-export alongside the other exports (match the file's existing style, e.g.):

```ts
export { resolveImageRef, type ImageRef } from './image-ref'
```

- [ ] **Step 6: Full shared suite + commit**

Run: `cd packages/shared && pnpm exec vitest run` → Expected: 167 passed (160 baseline + 7).

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add packages/shared/src/image-ref.ts packages/shared/test/image-ref.test.ts packages/shared/src/index.ts
git commit -m "feat(assets): resolveImageRef — note-relative/vault-root/external image targets

Claude goes brr.. via Dash"
```

---

## Task 5: thread `notePath` into the editor (renderer)

`buildDecorations` needs the open note's path to resolve note-relative image targets. Add a facet, provide it from `EditorPane` (the view is rebuilt per doc — EditorPane.tsx:131 — so a static value is correct).

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/livePreview.ts`
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts`
- Modify: `apps/desktop/src/renderer/src/components/EditorPane.tsx:142`

- [ ] **Step 1: Define the facet**

In `livePreview.ts`, beside `docExistsFacet` (~line 22), add:

```ts
/** The open note's vault path, so live-preview can resolve note-relative image
 *  targets (`![](img.png)`). Static per editor instance — the view is rebuilt
 *  per doc (EditorPane), so there is nothing to keep live here. */
export const notePathFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
})
```

- [ ] **Step 2: Provide it**

In `extensions.ts`, add to `EditorDeps` (after `nav`, ~line 28):

```ts
  /** The open note's vault path, for note-relative image resolution. */
  notePath: string
```

Import `notePathFacet` (extend the existing `./livePreview` import on line 12) and provide it in `baseEditorExtensions`, next to `docExistsFacet.of(...)` (~line 55):

```ts
    notePathFacet.of(deps.notePath),
```

- [ ] **Step 3: Pass the path from EditorPane**

In `EditorPane.tsx`, in the `baseEditorExtensions({...})` deps object (~line 142-148), add:

```tsx
                  notePath: path,
```

(`path` is the non-null note path in scope; this branch only runs for a markdown note.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/editor/livePreview.ts apps/desktop/src/renderer/src/editor/extensions.ts apps/desktop/src/renderer/src/components/EditorPane.tsx
git commit -m "feat(editor): notePathFacet — expose the open note's path to live-preview

Claude goes brr.. via Dash"
```

---

## Task 6: inline image rendering (renderer)

The `ImageWidget` and the two live-preview call sites — markdown `![]()` (note-relative) and wiki `[[img.png]]` (vault-relative).

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/imageWidget.ts`
- Modify: `apps/desktop/src/renderer/src/editor/livePreview.ts`

- [ ] **Step 1: The widget**

Create `apps/desktop/src/renderer/src/editor/imageWidget.ts` (modeled on `wikiLinkChips.ts`; inline styles avoid a CSS-file hunt):

```ts
import { WidgetType } from '@codemirror/view'

/**
 * Inline `<img>` for `![alt](path)` and `[[img.png]]` in live-preview. `src` is
 * already resolved (a `holi-vault://` URL or an external http(s) URL); the widget
 * renders what it is handed and looks nothing up, so `eq` is an honest identity
 * check. A broken/missing file falls back to the browser's native alt text.
 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }

  override toDOM(): HTMLElement {
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.className = 'cm-image'
    img.style.maxWidth = '100%'
    img.style.maxHeight = '320px'
    img.style.display = 'block'
    img.style.borderRadius = '4px'
    return img
  }

  override ignoreEvent(): boolean {
    return false
  }
}
```

- [ ] **Step 2: Wire the markdown `![]()` case**

In `livePreview.ts`, extend the imports:

```ts
import { fileKind, parseWikiLinks, resolveImageRef } from '@holi/shared'
import { ImageWidget } from './imageWidget'
import { vaultAssetUrl } from '../lib/vault-asset'
```

(Adjust to the file's existing `@holi/shared` import line — `parseWikiLinks` is already imported there; add `fileKind` and `resolveImageRef` to it.)

Read the note path once inside `buildDecorations`, next to the other facet reads (~line 178):

```ts
  const notePath = state.facet(notePathFacet)
```

Add a `case 'Image':` to the node switch, immediately after the `Link` case (~line 172). A CodeMirror `Image` node spans the whole `![alt](url)`:

```ts
        case 'Image': {
          // ![alt](target). Rendered as the image unless the cursor is on this
          // line (then the raw markdown shows, like every other widget).
          if (activeHere) break
          const text = state.sliceDoc(node.from, node.to)
          const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(text)
          if (m === null) break
          const [, alt, target] = m
          const ref = resolveImageRef(notePath, target)
          const src = ref.kind === 'external' ? ref.url : vaultAssetUrl(ref.path)
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new ImageWidget(src, alt) }),
          })
          break
        }
```

(Confirm `activeHere` is the in-scope active-line flag used by the sibling `HorizontalRule`/`Link` cases; if the local is named differently, use that name.)

- [ ] **Step 3: Wire the wiki `[[img.png]]` case**

In the wiki-link loop (~line 181-196), before building the note chip, branch on image targets. Replace the `else` (note) branch so an image target becomes an `ImageWidget`:

```ts
    } else if (fileKind(link.target) === 'image') {
      // [[img.png]] embeds are vault-relative (used as-is); render inline.
      ranges.push({
        from: start,
        to: end,
        deco: Decoration.replace({ widget: new ImageWidget(vaultAssetUrl(link.target), link.label ?? link.target) }),
      })
      continue
    } else {
      chip = new WikiLinkChip('note', link.target, link.label ?? link.target, docExists(link.target))
    }
```

(The loop already `continue`s past active lines at the top — `if (isActive(start)) continue` — so an image on the active line stays raw.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`.

- [ ] **Step 5: Full desktop suite**

Run: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6`
Expected: 584 passed (no live-preview unit tests exist; this confirms no regression).

- [ ] **Step 6: Verify live (renderer hot-reloads)**

In a markdown note in the vault, add `![logo](logo.png)` (with a real `logo.png` beside it) and a `[[logo.png]]`. Expected: both render inline as the image; moving the cursor onto that line reveals the raw markdown/wiki text; moving away re-renders. An external `![](https://…)` also renders. Ask the user to confirm (UI is manual/CDP-verified).

- [ ] **Step 7: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/editor/imageWidget.ts apps/desktop/src/renderer/src/editor/livePreview.ts
git commit -m "feat(editor): inline image rendering for ![]() and [[img]] in live-preview

Claude goes brr.. via Dash"
```

---

## Final verification

- [ ] Typecheck **36**: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
- [ ] Desktop **584**: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Shared **167**: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Build: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3`
- [ ] Live (after relaunch): open an image file → viewer; `![]()` and `[[img.png]]` render inline and reveal-on-active-line; external URL renders.

---

## Self-review (spec coverage)

- **Protocol keystone** (spec §keystone) → Tasks 1–2. Path-only URL, active-vault resolution, `vaultRelPath` reuse: assertions in `asset-protocol.test.ts`.
- **Path resolution** (spec §Path resolution) → Task 4 `resolveImageRef` (`![]()` note-relative + `/`-absolute + external); `[[]]` vault-relative handled inline in Task 6 Step 3.
- **Inline rendering** (spec §Consumer 1) → Tasks 5–6: `notePathFacet`, `case 'Image'`, wiki branch, active-line reveal inherited from the existing widget machinery.
- **Standalone viewer** (spec §Consumer 2) → Task 3: routed at Shell.tsx:200 before `FilePlaceholder`, no new tab kind.
- **SVG as image** (spec §SVG) → free: `fileKind` already classifies svg as `image`; both consumers key off that.
- **Security** (spec §Security) → Task 1 tests (traversal rejection, in-root invariant); handler is read-only.
- **Scope/non-goals** (spec §Scope) → no authoring, no zoom (Task 3 viewer is fit-only), no custom broken-image UI (native alt in Task 6 widget), no CSP change (none exists).
- **CSP** (spec note) → none exists today; nothing to change. If added later, `img-src` must include `holi-vault:`.
