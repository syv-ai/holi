# Branded document-template set — Implementation Plan

> **For agentic workers:** Use the executing-plans skill. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Port syv.ai's 1brain Typst pipeline into `.holi/document-templates/` as a seeded `_brand`
foundation plus `proposal` and `report` templates, with `--font-path` rendering and base64 binary
seeding.

**Spec:** `docs/specs/2026-08-04-document-template-set-design.md`. Lean plan per house style
(contracts + gotchas; Typst authored during implementation, verified by the compile smoke).

**Verification loop** (from `apps/desktop`; re-`cd` after any `git commit`, cwd drifts):
typecheck `pnpm exec node node_modules/typescript/bin/tsc --noEmit`; node `pnpm exec vitest run --project node <file>`;
dom `pnpm exec vitest run --project dom`; shared (from `packages/shared`) `pnpm exec vitest run`.

**Source of the port:** `~/syv-ai/1brain/.claude/skills/md-to-pdf/assets/` — `syvai-tilbud.typ`,
`syvai-figurer.typ`, `fonts/Raleway-*.ttf`, `syvai_logo.png`.

---

### Task 1 — Brand foundation assets + base64 generator

**Files:** create `src/main/agent/templates/_brand/{brand.typ, figures.typ, fonts/Raleway-*.ttf,
logo.png}`, `scripts/gen-brand-assets.mjs`, generated `_brand/binary-assets.generated.ts`.

- [ ] Copy the 4 Raleway TTFs + `syvai_logo.png`→`logo.png` from 1brain into `_brand/` (+`fonts/`).
- [ ] Port `syvai-figurer.typ`→`_brand/figures.typ` verbatim (keep `agent-flow`, `custom-arkitektur`).
- [ ] Author `_brand/brand.typ` — refactor the reusable guts of `syvai-tilbud.typ`:
  - palette consts (`ink #111111`, `muted #555555`, `rule-grey #595959`, `link-blue #1155CC`,
    `accent #EFEEEA`, `accent-tint #F7F6F3`, `col-sep #DBDBDB`);
  - `body-setup()` — the `set text(font:"Raleway",…)`/par/list rules + heading show-rules
    (H1 title / H2 numbered / H3) + table show-rules + `show link`;
  - `sig-felt`, `underskrifter`;
  - **`render-body(md-file, figures)`** — ordered pipeline: (1) strip leading YAML frontmatter,
    (2) strip `---` hr rules, (3) strip manual heading numbers `^(#{2,3}) \d+…`→`\1`,
    (4) `@@FIG@@`/`@@SIG@@` token-split rendering md chunks with `cmarker:0.1.6`.
  - Export `body-setup`, `render-body`, `underskrifter`, the palette.
- [ ] `scripts/gen-brand-assets.mjs`: read the raw binaries, write `_brand/binary-assets.generated.ts`
  exporting `export const BRAND_BINARIES: Record<string,string>` keyed by vault-relative path
  (`_brand/fonts/Raleway-regular.ttf` … `_brand/logo.png`) → base64. Run it.
- [ ] **Gotcha:** the generated file is main-process (not eslint-gated) — fine. Add a
  `// @generated` header. Typecheck must pass with the big string literal.

**Verify:** `pnpm exec node node_modules/typescript/bin/tsc --noEmit` → 0. Commit.

---

### Task 2 — `proposal` and `report` templates

**Files:** create `src/main/agent/templates/{proposal,report}/template.{typ,json}`.

- [ ] `proposal/template.typ` — `doc(notePath, meta: (:), assets: "")`:
  `#import "../_brand/brand.typ": *` + `#import "../_brand/figures.typ": *`; `set page` (a4,
  margins, header = `image(assets+"/../_brand/logo.png"…)` **left** + `meta.date` **right**,
  footer = page number); `body-setup()`; `render-body(notePath, figures: (agent-flow:…,
  custom-arkitektur:…))`. **Gotcha:** logo lives in `_brand/`, not the template's own `assets/`;
  reference it by relative path from the template dir (`assets` points at `proposal/assets`, so use
  a `_brand`-relative image path, mirroring the brand import).
- [ ] `proposal/template.json` — `{ name:"Proposal", description:…, fields:[{key:"date",
  label:"Date", type:"date", required:false}] }`.
- [ ] `report/template.typ` — `doc(...)`: import brand only; a cover/title page (`meta.title`
  else note H1, `meta.subtitle`, `meta.date`); `outline()` TOC; running header (logo + title) +
  page footer; `body-setup()`; `render-body(notePath, figures: (:))`.
- [ ] `report/template.json` — `{ name:"Report", description:…, fields:[{key:"title",type:"text"},
  {key:"subtitle",type:"text"},{key:"date",type:"date"}], all required:false }`.

