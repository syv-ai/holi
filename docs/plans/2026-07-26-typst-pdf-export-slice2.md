# Typst PDF export — Slice 2 (Convert dialog UX) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Convert-to-PDF from a bare template picker into the real dialog: the chosen template's declared **metadata fields** become inputs, the render writes through a **native save dialog** (not straight to Downloads), and errors surface in the dialog. The seeded **Plain** template gains two optional fields (Date, Recipient) so the metadata UX is demonstrable in-app now, before the Syv template lands in slice 3.

**Architecture:** The render pipeline already threads a `meta: Record<string,string>` end to end (`composeWrapper` → `renderPdf`) — slice 1 just passed `{}`. Slice 2 fills it: `pdf.templates` stops stripping each template's `fields`; the dialog renders those fields as inputs and collects values; `pdf.render` gains a `meta` map (validated by a dedicated `renderPdfInput`/`metaOf` helper, since the string-only `fields()` validator can't carry a nested object — same split `movesInput`/`pathsInput` already use) and an optional `outPath` (the absolute destination the native save dialog chose; absent → the existing Downloads default, the agent path). A new `holi:showSaveDialog` IPC (Electron `dialog`, defaulting to Downloads) is the only new main surface. After a successful convert the PDF is **revealed in Finder** via the existing `window.holi.openPath` — open-in-Preview is deliberately not done (the save dialog already told the user where it went). Plain's `template.typ` gets a small right-aligned metadata header that renders only the fields the user filled.

**Tech Stack:** Electron (main-process `dialog`/`BrowserWindow`/`app`, `shell`), tRPC (existing router + `createCaller` test rig), React 18, Tailwind v4, Typst 0.14.1 + `@preview/cmarker` 0.1.6, Vitest 4 (node env), `@holi/shared`. Live UI is CDP/manual per repo norm.

**Decision:** D62 (`docs/decisions.md`) — the vault is text-first by authorship; PDFs are **outputs**. Spec: `docs/specs/2026-07-26-typst-pdf-export-design.md` (§Slice decomposition, slice 2; §Front door 1). Slice 1 plan: `docs/plans/2026-07-26-typst-pdf-export-slice1.md`.

