# PRD (Phase 2 stub): Import conversion + viewing archived originals

> Deferred to **Phase 2** (first item after v1) per **D17**. Stub only — to be fleshed out when v1 lands. Reframed per **D28**: this is no longer a "PDF/docx preview" feature — the vault is text by construction.

## Summary
PDFs and Word (`.docx`) files are **converted to markdown on entry** (the import pipeline, D28) — the vault's working set is always editable, linkable, agent-readable text. The **original binary is archived to Hetzner object storage** and fetchable on demand. The viewer surface exists to open those **archived originals** when someone needs to check the source (layout, signatures, exact formatting) — a rare archival escape hatch, not a first-class working document (D28).

## Why phase 2, not v1
The PDF viewer is a known-fiddly surface (the old EmbedPDF integration was ~1550 LOC with real bugs — worker-engine + StrictMode hangs on "Loading PDF…"). Keeping it out of v1 lets the hard architecture (CRDT + agent) prove out first; it's not on the critical path. (D17) And v1 is clean-slate anyway (D16) — nothing to import yet.

## Goals
- **Import pipeline:** a `.pdf` / `.docx` dropped into a vault converts to a markdown doc (a normal CRDT doc, preserving what structure conversion can) — the vault stays text by construction (D28, keeps D23 full materialization cheap).
- **Original archival:** the source binary is uploaded to Hetzner object storage, linked from the converted doc, never eagerly synced to disk (D28).
- **View an archived original on demand:** fetch and open the stored PDF (scroll, zoom, page nav) or docx (rendered to readable HTML via `mammoth`) — read-only.

## Non-goals (phase 2)
- Editing PDFs/docx — the markdown conversion is the editable artifact; originals are immutable archives.
- Annotations/highlights on originals (the old app had annotation sidecars — revisit separately).
- Round-tripping markdown edits back into the original binary.

## Open questions
- Conversion fidelity: which pdf→markdown / docx→markdown converters, and what happens with heavily visual documents (scans, slide-like PDFs) where conversion yields little?
- Viewer library for archived originals: revisit EmbedPDF vs pdf.js-direct vs alternatives, given the prior worker-engine issues (see memory: PDF viewer worker engine). Given rarity (D28), is "download and open externally" enough for a first cut?
- How the converted doc references its archived original (frontmatter link? `related[]`-style ref?) and how originals surface in the file tree, if at all.
- Caching/eviction of fetched originals in the local cache (they are never part of the materialized working set, D23/D28).

## Dependencies
server-data (object storage, archived-original refs), notes-editor (open/embed UX for the converted doc + "view original" affordance), vaults-collaboration (materialization stays text-only), the deferred import path (D16).