**Verify:** typecheck (no code change, sanity). Templates are exercised in Task 6. Commit.

---

### Task 3 — `render.ts` gains `--font-path` (TDD)

**Files:** modify `src/main/pdf/render.ts`; test `test/pdf-render.test.ts` (or a new small unit).

- [ ] **Red:** add a pure helper `fontPathArgs(templateDir): string[]` → `['--font-path', dir]`
  when `join(templateDir,'..','_brand','fonts')` exists (sync), else `[]`. Unit-test it: temp dir
  with/without the sibling `_brand/fonts`.
- [ ] **Green:** implement `fontPathArgs`; splice its result into the `typst compile` args in
  `renderPdf` (`['compile', wrapperPath, outPath, '--root', '/', ...fontPathArgs(templateDir)]`).
- [ ] **Gotcha:** guard on existence so `plain` and un-re-seeded vaults still render on defaults.

**Verify:** `pnpm exec vitest run --project node test/pdf-render.test.ts` (unit part; compile parts
skip without typst). typecheck. Commit.

---

### Task 4 — `listTemplates` skips `_`-prefixed dirs (TDD)

**Files:** modify `src/main/pdf/templates.ts`; test `test/pdf-templates.test.ts`.

- [ ] **Red:** assert a `_brand/` dir (even with a `template.json`) is **not** listed.
- [ ] **Green:** skip entries whose basename starts with `_` before the manifest read.

**Verify:** `pnpm exec vitest run --project node test/pdf-templates.test.ts`. Commit.

---

### Task 5 — Seed the set: text + binary + generalized `writeAtomic` (TDD)

**Files:** modify `src/main/vault/vault-files.ts`, `src/main/agent/seed-content.ts`; test
`test/seed-content.test.ts`.

- [ ] Generalize `writeAtomic(root, rel, data: string | Uint8Array)` — drop the explicit `'utf8'`
  (string still defaults to utf8; Buffer writes bytes). No behavior change for text callers.
- [ ] Add `?raw` imports + `SEED_FILES` entries: `_brand/brand.typ`, `_brand/figures.typ`,
  `proposal/template.{typ,json}`, `report/template.{typ,json}` (the two `.json` built inline like
  `PLAIN_MANIFEST`, the `.typ` via `?raw`).
- [ ] Import `BRAND_BINARIES`; in `ensureSeeded`, after the text loop, write each decoded
  (`Buffer.from(b64,'base64')`) binary **if absent** (`readFile … .catch(()=>null)`; skip if
  present), pushing the path to `written`.
- [ ] **Red/Green test:** `ensureSeeded` on a temp vault writes `_brand/brand.typ`,
  `_brand/fonts/Raleway-regular.ttf` (bytes non-empty, `%`-magic or length match), `proposal/…`,
  `report/…`; a second run writes nothing (idempotent).

**Verify:** `pnpm exec vitest run --project node test/seed-content.test.ts`. typecheck. Commit.

---

### Task 6 — Compile smoke for `proposal` + `report` (TDD, skip-if-no-typst)

**Files:** modify `test/pdf-render.test.ts`.

- [ ] Add a `describe` that, per existing pattern (`resolveTypstBin() === null → return`), builds a
  temp vault: copy `_brand/{brand.typ,figures.typ}` + the 4 fonts + `logo.png` from the source dir,
  plus `proposal/template.{typ,json}` and `report/template.{typ,json}`.
- [ ] Render a proposal note containing `@@SIG:syv.ai ApS|ACME@@` and `@@FIG:agent-flow@@`; assert
  `%PDF-`. Render a report note with `meta:{title,date}`; assert `%PDF-`.
- [ ] **Gotcha:** this is the red/green for the Typst authoring in Tasks 1–2 — expect it to surface
  Typst syntax/import errors first; fix `brand.typ`/templates until green.

**Verify:** `pnpm exec vitest run --project node test/pdf-render.test.ts` (compiles if typst present
— it is on this machine). Commit.

---

### Task 7 — Full-suite verification + docs

- [ ] typecheck 0; `pnpm exec vitest run --project node` (full, ~130s, background); dom; shared.
- [ ] Extend memory `holi-document-templates-convention` to note the `_brand` foundation +
  proposal/report set + `--font-path`.
- [ ] Confirm clean tree; report. **Do not push** unless the user says so (they said work
  autonomously — commit locally; hold the push decision).

---

## Notes
- **UI verification ceiling:** the branded look (fonts/logo/layout) can only be truly seen in
  `pnpm dev` → Convert to PDF. The compile smoke proves it *compiles to a PDF*, not that it looks
  right. Hand the user a live-check for visual fidelity.
- **cmarker** is fetched by typst from `@preview/cmarker:0.1.6` (same as `plain`, already works —
  first compile may fetch/cache).