**User decisions (locked this session):**
- **Plain gains `date` + `recipient` optional fields** (matches the spec's own example manifest in §Template model) and `template.typ` renders them, so slice 2 is live-verifiable without waiting for the Syv template. This changes seeded vault content, which auto-pushes.
- **Reveal only after convert** — keep slice 1's `showItemInFolder` (`window.holi.openPath`). No open-in-Preview, so **no** `shell.openPath` / `openFile` IPC is added this slice.
- **Native save dialog stays** — it chooses *where* the PDF is written (default: the note's name under Downloads); the flow is fields → save dialog → render to the chosen path → reveal.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` are broken — always `pnpm exec`. Desktop tests run from `apps/desktop/`; shared from `packages/shared/`.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` — baseline **36**, must not rise. (Do NOT use bare `pnpm exec tsc`; grep `"error TS"`, not `error`.)
- **Test baselines:** desktop **613** (`cd apps/desktop && pnpm exec vitest run`; node env, ~90s — it exceeds the 120s Bash timeout and finishes in the background, that's fine), shared **171** (`cd packages/shared && pnpm exec vitest run`, untouched this slice). Must not drop.
- **typst in dev:** `typst 0.14.1` is on `PATH` (`/opt/homebrew/bin/typst`). The render/router integration tests spawn it; on a machine without typst those tests **skip** (early `return`) rather than fail. First compile fetches `@preview/cmarker` from the network and caches it under `~/Library/Caches/typst/` — one-time, already primed on this machine.
- **Live app:** dev instance on CDP 9333, driver `/tmp/holi-drive.mjs`. **Renderer edits hot-reload; main edits (router, seed, ipc, preload, new main modules) need a relaunch** — ask the user to relaunch. The dev app may be DOWN; ask before launching.
- **Vault writes auto-push** to the real GitHub vault — the updated Plain `template.json`/`template.typ` are committed vault content; that push is intended (templates are shared via git). Two pre-existing vaults were **manually seeded** with the slice-1 Plain template last session (`~/Holi/nthomsencph/a-demo-vault-3`, `~/Holi/nthomsencph/another-vault-42`); `SEED_FILES` is **never-overwrite** (written only when absent), so those vaults will NOT pick up the new fields automatically — see Task 5 Step 6 for how to live-verify (re-seed the two files by hand, or test in a fresh vault).
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.
- **Absolute paths in Bash** — the tool's cwd drifts between calls.

## File Structure

- **Modify** `apps/desktop/src/main/agent/templates/plain/template.typ` — add an optional metadata header (Date/Recipient) rendered only when filled. (Verified to compile with + without meta.)
- **Modify** `apps/desktop/src/main/agent/seed-content.ts:133-142` — `PLAIN_MANIFEST` gains the two `fields`.
- **Modify** `apps/desktop/test/pdf-render.test.ts` — add a test proving the populated-meta render is larger than the empty-meta render (i.e. the header actually renders).
- **Modify** `apps/desktop/src/main/router.ts` — `pdf.templates` returns `fields`; `pdf.render` gains `meta` + optional `outPath` via a new `renderPdfInput`/`metaOf`; import `type TemplateField`.
- **Modify** `apps/desktop/test/router.test.ts` — first router-level `pdf` coverage: `templates` returns fields, `render` rejects non-string meta, `render` honors `outPath` + threads meta.
- **Modify** `apps/desktop/src/main/ipc.ts` — a `holi:showSaveDialog` handler (Electron `dialog`, default under Downloads).
- **Modify** `apps/desktop/src/preload/index.ts:46-56` — expose `showSaveDialog`.
- **Modify** `apps/desktop/src/renderer/src/global.d.ts:14-35` — type `showSaveDialog`.
- **Modify** `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx` — field inputs + required handling + the save-dialog flow + `meta`.

---

## Task 1: Plain gains Date + Recipient — manifest + template header

The payload that makes the whole slice demonstrable: Plain declares two optional fields and its `template.typ` prints them as a small right-aligned header, shown only for the fields the user actually filled (an empty `meta` renders nothing, so Plain stays clean). This exact `template.typ` was verified to compile a real note with populated meta (14722 bytes) and with empty meta (12654 bytes) — the size delta is the header.

**Files:**
- Modify: `apps/desktop/src/main/agent/templates/plain/template.typ`
- Modify: `apps/desktop/src/main/agent/seed-content.ts`
- Test: `apps/desktop/test/pdf-render.test.ts`

- [ ] **Step 1: Write the failing test**

The behavioral change is invisible in a `%PDF` header check, so assert it by size: a render **with** Date+Recipient must be larger than the same note rendered with an empty meta. Before the template change (meta ignored) the two are byte-identical (typst is deterministic), so this fails; after, the header adds content.

Add this test to `apps/desktop/test/pdf-render.test.ts`, inside the existing `describe('renderPdf …')` block, after the current test:

```ts
  it('renders declared metadata (Date/Recipient) as a header — larger than an empty-meta render', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return // no typst on this machine — skip, don't fail

    const root = await work()
    const templateDir = join(root, '.holi/templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)

    const notePath = join(root, 'report.md')
    await writeFile(notePath, '---\ntitle: T\n---\n\n## Heading\n\nBody text.\n')

    const emptyOut = join(root, 'empty.pdf')
    const metaOut = join(root, 'meta.pdf')
    await renderPdf({ typstBin: typst, templateDir, notePath, outPath: emptyOut, meta: {} })
    await renderPdf({
      typstBin: typst,
      templateDir,
      notePath,
      outPath: metaOut,
      meta: { date: '2026-07-26', recipient: 'ACME Corp' },
    })

    const empty = await readFile(emptyOut)
    const withMeta = await readFile(metaOut)
    expect(withMeta.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(withMeta.length).toBeGreaterThan(empty.length)
  }, 30_000)
```

(`resolveTypstBin`, `renderPdf`, `plainTemplateTyp`, `work`, `mkdir`, `writeFile`, `readFile`, `join` are all already imported/defined at the top of `pdf-render.test.ts` from slice 1 — no new imports.)

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-render.test.ts 2>&1 | tail -12`
Expected: FAIL on the new test — `withMeta.length` equals `empty.length` because the current `template.typ` ignores `meta`. (The original test still passes.)

- [ ] **Step 3: Add the metadata header to the template**

Replace `apps/desktop/src/main/agent/templates/plain/template.typ` entirely with:

```typst
// Plain — a clean, unbranded document layout. The copy-to-customize starter
// every vault carries. It reads the markdown note, strips a leading YAML
// frontmatter block, and renders the body with cmarker (Typst reads markdown
// through this package). No bundled fonts — it rides Typst's defaults so it
// stays small. `assets` is accepted for a uniform template contract but unused
// here (Plain ships no assets); `meta` carries the two declared fields.
#import "@preview/cmarker:0.1.6"

// Drop a leading `---\n … \n---\n` YAML block, if present. Pure string ops.
#let strip-frontmatter(s) = {
  if s.starts-with("---\n") {
    let rest = s.slice(4)
    if rest.contains(regex("\n---[ \t]*\n")) {
      let idx = rest.position(regex("\n---[ \t]*\n"))
      return rest.slice(idx).replace(regex("^\n---[ \t]*\n"), "")
    }
  }
  s
}

#let doc(notePath, meta: (:), assets: "") = {
  set page(paper: "a4", margin: 2.5cm)
  set text(size: 11pt)

  // Optional metadata header. Plain declares `date` + `recipient` in
  // template.json; show each only when the user filled it, so an empty meta
  // renders nothing and Plain stays clean. Keys mirror template.json's fields.
  let lines = ()
  if meta.at("date", default: "") != "" { lines.push([Date: #meta.at("date")]) }
  if meta.at("recipient", default: "") != "" { lines.push([Recipient: #meta.at("recipient")]) }
  if lines.len() > 0 {
    align(right, text(size: 9pt, fill: luma(40%), lines.join(linebreak())))
    v(1em)
  }

  cmarker.render(strip-frontmatter(read(notePath)))
}
```

- [ ] **Step 4: Add the two fields to the manifest**

In `apps/desktop/src/main/agent/seed-content.ts`, replace the `PLAIN_MANIFEST` block (lines ~133-142) with:

```ts
/** The Plain template's manifest — a clean, unbranded layout with two optional
 * metadata fields (Date, Recipient) that the Convert dialog renders as inputs
 * and template.typ prints as a small header. Committed vault content under
 * `.holi/templates/plain/`. Built via `JSON.stringify` (like VAULT_MARKER) so
 * there is no `.json?raw` import dependency. */
const PLAIN_MANIFEST =
  JSON.stringify(
    {
      name: 'Plain',
      description: 'A clean, unbranded document layout.',
      fields: [
        { key: 'date', label: 'Date', required: false },
        { key: 'recipient', label: 'Recipient', required: false },
      ],
    },
    null,
    2,
  ) + '\n'
```

(The pinned seed test at `test/seed-content.test.ts:53` asserts the `SEED_FILES` **key list** only — the file paths are unchanged, so it needs no edit. No test asserts the manifest's contents.)

- [ ] **Step 5: Run the render + seed suites, verify they pass**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-render.test.ts test/seed-content.test.ts 2>&1 | tail -10`
Expected: PASS — the meta render is now larger than the empty render, and the seed suite is unaffected.

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/templates/plain/template.typ apps/desktop/src/main/agent/seed-content.ts apps/desktop/test/pdf-render.test.ts
git commit -m "feat(pdf): Plain template gains Date + Recipient metadata fields

Claude goes brr.. via Dash"
```

---

## Task 2: `pdf.templates` returns each template's `fields`

Slice 1's procedure destructured `fields` away (it only needed name/slug/description for the picker). Slice 2's dialog needs the fields to build inputs, so stop stripping them. First router-level coverage of the `pdf` namespace.

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/router.test.ts`

- [ ] **Step 1: Write the failing test**

The `rig(files)` helper (`router.test.ts:52`) writes `files` into a fresh clone and returns a `caller`. Add a new `describe('pdf', …)` block at the end of `router.test.ts` (before the final closing lines):

```ts
describe('pdf', () => {
  const TEMPLATE_FILES = {
    '.holi/templates/plain/template.json': JSON.stringify({
      name: 'Plain',
      description: 'Clean.',
      fields: [
        { key: 'date', label: 'Date', required: false },
        { key: 'recipient', label: 'Recipient', required: true },
      ],
    }),
    '.holi/templates/plain/template.typ': '#let doc(p, meta: (:), assets: "") = []',
  }

  it('templates returns each template with its declared fields', async () => {
    const { caller } = await rig(TEMPLATE_FILES)
    expect(await caller.pdf.templates({ remote: REMOTE })).toEqual([
      {
        name: 'Plain',
        slug: 'plain',
        description: 'Clean.',
        fields: [
          { key: 'date', label: 'Date', required: false },
          { key: 'recipient', label: 'Recipient', required: true },
        ],
      },
    ])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/router.test.ts -t "declared fields" 2>&1 | tail -12`
Expected: FAIL — the returned objects have no `fields` key (the procedure strips it), so `toEqual` mismatches.

- [ ] **Step 3: Return `fields` from the procedure**

In `apps/desktop/src/main/router.ts`, change the pdf import (line ~46) to also import the field type:

```ts
import { listTemplates, type TemplateField } from './pdf/templates'
```

Replace the `templates` procedure (lines ~832-841) with:

```ts
    // The vault's templates, for the Convert picker + its metadata inputs.
    // `fields` drives slice 2's per-template inputs, so it is no longer stripped.
    templates: t.procedure
      .input(fields({ remote: 'string' }))
      .query(
        async ({
          input,
        }): Promise<
          { name: string; slug: string; description: string; fields: TemplateField[] }[]
        > => {
          const root = await rootFor(input.remote)
          return (await listTemplates(root)).map(({ name, slug, description, fields }) => ({
            name,
            slug,
            description,
            fields,
          }))
        },
      ),
```

- [ ] **Step 4: Run it + typecheck, verify green**

Run: `cd apps/desktop && pnpm exec vitest run test/router.test.ts -t "declared fields" 2>&1 | tail -6` → Expected: PASS.
Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → Expected: `36`. (`trpc.pdf.templates` now types `fields` on the renderer.)

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/router.ts apps/desktop/test/router.test.ts
git commit -m "feat(pdf): pdf.templates returns each template's declared fields

Claude goes brr.. via Dash"
```

---

## Task 3: `pdf.render` accepts `meta` + an optional `outPath`

The render pipeline already threads `meta`; wire the procedure's input to fill it, and let a caller pass an explicit `outPath` (the native save-dialog destination). `outPath` absent → the existing Downloads default (the agent path, unchanged). The string-only `fields()` validator can't express the `meta` object, so a dedicated `renderPdfInput`/`metaOf` validates it — the same split `movesInput`/`pathsInput` use.

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/router.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests inside the `describe('pdf', …)` block from Task 2 (they reuse `TEMPLATE_FILES`):

```ts
  it('render rejects a meta value that is not a string', async () => {
    const { caller } = await rig({ ...TEMPLATE_FILES, 'note.md': '# Hi\n' })
    await expect(
      caller.pdf.render({
        remote: REMOTE,
        path: 'note.md',
        template: 'plain',
        meta: { date: 5 } as never,
      }),
    ).rejects.toThrow(/meta/)
  })

  it('render writes to the given outPath and threads meta through (needs typst)', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return // no typst — skip, don't fail
    const { caller, base } = await rig({
      '.holi/templates/plain/template.json': JSON.stringify({ name: 'Plain', fields: [] }),
      '.holi/templates/plain/template.typ': plainTemplateTyp,
      'note.md': '---\ntitle: T\n---\n\n## Heading\n\nBody.\n',
    })
    const outPath = join(base, 'chosen.pdf')
    const { pdfPath } = await caller.pdf.render({
      remote: REMOTE,
      path: 'note.md',
      template: 'plain',
      outPath,
      meta: { date: '2026-07-26', recipient: 'ACME' },
    })
    expect(pdfPath).toBe(outPath)
    const bytes = await readFile(outPath)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
```

Add these imports near the top of `router.test.ts` (beside the existing test imports):

```ts
import { resolveTypstBin } from '../src/main/pdf/typst-bin'
import plainTemplateTyp from '../src/main/agent/templates/plain/template.typ?raw'
```

(`readFile` and `join` are already imported at `router.test.ts:2,4`.)

- [ ] **Step 2: Run them, verify they fail**

Run: `cd apps/desktop && pnpm exec vitest run test/router.test.ts -t "render" 2>&1 | tail -14`
Expected: FAIL — the current input is `fields({ remote, path, template })`, so `meta`/`outPath` are ignored: the non-string-meta call does not throw `/meta/`, and the `outPath` call renders to Downloads (so `pdfPath !== outPath`, or throws because the rig's Downloads dir does not exist).

- [ ] **Step 3: Add the input validator**

In `apps/desktop/src/main/router.ts`, after `pathsInput` (ends ~line 195), add:

```ts
/** The Convert-to-PDF render input. The three string fields ride the string-only
 * `fields` helper; `meta` (the template's declared fields → user values) and the
 * optional `outPath` (an absolute destination the native save dialog chose) do
 * not, so they are validated here — the same split `movesInput`/`pathsInput` use.
 * `outPath` absent → the procedure defaults to Downloads (the agent path). */
function renderPdfInput(raw: unknown): {
  remote: string
  path: string
  template: string
  outPath?: string
  meta: Record<string, string>
} {
  const base = fields({ remote: 'string', path: 'string', template: 'string', outPath: 'string?' })(
    raw,
  )
  return { ...base, meta: metaOf(raw) }
}

/** A flat string→string metadata map from the render input. Missing → `{}`. Any
 *  non-string value throws (tRPC → BAD_REQUEST) rather than reaching `typst`. */
function metaOf(raw: unknown): Record<string, string> {
  const m = (raw as Record<string, unknown>).meta
  if (m === undefined || m === null) return {}
  if (typeof m !== 'object') throw new Error('meta must be an object')
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`meta value for ${k} must be a string`)
    out[k] = v
  }
  return out
}
```

- [ ] **Step 4: Wire the procedure to `meta` + `outPath`**

Replace the `render` procedure (lines ~846-863) with:

```ts
    // Render `path` through `template` to a PDF and return its path. Writes to
    // `outPath` when given (the native save dialog's choice); otherwise defaults
    // to Downloads (the agent path). Not a vaultMutation — the output goes
    // outside the vault, so there is no snapshot to refresh.
    render: t.procedure
      .input(renderPdfInput)
      .mutation(async ({ input }): Promise<{ pdfPath: string }> => {
        const root = await rootFor(input.remote)
        const noteAbs = absPathFor(root, safe(input.path))
        const tpl = (await listTemplates(root)).find((t) => t.slug === input.template)
        if (tpl === undefined) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `template ${input.template}` })
        }
        const typstBin = await ensureTypst({ cacheDir: deps.typstCacheDir })
        if (typstBin === null) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'typst is not available' })
        }
        const base = input.path.split('/').at(-1)!.replace(/\.(md|markdown)$/i, '')
        const outPath = input.outPath ?? join(deps.downloadsDir, `${base}.pdf`)
        await renderPdf({ typstBin, templateDir: tpl.dir, notePath: noteAbs, outPath, meta: input.meta })
        return { pdfPath: outPath }
      }),
