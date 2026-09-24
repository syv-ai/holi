# PDF comments reach the agent

**Date** 2026-09-24 · **Status** agreed, not built

> We need to plan how we can send comments to an agent from our PDF comments.

A PDF in the vault may be a client's document brought into Holi to ask the agent something
about, or a Typst export that someone else has commented on and that Claude should now
resolve. Either way, **what matters most is that Claude can see the comments, who added
them and when.** Two things deliver that: an **ask** sent from the PDF viewer, and a
command, **`holi pdf comments`**, that the agent can run on any PDF in the vault
whenever it likes. The command is the second tool in the small CLI toolkit the vault
assistant starts with and grows as it needs more.

## Why the agent cannot simply read the file

Comments are ordinary PDF annotations, and a PDF saved by Holi keeps them as plain strings:
`/Contents` (the comment), `/T` (author), `/CreationDate` and `/M` (created, modified), `/NM`
(a stable id), and embedpdf's own `/EPDFCustom` with the text a highlight covers. A
standard-library Python script read all of them from `ai-platformen-som-open-source.pdf`.
That does not generalise:

- **Other tools compress.** Acrobat and most editors pack objects into compressed object
  streams (`/ObjStm`) and write strings as UTF-16, so a text search finds nothing, and the
  machine has no PDF library to fall back on (no pypdf, PyMuPDF, qpdf or mutool;
  `pdftotext` ignores annotations).
- **The marked text is embedpdf's alone.** An Acrobat highlight stores only its rectangles;
  recovering the words under it means extracting text by position.
- **Claude Code's own PDF reading** shows page text and images, not authors or dates, and
  the agent would only go digging if asked to.

The viewer, meanwhile, has already parsed every comment through PDFium, whoever wrote it.
And a spike (2026-09-24) ran embedpdf's own engine in Node under Electron: `@embedpdf/pdfium`'s
Node build plus `PdfiumNative` from `@embedpdf/engines` read all nine annotations of an older
version of that PDF in 83 ms, with page, type, author, dates, ids and the marked text. So
main can use the very parser the viewer uses.

## Design

### One thread model, two readers, one formatter

- **The model** is pure and browser-safe, in `packages/shared` (say `pdf-comments.ts`). A
  **comment thread** is: page (1-based), the kind of mark (highlight, underline, strikeout,
  squiggly, pinned note, free text, ink, shape, stamp; named, not numbered), the marked text
  when the mark covers text, author, created and modified, the comment text (possibly
  empty), and its replies in order, each with author, dates and text. Threads are ordered
  by page, then by position on the page, then by creation time.
- **The same module formats** threads as readable text and as JSON (below). One layout, so
  a pasted ask and the command's output read the same.
- **Reader 1, the viewer** (renderer): threads from the annotations in the open viewer's
  store, for the ask. It reads the live store, so a mark made a moment ago is included
  before it is saved.
- **Reader 2, main** (`main/pdf/comments.ts`): threads from the file on disk, through PDFium
  in Node, for the command. PDFium is initialised once, on first use; each call opens,
  reads and closes the document.
- **Marked text.** embedpdf's saved `custom.text` when present; otherwise PDFium's
  `getTextSlices` over the mark's rectangles, which is what lets an Acrobat highlight say
  what it covers.
- **Replies.** Linked by `inReplyToId` (`/IRT`). No version of the test PDF holds one, so
  the build starts by making a reply on a scratch copy through the engine, to see how
  embedpdf stores it, before the model commits to that.
- **The set** is the one the comments panel lists: a highlight with no comment is included,
  because it can be feedback on its own, and is shown as "no comment". Links and form
  fields are not comments.

### The readable layout

The same for the ask and for `holi pdf comments`:

```
[From contracts/acme-msa.pdf, 2 comments]

Page 4, highlight on "payment within 60 days"
  Ada Holm, 2026-09-22 14:10
  > Should be 30 days, per our terms.
  Reply, Bo Lind, 2026-09-22 15:02
  > Agreed.

Page 7, note
  Bo Lind, 2026-09-23 09:41
  > Is this clause standard?
```

