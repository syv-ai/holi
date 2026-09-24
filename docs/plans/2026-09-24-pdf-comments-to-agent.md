# PDF comments reach the agent: implementation plan

**Goal:** Claude can see a vault PDF's comments, who wrote them and when: through
`holi pdf comments <path> [--json]`, and through an "Ask agent" button on the PDF viewer's top bar.
**Approach:** One pure thread model and formatter in `packages/shared`, fed by two readers: the open
viewer's annotation store (renderer, for the ask) and PDFium in Node over the file on disk (main, for
the command). The command is one more `holi` subcommand on the existing ops server; a slim managed
skill and a seeded allow rule make it discoverable and prompt-free.
**Stack:** TypeScript, `@embedpdf/pdfium` + `@embedpdf/engines` 2.15.1 (PDFium wasm), POSIX sh + curl,
Jotai, Radix popover, Vitest 4.

Requirements: [`docs/specs/2026-09-24-pdf-comments-to-agent-design.md`](../specs/2026-09-24-pdf-comments-to-agent-design.md).
Not repeated here. Order is his call: model, reader, command + skill + allow rule, then the button.

## Settled before planning (2026-09-24, on scratch copies in the job tmp dir)

1. **A reply is a text note (`/Subtype /Text`) carrying `/IRT <parent ref>`.** Created through the
   Node engine (`createPageAnnotation` with `inReplyToId`), saved, reopened: `getPageAnnotations`
   returns `type: 1`, `inReplyToId: <parent's /NM>`, and `replyType` **undefined** (absent `/RT` means
   Reply, per ISO 32000-2). embedpdf's own comments panel
   (`getSidebarAnnotationsWithRepliesGroupedByPage` in `@embedpdf/plugin-annotation`) defines the set:
   a root is any of text-without-IRT, text markup, ink, square, circle, polygon, line, polyline, free
   text, stamp, redact, caret; replies are text notes whose `inReplyToId` is the root's id; an
   annotation with `inReplyToId` and `replyType === 2` (Group) is folded into its leader and is not a
   root. Mirror that exactly, so the ask, the command and the panel agree.
2. **PDFium loads in main through plain CJS `require`.** Main's build is CJS with dependencies
   externalised (`electron.vite.config.ts`), and both packages ship a `require` export:
   `require('@embedpdf/pdfium')`, `require('@embedpdf/engines/pdfium')`, and the wasm read with
   `readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm'))`. Verified under
   `ELECTRON_RUN_AS_NODE`. **There is no packaging config in the repo** (no electron-builder/forge),
   so "packaged" today means `out/` plus `node_modules`; nothing needs emitting. `@embedpdf/engines`
   and `@embedpdf/models` are only transitive today: add both as direct dependencies of
   `@holi/desktop`, pinned `2.15.1` like `@embedpdf/pdfium`.
3. **`settingsWithRequired` merges `permissions.ask` only** (`main/agent/seed-content.ts` ~L565).
   `allow` needs the same merge added; it does not happen for free.
4. **Marked text for a highlight without `custom.text`:** `getPageGlyphs(doc, page)` returns one box
   per character, indexed like PDFium's char indices. Take the characters whose box centre lies in
   any of the mark's `segmentRects`, group consecutive indices into runs, and `getTextSlices` over
   the runs. On the old test PDF this reproduced embedpdf's saved `custom.text` byte for byte
   (218 chars, 18 ms for the page). `getPageTextRects` is **not** usable: its `content` came back as
   glyph codes, not text.

Also seen: embedpdf's `custom.text` keeps the PDF's `\r\n` line breaks; the existing PDF's author is a
GitHub login, which is why fixtures are generated, never copied.

## Files

