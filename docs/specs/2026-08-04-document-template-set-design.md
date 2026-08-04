# Branded Typst document-template set — design

**Date:** 2026-08-04
**Implements:** `docs/prd/_phase2-typst-export.md` (the "set of branded syv.ai templates" goal).
**Builds on:** D66 (`.holi/document-templates/` convention), the shipped md→PDF pipeline
(`main/pdf/*`, the `md-to-pdf` vault skill, `ConvertToPdf.tsx`).
**Status:** approved, ready for planning.

## Goal

Grow the vault's document templates past the seeded, unbranded `plain` to a **branded syv.ai
set**, ported from the production Typst pipeline in the private `1brain` repo
(`.claude/skills/md-to-pdf/`). First set: **`proposal`** (the tilbud template) and a fresh
**`report`** variant, both on a shared brand foundation.

## Decisions (resolved in brainstorming)

1. **Port from 1brain, fixed syv brand.** The brand (Raleway, logo, palette) is identical in
   every vault — a syv proposal looks like a syv proposal everywhere. Not driven by the D64
   per-vault theme tokens (those theme the *app*, not the document).
2. **First spec = brand foundation + starter set** (`proposal` + `report`). Metadata pre-fill
   and wiki-link fidelity are explicit follow-on specs (see Non-goals).
3. **Brand foundation is seeded into each vault** under `.holi/document-templates/_brand/`, so a
   cloned vault is self-contained and renders identically without depending on the app bundle.
4. **`proposal` ports signatures + diagrams** (`@@SIG@@` + `@@FIG@@`).
5. **`report` is a fresh variant** distinguished by a cover page, a TOC, and a running header.

## What 1brain gives us (source of the port)

`1brain/.claude/skills/md-to-pdf/`:
- `assets/syvai-tilbud.typ` — one template serving tilbud + kontrakt. Brand baked in: Raleway,
  justified 10.5pt body, H1=28pt title, H2=auto-numbered sections, H3=13pt, styled tables, logo
  top-left + date top-right header, page-number footer. Colors: `ink #111111`, `muted #555555`,
  `rule-grey #595959`, `link-blue #1155CC`, table tones `#EFEEEA` / `#F7F6F3` / `#DBDBDB`.
  Signature helper (`underskrifter`) and the `@@FIG@@`/`@@SIG@@` **token-split render loop already
  live inside the `.typ`** (not the Python layer), so they port directly.
- `assets/syvai-figurer.typ` — `agent-flow`, `custom-arkitektur` diagrams.
- `assets/fonts/Raleway-{regular,bold,italic,boldItalic}.ttf` (OFL — free to redistribute/commit).
- `assets/syvai_logo.png`.
- `scripts/render.py` — a Python preprocessor doing three md transforms before Typst: strip
  frontmatter, strip manual heading numbers, and indent contract-clause lines (`5.1 …`) as
  blockquotes. **Holi has no Python layer** — see the porting gaps below.

## Architecture

### Vault layout (all seeded)

```
.holi/document-templates/
  _brand/                    ← shared foundation; no manifest, so listTemplates skips it
    brand.typ                ← palette, Raleway text setup, heading/list/table styles,
                                 signature helpers, and render-body(md-file, figures)
    figures.typ              ← agent-flow, custom-arkitektur (from syvai-figurer.typ)
    fonts/Raleway-{regular,bold,italic,boldItalic}.ttf
    logo.png
  plain/                     ← unchanged; stays standalone/unbranded
  proposal/  { template.typ, template.json }
  report/    { template.typ, template.json }
```

### `brand.typ` — the shared module

