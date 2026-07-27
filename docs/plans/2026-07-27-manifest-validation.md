# Template manifest validation Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the silent template-manifest normalization into one that *reports* what it fixed. A pure `parseFields(raw) → { fields, warnings }` in `@holi/shared` supersedes the main-only `normalizeFields`, and the Convert-to-PDF dialog shows the warnings as an amber block — so a hand-authored `template.json` that Holi had to degrade tells the author *why*, instead of quietly rendering something they didn't intend.

**Architecture:** `normalizeFields` (in `apps/desktop/src/main/pdf/templates.ts`) already coerces a manifest into `TemplateField[]` — unknown `type` → text, `select` without `options` → text, missing `key` → dropped — but silently. Move that logic into `@holi/shared` beside `TemplateField`/`initialValue` as `parseFields`, returning the same fields **plus** a per-degradation warning list. `listTemplates` carries the warnings up through the `pdf.templates` tRPC query into the dialog. This is authoring feedback for the UI Convert flow — **agent-independent** (the agent reads `template.json` itself and writes typed `meta` directly; it never goes through this path).

**Tech Stack:** `@holi/shared` (pure TS, the natural home — it already owns `TemplateField`/`initialValue`), the PDF template loader (`pdf/templates.ts`), tRPC (`router.ts`), the `ConvertToPdfDialog` renderer, Vitest 4.

---

## Design decisions (settled, do not re-litigate)