| File                                                                                         | Responsibility                                                                               |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/shared/src/pdf-comments.ts` (new) + export from the index                          | Thread model, ordering, readable and JSON formatting, glyph-run geometry                     |
| `packages/shared/test/pdf-comments.test.ts` (new)                                            | Its tests (match where shared tests actually live)                                           |
| `apps/desktop/src/main/pdf/comments.ts` (new)                                                | PDFium in Node: lazy init, open/read/close, annotations → thread input, marked-text fallback |
| `apps/desktop/test/fixtures/pdf-comments/` (new)                                             | Two small fixture PDFs + the generator script that makes them                                |
| `apps/desktop/test/pdf-comments.test.ts` (new)                                               | Main reader against the fixtures                                                             |
| `apps/desktop/src/main/agent/ops.ts`, `hook-server.ts`                                       | `/pdf/comments` route; a reply may carry its own content type                                |
| `apps/desktop/src/main/agent/cli.ts`                                                         | `holi pdf comments` case, usage text                                                         |
| `apps/desktop/src/main/index.ts` ~L513-562                                                   | Wire the dep: remote → root → canonical path → reader                                        |
| `apps/desktop/src/main/agent/skills/pdf-comments/SKILL.md` (new), `seed-content.ts`          | Managed skill; `permissions.allow` seed + merge                                              |
| `apps/desktop/src/renderer/src/lib/pdf-comments.ts` (new)                                    | Viewer store → thread input; which thread is selected                                        |
| `apps/desktop/src/renderer/src/lib/pdf-viewer-config.ts`                                     | The two command ids in `HOLI_BUTTONS`, placed beside the comments button; icon               |
| `apps/desktop/src/renderer/src/composites/AskAgentPopover.tsx` (new)                         | Instruction field + session picker, anchored to a rect                                       |
| `apps/desktop/src/renderer/src/features/files/PdfDocument.tsx`                               | Register the commands, open the popover, send                                                |
| Docs: `prd/pdf-export.md`, `prd/agent.md`, `not-built.md`, `decisions.md`, `architecture.md` | Fold the behaviour in (D106)                                                                 |

## Tasks

One task, one commit, direct to `main`, **no push**. Trailer on every commit:
`Claude goes brr.. via syv-ai/dash` then `Claude-Session: https://claude.ai/code/session_01NJjMuC4GwYY9Zoc3J8EKpj`.

### Task 1: the thread model and formatter (shared)

**Files:** create `packages/shared/src/pdf-comments.ts`, its test; export from `@holi/shared`.

**Behaviour:** given plain annotation records from either reader, produce ordered threads, and format
them the one way the spec shows.

