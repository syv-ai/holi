# Design: Typst PDF export — per-vault templates, UI + agent front doors

**Status:** Approved direction (2026-07-26) — decomposed into slices below; each slice gets its own plan.
**Decision:** D62 (`docs/decisions.md`) — the vault is text-first by authorship; PDFs are **outputs** rendered from markdown via Typst. This realizes and supersedes the `prd/pdf-export.md` stub, pulled forward by D62.

## Summary

Turn any markdown note into a branded PDF through a **Typst template**. Two front doors — a UI **"Convert to PDF"** dialog and the vault **agent** — over one render engine and one per-vault template set. Templates are committed vault content, so a team shares a house style via git and each vault carries its own. The 1brain `md-to-pdf` skill is the *reference* for the Syv template's layout and markdown conventions, not the product.

## Decisions locked (2026-07-26)

- **Download typst on first use** (updated 2026-07-26, supersedes the earlier "bundle the binary" decision). The UI button must work with zero user *setup*, but there is no packaging pipeline yet (no electron-builder, no `extraResources`), and a per-platform binary is ~39 MB × 3 ≈ 117 MB of git bloat if committed. Instead, a `resolveTypstBin()` seam resolves the binary in order **`TYPST_BIN` env → a cached download under `userData` → `PATH`** (dev). On the first Convert with no cached binary, Holi downloads the pinned typst release for the host platform into `userData`, verifies it (`typst --version` == pinned), and caches it. This is zero-setup for the user, keeps the repo small, and sidesteps the packaged-GUI `PATH` problem (a Finder/Dock-launched app does not inherit the shell `PATH`). A one-time network fetch is already unavoidable — Typst fetches the `@preview/cmarker` package from the network on the first compile regardless.
- **Typst-only, no Python.** The markdown preprocessing 1brain did in `render.py` (strip frontmatter, renumber headings, indent contract clauses, expand `@@FIG@@`/`@@SIG@@`) moves **into the Typst template** (Typst already reads markdown via `cmarker` and does regex/string ops). The only runtime dependency is the bundled `typst`.
- **Seed a generic 'Plain' template** into every vault, so Convert-to-PDF works out of the box and serves as a copy-to-customize starter. The **Syv-branded template lives in the Syv vault**, not universally seeded.
- **Per-vault templates are committed content** (below).

## Template model

A template is a directory the vault owns, under a managed root:

```
.holi/templates/<name>/
  template.json     # manifest: display name, description, metadata fields
  template.typ      # the Typst layout — a function the render wrapper calls
  assets/           # fonts, logo, figures the template needs
```

`template.json`:

```json
{
  "name": "Plain",
  "description": "A clean, unbranded document layout.",
  "fields": [
    { "key": "date", "label": "Date", "required": false },
    { "key": "recipient", "label": "Recipient", "required": false }
  ]
}
```

- **Discovery:** the vault's templates = the subdirectories of `.holi/templates/`. The render engine and the UI both read from there. No registry, no index — the directory *is* the list (consistent with the vault-is-files model).
- **`.holi/templates/` is committed** (it is not `.local.`), so a team shares templates. It sits under `.holi/` (like `vault.json`), out of the notes tree.
- **`fields`** drives the Convert dialog's inputs and is passed to `template.typ` as a Typst dictionary. A template that wants no metadata declares `"fields": []`.

## Render engine (main)

One procedure, `pdf.render({ notePath, template, meta }) → { pdfPath }` (or bytes), used by both front doors:

1. Resolve the template dir under `.holi/templates/<template>/` (via the active vault root + `vaultRelPath` guard).
2. Compose a small Typst **wrapper** in a temp dir: `#import "<abs>/template.typ": doc` then `#doc("<abs note path>", meta: <meta dict>, assets: "<abs assets dir>")`.
3. Invoke the resolved `typst compile wrapper.typ <out.pdf> --root /` (the wrapper uses absolute paths; `--root /` lets Typst read the note + assets — the note and template live in different dirs than the temp wrapper, so a narrower root won't span them). Fonts are found via `--font-path <assets>/fonts` when the template ships fonts.
4. Return the output path/bytes.

- **All markdown preprocessing lives in `template.typ`** — it `read()`s the note, strips YAML frontmatter, removes manual heading numbers, indents clause paragraphs, and expands `@@FIG:…@@` / `@@SIG:…@@` tokens (the Syv template ports 1brain's logic; the Plain template does the minimum). This keeps the engine a dumb "compose wrapper + run typst" with no per-template knowledge.
- **typst path:** `resolveTypstBin()` resolves the binary in order **`TYPST_BIN` env → cached download under `userData` → `PATH`**. When nothing is cached and it is not on `PATH`, Holi downloads the pinned release for the host platform/arch on first use (see Decisions locked). No committed binary, no `extraResources`.

## Output location

The PDF is a **sendable output, not vault content** — 1brain's own convention is that the generated PDF is not committed, and D62 keeps binaries-in-git a deferred concern. So the UI writes through a **native save dialog** (default: Downloads), **not** into the vault, then opens it. (Writing into the auto-committing vault would commit a large binary on every convert.) A future "save into vault" option is easy to add but is not the default.

## Front door 1 — UI "Convert to PDF"

- **Entry:** a command (command palette / a menu item on an open note). Enabled for a markdown note.
- **Dialog:** a template picker (the vault's `.holi/templates/` set) + the selected template's `fields` as inputs + a **Convert** button.
- **Flow:** Convert → `pdf.render` → native save dialog → open the PDF. Errors (typst failure, template not found) surface in the dialog.

## Front door 2 — the agent

A seeded `.claude/skills/md-to-pdf/SKILL.md` documents the capability for the agent: how to pick a template, the markdown conventions each template supports (`@@FIG@@`, `@@SIG@@`, clause numbering), and how to trigger a render. The agent runs the **same bundled typst** on the **same templates** — Holi exposes the typst binary path to the vault environment (e.g. an env var the skill reads), so there is one renderer and one template set behind both doors. (Exact exposure mechanism is a slice-level detail.)

## Templates shipped

- **Plain** (seeded into every vault): a clean, unbranded layout — title, numbered sections, tables, images, links. No fonts bundled (system/Typst defaults) so it stays small. Its `template.typ` carries the minimal preprocessing.
- **Syv** (added to the Syv vault, not seeded universally): ports 1brain's `syvai-tilbud.typ` layout + `syvai-figurer.typ` diagrams + Raleway fonts + logo, in English (labels Name/Title/Date, `lang:"en"`, English diagram labels), with the `@@FIG@@`/`@@SIG@@` contract. This is where the base64 binary-asset handling and the full port land.

## Slice decomposition (tracer-first)

1. **Template model + Plain default + typst resolver (download-on-first-use) + render engine + a minimal Convert command.** The tracer bullet: a real markdown note → a PDF via the Plain template, end to end (no fancy dialog — a template picker + Convert is enough). Proves discovery, the wrapper/compile path, and the `resolveTypstBin()` seam. In dev the resolver rides `PATH`; the download path is built and wired but only end-to-end-verifiable once a packaged build exists.
2. **The Convert dialog UX** — metadata fields from the manifest, error surfacing, save-dialog + open.
3. **The Syv template** — port 1brain's layout/figures/fonts (English), including base64 binary seeding *for that template's assets* (added to the Syv vault). Reuses the binary-seed mechanism only if we seed it; otherwise it is just committed vault files.
4. **The agent front door** — the seeded `md-to-pdf` skill + typst-path exposure; re-add the AGENTS.md "PDFs are outputs" line.

Each slice is independently shippable and gets its own plan. Slice 1 is the next plan.

## Testing

- **Pure/unit:** template discovery (dir → template list + manifest parse, tmpdir), wrapper composition (note+template+meta → wrapper string), the typst-path resolver (dev vs packaged).
- **tmpdir integration:** `pdf.render` end to end against the bundled typst on a fixture note + the Plain template → asserts a non-empty PDF with a `%PDF` header.
- **UI:** the Convert dialog is CDP/manual per repo norm.

## Non-goals / open questions

- **Non-goals (this pillar):** a WYSIWYG template designer; round-tripping PDF→markdown; annotations; committing PDFs into the vault by default.
- **Open:** exact typst-path exposure to the agent (env var vs a tiny Holi shim — likely `TYPST_BIN`, which `resolveTypstBin()` already honors); whether Plain bundles a font or rides Typst defaults; supply-chain hardening of the first-use download (sha256-pin the release archive per platform/version, vs the slice-1 `typst --version` functional check); Windows `.zip` vs unix `.tar.xz` extraction in the downloader (slice 1 implements the host platform; other platforms are unverifiable until packaging exists).

## Supersedes

`prd/pdf-export.md` (the stub) — this is its realization. That stub's "where rendering runs" open question is resolved: **in-app, Typst-only, binary downloaded on first use.**