```

- [ ] **Step 5: Run the pdf tests + typecheck**

Run: `cd apps/desktop && pnpm exec vitest run test/router.test.ts -t "render" 2>&1 | tail -8` → Expected: PASS (both).
Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → Expected: `36`. (`trpc.pdf.render` now accepts `meta` + optional `outPath`.)

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/router.ts apps/desktop/test/router.test.ts
git commit -m "feat(pdf): pdf.render threads meta + honors an explicit outPath

Claude goes brr.. via Dash"
```

---

## Task 4: native save-dialog IPC

The renderer must let the user choose where the PDF lands. The native save sheet can only be shown from main, so add one IPC channel: `holi:showSaveDialog(defaultName)` → the chosen absolute path or `null` on cancel, defaulting to `defaultName` under Downloads. No unit test — native dialogs are CDP/manual per repo norm (like `openExternal`/`openPath`).

**Files:**
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/src/global.d.ts`

- [ ] **Step 1: The main handler**

In `apps/desktop/src/main/ipc.ts`, widen the electron import (line 15) and add a path import beneath it:

```ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
```

Add the handler inside `registerIpc`, after the `holi:openPath` handler (line ~38):

```ts
  // The native SAVE sheet for Convert-to-PDF (slice 2). Only main can present a
  // native dialog, so the renderer asks here, gets back an absolute path (or
  // null on cancel), and hands it to `pdf.render`. Defaults to the note's name
  // under Downloads; tied to the calling window so it is a sheet, not a floating
  // dialog.
  ipcMain.handle(
    'holi:showSaveDialog',
    async (event, defaultName: string): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        defaultPath: join(app.getPath('downloads'), defaultName),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }
      const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      return result.canceled || result.filePath === undefined ? null : result.filePath
    },
  )
