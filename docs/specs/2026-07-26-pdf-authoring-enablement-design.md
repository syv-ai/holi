# Design: PDF authoring enablement — the agent front door + manifest validation

**Status:** Approved direction (2026-07-26). Single implementation plan. Realizes **slice 4** of the Typst PDF export design (`docs/specs/2026-07-26-typst-pdf-export-design.md`, §Front door 2, §Slice decomposition) and adds manifest validation. Builds on the typed-fields work (`docs/specs/2026-07-26-typed-template-fields-design.md`).

**Decision:** D62 — the vault is text-first; PDFs are **outputs** rendered from markdown via Typst. Templates are committed vault content; the generated PDF is not.

## Summary

Make PDF templates authorable by both a human and the vault assistant, and give authors feedback when a manifest is malformed. There is **no authoring UI** — every Holi user is a developer, so authoring stays as files, guided by a documented schema. Four deliverables:

1. A seeded **`md-to-pdf` SKILL** — the single authoring reference (schema, the `doc()` contract, the render recipe, how to add a template), read by humans in-vault and discovered by the agent.
2. **`TYPST_BIN` exposed to the vault agent's environment**, so the assistant can run the same typst the UI uses.
3. An **`AGENTS.md` pointer** — PDFs are outputs; see the skill.
4. **Manifest validation feedback** — malformed fields surface in the Convert dialog instead of silently degrading.

## Guiding constraint

Users are developers; authoring is code + config files, not a builder UI (see the memory `holi-users-are-developers`). The SKILL and its files ARE the authoring surface; users read them in the vault. There is no separate human-facing doc to keep in sync.

## Deliverable 1 — the `md-to-pdf` SKILL

Seeded into every vault at `.claude/skills/md-to-pdf/SKILL.md` (plus a worked example), added to `SEED_FILES`. It is the one source of truth for how templates work. Sections:

- **What / when** — turn a `.md` note into a branded PDF via a vault template. PDFs are **outputs, never committed** (write them to a non-tracked path and report it).
- **Template model** — `.holi/templates/<slug>/` holds `template.json` (manifest), `template.typ` (the layout), and an optional `assets/`. Discovery is by convention: the subdirectories of `.holi/templates/` ARE the template list (drop one in → it appears in the Convert picker; no registration).
- **Manifest schema** — `{ name, description, fields: [...] }`, each field `{ key, label, type, required, default?, options? }`; `type` is one of `text | textarea | date | select | number | checkbox`. A worked `template.json`.
- **The `doc()` contract** — `template.typ` exports `#let doc(notePath, meta: (:), assets: "") = { … }`. It `read()`s the note, strips YAML frontmatter, and renders markdown via `@preview/cmarker`. `meta` carries **native typed values** — `meta.date` is a `datetime`, `meta.count` a number, `meta.urgent` a bool; a blank optional field is absent, so read defensively with `meta.at("key", default: none)`.
- **Render recipe** — compose a wrapper in a scratch dir and compile it:
  ```
  # wrapper.typ
  #import "<abs vault>/.holi/templates/<slug>/template.typ": doc
  #doc("<abs note>.md",
       meta: (date: datetime(year: 2026, month: 7, day: 26), recipient: "ACME Corp"),
       assets: "<abs vault>/.holi/templates/<slug>/assets")
  ```
  then `"$TYPST_BIN" compile wrapper.typ <out>.pdf --root /`. Every path is absolute; `--root /` lets typst read the note + template from different trees. The agent writes the typed `meta` literals directly (it is authoring Typst anyway), so it does not need Holi's coercion step.
- **Authoring a new template** — copy `plain/` to a new slug, edit `template.json` + `template.typ`; it appears in Convert automatically. Confirm it compiles with a test render.
- **Fallback** — if `$TYPST_BIN` is unset, typst is not yet installed; run one Convert in the UI (or retry shortly) to trigger the one-time download.

The SKILL is a **new** file, so adding it to an existing vault never conflicts with user edits.

## Deliverable 2 — expose `TYPST_BIN` to the agent

The vault assistant is a Claude Code process spawned by `agent-manager.ts` with `env: buildAgentEnv(process.env)` (cwd = the vault). It inherits the GUI app's `PATH`, which does **not** contain a downloaded typst — so Holi must hand it the path.

- Inject `typstCacheDir` into `agent-manager`'s deps from `index.ts` (same wiring the router uses).
- At agent **spawn**, call `resolveTypstBin({ cacheDir })` — find-only (`TYPST_BIN` env → cache → `PATH`), **never downloads**, so the spawn path never blocks. If it returns a path, pass it to `buildAgentEnv(process.env, { typstBin })`, which sets `env.TYPST_BIN`.
- Also fire `ensureTypst({ cacheDir })` **without awaiting** (fire-and-forget) so a machine that has never rendered caches typst for the next spawn.
- If typst is not yet resolvable, `TYPST_BIN` is simply omitted; the SKILL's fallback covers it. This keeps spawn fast and never surprises the user with a download at agent start.