- **Warn on genuine misuse, never on intentional legacy behavior.** An **absent** `type` → `text` is the deliberate "every legacy untyped field keeps working" path (see `TemplateField`'s doc comment) and must **not** warn. A `type` that is **present but not one of the six** *does* warn. This distinction is the whole point — don't turn the legacy-friendly default into noise.
- **Degrade *and* report, don't reject.** `parseFields` keeps producing usable fields (a bad template must never break Convert — `listTemplates` already skips unparseable manifests); the warnings are advisory. Same resilience, now visible.
- **`parseFields` lives in `@holi/shared`.** It is a pure function over already-parsed JSON, and it sits beside `TemplateField`/`initialValue`/`TemplateFieldType`. `pdf/templates.ts` keeps the disk I/O (`readdir`/`readFile`/`JSON.parse`) and delegates the shape work.
- **A bad `date` default is stripped, not kept.** A `date` field whose `default` is neither `"today"`, `""`, nor a valid `YYYY-MM-DD` would otherwise reach `typstDatetime` at render and throw. Drop the bad default (so `initialValue` falls back to today) and warn — consistent with the "degrade" philosophy.
- **Warnings are human-readable strings, keyed to the field.** They render verbatim in the dialog; keep them short and specific.

## Known limitations (state them, don't hide them)

- **Warnings surface only in the UI Convert dialog.** The agent path doesn't use `parseFields` (it authors `meta` from the raw manifest). That's intended — this is authoring feedback for the dialog, not a vault-wide linter.
- **Per-manifest, not cross-template.** `parseFields` validates one manifest's `fields` array; it does not check for duplicate slugs or cross-template concerns (out of scope).

---

## Conventions (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. Shared commands from `packages/shared/`; desktop from `apps/desktop/`. **Absolute `cd` every Bash call** — cwd drifts (it bit `tsc`/`electron-vite build`, which resolve only from `apps/desktop`).
- **Typecheck gate (desktop):** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline **6**. Must not rise. If it prints `0`, tsc ran from the wrong dir — re-run with the explicit `cd`.
- **Test baselines:** shared **179**, desktop **638**. Confirm at start.
- **Build:** `cd apps/desktop && pnpm exec electron-vite build`.
- **Commit trailer:** end every commit message with `Claude goes brr.. via Dash`.

## File Structure

- **Modify** `packages/shared/src/template-fields.ts` — add `parseFields(raw) → { fields, warnings }` (the `FIELD_TYPES` list moves here too).
- **Modify** `packages/shared/test/template-fields.test.ts` — the full warning/no-warning matrix.
- **Modify** `apps/desktop/src/main/pdf/templates.ts` — delete local `normalizeFields`/`FIELD_TYPES`; use `parseFields`; add `warnings: string[]` to `Template`.
- **Modify** `apps/desktop/test/pdf-templates.test.ts` — `listTemplates` surfaces a manifest's warnings.
- **Modify** `apps/desktop/src/main/router.ts` — include `warnings` in the `pdf.templates` output shape (`:869-885`).
- **Modify** `apps/desktop/src/renderer/src/components/ConvertToPdfDialog.tsx` — `TemplateOption.warnings`; render an amber block when the selected template has warnings.

### Shared contract (define once)

```ts
// @holi/shared (template-fields.ts)
export interface ParsedFields {
  fields: TemplateField[]
  /** One short, human-readable line per degradation. Empty = a clean manifest. */
  warnings: string[]
}
export function parseFields(raw: unknown): ParsedFields
```

**Warning messages (exact, keyed by field):**
- non-object entry at index `i` → `` `field #${i} is not an object and was ignored` ``
- missing/invalid `key` at index `i` → `` `field #${i} has no "key" and was ignored` ``
- `type` present but invalid → `` `field "${key}": unknown type "${badType}", using text` ``
- `select` with no usable `options` → `` `field "${key}": select has no options, using text` ``
- bad `date` default → `` `field "${key}": default "${bad}" is not a valid date (use YYYY-MM-DD or "today"), ignoring it` ``

(An **absent** `type` produces a `text` field and **no** warning.)

---

## Task 1: `parseFields` in `@holi/shared`

**Files:** Modify `packages/shared/src/template-fields.ts`, `packages/shared/test/template-fields.test.ts`.

- [ ] **Step 1: Write the failing tests** (pure — this is the bulk of the work). In `template-fields.test.ts`, a `describe('parseFields', …)`. Test-intent:
  - **Clean manifest, no warnings:** a valid mix (text, a `select` with options, a `date` with `default: "today"`, a `checkbox`) → `warnings` is `[]` and `fields` matches.
  - **Absent `type` → text, NO warning:** `{ key: 'a' }` → one `text` field, `warnings` empty (the legacy path).
  - **Present-but-invalid `type` → text + warning:** `{ key: 'a', type: 'colour' }` → `text` field and a warning containing `a` and `colour`.
  - **`select` without options → text + warning:** `{ key: 'a', type: 'select' }` and `{ …, options: [] }` both degrade to `text` with a warning.
  - **Missing/invalid key → dropped + warning:** `{ type: 'text' }` and `{ key: 5 }` are not in `fields` and each adds a warning naming its index.
  - **Non-object entry → dropped + warning:** `null`, `'x'`, `42` in the array each warn and are skipped.
  - **Bad `date` default → stripped + warning:** `{ key: 'd', type: 'date', default: '2026-13-40' }` → the field has **no** `default` and a warning; `{ …, default: 'today' }` and `{ …, default: '2026-07-27' }` and `{ …, default: '' }` produce **no** warning and keep their default.
  - **`raw` not an array:** `parseFields(null)`/`parseFields('x')` → `{ fields: [], warnings: [] }`.
- [ ] **Step 2: Run, verify fail** — `cd packages/shared && pnpm exec vitest run test/template-fields.test.ts`.
- [ ] **Step 3: Implement `parseFields`.** Port `normalizeFields`' body (from `pdf/templates.ts`) into `template-fields.ts`, moving `FIELD_TYPES` here, and push a warning at each degradation per the message table. Date-default validity: `default === 'today' || default === '' || /^\d{4}-\d{2}-\d{2}$/.test(default)` **and** the matched date is real (reuse a `YYYY-MM-DD` check that rejects `2026-13-40` — a regex plus a `new Date`/range check, or mirror `wrapper.ts`'s `typstDatetime` validation). Only `date` fields validate `default`; other types keep any string default untouched.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Typecheck (shared)** — `cd packages/shared && pnpm exec tsc --noEmit` (or the repo's shared typecheck script) → clean.
- [ ] **Step 6: Commit** — `feat(shared): parseFields validates a template manifest, returning warnings`.

---

## Task 2: Supersede `normalizeFields` in main, carry warnings through tRPC

**Files:** Modify `pdf/templates.ts`, `router.ts`, `test/pdf-templates.test.ts`.

- [ ] **Step 1: Failing test.** In `pdf-templates.test.ts`, add: a template dir whose `template.json` has a misused field (e.g. a `select` with no `options`) → `listTemplates` returns that template with a non-empty `warnings` naming the field, and its `fields` still degraded correctly. (Reuse the file-writing helpers already in that test.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.**
  - `pdf/templates.ts`: `import { parseFields } from '@holi/shared'`; delete the local `normalizeFields` and `FIELD_TYPES`; add `warnings: string[]` to the `Template` interface; in `listTemplates`, `const { fields, warnings } = parseFields(m.fields)` and set both on the pushed template.
  - `router.ts` (`pdf.templates`, `:869-885`): add `warnings` to the return type and the mapped object (`{ name, slug, description, fields, warnings }`).
- [ ] **Step 4: Run, verify pass** — `cd apps/desktop && pnpm exec vitest run test/pdf-templates.test.ts`.
- [ ] **Step 5: Typecheck (desktop)** → 6.
- [ ] **Step 6: Commit** — `feat(pdf): listTemplates surfaces manifest warnings (supersedes normalizeFields)`.

---

## Task 3: The amber warnings block in the Convert dialog

**Files:** Modify `ConvertToPdfDialog.tsx`.

- [ ] **Step 1: Add `warnings` to the option type + render the block.**
  - Extend the dialog's `TemplateOption` type (`:8-11`) with `warnings: string[]` (the query now returns it — Task 2).
  - Where the selected template's fields render (`:147`, `selected.fields.map(...)`), add — above the fields — an amber block shown only when `selected.warnings.length > 0`: a small container listing each warning (mirror the file's existing muted/error text styling; e.g. `border-amber-900/60 bg-amber-950/40 text-amber-100 text-xs`, one line per warning). Header like "This template's manifest had issues (using safe defaults):".
- [ ] **Step 2: Typecheck** → 6. (Renderer behaviour is CDP/manual per repo norm; the logic under test — `parseFields` — is fully covered in Task 1.)
- [ ] **Step 3: Commit** — `feat(pdf): show template manifest warnings in the Convert dialog`.

---

## Task 4: Full gates + verification

**Files:** none.

- [ ] **Step 1: Shared suite** — `cd packages/shared && pnpm exec vitest run 2>&1 | tail -3` (~188; the `parseFields` matrix. Confirm 179 + new).
- [ ] **Step 2: Desktop suite** — `cd apps/desktop && pnpm exec vitest run 2>&1 | tail -6` (~639; confirm, no unexpected failures).
- [ ] **Step 3: Typecheck (desktop)** → 6.
- [ ] **Step 4: Build** — `cd apps/desktop && pnpm exec electron-vite build 2>&1 | tail -3` → clean.
- [ ] **Step 5 (optional live):** hand-author a broken `.holi/templates/<slug>/template.json` (e.g. a `select` with no `options`, a `date` with `default: "2026-13-40"`) in a test vault, open Convert to PDF, pick that template → the amber block lists the warnings and the fields still render with safe defaults.

---

## Final verification

- [ ] Shared suite green (confirm count); desktop suite green; typecheck **6**; build clean.
- [ ] A misused manifest degrades exactly as before **and** the dialog names each fix in an amber block; a clean manifest shows nothing.

## Self-review (spec coverage)

- **Pure `parseFields(raw) → {fields, warnings}` in `@holi/shared`, superseding main-only `normalizeFields`** → Tasks 1–2.
- **Warn on: unknown `type` → text; `select` without `options` → text; missing `key`; bad `date` default** → Task 1's message table (+ the deliberate no-warn on an *absent* type).
- **Warnings surfaced in `ConvertToPdfDialog` as an amber block** → Task 3.
- **Agent-independent** → stated; the agent path never calls `parseFields`.
- **Resilience preserved** → `parseFields` still degrades rather than rejects; `listTemplates` still skips wholly-unparseable manifests.
