# PRD — PDF export: branded syv.ai documents

> **Built and live.** Convert-to-PDF is in the app (`features/pdf/ConvertToPdf.tsx`, `main/pdf/*`), templates are vault content under `.holi/document-templates/` (D66), and the agent has the same capability through the seeded `md-to-pdf` skill. This was written as a phase-2 stub, pulled forward by D62, and then left describing a future it had already become — including a line saying this would be *"an agent skill, not an in-app export UI"*, which stopped being true when the export UI shipped.

## Summary
Turn any Holi markdown doc into a **branded syv.ai document** by rendering it through a **Typst template** — producing a company-styled PDF (and/or Typst source). This is the "make it presentable / send it to a client" step a real company DMS needs: notes and drafts live in Holi, finished documents come out looking like Syv.

## Why Typst
- Typst is a modern, fast, scriptable typesetting system (LaTeX-class output, far simpler authoring) with a clean programmatic API — a good fit for template-driven, branded document generation from markdown.
- OSS, self-hostable rendering (aligns with the stack's self-hosted, OSS, no-vendor-lock-in stance).

## Goals — as built
- **Markdown is the source and stays the source.** Author in Holi, emit a branded PDF; nothing round-trips back. This is D62 restated: the vault is text-first *by authorship*, and a PDF is an output the vault emits rather than a document it holds.
- **Templates are committed vault content**, under `.holi/document-templates/<slug>/` — a `template.json` plus `template.typ` plus `assets/`. The path is named for its *purpose*, not its mechanism (D66): in a notes app, a bare `templates/` invites "templates for *notes*?". `main/pdf/templates.ts` holds the single source for that path, and the seed content lives internally at `main/agent/templates/plain/`, which is build content rather than the vault convention and is deliberately not renamed to match.
- **A team exports consistently because the template is in the repo.** Nobody installs a brand.
- **Typed template fields.** `template.json` declares the metadata a template consumes, and the export UI renders a widget per field rather than a free-text blob — so a template can require a recipient and get one. Frontmatter prefills them, because the document usually already knows its own title.
- **Two front doors, one pipeline.** The Convert-to-PDF UI and the agent's `md-to-pdf` skill both shell out to the same renderer. The skill is what makes *"export this as a proposal"* work in a sentence; the UI is what makes it work without one.
- **Typst is resolved, not assumed.** `TYPST_BIN` override → a version-pinned cached download under `userData/typst` → `PATH`. Pinned to one version (`TYPST_VERSION`) because templates are authored against it, and a template that renders differently on two machines defeats the point of committing it.
- **Wiki-links and images resolve at conversion**, so a document full of `[[links]]` exports as prose rather than as syntax.

## Non-goals
- **A WYSIWYG document designer.** Templates are code, authored once and chosen by users — the standing "users are developers, so prefer a documented schema over a builder" rule.
- **Round-tripping Typst back into markdown.** The PDF is an artifact; the markdown is the document.

**What is not built** — templates beyond `plain`, distributing a template set across vaults, and any output target other than PDF — is in [`../roadmap.md`](../roadmap.md).

## Resolved, and worth not re-litigating
- **Where rendering runs** → locally, against a resolved-and-pinned Typst binary. The original recommendation was a server-side Typst service for font and asset consistency; there is no server (D60), and pinning the version plus committing the assets into the vault buys the same consistency without one.
- **Whether this is a skill or a UI** → both, over one pipeline. It was specified as a skill *instead of* a UI, and that was wrong: the agent route needs no dialog and the human route needs no sentence.

## Dependencies
[`notes-editor.md`](notes-editor.md) (source docs, the markdown pipeline, wiki-link resolution), [`agent.md`](agent.md) (the seeded `md-to-pdf` skill and the template convention), [`vaults-sync.md`](vaults-sync.md) (templates and their assets as committed vault content), and [`../architecture.md`](../architecture.md) §9 for the theme tokens a template may reuse.