Contract (names are binding across tasks; field details are the implementer's):

```ts
export interface PdfAnnotationInput {
  id: string                 // the /NM
  subtype: number            // PDF annotation subtype, the numbering embedpdf's enum uses (TEXT 1 … REDACT 28)
  pageIndex: number          // 0-based
  rect: { x: number; y: number; width: number; height: number } // top-left origin, as embedpdf gives it
  author?: string; created?: Date; modified?: Date
  contents?: string
  inReplyToId?: string; replyType?: number
  markedText?: string        // already resolved by the reader
}
export type PdfMarkKind = 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'note'
  | 'free text' | 'ink' | 'shape' | 'stamp' | 'caret' | 'redaction'
export interface PdfComment { id: string; author: string | null; created: Date | null; modified: Date | null; text: string }
export interface PdfCommentThread extends PdfComment { page: number /* 1-based */; kind: PdfMarkKind; markedText: string | null; replies: PdfComment[] }

export function commentThreads(annotations: PdfAnnotationInput[]): PdfCommentThread[]
export function formatCommentThreads(path: string, threads: PdfCommentThread[], opts?: { timeZone?: string }): string
export function commentThreadsJson(path: string, threads: PdfCommentThread[]): unknown // stable shape below
export function glyphRuns(glyphs: { x: number; y: number; width: number; height: number }[], rects: …[]): { start: number; count: number }[]
```

- Set and grouping exactly as "Settled" 1. Subtypes not in the set (link, widget, popup, …) are
  dropped. Square, circle, polygon, line, polyline are all `'shape'`; text note is `'note'`.
- Order: page, then `rect.y`, then `rect.x`, then created; replies by created.
- Readable layout: the spec's block, verbatim shape. `[From <path>, N comment(s)]`, N = threads.
  Thread head `Page P, <kind>` plus ` on "<marked text>"` when there is marked text, with every run of
  whitespace (the `\r\n`s) collapsed to one space. Then `  <author>, YYYY-MM-DD HH:MM` (local, or
  `opts.timeZone`; `Unknown` for a missing author; the date omitted when missing), then the comment
  quoted line by line as `  > …`, or `  (no comment)` when empty. A reply is
  `  Reply, <author>, <date>` then its quoted lines. Blank line between threads.
- No threads: `No comments in <path>.` (the formatter owns this string; the CLI prints it, exit 0).
- JSON: `{ path, threads: [{ id, page, kind, markedText, author, created, modified, text, replies: [{ id, author, created, modified, text }] }] }`,
  dates as ISO strings or `null`.
- `glyphRuns`: indices whose box centre lies inside any rect, grouped into consecutive runs.

Tests: ordering across pages and positions; a highlight with no comment is a thread shown
`(no comment)`; multi-line comment quoted per line; replies nested and ordered; a Group member is not
its own thread; a link is dropped; `No comments in …`; singular/plural header; JSON shape;
`glyphRuns` on a two-line fixture. Use `timeZone: 'UTC'` in tests.

- [ ] Failing tests, then implement: `pnpm -C packages/shared test` → green (552 + new)
- [ ] `pnpm typecheck`; commit `feat(shared): one PDF comment thread model for the ask and the command`

### Task 2: the fixtures

**Files:** create `apps/desktop/test/fixtures/pdf-comments/make-fixtures.cjs`, `embedpdf.pdf`, `other-tool.pdf`.

**Behaviour:** two small committed PDFs that the reader test depends on, reproducible from the script.

- The script writes a one-page base PDF by hand (Helvetica, two or three lines, one of them
  `Payment within 60 days of invoice.`), then:
  - `embedpdf.pdf`: through the Node engine, a highlight over that sentence with `contents` and
    `custom: { text }`, a text note elsewhere, and a reply to the highlight (text note with
    `inReplyToId`), then `saveAsCopy`. Authors Ada Holm and Bo Lind, fixed dates.
  - `other-tool.pdf`: the base plus an **incremental update written by hand** in the shape Acrobat
    writes: the highlight dictionary (with `/QuadPoints`, no `/EPDFCustom`) inside a
    Flate-compressed `/Type /ObjStm`, a cross-reference **stream**, and `/T` and `/Contents` as
    UTF-16BE strings with a BOM (`<FEFF…>`). Use a non-ASCII author, e.g. `Åse Holm`, to prove the decode.
- Check afterwards: `grep -a EPDFCustom other-tool.pdf` finds nothing and `grep -a "Payment" other-tool.pdf`
  finds only the base content stream. Neither file may contain a real name or login.
- Run with `ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/.bin/electron <script>` (bare `node` is
  broken in this shell); document that in the script's header.

- [ ] Generate, inspect both with the handoff spike (`pdfium-node-spike.mjs`), commit
      `test(pdf): comment fixtures, one from embedpdf and one written the way other tools write`

### Task 3: the main reader

**Files:** create `apps/desktop/src/main/pdf/comments.ts`, `apps/desktop/test/pdf-comments.test.ts`; add
`@embedpdf/engines` and `@embedpdf/models` 2.15.1 to `apps/desktop/package.json`.

**Behaviour:** `readPdfComments(absPath)` returns
`{ ok: true; threads: PdfCommentThread[] } | { ok: false; reason: 'not-found' | 'not-pdf' | 'password' }`.

- PDFium initialised once, lazily, as a module-level promise (`init({ wasmBinary })` →
  `PDFiumExt_Init()` → `new PdfiumNative(mod)`), wasm read via `require.resolve` as in "Settled" 2.
  No `electron` import (the node test project must load it).
- Each call: read the file, `openDocumentBuffer`, every page's `getPageAnnotations`, map to
  `PdfAnnotationInput`, `closeDocument` in a `finally`. `markedText` = `custom?.text` when present,
  else for text-markup subtypes (highlight, underline, strikeout, squiggly) `getPageGlyphs` +
  `glyphRuns` + `getTextSlices`, joined with a space. Glyphs are read at most once per page per call.
- Map engine failures: missing file → `not-found`; a PDFium open error with the password code →
  `password`; anything else that fails to open → `not-pdf`. Find the error codes in
  `@embedpdf/models` (`PdfErrorCode`) rather than matching messages. Tests make a password case only if
  the generator can produce one cheaply; otherwise cover `not-found` and `not-pdf` (a `.pdf` of junk).

Tests: `embedpdf.pdf` → two threads in order, highlight with its `custom.text`, the reply nested with
its author and date; `other-tool.pdf` → the highlight's author decoded from UTF-16 and its marked text
recovered through glyphs; junk and missing files refused with the right reason.

- [ ] `pnpm -C apps/desktop exec vitest run --project node test/pdf-comments.test.ts` → green
- [ ] Commit `feat(pdf): read a PDF's comment threads in main through PDFium`

### Task 4: `holi pdf comments`, the route and the wiring

**Files:** modify `main/agent/ops.ts`, `main/agent/hook-server.ts`, `main/agent/cli.ts`, `main/index.ts`;
tests `test/agent-ops.test.ts`, `test/agent-cli.test.ts` (and the hook-server test if it pins the
content type).

**Behaviour:** `holi pdf comments <path> [--json]` prints the readable layout (or JSON) to stdout and
exits 0; a refusal prints `holi pdf comments: <message>` to stderr and exits 1.

- **Deliberate departure from ops.ts's "every refusal is a value" rule, and say so in the route's
  comment:** this command's output _is_ the answer, and the spec wants stderr and a non-zero exit.
  The route answers `200` with a `text/plain` body (readable or JSON text) on success, `422` with a
  one-line `text/plain` message on refusal. `OpsReply` gains an optional `contentType`; the hook
  server uses it, defaulting to `application/json` so every existing route is unchanged.
- Route `/pdf/comments`, params `path` and `json` (`'true'`). Dep:
  `pdfComments(path: string): Promise<{ ok: true; path: string; threads: PdfCommentThread[] } | { ok: false; error: string }>`.
  The route formats with Task 1's functions; the dep owns the vault. A thrown dep is a 422 too.
- The dep in `index.ts`: `rootFor(remote)` → `vaultRelPath(path)` (refuse what it rejects) → must end in
  `.pdf` (case-insensitive) → the Node-only canonicalising entrypoint from
  `@holi/shared/path-safety-node` so a symlink cannot leave the vault → `readPdfComments`. Messages:
  `no vault is open`, `<path> is not a vault path`, `<path> is not a PDF`, `<path> not found`,
  `<path> is password-protected`.
- Script: new `pdf` → `comments` case. Parse options into variables first (the file's own scar
  comment explains why), then one `curl -sS -X POST -w '\n%{http_code}'` without `--fail-with-body`;
  split the last line off as the status; print the body to stdout on 200, to stderr with the prefix
  otherwise, `exit 1`. Add the line to both the header comment and `usage`; the header's "every
  command here is reversible" becomes true of a read too, say it is read-only.

Tests: route with a fake dep (text, JSON, each refusal is 422 with the message, a thrown dep);
the real script against a live hook server with a fake dep (stdout and exit 0; stderr and exit 1;
`--json`; a path with a space arrives intact; `No comments in …` exits 0).

- [ ] Node project green for the touched tests; `pnpm typecheck`
- [ ] Commit `feat(agent): holi pdf comments prints a PDF's comment threads`

### Task 5: the skill and the allow rule

**Files:** create `main/agent/skills/pdf-comments/SKILL.md`; modify `main/agent/seed-content.ts`
(import `?raw`, `MANAGED_FILES`, `SETTINGS_JSON.permissions.allow`, the merge); test
`test/seed-content.test.ts`.

**Behaviour:** every vault, new or existing, gets the skill on its next open, and
`Bash(holi pdf comments:*)` in `permissions.allow`.

- Skill frontmatter `name: pdf-comments`, a `description` that triggers on "a PDF in the vault has
  review comments, or an ask quotes PDF comments". Body a few lines: the command and `--json`, what
  the output holds (page, kind of mark, marked text, author, dates, replies), that it reads the saved
  file so a mark made seconds ago may not be there yet. Not a manual.
- `SETTINGS_JSON.permissions.allow = ['Bash(holi pdf comments:*)']`, and in `settingsWithRequired` the
  same missing-rules merge `ask` has, for `allow`. Extend the `required` type.

Tests: the skill is in `MANAGED_FILES`; a settings file with an `ask` list and no `allow` gains the
rule and keeps the user's rules; one that already has it returns `null` (no rewrite); a user `allow`
list keeps its entries.

- [ ] Node project green; commit `feat(agent): a pdf-comments skill, and the command runs without a prompt`

### Task 6: live check of the command (before any UI)

- Ask him to restart the dev app (main changed; the `holi` script is rewritten at launch).
- In a session in his vault: `holi pdf comments ai-platformen-som-open-source.pdf` prints the threads
  with no permission prompt; `--json` parses; `holi pdf comments nope.pdf` exits 1 with the message.
  Read-only, so his vault is safe for this.
- `pnpm --filter @holi/desktop build`, then confirm `out/main/index.js` still `require`s
  `@embedpdf/engines/pdfium` (externalised) rather than bundling it.

### Task 7: the Ask agent button and popover

**Files:** create `renderer/src/lib/pdf-comments.ts`, `renderer/src/composites/AskAgentPopover.tsx`;
modify `lib/pdf-viewer-config.ts`, `features/files/PdfDocument.tsx`, `primitives/Popover.tsx` (export
`PopoverAnchor` if absent); tests `test/pdf-viewer-config.test.ts` (node),
`features/files/__tests__/PdfDocument.test.tsx` (dom), a small dom test for the popover.

**Behaviour:** beside the comments button, "Ask agent about this comment" when a comment is selected,
"Ask agent about all comments" otherwise (disabled when there are none). Either opens a popover
under the button: instruction field and session picker; Enter sends
`askPrompt(instruction, formatCommentThreads(path, threads))` through `sendToAgentAtom`, which pastes
and never submits. A refusal keeps the text and shows the message.

- `lib/pdf-comments.ts` (pure): `threadsInViewer(state, documentId)` maps
  `state.plugins.annotation.documents[doc].byUid[*].object` to `PdfAnnotationInput` (store `rect` is
  `{origin,size}`: flatten it) and calls `commentThreads`; `selectedThread(threads, selectedId)` finds
  the thread whose root or a reply has that id. Marked text: `custom?.text`; for a text-markup mark
  without it, resolve once per ask through the viewer's engine (`registry.getEngine()`, same
  `getPageGlyphs` + `glyphRuns` + `getTextSlices` as main) so an Acrobat highlight reads the same in
  the ask as in the command.
