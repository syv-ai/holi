# Design: Typed template fields — data types that compile to widgets

**Status:** Approved direction (2026-07-26). Single implementation plan. Extends the Typst PDF export design (`docs/specs/2026-07-26-typst-pdf-export-design.md`, §Template model) and supersedes its untyped `fields` shape.

**Decision:** D62 (`docs/decisions.md`) — the vault is text-first; PDFs are outputs rendered from markdown via Typst. Templates are committed vault content.

## Summary

A template's metadata fields become **typed**. Each field declares a data `type` (one of six), and that type drives three things at once:

1. **The widget** the Convert dialog renders for it (a `date` field → a date picker prefilled to today, a `select` → a dropdown, a `checkbox` → a checkbox, …).
2. **The value** the Typst template receives — a native Typst value coerced from the type (a `number` arrives as `3`, a `checkbox` as `true`, a `date` as a `datetime`), not an untyped string.
3. **How the template presents it** — because the template gets real values (e.g. a `datetime`), it formats them itself. There is no Holi-injected `Date: <raw>` label; presentation is the template author's job.

Authoring is **manifest-driven**: the schema below is the system. The vault assistant (which already edits vault files) or a power user writes `template.json` + `template.typ`, and the dialog auto-compiles the right widgets from the declared types. No template-builder UI this round.

## The six field types

| `type` | Dialog widget | Typst value the template receives | blank / unset |
| --- | --- | --- | --- |
| `text` | single-line input | `"…"` string | key omitted |
| `textarea` | multi-line textarea | `"…"` string (may contain newlines) | key omitted |
| `date` | date picker, prefilled to today | `datetime(year: Y, month: M, day: D)` | key omitted |
| `select` | dropdown of `options` | `"…"` string (exactly one option) | key omitted |
| `number` | numeric input | `3` / `3.5` (unquoted) | key omitted |
| `checkbox` | checkbox | `true` / `false` | **always present** |

- A blank **optional** field is **omitted** from the meta dictionary. Templates read `meta.at("key", default: none)` and branch on presence.
- A `checkbox` is always present (`true` or `false`) — "unset" is not meaningful for a boolean.
- A `date` is a native Typst `datetime`, so the template renders it however it likes: `meta.date.display("[day] [month repr:long] [year]")` → `26 July 2026`. This is how "state the date, not `Date: <raw>`" is realized.

## Manifest schema

`template.json` keeps its `name` / `description`; each `fields[]` entry grows:

```json
{
  "key": "date",
  "label": "Date",
  "type": "date",
  "required": false,
  "default": "today",
  "options": ["Draft", "Final"]
}
```

- **`key`** (required, string) — the identifier; becomes `meta.<key>` in the template.
- **`label`** (optional, string) — shown beside the widget; defaults to `key`.
- **`type`** (optional, string) — one of the six above. **Missing or unknown → `text`.** This is what keeps every existing (untyped) manifest working unchanged.
- **`required`** (optional, boolean, default `false`) — an empty required field blocks Convert. `checkbox` is exempt (always has a value).
- **`default`** (optional, string) — initial widget value. Special token `"today"` resolves to the current local date for `date` fields; `""` forces a blank prefill; any other literal is used as-is.
- **`options`** (required for `select`, `string[]`) — the dropdown choices. Ignored for other types. A `select` with no/empty `options` degrades to a `text` widget rather than erroring.

## Architecture — three small units (Approach A: curated type registry)

The type knowledge is a closed, curated set of six, split across three focused units so each is understandable and testable on its own.

### Unit 1 — shared field schema (`@holi/shared`)

The `TemplateFieldType` union (`'text' | 'textarea' | 'date' | 'select' | 'number' | 'checkbox'`) and the `TemplateField` wire shape (`key`, `label`, `type`, `required`, `default?`, `options?`). One source of truth imported by both main and renderer, replacing the dialog's duplicated local `TemplateField` interface. Types only (no runtime logic), plus the pure `initialValue` resolver (below), which both the renderer prefill and its tests use.

- **`initialValue(field, today) → string`** — the default resolver. If `field.default` is set: `"today"` → `today` (for `date`), `""` → `""`, else the literal. Otherwise by type: `date` → `today`, `checkbox` → `"false"`, everything else → `""`. Pure; `today` (local `YYYY-MM-DD`) is passed in so it is deterministic under test.

### Unit 2 — renderer widget registry (`renderer/.../pdf/field-widgets.tsx`)

A `type → controlled-component` map. Each widget takes `{ field, value, onChange }` and renders the appropriate control (`<input type="date">`, `<select>`, `<textarea>`, `<input type="number">`, checkbox, text). Unknown/absent type falls back to the text widget. The Convert dialog iterates a template's `fields` and renders `widgetFor(field.type)` for each, seeded from `initialValue`. The dialog collects a `Record<string, string>` of raw values (HTML controls are string-valued; a checkbox contributes `"true"`/`"false"`).