```

- [ ] **Step 2: Expose it on the preload bridge**

In `apps/desktop/src/preload/index.ts`, add to the `holi` object (after `openPath`, line ~55):

```ts
  showSaveDialog: (defaultName: string) => ipcRenderer.invoke('holi:showSaveDialog', defaultName),
```

- [ ] **Step 3: Type it**

In `apps/desktop/src/renderer/src/global.d.ts`, add after the `openPath` declaration (line ~34):

```ts
      /** Native "save as" for the Convert-to-PDF output. Presents a save sheet
       *  defaulting to `defaultName` under Downloads; resolves to the chosen
       *  absolute path, or null if the user cancelled. */
      showSaveDialog(defaultName: string): Promise<string | null>
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`. (`window.holi.showSaveDialog` is now typed for Task 5.)

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/global.d.ts
git commit -m "feat(pdf): holi:showSaveDialog IPC — native save sheet defaulting to Downloads

Claude goes brr.. via Dash"
```

---

## Task 5: the Convert dialog — field inputs + save-dialog flow

The front door's real form: render the selected template's `fields` as inputs, enforce required ones, then Convert = save dialog → `pdf.render({ outPath, meta })` → reveal. Reuses the house modal pattern already in the file; only the body between the picker and the buttons grows.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx`

- [ ] **Step 1: Rewrite the dialog**

Replace `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx` entirely with:

```tsx
import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'