- Two commands (`ASK_AGENT_THREAD`, `ASK_AGENT_ALL`) whose `visible` swaps on whether the store has a
  selected annotation that belongs to a thread, like the read-only pair; both in `HOLI_BUTTONS`,
  inserted by `withHoliButtons` right after the comments button. An icon registered the way the lock
  glyphs are (`holi-…`), not a new mechanism.
- The action records the anchor (the button's `getBoundingClientRect()`, found in the shadow root by
  the id the empty-wrapper CSS already targets, excluding `.holi-sidebar-leaving`) and the scope in
  React state; `AskAgentPopover` is a Radix popover anchored with a virtual ref to that rect. It portals
  to `document.body`, so Tailwind reaches it. Targets: `askTargetsAtom` and `defaultAgentTargetAtom`,
  as `TaskBodyEditor` does; same picker shape and placeholder copy as the note popover
  (`editor/askAgent.ts`), New session last.
- Threads are read at the moment the popover opens, from the live store, so an unsaved mark is in it.
- No em dashes in any copy.

Tests: config puts both ids after the comments button; dom: with a selected comment the thread
command is visible and its ask holds only that thread; with none, all threads; the fake
`sendToAgent` receives the text with the instruction first and no submit; a refusal keeps the field's
text. Extend the dom test's annotation/commands/ui fakes with anything newly called
(`getSelectedAnnotation`, the engine, …).