`buildAgentEnv` gains an optional second argument `{ typstBin?: string }` and sets `env.TYPST_BIN = typstBin` only when present — a pure, unit-testable change.

## Deliverable 3 — the `AGENTS.md` pointer

Add a short **"Rendering to PDF"** section to the seeded `AGENTS_MD` (`seed-content.ts`): PDFs are outputs (not committed); to make one, use the `md-to-pdf` skill; the bundled typst is at `$TYPST_BIN`. `AGENTS.md` is never-overwrite (it is user-editable), so only new vaults get this automatically; existing vaults keep their own, and the SKILL is discoverable regardless.

## Deliverable 4 — manifest validation feedback

Today `normalizeFields` (main) silently degrades a malformed manifest (unknown type → text, select-without-options → text). Make the degradation **visible**.

- **`parseFields(raw) → { fields, warnings }`** — a pure function in `@holi/shared` (co-located with the field schema), one pass producing both the clamped `TemplateField[]` and a `string[]` of ready-to-show warnings. It **supersedes** the main-only `normalizeFields` (a small relocation — the logic is pure and belongs with the schema).
- **Warnings** are emitted for: a non-object field entry; a field with no string `key`; an unknown `type` (→ text); a `select` with no `options` (→ text); a `date` `default` that is neither `"today"` nor `YYYY-MM-DD` (which would otherwise throw at render). Each message names the field, e.g. `field "when": unknown type "daet" — treated as text`.
- **Transport** — `Template` gains `warnings: string[]`; `listTemplates` populates it via `parseFields`; `pdf.templates` returns `warnings` per template (extending its return shape).
- **Surface** — the Convert dialog shows a small amber "⚠ N issue(s) in this template" block under the picker when the selected template has warnings, listing each. No separate procedure; the warnings ride on the data the dialog already fetches. The validator is a pure core, reusable later (e.g. by a future agent-callable check).

## Architecture / units

- `@holi/shared/template-fields.ts` — grows `parseFields` (fields + warnings); `initialValue` and the types stay.
- `apps/desktop/src/main/pdf/templates.ts` — `listTemplates` calls `parseFields`, adds `warnings` to `Template`; drops the local `normalizeFields`.
- `apps/desktop/src/main/router.ts` — `pdf.templates` returns `warnings`.
- `apps/desktop/src/main/agent/agent-runtime.ts` — `buildAgentEnv(env, { typstBin? })`.
- `apps/desktop/src/main/agent/agent-manager.ts` — resolve typst at spawn, inject, background-ensure; new `typstCacheDir` dep.
- `apps/desktop/src/main/index.ts` — inject `typstCacheDir` into `agent-manager`.
- `apps/desktop/src/main/agent/seed-content.ts` — add the SKILL file(s) to `SEED_FILES`; add the `AGENTS.md` section.
- `apps/desktop/src/renderer/.../ConvertToPdfDialog.tsx` — render `warnings`.

## Testing

- **Shared:** `parseFields` — correct `{ fields, warnings }` per case (the existing `normalizeFields` cases move here and gain warning assertions).
- **Main/router:** `listTemplates` and `pdf.templates` surface `warnings`.
- **Agent env:** `buildAgentEnv` sets `TYPST_BIN` when a path is given, omits it otherwise (pure unit).
- **Seed:** the SKILL file(s) appear in the pinned `SEED_FILES` key list.
- **Dialog warnings + the SKILL render recipe end-to-end:** CDP/manual per repo norm.

## Seeding & migration

- The SKILL is new — safe to drop into existing vaults. The two test vaults (`a-demo-vault-3`, `another-vault-42`) get it in the closing re-seed step.
- The `AGENTS.md` section only lands in new vaults (never-overwrite preserves user edits); the two test vaults may be re-seeded since they are throwaway.

## Non-goals / deferred (YAGNI)

- **No authoring UI** (builder or scaffolding) — files + the SKILL, per the developer-user constraint.
- **No Holi CLI / render endpoint** for the agent — it composes the wrapper and runs `$TYPST_BIN` directly. A real `holi` bin is a separate, larger project if ever wanted.
- **No agent-callable validation** — validation surfaces in the dialog for humans; the SKILL keeps the agent correct by documentation + safe degradation. The pure validator is reusable if we later add an endpoint.
- **The Syv branded template** (slice 3 of the PDF spec) is unaffected and still separate.

## Supersedes

The PDF export spec's slice 4 open question ("exact typst-path exposure to the agent — env var vs a shim") is resolved: **`TYPST_BIN` in the agent env**, which `resolveTypstBin` already honors, populated non-blocking at spawn.
