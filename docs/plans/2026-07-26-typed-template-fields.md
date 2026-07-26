# Typed template fields — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a PDF template's metadata fields **typed**. Each field declares a data `type` (one of six) that drives its Convert-dialog widget, the native Typst value the template receives, and how the template presents it. The seeded Plain template is upgraded to use a real `date` field (picker prefilled to today) whose value renders as a formatted date, not `Date: <raw>`.

**Architecture:** A curated six-type registry across three small units (spec §Architecture). Unit 1 — `@holi/shared/template-fields.ts`: the `TemplateFieldType` union, the `TemplateField` wire shape, and a pure `initialValue` default-resolver, imported by both main and renderer. Unit 2 — a renderer **widget registry** (`type → controlled component`) the Convert dialog iterates. Unit 3 — engine **coercion** (`coerceMeta(fields, values) → Typst dict literal`) replacing the current all-strings `typstDict`, emitting native values (`number → 3`, `checkbox → true`, `date → datetime(...)`). The dialog still sends a `Record<string,string>`; the engine — which resolves the template and knows each field's type — does the typing.

**Tech Stack:** TypeScript, `@holi/shared` (Vitest 4, node env), Electron main (`child_process`), tRPC, React 18, Tailwind v4, Typst 0.14.1 + `@preview/cmarker` 0.1.6. Live UI is CDP/manual per repo norm.

**Decision:** D62. Spec: `docs/specs/2026-07-26-typed-template-fields-design.md`. Extends `docs/specs/2026-07-26-typst-pdf-export-design.md` (§Template model) and the slice-2 untyped `fields` shape (a strict subset — a field with `type: "text"`).

