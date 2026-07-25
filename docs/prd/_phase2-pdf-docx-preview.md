# PRD (Phase 2 stub): Import conversion + viewing archived originals

> **⚠️ Superseded by D62 (2026-07-25).** The convert-on-entry + archive framing below is dead. Under D62 the vault is text-first *by authorship* (markdown is the source; PDFs are **outputs** rendered from it via Typst, not inputs to convert), binaries live in the vault as ordinary committed files, the `.docx`-import pipeline is dropped, and in-place PDF viewing stays deferred. Blob-storage/reference-file offloading (below, "where originals live") survives D62 as the deferred vault-size answer. Kept for that one open question and as a record; do not build the import pipeline.

> Deferred to **Phase 2** (first item after v1). Stub only — to be fleshed out when v1 lands. This is not a "PDF/docx preview" feature — the vault is text by construction.

## Summary
PDFs and Word (`.docx`) files are **converted to markdown on entry** (the import pipeline) — the vault's working set is always editable, linkable, agent-readable text. The **original binary is archived to Hetzner object storage** and fetchable on demand. The viewer surface exists to open those **archived originals** when someone needs to check the source (layout, signatures, exact formatting) — a rare archival escape hatch, not a first-class working document.

## Why phase 2, not v1
The PDF viewer is a known-fiddly surface (the old EmbedPDF integration was ~1550 LOC with real bugs — worker-engine + StrictMode hangs on "Loading PDF…"). It's not on the critical path, and v1 is clean-slate — nothing to import yet.

## Goals
- **Import pipeline:** a `.pdf` / `.docx` dropped into a vault converts to a markdown file — the vault stays text-first, which is what keeps it greppable, diffable, and agent-readable.
- **Original archival:** where the source binary goes is now an **open question**, not a given. There is no object storage. Options: commit it to the repo (simple, but git punishes binaries permanently), keep it machine-local and uncommitted (no sharing), or use Git LFS (real answer, real setup cost). Decide before building.
- **View an archived original on demand:** fetch and open the stored PDF (scroll, zoom, page nav) or docx (rendered to readable HTML via `mammoth`) — read-only.

## Non-goals (phase 2)
- Editing PDFs/docx — the markdown conversion is the editable artifact; originals are immutable archives.
- Annotations/highlights on originals (the old app had annotation sidecars — revisit separately).
- Round-tripping markdown edits back into the original binary.

## Open questions
- Conversion fidelity: which pdf→markdown / docx→markdown converters, and what happens with heavily visual documents (scans, slide-like PDFs) where conversion yields little?
- Viewer library for archived originals: revisit EmbedPDF vs pdf.js-direct vs alternatives, given the prior worker-engine issues (see memory: PDF viewer worker engine). Given how rarely originals will be opened, is "download and open externally" enough for a first cut?
- **Where originals live** (see Goals) — the load-bearing open question now that there is no object storage.
- How the converted doc references its original (frontmatter link? a wiki-link?) and how originals surface in the file tree.

## Dependencies
[`notes-editor.md`](notes-editor.md) (open/embed UX for the converted doc + "view original" affordance), [`vaults-sync.md`](vaults-sync.md) (whatever binaries end up committed, this engine commits), the deferred generic "import a markdown folder" path.
