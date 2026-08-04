# Convert-to-PDF: pre-fill fields from note frontmatter — design

**Date:** 2026-08-04
**Follows:** `docs/specs/2026-08-04-document-template-set-design.md` (deferred metadata model).
**Decided model (brainstorm Q3):** frontmatter pre-fills the Convert dialog; the user overrides.
**Status:** approved (model pre-approved), lean spec.

## Problem

Convert-to-PDF seeds each template field from its type default only (`initialValue`, e.g. a date
field → today). A note that already declares `date`, `title`, `recipient` in its YAML frontmatter
does not pre-fill those fields, so the user retypes what the note already knows.

## Design

Client-side, reusing `@holi/shared` — no router change, no new tRPC.

Two pure helpers in `apps/desktop/src/renderer/src/lib/pdf-fields.ts` (node-tested in
`apps/desktop/test/pdf-fields.test.ts`, matching the existing pure-logic pattern):

- **`parseFrontmatter(text: string): Record<string, unknown>`** — `splitFrontmatter` (shared) +
  `parse` (yaml). Returns `{}` when there is no frontmatter, the YAML is invalid, or it is not a
  map (never throws — a broken note must not break Convert).
- **`prefillValues(fields, frontmatter, today): Record<string, string>`** — the seed map. For each
  field: if `frontmatter[field.key]` is present and coercible, use it; otherwise
  `initialValue(f, today)` (unchanged fallback). **Exact key match only** (predictable; documented;
  users are developers). Coercion is by field type:
  - `date` → a JS `Date` formats to `YYYY-MM-DD`; a string is used as-is.
  - `checkbox` → a boolean becomes `'true'`/`'false'`; the strings `'true'`/`'false'` pass through.
  - `number` → a finite number or numeric string becomes its `String`.
  - `text` / `textarea` / `select` → a string/number/boolean becomes its `String`.
  - Arrays, objects, `null`, and type-mismatched values are ignored → the field keeps its default.

`ConvertToPdf.tsx`: fetch the note once on open via the existing `trpc.notes.read.query({remote,
path})`, `parseFrontmatter` it into a `frontmatter` state (default `{}`), and change the seed
effect to `setValues(prefillValues(tpl.fields, frontmatter, today))`. The effect depends on
`[slug, templates, today, frontmatter]`. Everything else (widgets, override, validation, render)
is unchanged — the user still edits any pre-filled value before Convert.

## Testing

- **node** (`test/pdf-fields.test.ts`): `parseFrontmatter` — none/invalid/non-map → `{}`, a valid
  map parsed; `prefillValues` — exact-key overlay per type (date Date→ISO, checkbox bool→string,
  number, text), fallback to `initialValue` when a key is absent or the value is an
  array/object/mismatch, and one template's frontmatter never leaks to a field it doesn't declare.

## Non-goals

- Alias/fuzzy key mapping (only exact `field.key` matches).
- Writing values back into the note's frontmatter.
- Any change to the render pipeline or template contracts.
