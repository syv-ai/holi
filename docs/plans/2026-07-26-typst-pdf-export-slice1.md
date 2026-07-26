# Typst PDF export — Slice 1 (tracer bullet) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a real markdown note into a PDF through the seeded **Plain** template, end to end — right-click a `.md` note → **Convert to PDF** → pick a template → a rendered PDF opens.

**Architecture:** One render engine in main (`renderPdf`) over three pure cores: template **discovery** (`.holi/templates/<name>/` → list), wrapper **composition** (note + template + meta → a tiny Typst program), and a typst-binary **resolver** (`resolveTypstBin`: `TYPST_BIN` env → cached download → `PATH`). The engine composes a wrapper in a temp dir and shells out to `typst compile … --root /`. Two tRPC procedures (`pdf.templates`, `pdf.render`) expose it; a FileTree context-menu item + a small picker dialog are the UI front door. The typst binary is **downloaded on first use** into `userData` — no committed binary, no packaging pipeline. All markdown preprocessing lives inside `template.typ` (Plain does the minimum: strip YAML frontmatter, render via `@preview/cmarker`); the engine stays a dumb "compose wrapper + run typst".

**Tech Stack:** Electron (main-process `child_process`, `app.getPath`), tRPC (existing router), React 18, Tailwind v4, Typst 0.14.1 + `@preview/cmarker` 0.1.6, Vitest 4 (node env), `@holi/shared`. Live UI is CDP/manual per repo norm.

**Decision:** D62 (`docs/decisions.md`) — the vault is text-first by authorship; PDFs are **outputs** rendered from markdown via Typst. Spec: `docs/specs/2026-07-26-typst-pdf-export-design.md` (§Slice decomposition, slice 1).