### Unit 3 — engine coercion (`main/pdf/`, beside `wrapper.ts`)

**`coerceMeta(fields, rawValues) → string`** — turns the field definitions plus the submitted `Record<string,string>` into a Typst dictionary literal, emitting the native value per the type table:

- `text` / `textarea` / `select` → escaped Typst string literal.
- `number` → the numeric literal (parsed; non-numeric → throw).
- `checkbox` → `true` / `false`.
- `date` → `datetime(year: Y, month: M, day: D)` parsed from the `YYYY-MM-DD` value (invalid → throw).
- Blank optional values → the key is omitted. Empty dict → `(:)`.

`coerceMeta` replaces the current all-strings `typstDict` inside `composeWrapper`. Coercion runs in the **engine**, not the dialog, because the engine is the side that resolves the template and therefore knows each field's declared type. Invalid `number`/`date` values are only reachable via a hand-authored bad `default` (the widgets constrain live input); the throw surfaces as a clear error in the dialog.

## Data flow

1. Dialog opens → `pdf.templates` returns each template with its **typed** `fields` (main stops needing to strip anything; `normalizeFields` now parses `type/default/options`).
2. Dialog renders one widget per field via the registry, each seeded by `initialValue`.
3. Convert → `pdf.render({ remote, path, template, meta })` where `meta` is the raw `Record<string,string>` of widget values (unchanged transport).
4. The `render` procedure resolves the template (so it has the `fields`) and passes `fields` + `meta` into `renderPdf` → `composeWrapper`, which calls `coerceMeta(fields, meta)` to build the typed Typst dict.
5. `typst compile` runs; the template's `doc(notePath, meta: <typed dict>, assets: …)` receives native values and renders.

The only transport change is threading the resolved `fields` from the `render` procedure into `renderPdf`/`composeWrapper`; the renderer→main `meta` payload stays a string map.

## Presentation: the Plain template, upgraded

- **Manifest:** `date` → `type: "date"` (prefilled today via the type default); `recipient` → `type: "text"`.
- **`template.typ`:** the header is rewritten to **state values, no hardcoded key labels** — the formatted date (`meta.date.display("[day] [month repr:long] [year]")`) top-right, the recipient on its own line, each shown only when its key is present. Verified to compile against real typst (with values, with a subset, and empty) before landing in the plan.

## Testing

- **Pure/unit:**
  - `normalizeFields` (main) — parses `type`/`default`/`options`; unknown `type` → `text`; missing `type` → `text` (back-compat); `select` without `options` → `text`.
  - `coerceMeta` (main) — each type → the correct Typst literal; blank optional omitted; `checkbox` always present; invalid `number`/`date` → throws.
  - `initialValue` (shared) — `default` literal / `"today"` / `""`, and the per-type fallbacks.
- **tmpdir integration:** the render test gains a typed template (`date` + `number` + `checkbox`) that compiles to a `%PDF`.
- **Router:** `pdf.templates` returns typed fields; `pdf.render` threads `fields` into coercion (asserts a `%PDF` and honored `outPath`, extending the slice-2 tests).
- **Widgets + dialog:** CDP/manual per repo norm — the registry is a thin map over the unit-tested cores.

## Backward compatibility & migration

- Manifests without `type` render every field as `text` — nothing breaks.
- The seeded Plain manifest is upgraded to typed in this work.
- The two existing vaults (`a-demo-vault-3`, `another-vault-42`) currently carry an **untyped** date/recipient Plain (from the slice-2 update); they will render as text inputs until re-seeded. Closing step: re-run the same scoped, path-safe single-file update to install the typed Plain, so those vaults get the date picker.

## Non-goals / deferred (YAGNI)

- **No template-builder UI** — authoring is manifest files this round.
- **No custom/plugin widget types** beyond the six; adding a seventh later is one entry per unit.
- **Agent in-vault front door** (seeded `md-to-pdf` SKILL/AGENTS guidance so the assistant discovers the schema in-vault) is **slice 4** of the PDF export spec — this work delivers the mechanism plus a human-readable schema reference in `docs/` that slice 4 points to; it does not pre-build slice 4.
- **No advanced per-type validation** (regex, min/max, step) beyond `required` + parse-validity.
- **`select` options are a plain `string[]`** (no separate value/label) for v1.

## Supersedes

The untyped `{ key, label, required }` field shape introduced in the Typst PDF export slice 2. That shape is a strict subset of the typed schema (a field with `type: "text"`), so the change is additive.