- [ ] Dom project green, then node project, lint; commit `feat(pdf): Ask agent about a comment, or all of them, from the top bar`

### Task 8: docs and consolidation

- `prd/pdf-export.md` §Viewing a PDF: a bullet **Comments reach the agent (D106)**: the button, the
  popover, pasted never submitted, the command, reads the saved file. Hand-edit; the file is not
  Prettier-clean, never `--write` it.
- `prd/agent.md`: one line on the `holi` toolkit gaining `pdf comments` (read-only, allowed without a
  prompt), near L324.
- `not-built.md` §PDF export: delete the entry. `decisions.md`: D106 row in the table, next free D107.
  `architecture.md`: `main/pdf/comments.ts` runs PDFium in main, if the main-process module list names
  `main/pdf/`.
- Commit `docs: PDF comments reach the agent (D106)`.

## End-to-end verification

1. All gates, one at a time (never node and dom together, never beside a build):
   `pnpm -C packages/shared test`, `pnpm -C apps/desktop exec vitest run --project node`,
   `... --project dom`, `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm --filter @holi/desktop build`,
   Prettier `--check` on touched files only.
2. Over CDP (port 9333, driver in the handoff dir), **on a copy** of his PDF placed in the vault only
   if he agrees, otherwise through the dom tests and the command on his existing file: make a comment
   in the viewer, press Ask agent, the popover's send pastes the thread into a session unsubmitted;
   after the one-second save, `holi pdf comments <copy>` in that session prints it.
3. Report and let him look before the docs commit if anything in the UI changed from the spec.
