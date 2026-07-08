# PRD (Phase 2 stub): PDF / docx preview

> Deferred to **Phase 2** (first item after v1) per **D17**. Stub only — to be fleshed out when v1 lands.

## Summary
View PDF and Word (`.docx`) attachments inside Holi without leaving the app — read-only in phase 2. A real company DMS needs to open the documents people actually attach.

## Why phase 2, not v1
The PDF viewer is a known-fiddly surface (the old EmbedPDF integration was ~1550 LOC with real bugs — worker-engine + StrictMode hangs on "Loading PDF…"). Keeping it out of v1 lets the hard architecture (CRDT + agent) prove out first; it's not on the critical path. (D17)

## Goals
- Open a `.pdf` in a pane and read it (scroll, zoom, page nav, search).
- Open a `.docx` rendered to readable HTML (via `mammoth`) for viewing.
- Attachments live in object storage (see server-data PRD); the client streams/caches them.

## Non-goals (phase 2)
- Editing PDFs/docx. Annotations/highlights (the old app had annotation sidecars — revisit separately).
- docx → markdown conversion.

## Open questions
- Viewer library: revisit EmbedPDF vs pdf.js-direct vs alternatives, given the prior worker-engine issues (see memory: PDF viewer worker engine).
- How attachments are referenced from notes/tasks (as `related[]` items? inline embeds?).
- Caching/eviction of large binaries in the local cache.
- Annotations: shared (tier-1) vs per-user (tier-2)?

## Dependencies
server-data (object storage, attachment refs), notes-editor (embed/open UX), vaults-collaboration (materialization/caching).