Holds the reusable guts refactored out of `syvai-tilbud.typ`:
- the colour constants and `set text(font: "Raleway", …)`, paragraph/list styling;
- the heading show-rules (H1 title / H2 numbered section / H3 subheading);
- the table show-rules (grey header bar, tinted label column, hairline rows);
- the signature helpers `sig-felt` / `underskrifter`;
- **`render-body(md-file, figures)`** — the source pipeline, in this order (order matters):
  1. **strip a leading YAML frontmatter block** (as `plain.typ`'s `strip-frontmatter` does) —
     **before** the hr-strip below, because the frontmatter delimiters are `---` lines that the
     hr regex would otherwise eat, leaking the YAML as body text. In 1brain the Python layer did
     this pre-Typst; here there is no Python layer, so `render-body` owns it;
  2. strip `---` horizontal rules (`^[-*_]{3,}$`);
  3. strip manual heading numbers (`^(#{2,3}) \d+…` → `\1`, ported from `render.py`);
  4. the `@@FIG:name@@` / `@@SIG:a|b@@` token-split loop that renders md chunks with `cmarker`
     (0.1.6, same as `plain`) and inserts diagrams / signature columns between them.

Each `template.typ` imports it by **relative path**: `#import "../_brand/brand.typ": …` and
`#import "../_brand/figures.typ": …`. Typst resolves relative imports; the wrapper already
compiles under absolute `--root /`, so **no brand-path injection is needed** — the payoff of
seeding in-vault. `plain` does **not** import `_brand` (it stays unbranded on Typst defaults).

### `proposal/`

`template.typ` exports `doc(notePath, meta, assets)`:
- `set page(paper: "a4", margin: …, header: logo (from `assets`) + `meta.date`, footer: page no.)`;
- imports `brand.typ` + `figures.typ`, applies the brand setup;
- renders via `render-body(notePath, figures: (agent-flow: …, custom-arkitektur: …))` with the
  `@@SIG@@`/`@@FIG@@` tokens live.

`template.json`: `{ name: "Proposal", description: …, fields: [ { key: "date", label: "Date",
type: "date", required: false } ] }`. The note's H1 is the document title.

### `report/`

A distinct long-form layout on the same brand — **not** a tilbud clone:
- a **cover/title page**: `meta.title` (falls back to the note H1), optional `meta.subtitle`,
  `meta.date`, on a page of their own before the body;
- an **`outline()` table of contents** after the cover;
- a **running header** (logo + document title) and page-number footer on body pages;
- body via `render-body(notePath, figures: (:))` — no signature tokens.

`template.json`: `{ name: "Report", description: …, fields: [ { key: "title", type: "text",
required: false }, { key: "subtitle", type: "text", required: false }, { key: "date", type:
"date", required: false } ] }`.

### Pipeline changes (`main/pdf`)

1. **`render.ts` gains `--font-path`.** After composing the wrapper, add
   `--font-path <fontsDir>` to the `typst compile` args where
   `fontsDir = join(templateDir, '..', '_brand', 'fonts')`, **guarded to only add it when that
   directory exists** (via `existsSync`) — so `plain` and vaults not yet re-seeded still render on
   Typst defaults. This is the "Fonts (`--font-path`) are a later concern" note in `render.ts`
   coming due. `wrapper.ts`/`composeWrapper` are unchanged (logo already flows through `assets`).

2. **Binary seeding.** `SEED_FILES` in `seed-content.ts` is `Record<string,string>` (text). The
   text files — `_brand/brand.typ`, `_brand/figures.typ`, `proposal/template.{typ,json}`,
   `report/template.{typ,json}` — join `SEED_FILES` via `?raw` imports (like `plainTemplateTyp`).
   The **binaries** (4 TTFs + `logo.png`) need a new seed step: ship them as app resources and
   copy each into `_brand/` on vault open **if absent** (never overwrite a member's edit, matching
   the existing seed rule). `resolveTypstBin` is the precedent for shipping a binary resource; the
   plan resolves the exact electron-vite/resources mechanism.

### `listTemplates` (`main/pdf/templates.ts`)

Already skips `_brand` (it lists only subdirs with a readable `template.json`). Add an explicit
skip of `_`-prefixed directory names for clarity, so a future underscore-folder can't accidentally
surface in the picker.

## Data flow (unchanged contract)

`ConvertToPdf.tsx` → `pdf.templates` lists `plain`, `proposal`, `report` (not `_brand`) → user
picks one, fills its manifest fields → `pdf.render` → `renderPdf` composes the wrapper, adds
`--font-path` when `_brand/fonts` exists, shells out to the bundled `$TYPST_BIN`, returns the PDF
path outside the vault. The agent path (`md-to-pdf` SKILL) is unaffected beyond the new templates
appearing under `ls .holi/document-templates/`.

## Testing

Mirror the existing patterns (`pdf-templates.test.ts`, `pdf-render.test.ts`, `seed-content.test.ts`):
- **node, no typst** — `listTemplates` skips `_brand` and surfaces `proposal` + `report` with their
  manifest names/fields; the binary seed step writes the 4 fonts + logo into a temp vault's
  `_brand/` and is a no-op when they already exist.
- **node, real compile (skip-if-no-typst, `resolveTypstBin() === null` → return)** — build a temp
  vault with `_brand/` (copy the seeded `brand.typ`/`figures.typ` + the font files from the source
  dir) plus `proposal/` and `report/`, render a sample note through each, assert the output starts
  with `%PDF-`. This exercises the relative `_brand` import, the `--font-path` wiring, and both
  layouts. A proposal note containing `@@SIG:syv.ai ApS|ACME@@` and `@@FIG:agent-flow@@` proves the
  token pipeline compiles.

## Non-goals (explicit follow-on specs / deferrals)

- **Metadata frontmatter pre-fill** — decided model (frontmatter pre-fills the Convert dialog,
  user overrides) but its own later spec; today the dialog remains the field source.
- **Wiki-link / task-embed conversion fidelity** in md→Typst — later spec.
- **Kontrakt clause-indentation** (`indryk_klausuler`) — contract-specific; deferred with the
  kontrakt document type.
- **Letter, memo** document types — later additions to the set.

## Known limitations (not blockers)

- The `@@FIG@@` diagrams (`agent-flow`, `custom-arkitektur`) are syv-specific; they port as-is and
  are only meaningful for syv's own proposals — acceptable for a fixed-brand syv set.
- Seeded fonts add ~1–1.5 MB to each vault (committed, synced). Well under the D62 10 MB
  hold-back; the cost buys vault self-containment.

## Seams (reference)

- Source of the port: `~/syv-ai/1brain/.claude/skills/md-to-pdf/assets/{syvai-tilbud.typ,
  syvai-figurer.typ,fonts/*,syvai_logo.png}`.
- New seed source: `apps/desktop/src/main/agent/templates/{_brand/*,proposal/*,report/*}`.
- `apps/desktop/src/main/pdf/render.ts` — add `--font-path`.
- `apps/desktop/src/main/pdf/templates.ts` — `_`-prefix skip.
- `apps/desktop/src/main/agent/seed-content.ts` — text seeds + new binary seed step.
- Tests: `apps/desktop/test/{pdf-templates,pdf-render,seed-content}.test.ts`.
