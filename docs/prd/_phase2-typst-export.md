# PRD (Phase 2 stub): Typst export — branded syv.ai documents

> Deferred to **Phase 2** (after Google mail/calendar). Stub only. This is a **new pillar** — nothing like it exists in the old codebase.

## Summary
Turn any Holi markdown doc into a **branded syv.ai document** by rendering it through a **Typst template** — producing a company-styled PDF (and/or Typst source). This is the "make it presentable / send it to a client" step a real company DMS needs: notes and drafts live in Holi, finished documents come out looking like Syv.

## Why Typst
- Typst is a modern, fast, scriptable typesetting system (LaTeX-class output, far simpler authoring) with a clean programmatic API — a good fit for template-driven, branded document generation from markdown.
- OSS, self-hostable rendering (aligns with the stack's self-hosted, OSS, no-vendor-lock-in stance).

## Goals
- A set of **syv.ai Typst templates** (letter, report, memo, proposal…) with company branding (logo, fonts, colors — reusing the vault theme tokens where sensible).
- **Export flow:** pick a doc → pick a template → map/confirm metadata (title, author, date, recipient) → render → preview → download/save the PDF (and optionally the `.typ` source).
- Markdown → Typst conversion: headings, emphasis, lists, tables, code, images, links, blockquotes. Decide handling for wiki-links (resolve to text/title) and embeds.
- Templates are **committed vault content** so a team exports consistently; possibly per-vault template sets.
- Agent-invokable: the assistant can "export this as a syv proposal" (an MCP op or a skill).

## Non-goals (phase 2)
- A full WYSIWYG document designer. Templates are authored by Syv (code), chosen by users.
- Round-tripping Typst back into markdown.

## Open questions
- **Where rendering runs.** The old recommendation was a server-side Typst service for consistent fonts and brand assets; there is no server. Options: bundle the Typst binary with the app (consistent, bigger installer), shell out to a user-installed `typst` (every user is a developer, so plausible), or commit the brand assets into the vault and render locally. Leaning: bundle, because brand consistency is the whole point of the feature.
- Template authoring/versioning: who edits templates, how they're distributed to vaults (a shared "brand" repo, cloned as a vault?).
- Metadata model: front-matter fields the templates consume; how much is inferred vs prompted.
- Wiki-link / task-embed / image resolution during conversion.
- Output targets beyond PDF (e.g. Typst source, or Google Docs export).

## Dependencies
[`notes-editor.md`](notes-editor.md) (source docs, markdown pipeline), [`agent.md`](agent.md) (export as a vault skill), [`vaults-sync.md`](vaults-sync.md) (templates as committed vault content), + the phase-2 theme tokens.