**User decisions (locked this session):**
- Six field types: `text`, `textarea`, `date`, `select`, `number`, `checkbox`.
- Authoring is **manifest-driven files** (no builder UI this round); the typed schema is the system.
- Values reach the template as **native Typst types** (engine coerces per manifest); `date` → a native `datetime`.
- Defaults: **type default + per-field `default` override** — a `date` prefills to today unless `default` says otherwise (`"today"` token / `""` blank / literal).

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` are broken — always `pnpm exec`. Desktop tests run from `apps/desktop/`; shared from `packages/shared/`.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` — baseline **36**, must not rise. (Do NOT use bare `pnpm exec tsc`; grep `"error TS"`.)
- **Test baselines:** desktop **617** (`cd apps/desktop && pnpm exec vitest run`; node env, ~90s — exceeds the 120s Bash timeout and finishes in the background, that's fine), shared **171** (`cd packages/shared && pnpm exec vitest run`). This plan adds **+8 shared** (→ 179) and **+9 desktop** (pdf-wrapper +6, pdf-templates +2, pdf-render +1 → 626); the real gate is *no drop + the new tests green*.
- **typst in dev:** `typst 0.14.1` on `PATH`. Integration tests spawn it; no-typst machines **skip** (early `return`). The upgraded Plain `template.typ` (native `datetime` + `.display`) was verified to compile with a full/partial/empty `meta`.
- **Live app:** dev on CDP 9333, driver `/tmp/holi-drive.mjs`. **Renderer edits hot-reload; main edits (shared, router, seed, pdf modules) need a relaunch** — ask the user. The app may be running; ask before assuming state.
- **Vault writes auto-push** to the real GitHub vault — the upgraded Plain files are committed vault content (intended). The two existing vaults are re-seeded by hand in Task 7.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.
- **Absolute paths in Bash** — the tool's cwd drifts between calls; `cd` explicitly each call.

## File Structure

- **Create** `packages/shared/src/template-fields.ts` — `TemplateFieldType`, `TemplateField`, `initialValue`.
- **Modify** `packages/shared/src/index.ts` — barrel-export the new module.
- **Create** `packages/shared/test/template-fields.test.ts` — `initialValue` cases.
- **Modify** `apps/desktop/src/main/pdf/templates.ts` — import `TemplateField` from `@holi/shared`; `normalizeFields` parses `type/default/options`.
- **Modify** `apps/desktop/test/pdf-templates.test.ts` — typed-field cases; update existing `fields` assertions to include `type`.
- **Modify** `apps/desktop/src/main/pdf/wrapper.ts` — replace `typstDict` with `coerceMeta`; `composeWrapper` gains `fields`.
- **Modify** `apps/desktop/test/pdf-wrapper.test.ts` — `coerceMeta` cases; update `composeWrapper` test.
- **Modify** `apps/desktop/src/main/pdf/render.ts` — `RenderInput` gains `fields`, threaded to `composeWrapper`.
- **Modify** `apps/desktop/src/main/router.ts` — import `TemplateField` from `@holi/shared`; `render` passes `tpl.fields`.
- **Modify** `apps/desktop/test/pdf-render.test.ts` — pass `fields`; add a native-values integration test.
- **Modify** `apps/desktop/test/router.test.ts` — typed manifests in the `pdf` tests.
- **Modify** `apps/desktop/src/main/agent/templates/plain/template.typ` — datetime-formatted header, no key labels.
- **Modify** `apps/desktop/src/main/agent/seed-content.ts` — Plain manifest: `date`→`date`, `recipient`→`text`.
- **Create** `apps/desktop/src/renderer/src/components/pdf/FieldWidget.tsx` — the widget registry.
- **Modify** `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx` — use shared types + `initialValue` + `FieldWidget`.

---

## Task 1: Shared field schema + `initialValue` resolver

The one source of truth for what a typed field is, plus the pure prefill resolver both the dialog and its tests use. Lives in `@holi/shared` so main (coercion) and renderer (widgets) agree on the shape.

**Files:**
- Create: `packages/shared/src/template-fields.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/template-fields.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/template-fields.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { initialValue, type TemplateField } from '../src/template-fields'

const f = (over: Partial<TemplateField>): TemplateField => ({
  key: 'k',
  label: 'K',
  type: 'text',
  required: false,
  ...over,
})
const TODAY = '2026-07-26'

describe('initialValue', () => {
  it('a date field with no default prefills to today', () => {
    expect(initialValue(f({ type: 'date' }), TODAY)).toBe(TODAY)
  })
  it('a date field with default "today" resolves the token', () => {
    expect(initialValue(f({ type: 'date', default: 'today' }), TODAY)).toBe(TODAY)
  })
  it('a date field with a literal default keeps the literal', () => {
    expect(initialValue(f({ type: 'date', default: '2020-01-01' }), TODAY)).toBe('2020-01-01')
  })
  it('a default of "" forces a blank prefill', () => {
    expect(initialValue(f({ type: 'date', default: '' }), TODAY)).toBe('')
  })
  it('a checkbox with no default starts unchecked ("false")', () => {
    expect(initialValue(f({ type: 'checkbox' }), TODAY)).toBe('false')
  })
  it('a checkbox default is honored', () => {
    expect(initialValue(f({ type: 'checkbox', default: 'true' }), TODAY)).toBe('true')
  })
  it('text/select/number without a default start blank', () => {
    expect(initialValue(f({ type: 'text' }), TODAY)).toBe('')
    expect(initialValue(f({ type: 'select' }), TODAY)).toBe('')
    expect(initialValue(f({ type: 'number' }), TODAY)).toBe('')
  })
  it('a literal default is used for a non-date field ("today" stays literal)', () => {
    expect(initialValue(f({ type: 'text', default: 'today' }), TODAY)).toBe('today')
    expect(initialValue(f({ type: 'text', default: 'Acme' }), TODAY)).toBe('Acme')
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd packages/shared && pnpm exec vitest run test/template-fields.test.ts`
Expected: FAIL — cannot resolve `../src/template-fields`.

- [ ] **Step 3: Implement**

Create `packages/shared/src/template-fields.ts`:

```ts
/** The data type a template metadata field declares. Drives the Convert-dialog
 * widget, the native Typst value the template receives, and how it is presented.
 * A curated, closed set — adding a seventh type is one entry per unit. */
export type TemplateFieldType = 'text' | 'textarea' | 'date' | 'select' | 'number' | 'checkbox'

/** A template's metadata field, as it travels from the manifest to the dialog.
 * `type` defaults to `text` when a manifest omits or misuses it (see
 * `normalizeFields`), so every legacy untyped field keeps working. */
export interface TemplateField {
  /** Identifier; becomes `meta.<key>` in the template. */
  key: string
  /** Shown beside the widget; defaults to `key`. */
  label: string
  type: TemplateFieldType
  required: boolean
  /** Initial widget value. `"today"` resolves to the current date for a `date`
   *  field; `""` forces a blank prefill; any other literal is used as-is. */
  default?: string
  /** Dropdown choices; only meaningful for `type: 'select'`. */
  options?: string[]
}

/**
 * The initial string value a widget shows before the user edits it. Every value
 * is a string (HTML controls are string-valued; a checkbox is `"true"`/`"false"`).
 * `today` (local `YYYY-MM-DD`) is passed in so the resolver stays pure and
 * deterministic under test.
 */
export function initialValue(field: TemplateField, today: string): string {
  if (field.default !== undefined) {
    return field.default === 'today' && field.type === 'date' ? today : field.default
  }
  if (field.type === 'date') return today
  if (field.type === 'checkbox') return 'false'
  return ''
}
```

Add the barrel export to `packages/shared/src/index.ts` (after the other `export *` lines):

```ts
export * from './template-fields'
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd packages/shared && pnpm exec vitest run test/template-fields.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add packages/shared/src/template-fields.ts packages/shared/src/index.ts packages/shared/test/template-fields.test.ts
git commit -m "feat(pdf): shared typed-field schema + initialValue resolver

Claude goes brr.. via Dash"
```

---

## Task 2: `normalizeFields` parses `type` / `default` / `options`

The manifest reader learns the typed schema. `TemplateField` now comes from `@holi/shared`; `normalizeFields` reads `type` (unknown/missing → `text`), `default`, and `options` (a `select` with no options degrades to `text` so one bad field can't break Convert).

**Files:**
- Modify: `apps/desktop/src/main/pdf/templates.ts`
- Modify: `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/pdf-templates.test.ts`

- [ ] **Step 1: Update the existing tests + add typed cases (write them failing)**

In `apps/desktop/test/pdf-templates.test.ts`, the existing `reads a template dir + manifest` and `normalizes fields` tests assert `fields` without `type`. Update those assertions to include `type: 'text'`:

- In `reads a template dir + manifest into a Template`, the field list is empty (`fields: []`) — no change needed there.
- In `normalizes fields and defaults label/required`, replace the expected array with:

```ts
    expect(t.fields).toEqual([
      { key: 'date', label: 'Date', type: 'text', required: true },
      { key: 'to', label: 'to', type: 'text', required: false },
    ])
```

Then add a new test after it:

```ts
  it('parses type, default and options; unknown/missing type falls back to text', async () => {
    const root = await vault()
    await seed(root, 'typed', {
      name: 'Typed',
      fields: [
        { key: 'when', label: 'When', type: 'date', default: 'today' },
        { key: 'status', label: 'Status', type: 'select', options: ['Draft', 'Final'] },
        { key: 'count', label: 'Count', type: 'number' },
        { key: 'weird', label: 'Weird', type: 'nonsense' },
        { key: 'plain', label: 'Plain' },
      ],
    })
    const [t] = await listTemplates(root)
    expect(t.fields).toEqual([
      { key: 'when', label: 'When', type: 'date', required: false, default: 'today' },
      { key: 'status', label: 'Status', type: 'select', required: false, options: ['Draft', 'Final'] },
      { key: 'count', label: 'Count', type: 'number', required: false },
      { key: 'weird', label: 'Weird', type: 'text', required: false },
      { key: 'plain', label: 'Plain', type: 'text', required: false },
    ])
  })

  it('a select with no usable options degrades to text', async () => {
    const root = await vault()
    await seed(root, 's', { name: 'S', fields: [{ key: 'x', type: 'select' }] })
    const [t] = await listTemplates(root)
    expect(t.fields).toEqual([{ key: 'x', label: 'x', type: 'text', required: false }])
  })
```

- [ ] **Step 2: Run them, verify they fail**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-templates.test.ts 2>&1 | tail -12`
Expected: FAIL — `fields` have no `type` yet (existing assertions mismatch, new ones can't find typed output).

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/pdf/templates.ts`, replace the top imports + the local `TemplateField` interface. Change the imports (lines 1-2) to add the shared type, and delete the local `TemplateField` interface (lines 4-8):

```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TemplateField, TemplateFieldType } from '@holi/shared'
```

(`Template` at line 10 keeps `fields: TemplateField[]` — now the shared type.)

Replace `normalizeFields` (lines 58-72) with:

```ts
const FIELD_TYPES: readonly TemplateFieldType[] = [
  'text',
  'textarea',
  'date',
  'select',
  'number',
  'checkbox',
]

function normalizeFields(raw: unknown): TemplateField[] {
  if (!Array.isArray(raw)) return []
  const out: TemplateField[] = []
  for (const f of raw) {
    if (typeof f !== 'object' || f === null) continue
    const g = f as Record<string, unknown>
    if (typeof g.key !== 'string') continue
    let type: TemplateFieldType =
      typeof g.type === 'string' && (FIELD_TYPES as readonly string[]).includes(g.type)
        ? (g.type as TemplateFieldType)
        : 'text'
    const options =
      Array.isArray(g.options) && g.options.every((o) => typeof o === 'string')
        ? (g.options as string[])
        : undefined
    // A select needs options to render a dropdown; without them, degrade to a
    // text input rather than shipping an empty, unusable select.
    if (type === 'select' && (options === undefined || options.length === 0)) type = 'text'
    out.push({
      key: g.key,
      label: typeof g.label === 'string' ? g.label : g.key,
      type,
      required: g.required === true,
      ...(typeof g.default === 'string' ? { default: g.default } : {}),
      ...(type === 'select' && options !== undefined ? { options } : {}),
    })
  }
  return out
}
```

In `apps/desktop/src/main/router.ts`, the `TemplateField` type must now come from `@holi/shared` (templates.ts no longer exports it). Change the pdf import (line ~46) back to value-only and add the shared type import beside the other `@holi/shared` imports:

```ts
import { listTemplates } from './pdf/templates'
```

Add to the existing `@holi/shared` import in `router.ts` (find the line importing from `'@holi/shared'` and add `TemplateField`), or add a new type import:

```ts
import type { TemplateField } from '@holi/shared'
```

(The `pdf.templates` procedure's `Promise<{ …; fields: TemplateField[] }[]>` annotation now resolves to the shared type — no other change there.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-templates.test.ts 2>&1 | tail -6` → Expected: PASS.
Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → Expected: `36`.

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/pdf/templates.ts apps/desktop/src/main/router.ts apps/desktop/test/pdf-templates.test.ts
git commit -m "feat(pdf): normalizeFields parses field type/default/options

Claude goes brr.. via Dash"
```

---

## Task 3: `coerceMeta` — the typed Typst dictionary

The engine turns raw string values into native Typst values per the field types. Replaces the all-strings `typstDict` inside `composeWrapper`, which now takes the template's `fields`.

**Files:**
- Modify: `apps/desktop/src/main/pdf/wrapper.ts`
- Test: `apps/desktop/test/pdf-wrapper.test.ts`

- [ ] **Step 1: Rewrite the test (write it failing)**

Replace `apps/desktop/test/pdf-wrapper.test.ts` entirely with:

```ts
import type { TemplateField } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import { coerceMeta, composeWrapper, typstString } from '../src/main/pdf/wrapper'

const f = (over: Partial<TemplateField>): TemplateField => ({
  key: 'k',
  label: 'K',
  type: 'text',
  required: false,
  ...over,
})

describe('typstString', () => {
  it('wraps in quotes and escapes backslashes and quotes', () => {
    expect(typstString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('coerceMeta', () => {
  it('renders no fields as the empty-dict literal (:)', () => {
    expect(coerceMeta([], {})).toBe('(:)')
  })
  it('text/textarea/select values become quoted strings', () => {
    const fields = [f({ key: 'to', type: 'text' }), f({ key: 's', type: 'select', options: ['A'] })]
    expect(coerceMeta(fields, { to: 'ACME', s: 'A' })).toBe('(to: "ACME", s: "A")')
  })
  it('a number value is an unquoted numeric literal', () => {
    expect(coerceMeta([f({ key: 'n', type: 'number' })], { n: '3' })).toBe('(n: 3)')
    expect(coerceMeta([f({ key: 'n', type: 'number' })], { n: '3.5' })).toBe('(n: 3.5)')
  })
  it('an invalid number throws', () => {
    expect(() => coerceMeta([f({ key: 'n', type: 'number' })], { n: 'x' })).toThrow(/number/)
  })
  it('a checkbox is always present as true/false, defaulting to false', () => {
    expect(coerceMeta([f({ key: 'b', type: 'checkbox' })], { b: 'true' })).toBe('(b: true)')
    expect(coerceMeta([f({ key: 'b', type: 'checkbox' })], { b: 'false' })).toBe('(b: false)')
    expect(coerceMeta([f({ key: 'b', type: 'checkbox' })], {})).toBe('(b: false)')
  })
  it('a date becomes a native datetime literal', () => {
    expect(coerceMeta([f({ key: 'd', type: 'date' })], { d: '2026-07-26' })).toBe(
      '(d: datetime(year: 2026, month: 7, day: 26))',
    )
  })
  it('an invalid date throws', () => {
    expect(() => coerceMeta([f({ key: 'd', type: 'date' })], { d: 'nope' })).toThrow(/date/)
  })
  it('blank optional values are omitted (checkbox excepted)', () => {
    const fields = [f({ key: 'to', type: 'text' }), f({ key: 'b', type: 'checkbox' })]
    expect(coerceMeta(fields, { to: '', b: 'false' })).toBe('(b: false)')
  })
})

describe('composeWrapper', () => {
  it('imports the template and calls doc with the coerced meta', () => {
    const out = composeWrapper({
      templateDir: '/v/.holi/templates/plain',
      notePath: '/v/notes/report.md',
      assetsDir: '/v/.holi/templates/plain/assets',
      fields: [f({ key: 'to', type: 'text' })],
      meta: { to: 'ACME' },
    })
    expect(out).toBe(
      '#import "/v/.holi/templates/plain/template.typ": doc\n' +
        '#doc("/v/notes/report.md", meta: (to: "ACME"), assets: "/v/.holi/templates/plain/assets")\n',
    )
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-wrapper.test.ts`
Expected: FAIL — `coerceMeta` is not exported and `composeWrapper` has no `fields`.

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/pdf/wrapper.ts`, add the shared import at the top, remove `typstDict` (lines 7-14), and add `coerceMeta`; then update `WrapperInput`/`composeWrapper`. The full new file:

```ts
import type { TemplateField, TemplateFieldType } from '@holi/shared'

/** Escape a JS string for a Typst double-quoted string literal. Backslash first,
 * then quote, so the escape characters themselves aren't re-escaped. */
export function typstString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * A Typst dictionary literal from a template's fields and the raw string values
 * the dialog collected, coercing each value to a native Typst value per the
 * field's type. A blank optional value is omitted (the template reads
 * `meta.at(key, default: none)`); a checkbox is always present. Empty → `(:)`.
 * Keys are assumed valid Typst identifiers — they are a template's declared keys.
 */
export function coerceMeta(fields: TemplateField[], values: Record<string, string>): string {
  const entries: string[] = []
  for (const f of fields) {
    if (f.type === 'checkbox') {
      entries.push(`${f.key}: ${values[f.key] === 'true' ? 'true' : 'false'}`)
      continue
    }
    const raw = values[f.key]
    if (raw === undefined || raw === '') continue // blank optional → omit
    entries.push(`${f.key}: ${coerceValue(f.type, raw)}`)
  }
  if (entries.length === 0) return '(:)'
  return `(${entries.join(', ')})`
}

function coerceValue(type: TemplateFieldType, raw: string): string {
  switch (type) {
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error(`invalid number for template field: ${raw}`)
      return String(n)
    }
    case 'date':
      return typstDatetime(raw)
    default:
      return typstString(raw)
  }
}

/** `YYYY-MM-DD` → a Typst `datetime(...)` literal. Throws on a malformed date so
 *  a hand-authored bad `default` surfaces as a clear error, not a typst crash. */
function typstDatetime(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (m === null) throw new Error(`invalid date for template field: ${raw}`)
  return `datetime(year: ${Number(m[1])}, month: ${Number(m[2])}, day: ${Number(m[3])})`
}

export interface WrapperInput {
  /** Absolute `.holi/templates/<name>/`. */
  templateDir: string
  /** Absolute path to the note being rendered. */
  notePath: string
  /** Absolute `<templateDir>/assets`. */
  assetsDir: string
  /** The template's declared fields — drives value coercion. */
  fields: TemplateField[]
  /** Raw string values from the dialog, keyed by field key. */
  meta: Record<string, string>
}

/**
 * The tiny Typst program the engine compiles in a temp dir: import the
 * template's `doc` function and call it. Every path is absolute, so
 * `typst compile … --root /` can read the note and template even though the
 * wrapper itself lives in an unrelated temp directory.
 */
export function composeWrapper({
  templateDir,
  notePath,
  assetsDir,
  fields,
  meta,
}: WrapperInput): string {
  return (
    `#import ${typstString(`${templateDir}/template.typ`)}: doc\n` +
    `#doc(${typstString(notePath)}, meta: ${coerceMeta(fields, meta)}, assets: ${typstString(assetsDir)})\n`
  )
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-wrapper.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/pdf/wrapper.ts apps/desktop/test/pdf-wrapper.test.ts
git commit -m "feat(pdf): coerceMeta — native Typst values from typed fields

Claude goes brr.. via Dash"
```

---

## Task 4: Thread `fields` through the engine + upgrade Plain's template

`renderPdf` and the `render` procedure carry the template's `fields` so coercion can run, and the Plain `template.typ` is rewritten to present a native `datetime` (no `Date:` label). The render integration test proves the real Plain template compiles typed metadata to a `%PDF`.

**Files:**
- Modify: `apps/desktop/src/main/pdf/render.ts`
- Modify: `apps/desktop/src/main/router.ts`
- Modify: `apps/desktop/src/main/agent/templates/plain/template.typ`
- Test: `apps/desktop/test/pdf-render.test.ts`
- Test: `apps/desktop/test/router.test.ts`

- [ ] **Step 1: Update `RenderInput` + `renderPdf`**

In `apps/desktop/src/main/pdf/render.ts`, add the shared import and a `fields` member, and pass it to `composeWrapper`. Change the import block (lines 1-6) to add:

```ts
import type { TemplateField } from '@holi/shared'
```

Add to `RenderInput` (after `outPath`):

```ts
  /** The template's declared fields — drives meta coercion in the wrapper. */
  fields: TemplateField[]
```

Update the destructure + the `composeWrapper` call inside `renderPdf`:

```ts
export async function renderPdf({
  typstBin,
  templateDir,
  notePath,
  outPath,
  fields,
  meta,
}: RenderInput): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'holi-typst-'))
  try {
    const wrapperPath = join(work, 'wrapper.typ')
    await writeFile(
      wrapperPath,
      composeWrapper({ templateDir, notePath, assetsDir: join(templateDir, 'assets'), fields, meta }),
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

- [ ] **Step 2: Pass `tpl.fields` from the `render` procedure**

In `apps/desktop/src/main/router.ts`, in the `pdf.render` mutation, add `fields` to the `renderPdf` call:

```ts
        await renderPdf({
          typstBin,
          templateDir: tpl.dir,
          notePath: noteAbs,
          outPath,
          fields: tpl.fields,
          meta: input.meta ?? {},
        })
```

- [ ] **Step 3: Rewrite Plain's `template.typ`**

Replace `apps/desktop/src/main/agent/templates/plain/template.typ` entirely with (verified to compile with full/partial/empty meta):

```typst
// Plain — a clean, unbranded document layout. The copy-to-customize starter
// every vault carries. It reads the markdown note, strips a leading YAML
// frontmatter block, and renders the body with cmarker (Typst reads markdown
// through this package). No bundled fonts — it rides Typst's defaults so it
// stays small. `assets` is accepted for a uniform template contract but unused
// here; `meta` carries the declared fields as native Typst values.
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

  // Metadata header: state each provided value cleanly, no key labels. `date`
  // arrives as a native datetime, formatted here; `recipient` is shown as-is.
  // Fields the user left blank are absent from `meta`, so nothing prints.
  let lines = ()
  let d = meta.at("date", default: none)
  if d != none { lines.push(d.display("[day] [month repr:long] [year]")) }
  let r = meta.at("recipient", default: none)
  if r != none and r != "" { lines.push(r) }
  if lines.len() > 0 {
    align(right, text(size: 9pt, fill: luma(40%), lines.join(linebreak())))
    v(1em)
  }

  cmarker.render(strip-frontmatter(read(notePath)))
}
```

- [ ] **Step 4: Update the render tests + add a native-values test**

In `apps/desktop/test/pdf-render.test.ts`:

The first test (`renders a real markdown note …`) calls `renderPdf({ …, meta: {} })` — add `fields: []`:

```ts
    await renderPdf({ typstBin: typst, templateDir, notePath, outPath, fields: [], meta: {} })
```

The second test (`renders declared metadata …`) now drives the real Plain with typed fields — replace its two `renderPdf` calls with:

```ts
    const fields = [
      { key: 'date', label: 'Date', type: 'date', required: false },
      { key: 'recipient', label: 'Recipient', type: 'text', required: false },
    ] as const
    await renderPdf({
      typstBin: typst,
      templateDir,
      notePath,
      outPath: emptyOut,
      fields: [...fields],
      meta: {},
    })
    await renderPdf({
      typstBin: typst,
      templateDir,
      notePath,
      outPath: metaOut,
      fields: [...fields],
      meta: { date: '2026-07-26', recipient: 'ACME Corp' },
    })
```

Add a new test after it (proves `number`/`checkbox`/`date` native values compile through an inline template):

```ts
  it('compiles native number/checkbox/date values through a template', async () => {
    const typst = await resolveTypstBin()
    if (typst === null) return

    const root = await work()
    const templateDir = join(root, '.holi/templates/t')
    await mkdir(templateDir, { recursive: true })
    await writeFile(
      join(templateDir, 'template.typ'),
      '#let doc(notePath, meta: (:), assets: "") = {\n' +
        '  [Count: #(meta.count + 1)]\n' +
        '  if meta.urgent [ #text(fill: red)[URGENT] ]\n' +
        '  [ On #meta.day.display() ]\n' +
        '}\n',
    )
    const notePath = join(root, 'n.md')
    await writeFile(notePath, '# n\n')
    const outPath = join(root, 'out.pdf')

    await renderPdf({
      typstBin: typst,
      templateDir,
      notePath,
      outPath,
      fields: [
        { key: 'count', label: 'Count', type: 'number', required: false },
        { key: 'urgent', label: 'Urgent', type: 'checkbox', required: false },
        { key: 'day', label: 'Day', type: 'date', required: false },
      ],
      meta: { count: '4', urgent: 'true', day: '2026-07-26' },
    })

    const bytes = await readFile(outPath)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 30_000)
```

In `apps/desktop/test/router.test.ts`, the `pdf` block's tests must reflect typed fields:

- In `templates returns each template with its declared fields`, the seeded `TEMPLATE_FILES` fields have no `type`, so the returned fields are now `text`. Update the expected array:

```ts
        fields: [
          { key: 'date', label: 'Date', type: 'text', required: false },
          { key: 'recipient', label: 'Recipient', type: 'text', required: true },
        ],
```

- In `render writes to the given outPath and threads meta through`, give the seeded manifest a typed `date` field so coercion emits a `datetime` the real Plain template renders:

```ts
      '.holi/templates/plain/template.json': JSON.stringify({
        name: 'Plain',
        fields: [{ key: 'date', label: 'Date', type: 'date', required: false }],
      }),
```

(Its `meta: { date: '2026-07-26', recipient: 'ACME' }` still works — `recipient` isn't a declared field so it is dropped by coercion; `date` renders.)

- [ ] **Step 5: Run the suites + typecheck**

Run: `cd apps/desktop && pnpm exec vitest run test/pdf-render.test.ts test/router.test.ts 2>&1 | tail -8` → Expected: PASS.
Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → Expected: `36`.

- [ ] **Step 6: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/pdf/render.ts apps/desktop/src/main/router.ts apps/desktop/src/main/agent/templates/plain/template.typ apps/desktop/test/pdf-render.test.ts apps/desktop/test/router.test.ts
git commit -m "feat(pdf): thread typed fields into render; Plain renders a native date

Claude goes brr.. via Dash"
```

---

## Task 5: Upgrade the seeded Plain manifest to typed fields

The manifest that fresh vaults get: `date` becomes a real `date` field (picker, prefilled today), `recipient` stays `text`. This is what makes the dialog show a date picker for Plain.

**Files:**
- Modify: `apps/desktop/src/main/agent/seed-content.ts`

- [ ] **Step 1: Type the manifest fields**

In `apps/desktop/src/main/agent/seed-content.ts`, update the `fields` array inside `PLAIN_MANIFEST`:

```ts
      fields: [
        { key: 'date', label: 'Date', type: 'date', required: false },
        { key: 'recipient', label: 'Recipient', type: 'text', required: false },
      ],
```

(The pinned seed test at `test/seed-content.test.ts` asserts the `SEED_FILES` key list only — unchanged. No test asserts the manifest body.)

- [ ] **Step 2: Run the seed suite**

Run: `cd apps/desktop && pnpm exec vitest run test/seed-content.test.ts 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/agent/seed-content.ts
git commit -m "feat(pdf): seed Plain with a typed date field (picker, prefilled today)

Claude goes brr.. via Dash"
```

---

## Task 6: Renderer widget registry + dialog

The dialog compiles each field to its widget. A small registry (`FieldWidget`) maps `type → control`; the dialog seeds each from `initialValue` and collects raw string values. CDP/manual-verified per repo norm.

**Files:**
- Create: `apps/desktop/src/renderer/src/components/pdf/FieldWidget.tsx`
- Modify: `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx`

- [ ] **Step 1: The widget registry**

Create `apps/desktop/src/renderer/src/components/pdf/FieldWidget.tsx`:

```tsx
import type { TemplateField } from '@holi/shared'

export interface WidgetProps {
  field: TemplateField
  value: string
  onChange: (value: string) => void
}

const control =
  'w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-100'

/**
 * The type → widget registry for the Convert dialog. Each control is string-valued
 * (a checkbox contributes "true"/"false"); the engine coerces to native Typst
 * values later. An unknown type can't occur (normalizeFields clamps to the six),
 * but the switch falls back to a text input for safety.
 */
export function FieldWidget({ field, value, onChange }: WidgetProps) {
  switch (field.type) {
    case 'textarea':
      return (
        <textarea
          data-convert-field={field.key}
          rows={4}
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'date':
      return (
        <input
          data-convert-field={field.key}
          type="date"
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
      return (
        <input
          data-convert-field={field.key}
          type="number"
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'select':
      return (
        <select
          data-convert-field={field.key}
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )
    case 'checkbox':
      return (
        <input
          data-convert-field={field.key}
          type="checkbox"
          className="h-4 w-4 accent-neutral-100"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
      )
    default:
      return (
        <input
          data-convert-field={field.key}
          className={control}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
```

- [ ] **Step 2: Rewrite the dialog to use the registry**

Replace `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx` entirely with:

```tsx
import { type TemplateField, initialValue } from '@holi/shared'
import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../lib/trpc'
import { FieldWidget } from './pdf/FieldWidget'

interface TemplateOption {
  name: string
  slug: string
  description: string
  fields: TemplateField[]
}

/**
 * Convert-to-PDF: pick a template, fill its typed metadata fields (each rendered
 * as the widget its declared type maps to — a date picker prefilled to today, a
 * dropdown, a checkbox, …), choose a destination via the native save dialog,
 * Convert. The render writes to the chosen path and is revealed in Finder. The
 * house modal pattern (fixed overlay + stop-propagation card), driven by the
 * caller's useState.
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

  const today = useMemo(() => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }, [])

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

  // Seed each field from its type/default whenever the chosen template changes,
  // so a date field lands on today and one template's values never leak to another.
  useEffect(() => {
    const tpl = templates?.find((t) => t.slug === slug) ?? null
    if (tpl === null) {
      setValues({})
      return
    }
    const seed: Record<string, string> = {}
    for (const f of tpl.fields) seed[f.key] = initialValue(f, today)
    setValues(seed)
  }, [slug, templates, today])

  const convert = async () => {
    if (selected === null) return
    const missing = selected.fields.filter(
      (f) => f.required && f.type !== 'checkbox' && (values[f.key] ?? '').trim() === '',
    )
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
      for (const f of selected.fields) meta[f.key] = values[f.key] ?? ''
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
            <label key={f.key} className="mb-3 flex flex-col gap-1">
              <span className="text-xs text-neutral-400">
                {f.label}
                {f.required && f.type !== 'checkbox' && <span className="text-red-400"> *</span>}
              </span>
              <FieldWidget
                field={f}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
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

- [ ] **Step 3: Typecheck + full desktop suite**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → Expected: `36`.
Run: `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -4` → Expected: **626** passed.

- [ ] **Step 4: Shared suite + build**

Run: `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3` → Expected: **179** passed.
Run: `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -5` → Expected: builds cleanly.

- [ ] **Step 5: Commit**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/components/pdf/FieldWidget.tsx apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx
git commit -m "feat(pdf): Convert dialog compiles each typed field to its widget

Claude goes brr.. via Dash"
```

---

## Task 7: Re-seed the two vaults + final verification

Install the typed Plain into the existing vaults (`SEED_FILES` is never-overwrite, so they keep the old untyped Plain otherwise) and run the full gate. Live verification needs a relaunch — ask the user.

**Files:** none (operational).

- [ ] **Step 1: Re-seed both vaults (scoped, path-safe)**

Overwrite only the two Plain files on disk; do not touch other pending vault changes.

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
SRC_TYP="apps/desktop/src/main/agent/templates/plain/template.typ"
pnpm --dir apps/desktop exec node -e 'const s=JSON.stringify({name:"Plain",description:"A clean, unbranded document layout.",fields:[{key:"date",label:"Date",type:"date",required:false},{key:"recipient",label:"Recipient",type:"text",required:false}]},null,2)+"\n";process.stdout.write(s)' > /tmp/plain-manifest.json
for v in ~/Holi/nthomsencph/a-demo-vault-3 ~/Holi/nthomsencph/another-vault-42; do
  cp "$SRC_TYP" "$v/.holi/templates/plain/template.typ"
  cp /tmp/plain-manifest.json "$v/.holi/templates/plain/template.json"
  echo "re-seeded: $v"
done
```

(If the running app or a vault has committed `.holi/templates/`, let the app's auto-sync carry the change, or commit only `.holi/templates/` path-scoped as in the prior vault-update — do NOT sweep unrelated pending changes. Ask the user before pushing.)

- [ ] **Step 2: Final gate**

```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"   # 36
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop && pnpm exec vitest run 2>&1 | tail -3                                                   # 626
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/packages/shared && pnpm exec vitest run 2>&1 | tail -3                                                # 179
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3                                          # builds
```

- [ ] **Step 3: Live verify (ask the user to relaunch — main changed)**

Shared, router, seed, and pdf modules changed, so the dev app needs a relaunch (CDP 9333). Then:
1. Right-click a markdown note → **Convert to PDF…** → Plain shows a **Date** field rendered as a date picker **prefilled to today**, and a **Recipient** text field.
2. Change the date / fill recipient → **Convert** → native save sheet → the PDF renders with the date shown as **"26 July 2026"** (formatted, no "Date:" label) top-right, recipient beneath; blank fields print nothing.
3. Optional: hand-author a template with `select`/`number`/`checkbox` fields under `.holi/templates/<name>/` and confirm each compiles to the right widget and renders.

Report what actually happened.

---

## Final verification

- [ ] Typecheck **36**
- [ ] Desktop **626**, Shared **179**
- [ ] Build clean
- [ ] Live (after relaunch): Plain → date picker prefilled today → PDF states the formatted date, not "Date: <raw>".

---

## Self-review (spec coverage)

- **Six field types → widgets** (spec §The six field types) → Task 6 `FieldWidget` (one control per type) + Task 2 `normalizeFields` (clamps `type` to the six).
- **Manifest schema** (`key/label/type/required/default/options`; unknown→text; select-without-options→text) → Task 2 `normalizeFields` + its tests.
- **Native typed values** (`number`/`checkbox`/`date`→datetime; blank omitted; checkbox always present) → Task 3 `coerceMeta` + Task 4 threading; verified end-to-end by the render integration tests.
- **Defaults / prefill** (type default + `default` override, `today` token) → Task 1 `initialValue` + Task 6 dialog seeding.
- **Presentation states the value** (no `Date:` label; `date` as a formatted `datetime`) → Task 4 Plain `template.typ` (`.display(...)`), verified to compile.
- **Shared source of truth** (`@holi/shared`) → Task 1; consumed by main (Tasks 2-4) and renderer (Task 6).
- **Backward compatibility** (no-`type` → text) → Task 2 (default) + the updated `pdf-templates`/`router` assertions.
- **Migration** (re-seed existing vaults) → Task 7 Step 1.
- **Deferred (correctly absent):** no template-builder UI; no widgets beyond the six; the agent in-vault front door is slice 4; no advanced per-type validation; `select` options are `string[]`.
```