interface TemplateField {
  key: string
  label: string
  required: boolean
}

interface TemplateOption {
  name: string
  slug: string
  description: string
  fields: TemplateField[]
}

/**
 * Convert-to-PDF, slice 2: pick a template, fill its declared metadata fields,
 * choose a destination via the native save dialog, Convert. The render writes to
 * the chosen path and is revealed in Finder (open-in-Preview is deliberately not
 * done — the save dialog already told the user where it went). Fixed-overlay +
 * stop-propagation card, the house modal pattern (see DeleteConfirm); driven by
 * the caller's useState.
 */
export function ConvertToPdfDialog({
  remote,
  path,
  onClose,
}: {
  remote: string
  path: string
  onClose: () => void
}) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null)
  const [slug, setSlug] = useState<string>('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = path.split('/').at(-1) ?? path
  const selected = templates?.find((t) => t.slug === slug) ?? null

  useEffect(() => {
    let live = true
    void trpc.pdf.templates
      .query({ remote })
      .then((list) => {
        if (!live) return
        setTemplates(list)
        setSlug(list[0]?.slug ?? '')
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [remote])

  // Clear field values when the chosen template changes, so one template's
  // inputs never leak into another's meta.
  useEffect(() => {
    setValues({})
  }, [slug])

  const convert = async () => {
    if (selected === null) return
    const missing = selected.fields.filter((f) => f.required && (values[f.key] ?? '').trim() === '')
    if (missing.length > 0) {
      setError(
        `Fill required field${missing.length > 1 ? 's' : ''}: ${missing
          .map((f) => f.label)
          .join(', ')}`,
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const defaultName = name.replace(/\.(md|markdown)$/i, '') + '.pdf'
      const outPath = await window.holi.showSaveDialog(defaultName)
      if (outPath === null) {
        setBusy(false)
        return // user cancelled the save dialog
      }
      const meta: Record<string, string> = {}
      for (const f of selected.fields) meta[f.key] = (values[f.key] ?? '').trim()
      const { pdfPath } = await trpc.pdf.render.mutate({ remote, path, template: slug, outPath, meta })
      await window.holi.openPath(pdfPath)
      onClose()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        data-convert-dialog={path}
        className="w-96 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-200 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-3">
          Convert <span className="font-mono text-neutral-100">{name}</span> to PDF
        </p>

        {templates === null && error === null && (
          <p className="mb-3 text-xs text-neutral-500">Loading templates…</p>
        )}
        {templates !== null && templates.length === 0 && (
          <p className="mb-3 text-xs text-neutral-500">
            No templates in this vault. Expected a seeded <span className="font-mono">Plain</span>{' '}
            under <span className="font-mono">.holi/templates/</span>.
          </p>
        )}
        {templates !== null && templates.length > 0 && (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-neutral-400">Template</span>
            <select
              data-convert-template
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            >
              {templates.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {selected !== null &&
          selected.fields.map((f) => (
            <label key={f.key} className="mb-3 block">
              <span className="mb-1 block text-xs text-neutral-400">
                {f.label}
                {f.required && <span className="text-red-400"> *</span>}
              </span>
              <input
                data-convert-field={f.key}
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </label>
          ))}

        {error !== null && <p className="mb-3 text-xs text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            data-convert-confirm
            disabled={busy || slug === ''}
            className="rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-900 hover:bg-white disabled:opacity-40"
            onClick={() => void convert()}
          >
            {busy ? 'Converting…' : 'Convert'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`. (The local `TemplateOption` now carries `fields`, matching `trpc.pdf.templates`'s return; `showSaveDialog` + `render`'s `meta`/`outPath` are all typed.)

- [ ] **Step 3: Full desktop suite (no regression)**

Run: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6`
Expected: **617** passed (613 baseline + 1 render-meta + 3 router pdf). No renderer unit tests here; this confirms nothing regressed.

- [ ] **Step 4: Shared suite (untouched — confirm no drift)**

Run: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
Expected: **171** passed.

- [ ] **Step 5: Build check**

Run: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -5`
Expected: builds without an unresolved-import error (confirms the new ipc/preload/main paths and the `template.typ?raw` import bundle).

- [ ] **Step 6: Verify live (ask the user to relaunch — main changed)**

Tasks 1–4 are main edits (seed, router, ipc, preload), so the dev app needs a relaunch. **Important:** `SEED_FILES` is never-overwrite, so an *existing* vault will NOT gain Plain's new fields — its `.holi/templates/plain/template.json` already exists from slice 1's manual seed. To live-verify the field UX, either (a) create a **fresh** vault (its Plain is seeded with the new manifest), or (b) hand-overwrite the two files in an existing test vault:

```bash
# Option (b): refresh the Plain template in an existing test vault so its
# manifest carries the new fields (the app will auto-commit + push it).
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
V=~/Holi/nthomsencph/a-demo-vault-3
cp src/main/agent/templates/plain/template.typ "$V/.holi/templates/plain/template.typ"
# Rewrite template.json with the two fields (or copy from a freshly-seeded vault).
```

Ask the user to relaunch the dev app (CDP 9333). Then:
1. Right-click a markdown note → **Convert to PDF…** → the picker shows **Plain**, and **Date** + **Recipient** inputs appear beneath it.
2. Fill one or both → **Convert** → a native **save sheet** opens, defaulting to `<note>.pdf` in Downloads. Pick a location and save.
3. Expected: the PDF renders to the chosen path, Finder reveals it, and opening it shows the Date/Recipient header (top-right, dim) above the note body. Leaving both blank → no header (Plain stays clean).
4. Cancel the save sheet → the dialog stays open, not busy, no error.
5. Error path: an unavailable typst surfaces "typst is not available" in the dialog rather than crashing.

Report what actually happened (per the handoff's live-verification norm — the dev app has been down, so this is the first live look at the Convert flow).

- [ ] **Step 7: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx
git commit -m "feat(pdf): Convert dialog — metadata field inputs + native save dialog

Claude goes brr.. via Dash"
```

---

## Final verification

- [ ] Typecheck **36**: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
- [ ] Desktop **617**: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Shared **171**: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Build: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3`
- [ ] Live (after relaunch, fresh or re-seeded vault): markdown note → Convert → Plain shows Date/Recipient inputs → save sheet → a PDF with the metadata header renders to the chosen path and is revealed.

---

## Self-review (spec coverage)

- **Convert dialog: metadata fields from the manifest** (spec §Front door 1: "the selected template's `fields` as inputs") → Task 2 (`pdf.templates` returns `fields`) + Task 5 (the dialog renders them as inputs, with required-field enforcement). Task 1 gives Plain real fields so the path is exercised end to end.
- **`fields` drives the dialog's inputs and is passed to `template.typ` as a Typst dictionary** (spec §Template model) → Task 3 (`meta` threaded through `pdf.render` → `renderPdf` → `composeWrapper`, which already builds the Typst dict) + Task 1 (`template.typ` reads `meta.at(...)`).
- **Native save dialog, default Downloads** (spec §Output location: "the UI writes through a native save dialog (default: Downloads)") → Task 4 (`holi:showSaveDialog`, `defaultPath` under Downloads) + Task 5 (the flow calls it before render, passes the chosen `outPath`).
- **Flow: Convert → render → open** (spec §Front door 1) → Task 5. Per the locked decision, "open" is the existing Finder **reveal** (`window.holi.openPath`), not open-in-Preview — deliberately narrower than the spec's wording, recorded above.
- **Errors surface in the dialog** (spec §Front door 1: "typst failure, template not found") → Task 5 (`setError` on render rejection — the procedure throws typed `NOT_FOUND`/`PRECONDITION_FAILED`/`BAD_REQUEST`) + Task 3 (`metaOf` → BAD_REQUEST for a malformed meta).
- **Testing** (spec §Testing) → discovery/fields returned (Task 2 router test), meta plumbing (Task 3 router tests: BAD_REQUEST + tmpdir `%PDF` with `outPath`), template renders meta (Task 1 size-delta integration). The dialog itself is CDP/manual (Task 5 Step 6), per spec.
- **Deferred to later slices (correctly absent here):** the Syv template + fonts/logo + `@@FIG@@`/`@@SIG@@` + base64 asset seeding (slice 3); the agent `md-to-pdf` skill + typst-path exposure + the AGENTS.md line (slice 4).
- **Open questions surfaced, not silently resolved:** existing vaults do NOT auto-receive Plain's new fields (`SEED_FILES` is never-overwrite) — Task 5 Step 6 gives the fresh-vault / hand-re-seed workaround; the general `ensureSeeded`-on-open gap stays deferred (handoff §Open items). `outPath` is written wherever the native dialog chose, outside the vault sandbox by design (a user-authorized destination), so it is intentionally not run through `safe()`.
```