The header names the vault path, so the agent knows the file and can run the command on it.
Dates are local time to the minute. The marked text is quoted in full; a multi-line comment
is quoted line by line. `--json` gives the same threads with ids and ISO timestamps.

### The ask

- **One "Ask agent" button on the viewer's top bar**, beside the comments button. With a
  comment selected it asks about that thread ("Ask agent about this comment"); with none it
  asks about all of them ("Ask agent about all comments"). Two commands whose `visible`
  swaps, like the read-only toggle, because a command's label is fixed. Nothing is
  injected into the viewer's own comment cards.
- **It opens a popover under the button**, the same shape a note selection's Ask agent
  has: an instruction field and the session picker (live sessions, then New session;
  needs-you sessions left out). Your instruction goes first and the comments follow; an
  empty instruction sends the comments alone.
- **It pastes and never submits**, through `sendToAgentAtom` like every other ask
  (`prd/agent.md` §An ask is pasted, never submitted). A target that ended in the meantime
  is refused with the reason, and the text stays in the popover.
- The popover is Holi's (a Radix popover in `primitives/`), anchored to the button's
  position inside the viewer's shadow root.

### The command

- **`holi pdf comments <path> [--json]`**: one more case in the generated `holi` script
  (`main/agent/cli.ts`), calling one more route on the existing agent ops server
  (`main/agent/ops.ts`, the hook server's loopback and per-session token). The token decides
  the vault; the path is vault-relative, checked with `vaultRelPath`, and must be an
  existing `.pdf`.
- **Output**: the readable layout by default; `--json` for data.
- **Errors**: not found, not a PDF or password-protected is a one-line message on stderr
  and a non-zero exit. No comments is `No comments in <path>.` and exit 0.
- **It reads the file on disk**, so a mark still inside the viewer's one-second quiet window
  is not there yet. The ask, which reads the viewer, has it.
- **The wasm must ship with main's build**, not only the renderer's (today only the
  renderer imports it). How it is emitted and found in a packaged app is the plan's to pin
  down.
- **Allowed without a prompt**: it is read-only. The seeded `.claude/settings.json` gains
  `permissions.allow: ["Bash(holi pdf comments:*)"]` through `settingsWithRequired`, so
  existing vaults get it on their next open; the plan checks that the merge reaches
  `permissions.allow`.

### The skill

A slim managed skill, `.claude/skills/pdf-comments/SKILL.md` (in `MANAGED_FILES`, so an
unedited copy is updated in existing vaults): use it when a PDF in the vault has review
comments or an ask quotes them; the command and its flag; what the output holds (page, mark,
marked text, author, dates, replies). A few lines, not a manual.

## Out of scope

- The agent writing replies or resolving comments in the PDF. The command is read-only;
  a write side can come later, gated like any reversible write.
- Knowing which note a PDF was exported from. Exports record no provenance, and a
  re-export replaces the file's bytes, comments included; that is worth solving on its own.
- A generic registry for Holi's CLI tools. `holi` grows by subcommands for now.

## Verification

- **Shared**: node tests for ordering, the readable layout (empty comment, multi-line
  comment, replies, no comments) and the JSON shape.
- **Main reader**: node tests against small committed fixtures, one saved by embedpdf with a
  reply and a highlight, and one compressed, UTF-16 file as another tool writes it; the
  marked text is recovered for a highlight without `custom.text`.
- **Command**: the ops route test (token → vault, path checks, errors), and the generated
  script's new case.
- **Seeding**: the skill is managed, and the allow rule merges into an existing settings
  file.
- **Ask**: a dom test that the button asks about the selected thread, or about all when
  none is selected, and pastes through a fake `sendToAgent` without submitting.
- **End to end**, over CDP in the running app: a comment made in the viewer appears in the
  pasted ask, and `holi pdf comments` run from a session prints it once saved.