**User decisions (locked this session):**
- **Download typst on first use** (supersedes the earlier "bundle the binary" decision). The whole render pipeline sits behind `resolveTypstBin()`; in dev it rides `PATH`, so this slice is demonstrable now, and the download path is built + wired but only fully verifiable once a packaged build exists.
- **PDF → Downloads, then reveal** (not into the auto-committing vault). Slice 1 writes `<note>.pdf` to `~/Downloads` and reveals it in Finder via the existing `window.holi.openPath`. The native **save dialog** + open-in-Preview + metadata-field inputs are **slice 2** — slice 1's dialog is a template picker + Convert, nothing more.
- **Plain declares `"fields": []`** — no metadata inputs this slice; `pdf.render` passes `meta: {}`.

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` are broken — always `pnpm exec`. Desktop tests run from `apps/desktop/`; shared from `packages/shared/`.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` — baseline **36**, must not rise. (Do NOT use bare `pnpm exec tsc`; grep `"error TS"`, not `error`.)
- **Test baselines:** desktop **591** (`cd apps/desktop && pnpm exec vitest run`; node env, ~130s — it exceeds the 120s Bash timeout and finishes in the background, that's fine), shared **167** (`cd packages/shared && pnpm exec vitest run`). Must not drop.
- **typst in dev:** `typst 0.14.1` is on `PATH` (`/opt/homebrew/bin/typst`). The render integration test (Task 4) spawns it; on a machine without typst that test **skips** rather than fails. First compile fetches `@preview/cmarker` from the network and caches it under `~/Library/Caches/typst/` (macOS) — one-time, already primed on this machine.
- **Live app:** dev instance on CDP 9333, driver `/tmp/holi-drive.mjs`. **Renderer edits hot-reload; main edits (router, seed, new main modules) need a relaunch** — ask the user to relaunch. The dev app may be DOWN; ask before launching.
- **Vault writes auto-push** to the real GitHub vault — the Plain template files are committed vault content; that is intended (templates are shared via git), but minimize throwaway probe files in the live vault.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.
- **Absolute paths in Bash** — the tool's cwd drifts between calls.

## File Structure

- **Create** `apps/desktop/src/main/agent/templates/plain/template.typ` — the Plain Typst layout (seeded, committed vault content). Imported `?raw` by seed-content + the render test.
- **Modify** `apps/desktop/src/main/agent/seed-content.ts` — add the two Plain template files to `SEED_FILES`.
- **Modify** `apps/desktop/test/seed-content.test.ts:50` — extend the pinned `SEED_FILES` key list.
- **Create** `apps/desktop/src/main/pdf/wrapper.ts` — pure `composeWrapper` + `typstDict`/`typstString`.
- **Create** `apps/desktop/test/pdf-wrapper.test.ts` — wrapper composition tests.
- **Create** `apps/desktop/src/main/pdf/templates.ts` — `listTemplates(vaultRoot) → Template[]` (discovery + manifest parse).
- **Create** `apps/desktop/test/pdf-templates.test.ts` — discovery tests (tmpdir).
- **Create** `apps/desktop/src/main/pdf/typst-bin.ts` — `resolveTypstBin` / `ensureTypst` / `typstReleaseAsset` (the download-on-first-use seam).
- **Create** `apps/desktop/test/typst-bin.test.ts` — pure asset-resolver + cache-path tests.
- **Create** `apps/desktop/src/main/pdf/render.ts` — `renderPdf({ typstBin, templateDir, notePath, outPath, meta })`.
- **Create** `apps/desktop/test/pdf-render.test.ts` — tmpdir integration (`%PDF` against dev typst).
- **Modify** `apps/desktop/src/main/router.ts` — a `pdf` sub-router (`templates` + `render`); two `RouterDeps` fields.
- **Modify** `apps/desktop/src/main/index.ts:126-135` — inject `downloadsDir` + `typstCacheDir`.
- **Create** `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx` — template picker + Convert.
- **Modify** `apps/desktop/src/renderer/src/components/FileTree.tsx` — a "Convert to PDF" menu item (markdown-only) + dialog state + conditional render.

---

## Task 1: The Plain template + seeding

The tracer's payload: a real, proven Typst template that reads a markdown note, strips its YAML frontmatter, and renders it via `cmarker`. It is seeded as committed vault content under `.holi/templates/plain/`. (This exact `template.typ` was verified to compile a real note with frontmatter, a heading, a bold run, a list, and a table into a valid `%PDF`.)

**Files:**
- Create: `apps/desktop/src/main/agent/templates/plain/template.typ`
- Modify: `apps/desktop/src/main/agent/seed-content.ts`
- Test: `apps/desktop/test/seed-content.test.ts:50`

- [ ] **Step 1: Write the template**

Create `apps/desktop/src/main/agent/templates/plain/template.typ`:

```typst
// Plain — a clean, unbranded document layout. The copy-to-customize starter
// every vault carries. It reads the markdown note, strips a leading YAML
// frontmatter block, and renders the body with cmarker (Typst reads markdown
// through this package). No bundled fonts — it rides Typst's defaults so it
// stays small. `meta` and `assets` are accepted for a uniform template contract
// but unused here (Plain has no metadata fields and no assets).
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
  cmarker.render(strip-frontmatter(read(notePath)))
}
```

- [ ] **Step 2: Add both files to `SEED_FILES`**

In `apps/desktop/src/main/agent/seed-content.ts`, add the `?raw` import beside the existing hook import (~line 26):

```ts
import plainTemplateTyp from './templates/plain/template.typ?raw'
```

Add the Plain manifest constant next to `VAULT_MARKER` (~line 130), built the same way (`JSON.stringify`, so no `.json?raw` dependency):

```ts
/** The Plain template's manifest — a clean, unbranded layout with no metadata
 * fields (slice 1). Committed vault content under `.holi/templates/plain/`. */
const PLAIN_MANIFEST =
  JSON.stringify(
    { name: 'Plain', description: 'A clean, unbranded document layout.', fields: [] },
    null,
    2,
  ) + '\n'
```

Add both to `SEED_FILES` (~line 133), after `.holi/vault.json`:

```ts
  '.holi/vault.json': VAULT_MARKER,
  '.holi/templates/plain/template.json': PLAIN_MANIFEST,
  '.holi/templates/plain/template.typ': plainTemplateTyp,
```

- [ ] **Step 3: Update the pinned seed test**

The test at `apps/desktop/test/seed-content.test.ts:49-58` asserts the exact `SEED_FILES` key set. Replace the array (line 50-57) with the new sorted list:

```ts
    expect(Object.keys(SEED_FILES).sort()).toEqual([
      '.claude/hooks/user-prompt-submit.mjs',
      '.claude/settings.json',
      '.holi/templates/plain/template.json',
      '.holi/templates/plain/template.typ',
      '.holi/vault.json',
      'AGENTS.md',
      'CLAUDE.md',
      'MEMORY.md',
    ])
```

(The `ensureSeeded` "seeds every managed file" test derives its expectation from `Object.keys(SEED_FILES)`, so it needs no change. The "every hook script has its shebang" test filters `.mjs`, so `.typ`/`.json` are ignored.)

- [ ] **Step 4: Run the seed suite**

Run: `cd apps/desktop && pnpm exec vitest run test/seed-content.test.ts 2>&1 | tail -6`
Expected: PASS. The `?raw` import of `.typ` resolves under vitest exactly as the existing `.mjs?raw` hook import does.

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/templates/plain/template.typ apps/desktop/src/main/agent/seed-content.ts apps/desktop/test/seed-content.test.ts
git commit -m "feat(pdf): seed the Plain typst template into every vault

Claude goes brr.. via Dash"
```

---

## Task 2: `composeWrapper` — the Typst wrapper (pure)

The engine never edits templates or notes; it writes one tiny program that imports the template's `doc` and calls it with absolute paths. Isolated and pure so it is unit-testable without spawning anything.

**Files:**
- Create: `apps/desktop/src/main/pdf/wrapper.ts`
- Test: `apps/desktop/test/pdf-wrapper.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/pdf-wrapper.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { composeWrapper, typstDict, typstString } from '../src/main/pdf/wrapper'

describe('typstString', () => {
  it('wraps in quotes and escapes backslashes and quotes', () => {
    expect(typstString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('typstDict', () => {
  it('renders an empty map as the empty-dict literal (:)', () => {
    expect(typstDict({})).toBe('(:)')
  })
  it('renders string entries as a Typst dictionary', () => {
    expect(typstDict({ date: '2026-07-26', to: 'ACME' })).toBe('(date: "2026-07-26", to: "ACME")')
  })
})

describe('composeWrapper', () => {
  it('imports the template and calls doc with absolute paths + meta', () => {
    const out = composeWrapper({
      templateDir: '/v/.holi/templates/plain',
      notePath: '/v/notes/report.md',
      assetsDir: '/v/.holi/templates/plain/assets',
      meta: {},
    })
    expect(out).toBe(
      '#import "/v/.holi/templates/plain/template.typ": doc\n' +
        '#doc("/v/notes/report.md", meta: (:), assets: "/v/.holi/templates/plain/assets")\n',
    )
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-wrapper.test.ts`
Expected: FAIL — cannot resolve `../src/main/pdf/wrapper`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/pdf/wrapper.ts`:

```ts
/** Escape a JS string for a Typst double-quoted string literal. Backslash first,
 * then quote, so the escape characters themselves aren't re-escaped. */
export function typstString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** A flat string→string map as a Typst dictionary literal. Empty → `(:)` (the
 * empty-dict literal; `()` is the empty array in Typst). Keys are assumed to be
 * valid Typst identifiers — they come from a template's declared `fields`. */
export function typstDict(meta: Record<string, string>): string {
  const entries = Object.entries(meta)
  if (entries.length === 0) return '(:)'
  return `(${entries.map(([k, v]) => `${k}: ${typstString(v)}`).join(', ')})`
}

export interface WrapperInput {
  /** Absolute `.holi/templates/<name>/`. */
  templateDir: string
  /** Absolute path to the note being rendered. */
  notePath: string
  /** Absolute `<templateDir>/assets`. */
  assetsDir: string
  /** Metadata dict passed through to the template's `doc`. */
  meta: Record<string, string>
}

/**
 * The tiny Typst program the engine compiles in a temp dir: import the
 * template's `doc` function and call it. Every path is absolute, so
 * `typst compile … --root /` can read the note and template even though the
 * wrapper itself lives in an unrelated temp directory.
 */
export function composeWrapper({ templateDir, notePath, assetsDir, meta }: WrapperInput): string {
  return (
    `#import ${typstString(`${templateDir}/template.typ`)}: doc\n` +
    `#doc(${typstString(notePath)}, meta: ${typstDict(meta)}, assets: ${typstString(assetsDir)})\n`
  )
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-wrapper.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/pdf/wrapper.ts apps/desktop/test/pdf-wrapper.test.ts
git commit -m "feat(pdf): composeWrapper — note+template+meta to a Typst wrapper program

Claude goes brr.. via Dash"
```

---

## Task 3: `listTemplates` — discovery (tmpdir)

The vault's templates = the subdirectories of `.holi/templates/` that carry a readable `template.json`. No registry, no index — the directory is the list. A half-written template (no/invalid manifest) is skipped, never an error, so Convert can't break on a bad dir.

**Files:**
- Create: `apps/desktop/src/main/pdf/templates.ts`
- Test: `apps/desktop/test/pdf-templates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/pdf-templates.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listTemplates } from '../src/main/pdf/templates'

const dirs: string[] = []
async function vault(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-tpl-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function seed(root: string, slug: string, manifest: unknown): Promise<void> {
  const dir = join(root, '.holi/templates', slug)
  await mkdir(dir, { recursive: true })
  const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  await writeFile(join(dir, 'template.json'), body)
  await writeFile(join(dir, 'template.typ'), '#let doc(p, meta: (:), assets: "") = []')
}

describe('listTemplates', () => {
  it('returns [] when there is no templates dir', async () => {
    expect(await listTemplates(await vault())).toEqual([])
  })

  it('reads a template dir + manifest into a Template', async () => {
    const root = await vault()
    await seed(root, 'plain', { name: 'Plain', description: 'Clean.', fields: [] })
    const [t] = await listTemplates(root)
    expect(t).toMatchObject({ name: 'Plain', description: 'Clean.', fields: [], slug: 'plain' })
    expect(t.dir).toBe(join(root, '.holi/templates/plain'))
  })

  it('normalizes fields and defaults label/required', async () => {
    const root = await vault()
    await seed(root, 'p', {
      name: 'P',
      fields: [{ key: 'date', label: 'Date', required: true }, { key: 'to' }],
    })
    const [t] = await listTemplates(root)
    expect(t.fields).toEqual([
      { key: 'date', label: 'Date', required: true },
      { key: 'to', label: 'to', required: false },
    ])
  })

  it('skips a dir with no manifest and a dir with invalid JSON', async () => {
    const root = await vault()
    await mkdir(join(root, '.holi/templates/nomanifest'), { recursive: true })
    await seed(root, 'broken', '{ not json')
    await seed(root, 'plain', { name: 'Plain', fields: [] })
    expect((await listTemplates(root)).map((t) => t.slug)).toEqual(['plain'])
  })

  it('sorts by display name', async () => {
    const root = await vault()
    await seed(root, 'z', { name: 'Zeta' })
    await seed(root, 'a', { name: 'Alpha' })
    expect((await listTemplates(root)).map((t) => t.name)).toEqual(['Alpha', 'Zeta'])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-templates.test.ts`
Expected: FAIL — cannot resolve `../src/main/pdf/templates`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/pdf/templates.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TemplateField {
  key: string
  label: string
  required: boolean
}

export interface Template {
  /** Display name from the manifest. */
  name: string
  description: string
  fields: TemplateField[]
  /** Absolute `.holi/templates/<slug>/`. */
  dir: string
  /** The directory name — the stable id passed to `pdf.render`. */
  slug: string
}

const TEMPLATES_REL = '.holi/templates'

/**
 * The vault's templates: subdirectories of `.holi/templates/` with a readable,
 * valid `template.json`. Missing dir → `[]`. A dir without a valid manifest is
 * skipped rather than throwing, so one bad template can't break Convert. Sorted
 * by display name.
 */
export async function listTemplates(vaultRoot: string): Promise<Template[]> {
  const base = join(vaultRoot, TEMPLATES_REL)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const templates: Template[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(base, e.name)
    const raw = await readFile(join(dir, 'template.json'), 'utf8').catch(() => null)
    if (raw === null) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const m = parsed as Record<string, unknown>
    if (typeof m.name !== 'string') continue
    templates.push({
      name: m.name,
      description: typeof m.description === 'string' ? m.description : '',
      fields: normalizeFields(m.fields),
      dir,
      slug: e.name,
    })
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeFields(raw: unknown): TemplateField[] {
  if (!Array.isArray(raw)) return []
  const out: TemplateField[] = []
  for (const f of raw) {
    if (typeof f !== 'object' || f === null) continue
    const g = f as Record<string, unknown>
    if (typeof g.key !== 'string') continue
    out.push({
      key: g.key,
      label: typeof g.label === 'string' ? g.label : g.key,
      required: g.required === true,
    })
  }
  return out
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-templates.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/pdf/templates.ts apps/desktop/test/pdf-templates.test.ts
git commit -m "feat(pdf): listTemplates — the .holi/templates directory is the list

Claude goes brr.. via Dash"
```

---

## Task 4: `renderPdf` + `resolveTypstBin` (PATH) + integration

The engine's heart, and the tracer's proof. `resolveTypstBin` is introduced PATH-only here (the cached-download branch is Task 6); its signature already takes an options object so Task 6 adds a branch without changing callers. `renderPdf` composes a wrapper in a temp dir and shells out to typst. The integration test runs the **real** seeded `template.typ` against dev typst and asserts a `%PDF`.

**Files:**
- Create: `apps/desktop/src/main/pdf/typst-bin.ts`
- Create: `apps/desktop/src/main/pdf/render.ts`
- Test: `apps/desktop/test/pdf-render.test.ts`

- [ ] **Step 1: The typst resolver (PATH branch only)**

Create `apps/desktop/src/main/pdf/typst-bin.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** The typst version Holi targets. Templates are authored against it, and the
 * download-on-first-use path (Task 6) pins to it. */
export const TYPST_VERSION = '0.14.1'

export interface ResolveTypstOpts {
  /** Where a downloaded binary is cached (userData/typst). Omitted in tests that
   *  only exercise the PATH branch; wired up in the download task. */
  cacheDir?: string
}

/**
 * Absolute path to a usable typst binary, or null. Resolution order:
 *   1. `TYPST_BIN` env override (tests, power users, the agent front door).
 *   2. a cached download under `cacheDir` (added in the download-on-first-use task).
 *   3. `PATH` (dev — `which typst`).
 * This finds an EXISTING binary only; `ensureTypst` (Task 6) adds the download.
 */
export async function resolveTypstBin(_opts: ResolveTypstOpts = {}): Promise<string | null> {
  const override = process.env.TYPST_BIN
  if (override) return override
  return onPath()
}

/** `typst` on `PATH`, or null. `which` on unix, `where` on Windows. */
export async function onPath(): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await exec(cmd, ['typst'])
    const first = stdout.split(/\r?\n/).find((l) => l.trim() !== '')
    return first?.trim() ?? null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: The render engine**

Create `apps/desktop/src/main/pdf/render.ts`:

```ts
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { composeWrapper } from './wrapper'

const exec = promisify(execFile)

export interface RenderInput {
  /** Absolute path to the typst binary (from resolveTypstBin/ensureTypst). */
  typstBin: string
  /** Absolute `.holi/templates/<name>/`. */
  templateDir: string
  /** Absolute path to the note. */
  notePath: string
  /** Absolute `.pdf` destination. */
  outPath: string
  meta: Record<string, string>
}

/**
 * Compose a wrapper in a fresh temp dir and run `typst compile`, producing
 * `outPath`. `--root /` because the wrapper (temp dir), the template, and the
 * note live in three different trees and the wrapper references them all by
 * absolute path — no single narrower root spans them. Throws with typst's
 * stderr on a non-zero exit. Fonts (`--font-path`) are a later concern; Plain
 * ships none.
 */
export async function renderPdf({
  typstBin,
  templateDir,
  notePath,
  outPath,
  meta,
}: RenderInput): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'holi-typst-'))
  try {
    const wrapperPath = join(work, 'wrapper.typ')
    await writeFile(
      wrapperPath,
      composeWrapper({ templateDir, notePath, assetsDir: join(templateDir, 'assets'), meta }),
    )
    await exec(typstBin, ['compile', wrapperPath, outPath, '--root', '/'])
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)
    throw new Error(`typst compile failed: ${stderr}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
```

- [ ] **Step 3: Write the integration test**

Create `apps/desktop/test/pdf-render.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderPdf } from '../src/main/pdf/render'
import { resolveTypstBin } from '../src/main/pdf/typst-bin'
// The ACTUAL seeded template — this test proves that exact file compiles.
import plainTemplateTyp from '../src/main/agent/templates/plain/template.typ?raw'

const dirs: string[] = []
async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'holi-render-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('renderPdf (integration — needs typst on PATH; first run fetches cmarker)', () => {
  it('renders a real markdown note through the Plain template to a %PDF', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return // no typst on this machine — skip, don't fail

    const root = await work()
    const templateDir = join(root, '.holi/templates/plain')
    await mkdir(join(templateDir, 'assets'), { recursive: true })
    await writeFile(join(templateDir, 'template.typ'), plainTemplateTyp)

    const notePath = join(root, 'report.md')
    await writeFile(
      notePath,
      '---\ntitle: T\n---\n\n## 1. Heading\n\nBody **bold** text and a list:\n\n- a\n- b\n',
    )
    const outPath = join(root, 'out.pdf')

    await renderPdf({ typstBin: typst, templateDir, notePath, outPath, meta: {} })

    const bytes = await readFile(outPath)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
})
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-render.test.ts 2>&1 | tail -8`
Expected: PASS (1 test) — typst is on PATH here, so it renders a real `%PDF`. (If it prints a network error on a cold machine, the cmarker fetch failed; re-run once online.)

- [ ] **Step 5: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`.

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/pdf/typst-bin.ts apps/desktop/src/main/pdf/render.ts apps/desktop/test/pdf-render.test.ts
git commit -m "feat(pdf): renderPdf engine + resolveTypstBin (PATH); tmpdir %PDF integration test

Claude goes brr.. via Dash"
```

---

## Task 5: `pdf` tRPC namespace + injected deps

Expose the engine to the renderer. `pdf.templates` lists the vault's templates for the picker; `pdf.render` renders the chosen template to `~/Downloads` and returns the path. The router stays Node-testable, so the Downloads dir and typst cache dir are **injected** (like `openExternal`/`vaultRoot`), not read from `electron` here.

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Modify: `apps/desktop/src/main/index.ts:126-135`

- [ ] **Step 1: Import the engine + add the deps**

In `router.ts`, add imports beside the other `./vault`/`./agent` imports (~line 45):

```ts
import { listTemplates } from './pdf/templates'
import { renderPdf } from './pdf/render'
import { resolveTypstBin } from './pdf/typst-bin'
```

Add two fields to `RouterDeps` (after `openExternal`, ~line 90):

```ts
  /** Absolute dir the Convert-to-PDF output is written to (the user's Downloads).
   *  Injected rather than read from electron here so the router stays
   *  typecheckable and testable under plain Node. */
  downloadsDir: string
  /** Where a downloaded typst binary is cached (userData/typst). Injected for
   *  the same reason; the resolver only reads it, never electron. */
  typstCacheDir: string
```

- [ ] **Step 2: Add the `pdf` sub-router**

In `createRouter`, next to the other sub-routers (before the `return t.router({...})` at ~line 808), add:

```ts
  const pdf = t.router({
    // The vault's templates, for the Convert picker. Slice 1 only needs
    // name/slug/description; the full `fields` shape drives slice 2's inputs.
    templates: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<{ name: string; slug: string; description: string }[]> => {
        const root = await rootFor(input.remote)
        return (await listTemplates(root)).map(({ name, slug, description }) => ({
          name,
          slug,
          description,
        }))
      }),

    // Render `path` through `template` to a PDF in Downloads; return its path.
    // Not a vaultMutation — the output goes to Downloads, not the vault, so
    // there is no snapshot to refresh.
    render: t.procedure
      .input(fields({ remote: 'string', path: 'string', template: 'string' }))
      .mutation(async ({ input }): Promise<{ pdfPath: string }> => {
        const root = await rootFor(input.remote)
        const noteAbs = absPathFor(root, safe(input.path))
        const tpl = (await listTemplates(root)).find((t) => t.slug === input.template)
        if (tpl === undefined) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `template ${input.template}` })
        }
        const typstBin = await resolveTypstBin({ cacheDir: deps.typstCacheDir })
        if (typstBin === null) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'typst is not available' })
        }
        const base = input.path.split('/').at(-1)!.replace(/\.(md|markdown)$/i, '')
        const outPath = join(deps.downloadsDir, `${base}.pdf`)
        await renderPdf({ typstBin, templateDir: tpl.dir, notePath: noteAbs, outPath, meta: {} })
        return { pdfPath: outPath }
      }),
  })
```

Add `pdf` to the returned router (~line 808):

```ts
  return t.router({ auth, github, vaults, notes, tasks, sync, pdf })
```

(`rootFor`, `safe`, `absPathFor`, `fields`, `TRPCError`, and `join` are all already in scope in `router.ts`.)

- [ ] **Step 3: Inject the deps from `index.ts`**

In `apps/desktop/src/main/index.ts`, add the two fields to the `createRouter({...})` call (~line 126-135), after `openExternal`:

```ts
    downloadsDir: app.getPath('downloads'),
    typstCacheDir: join(app.getPath('userData'), 'typst'),
```

(`app` and `join` are already imported in `index.ts`.)

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`. `trpc.pdf.templates` / `trpc.pdf.render` are now typed on the renderer (the client imports `AppRouter`).

- [ ] **Step 5: Build check (main path must resolve)**

Run: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -5`
Expected: builds without an unresolved-import error (this also confirms the `template.typ?raw` import bundles in the main build).

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/router.ts apps/desktop/src/main/index.ts
git commit -m "feat(pdf): pdf.templates + pdf.render tRPC procedures (render to Downloads)

Claude goes brr.. via Dash"
```

---

## Task 6: download typst on first use (`ensureTypst`)

The shipping mechanism. When no binary is found (no override, nothing cached, not on PATH), download the pinned typst release for the host platform, extract it, cache it under `userData/typst/typst-<version>/`, and verify it runs the pinned version. The pure asset/URL/cache-path helpers are TDD'd; the network download + archive extraction are exercised manually (a 30 MB fetch has no place in the unit suite) and are only fully verifiable once a packaged build exists — flag that honestly.

**Files:**
- Modify: `apps/desktop/src/main/pdf/typst-bin.ts`
- Modify: `apps/desktop/src/main/router.ts` (swap `resolveTypstBin` → `ensureTypst` at the one render call site)
- Test: `apps/desktop/test/typst-bin.test.ts`

- [ ] **Step 1: Write the failing test (pure helpers)**

Create `apps/desktop/test/typst-bin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { cachedBinPath, TYPST_VERSION, typstDownloadUrl, typstReleaseAsset } from '../src/main/pdf/typst-bin'

describe('typstReleaseAsset', () => {
  it('maps darwin/arm64 to the aarch64-apple-darwin tar.xz', () => {
    expect(typstReleaseAsset('darwin', 'arm64')).toEqual({
      archive: 'typst-aarch64-apple-darwin.tar.xz',
      binInArchive: 'typst-aarch64-apple-darwin/typst',
      format: 'tar.xz',
    })
  })
  it('maps win32/x64 to the msvc zip carrying typst.exe', () => {
    expect(typstReleaseAsset('win32', 'x64')).toEqual({
      archive: 'typst-x86_64-pc-windows-msvc.zip',
      binInArchive: 'typst-x86_64-pc-windows-msvc/typst.exe',
      format: 'zip',
    })
  })
  it('throws for an unsupported platform', () => {
    expect(() => typstReleaseAsset('sunos', 'sparc')).toThrow(/no typst release/)
  })
})

describe('typstDownloadUrl', () => {
  it('builds a pinned github release URL', () => {
    expect(typstDownloadUrl(typstReleaseAsset('darwin', 'arm64'))).toBe(
      `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-aarch64-apple-darwin.tar.xz`,
    )
  })
})

describe('cachedBinPath', () => {
  it('is versioned so a pin bump lands in a fresh dir', () => {
    // The binary name follows process.platform; on a unix dev machine it is `typst`.
    expect(cachedBinPath('/u/typst')).toBe(`/u/typst/typst-${TYPST_VERSION}/typst`)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/typst-bin.test.ts`
Expected: FAIL — `typstReleaseAsset` / `typstDownloadUrl` / `cachedBinPath` are not exported.

- [ ] **Step 3: Implement the download-on-first-use path**

Edit `apps/desktop/src/main/pdf/typst-bin.ts`. Extend the imports:

```ts
import { execFile } from 'node:child_process'
import { access, chmod, constants, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
```

Add the cache-lookup branch to `resolveTypstBin` (replace the existing body):

```ts
export async function resolveTypstBin(opts: ResolveTypstOpts = {}): Promise<string | null> {
  const override = process.env.TYPST_BIN
  if (override) return override
  if (opts.cacheDir) {
    const cached = cachedBinPath(opts.cacheDir)
    if (await isExecutable(cached)) return cached
  }
  return onPath()
}
```

Append the rest (asset map, URL, cache path, `ensureTypst`, and the downloader):

```ts
export interface TypstAsset {
  /** GitHub release asset filename. */
  archive: string
  /** Path of the binary inside the extracted archive. */
  binInArchive: string
  /** Archive format — decides the extractor. */
  format: 'tar.xz' | 'zip'
}

const TARGETS: Record<string, { triple: string; format: 'tar.xz' | 'zip' }> = {
  'darwin/arm64': { triple: 'aarch64-apple-darwin', format: 'tar.xz' },
  'darwin/x64': { triple: 'x86_64-apple-darwin', format: 'tar.xz' },
  'linux/x64': { triple: 'x86_64-unknown-linux-musl', format: 'tar.xz' },
  'linux/arm64': { triple: 'aarch64-unknown-linux-musl', format: 'tar.xz' },
  'win32/x64': { triple: 'x86_64-pc-windows-msvc', format: 'zip' },
}

/** The release asset for a platform/arch, or throw if typst ships none. */
export function typstReleaseAsset(platform: string, arch: string): TypstAsset {
  const target = TARGETS[`${platform}/${arch}`]
  if (target === undefined) throw new Error(`no typst release for ${platform}/${arch}`)
  const dir = `typst-${target.triple}`
  const bin = platform === 'win32' ? 'typst.exe' : 'typst'
  return { archive: `${dir}.${target.format}`, binInArchive: `${dir}/${bin}`, format: target.format }
}

/** The pinned GitHub release download URL for an asset. */
export function typstDownloadUrl(asset: TypstAsset, version = TYPST_VERSION): string {
  return `https://github.com/typst/typst/releases/download/v${version}/${asset.archive}`
}

/** Where the downloaded binary is cached. Versioned, so bumping the pin lands in
 *  a fresh dir and never runs a stale binary. */
export function cachedBinPath(cacheDir: string): string {
  const bin = process.platform === 'win32' ? 'typst.exe' : 'typst'
  return join(cacheDir, `typst-${TYPST_VERSION}`, bin)
}

async function isExecutable(p: string): Promise<boolean> {
  return access(p, constants.X_OK).then(
    () => true,
    () => false,
  )
}

/**
 * Like `resolveTypstBin`, but downloads-on-first-use: if nothing is found and a
 * `cacheDir` is given, fetch + cache the pinned release for the host platform.
 * Returns null if the download/extraction/verification fails (the UI surfaces a
 * clear "typst is not available" error). Network + extraction are NOT unit-
 * tested here (a 30 MB fetch) — the pure helpers above are, and the end-to-end
 * download is verified manually (Step 6).
 */
export async function ensureTypst(opts: ResolveTypstOpts = {}): Promise<string | null> {
  const existing = await resolveTypstBin(opts)
  if (existing !== null) return existing
  if (!opts.cacheDir) return null
  return downloadTypst(opts.cacheDir)
}

async function downloadTypst(cacheDir: string): Promise<string | null> {
  const asset = typstReleaseAsset(process.platform, process.arch)
  const scratch = await mkdtemp(join(tmpdir(), 'holi-typst-dl-'))
  try {
    const res = await fetch(typstDownloadUrl(asset))
    if (!res.ok) return null
    const archivePath = join(scratch, asset.archive)
    await writeFile(archivePath, Buffer.from(await res.arrayBuffer()))
    await extract(archivePath, scratch, asset.format)

    const dest = cachedBinPath(cacheDir)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(join(scratch, asset.binInArchive), dest)
    await chmod(dest, 0o755)

    // Functional integrity check: it runs and reports the pinned version.
    // (A sha256 pin of the archive is the stronger check — see the spec's open
    // questions; deferred so we don't maintain a per-platform checksum table.)
    const { stdout } = await exec(dest, ['--version'])
    if (!stdout.includes(TYPST_VERSION)) {
      await rm(dest, { force: true })
      return null
    }
    return dest
  } catch {
    return null
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Extract a typst release archive. `tar` autodetects xz on macOS/Linux;
 *  Windows uses PowerShell's Expand-Archive. Windows is unverified until a
 *  packaged build exists (spec open question). */
async function extract(archivePath: string, into: string, format: 'tar.xz' | 'zip'): Promise<void> {
  if (format === 'zip') {
    await exec('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${archivePath}" -DestinationPath "${into}" -Force`,
    ])
  } else {
    await exec('tar', ['-xf', archivePath, '-C', into])
  }
}
```

- [ ] **Step 4: Point the router's render at `ensureTypst`**

In `router.ts`, change the render procedure's resolver call and its import so first-use downloads:

```ts
import { ensureTypst, resolveTypstBin } from './pdf/typst-bin'
```

```ts
        const typstBin = await ensureTypst({ cacheDir: deps.typstCacheDir })
```

(`resolveTypstBin` stays imported — it's the find-only path used elsewhere/later; `ensureTypst` wraps it with the download.)

- [ ] **Step 5: Run the suite + typecheck**

Run: `cd apps/desktop && pnpm exec vitest run test/typst-bin.test.ts` → Expected: PASS (5 tests).
Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → Expected: `36`.

- [ ] **Step 6: Manually verify the real download (flag the result honestly)**

The download path can't be unit-tested. Verify it once by hand from a scratch cache dir, simulating "no typst on PATH" via an empty PATH so only the download can satisfy it:

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
CACHE=$(mktemp -d)
pnpm exec node --input-type=module -e "
  import { ensureTypst } from './src/main/pdf/typst-bin.ts'
" 2>/dev/null || echo "(node can't run .ts directly — verify via the live app instead)"
```

Because bare `node` can't execute TypeScript here, the honest verification is **through the live app** after the Task 7 relaunch: on a machine where typst is NOT on the GUI app's PATH (the normal packaged case), the first Convert triggers the download into `userData/typst/typst-0.14.1/`. In dev on this machine typst IS on PATH, so `ensureTypst` returns the PATH binary and the download branch is not exercised. **State plainly in the commit/PR that the download branch is covered only by its pure helpers + a manual check, not end-to-end, until a packaged build exists.**

- [ ] **Step 7: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/pdf/typst-bin.ts apps/desktop/src/main/router.ts apps/desktop/test/typst-bin.test.ts
git commit -m "feat(pdf): download typst on first use (ensureTypst) — pinned release, cached in userData

Claude goes brr.. via Dash"
```

---

## Task 7: the Convert command (UI)

The front door: a "Convert to PDF" item on a markdown note's context menu opens a small template-picker dialog; Convert calls `pdf.render` and reveals the PDF in Finder. Modeled on `DeleteConfirm` (fixed overlay + stop-propagation card, driven by parent `useState` — no portal, no modal library, per repo norm). CDP/manual-verified.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx`
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx`

- [ ] **Step 1: The dialog**

Create `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'

interface TemplateOption {
  name: string
  slug: string
  description: string
}

/**
 * Convert-to-PDF, slice 1: pick a template, hit Convert. Fields/metadata inputs,
 * the native save dialog, and open-in-Preview are slice 2 — here the render goes
 * to Downloads and is revealed in Finder. Fixed-overlay + stop-propagation card,
 * the house modal pattern (see DeleteConfirm); driven by the caller's useState.
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = path.split('/').at(-1) ?? path

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

  const convert = async () => {
    setBusy(true)
    setError(null)
    try {
      const { pdfPath } = await trpc.pdf.render.mutate({ remote, path, template: slug })
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

- [ ] **Step 2: The menu item + dialog state in FileTree**

In `apps/desktop/src/renderer/src/components/FileTree.tsx`:

Import `fileKind` (add to the `@holi/shared` imports; there is currently no `@holi/shared` import line in this file, so add one near the top with the other imports):

```tsx
import { fileKind } from '@holi/shared'
```

Import the dialog (near the other component imports):

```tsx
import { ConvertToPdfDialog } from './ConvertToPdfDialog'
```

Add dialog state beside `confirming` (~line 118):

```tsx
  const [converting, setConverting] = useState<string | null>(null)
```

In `buildMenu`, add a "Convert to PDF" item inside the `if (!multi)` block that already holds Copy Path / Reveal in Finder (~line 371-378) — gate it on markdown so it only shows for `.md`/`.markdown` notes:

```tsx
    if (!multi) {
      if (fileKind(path) === 'markdown') {
        items.push('separator', { label: 'Convert to PDF…', onSelect: () => setConverting(path) })
      }
      items.push(
        'separator',
        { label: 'Copy Path', onSelect: () => void navigator.clipboard.writeText(absPathFor(path)) },
        { label: 'Copy Relative Path', onSelect: () => void navigator.clipboard.writeText(path) },
        { label: 'Reveal in Finder', onSelect: () => void window.holi.openPath(absPathFor(path)) },
      )
    }
```

Render the dialog conditionally beside `{confirming && …}` (~line 490-501):

```tsx
      {converting !== null && activeRemote !== null && (
        <ConvertToPdfDialog
          remote={activeRemote}
          path={converting}
          onClose={() => setConverting(null)}
        />
      )}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
Expected: `36`. (`activeRemote` is `useAtomValue(activeRemoteAtom)` — already in scope at FileTree.tsx:98; the `activeRemote !== null` guard narrows it to `string` for the prop.)

- [ ] **Step 4: Full desktop suite**

Run: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6`
Expected: **606** passed (591 baseline + 4 wrapper + 5 templates + 1 render + 5 typst-bin). No renderer unit tests here; this confirms no regression.

- [ ] **Step 5: Verify live (ask the user to relaunch — main changed)**

Task 1/5/6 are main edits, so the dev app needs a relaunch. Ask the user to relaunch the dev app (CDP 9333). Then:
1. Right-click a markdown note in the tree → the menu shows **Convert to PDF…** (and does NOT show for a non-`.md` file — right-click an image to confirm it's absent).
2. Click it → the picker shows **Plain** selected → click **Convert**.
3. Expected: a `<note>.pdf` appears in `~/Downloads` and Finder reveals it; opening it shows the note rendered (heading, body, lists, tables). First-ever convert may take a beat while typst fetches cmarker.
4. Error path: if typst is somehow unavailable, the dialog shows "typst is not available" rather than crashing.

Report what actually happened (including whether the download branch was exercised — in dev it won't be, typst is on PATH).

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx apps/desktop/src/renderer/src/components/FileTree.tsx
git commit -m "feat(pdf): Convert to PDF command — markdown context-menu item + template picker

Claude goes brr.. via Dash"
```

---

## Final verification

- [ ] Typecheck **36**: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`
- [ ] Desktop **606**: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Shared **167** (untouched, but confirm no drift): `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3`
- [ ] Build: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3`
- [ ] Live (after relaunch): markdown note → Convert to PDF → Plain → a real PDF opens from Downloads; the item is absent on non-markdown files.

---

## Self-review (spec coverage)

- **Template model** (spec §Template model: `.holi/templates/<name>/` with `template.json` + `template.typ` + `assets/`) → Task 1 (seeded Plain, committed under `.holi/`) + Task 3 (`listTemplates` reads the dir as the list, parses the manifest, normalizes `fields`).
- **Plain default seeded into every vault** (spec §Templates shipped) → Task 1, via `SEED_FILES` + the pinned-test update; no bundled fonts (rides Typst defaults), minimal preprocessing (frontmatter strip only).
- **Render engine** (spec §Render engine: resolve template → compose wrapper → `typst compile … --root /` → return path) → Task 2 (`composeWrapper`) + Task 4 (`renderPdf`). All markdown preprocessing lives in `template.typ`, not the engine.
- **typst resolver / download-on-first-use** (spec §Decisions locked, updated) → Task 4 (`resolveTypstBin`, PATH) + Task 6 (`ensureTypst` cached download of the pinned release). `TYPST_BIN` → cache → PATH order. The download branch is honestly flagged as verifiable only once packaged.
- **Output → Downloads, not the vault** (spec §Output location) → Task 5 writes to `deps.downloadsDir`; Task 7 reveals via `window.holi.openPath`. (Native save dialog + open-in-Preview are slice 2.)
- **Minimal Convert command** (spec §Slice 1: a template picker + Convert) → Task 7: context-menu item (markdown-gated) + picker dialog + `pdf.render`.
- **Testing** (spec §Testing: discovery, wrapper composition, resolver, tmpdir `%PDF` integration) → Tasks 3, 2, 6, 4 respectively.
- **Deferred to later slices (correctly absent here):** the full dialog UX + metadata fields + save dialog (slice 2); the Syv template + fonts/logo + `@@FIG@@`/`@@SIG@@` + base64 asset seeding (slice 3); the agent `md-to-pdf` skill + typst-path exposure + AGENTS.md line (slice 4).
- **Open questions surfaced, not silently resolved:** sha256-pinning the download (Task 6 uses a `--version` functional check, flagged); Windows `.zip` extraction (implemented, unverified); whether Plain should bundle a font (it does not — rides defaults).
</content>
</invoke>
