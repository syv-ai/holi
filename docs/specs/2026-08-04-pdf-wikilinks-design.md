# Convert-to-PDF: render wiki-links as text — design

**Date:** 2026-08-04
**Follows:** the document-template-set work (deferred md→Typst fidelity).
**Status:** approved, lean spec.

## Problem

`cmarker` renders markdown as CommonMark, where `[[…]]` is not link syntax — so a note's
wiki-links come out as **raw brackets** in the PDF: `See [[projects/q2/plan.md]] and
[[plan.md|The Plan]].` (verified). A document sent to a client must read as prose.

There is no embed/transclusion grammar to handle — a task link is an ordinary path wiki-link
(`wiki-links.ts`), so this is only about rendering `[[…]]` / `[[…|Label]]` as readable text.

## Design

Preprocess the note text before Typst compiles it, reusing the **one** grammar
(`parseWikiLinks`). No second parser (the codebase's stated rule), and no Typst-side regex.

- **`packages/shared/src/wiki-links.ts`** gains two pure functions (node-tested in
  `packages/shared/test/wiki-links.test.ts`):
  - **`wikiLinkDisplay(link): string`** — the label if present, else the target's file name
    without a trailing `.md` (`projects/q2/plan.md` → `plan`).
  - **`wikiLinksToText(text): string`** — replace every wiki-link with its display text, via the
    same cursor walk as `rewriteWikiLinks`. Returns `text` unchanged when there are none.
- **`apps/desktop/src/main/pdf/render.ts`** preprocesses: read the note, `wikiLinksToText` it,
  write the result to `<work>/note.md` in the existing temp dir, and pass **that** path to
  `composeWrapper` instead of the original. Applies to every template (`plain`, `proposal`,
  `report`) uniformly; frontmatter/hr/heading-number stripping still happens later in the
  template's `render-body`, which reads the preprocessed note.

### Why preprocess in render.ts, not in the Typst template

`render.ts` is where `@holi/shared` (the canonical grammar) is reachable; a Typst regex would be a
second grammar. Doing it here also covers `plain`, which has its own inline `cmarker.render` and
would otherwise miss the transform.

**Note on images:** moving the note to the temp dir does not regress image handling — `cmarker`
0.1.6 already resolves a note's relative image paths against its *own package directory*, not the
note's dir, so note-relative images do not work today regardless (a separate, deferred concern).
Absolute image paths are unaffected by the move. When note-relative images are addressed later, the
image base must be the **original** note directory, not the temp copy — noted in `render.ts`.

## Testing

- **shared** (`test/wiki-links.test.ts`): `wikiLinkDisplay` — label wins; no label → basename sans
  `.md`; nested path; non-`.md` target keeps its name. `wikiLinksToText` — single, multiple,
  labeled + unlabeled mixed, none (unchanged), adjacent links, link mid-sentence.
- **node** (`test/pdf-render.test.ts`): the branded compile smoke renders a note containing
  `[[a/b/plan.md]]` and `[[plan.md|The Plan]]` and still produces `%PDF-` (the transform composes
  with the real pipeline).

## Non-goals

- Clickable/internal PDF links (the target isn't in the PDF).
- Resolving the display to the *target note's title* (would require reading other files); v1 uses
  the label or the basename. A follow-up can upgrade `wikiLinkDisplay`'s no-label branch.
- Fixing note-relative image resolution (separate deferred concern).
