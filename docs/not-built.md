# Not built — designed, wanted, absent

The PRDs describe **the product that exists**. This file holds the other thing: work that is
wanted, mostly designed, and not built. The split exists because the two kinds of statement had
been living in the same sections, and a reader could not tell them apart — a PRD section that
reads as a specification is indistinguishable from one that reads as a plan, and both were being
believed.

Below this line there is **no ordering, no sizing, and no dates**. It is a list of what is missing,
which is the only claim it can make honestly.

**Audited entry-by-entry against the code on 2026-08-21.** Three entries were describing work that
had shipped — the reconcile → drawer handoff (2026-07-27), creating a task from a calendar event
and the document-template set (both 2026-08-04) — and are gone, folded into their pillars. They
predated this file, which was written from PRD prose rather than from the code; the entries that
came after it were all accurate. The rule that follows is in the [README](README.md): an entry gets
checked against the code when it is *written*, not only when it is purged. The audit's own two
findings — the reconcile's read-only files and its abandon affordance — were built the same day
and purged with everything else.

## What belongs here, and what does not

An entry answers **"what could we build next"**. If a thing is absent and the honest statement is
**"why it isn't here, and what would change that"**, it is a boundary with a trigger condition —
product shape — and **the PRD owns it alone**. Squashing the autosave journal, an OS network-status
listener, a template output target nobody has asked for, and rename-as-a-slash-command are all of
that kind: each is deliberately absent, each names the observation that would revive it, and each is
complete in its own PRD. Filing them here too would be a second copy of a claim, which is exactly
what the consolidate-then-purge rule exists to prevent.

So this file also does not hold **non-goals** ("Holi is not a full email client" describes the
product's shape as surely as any feature does), **rejected alternatives** (only useful beside the
design that beat them), or **admitted uncertainty about behaviour that ships** ("the debounce is 3
seconds, tuned rather than derived").

Each entry names where its design and its reasoning live, because the reasoning belongs with the
pillar that owns it and not with the backlog.

**When something here gets built, this file purges it.** The entry's reasoning — including any
sub-question it carried — folds into the owning PRD as a description of what now exists, and the
entry is deleted. This is the same cycle [`decisions.md`](decisions.md) runs, for the same reason the
[README](README.md) gives: "not built" is a *claim about how things are*, so two copies of it can
contradict each other. A plan, by contrast, records what was done on a date and cannot go stale.

---

## Agent

**Vault apps — state, writes, and a backend.** The feature itself is **built**: slice 1 shipped
(2026-08-20), so an agent-authored app in `.holi/apps/<id>/` opens as a themed tab and reads the
vault's notes and tasks. [`prd/vault-apps.md`](prd/vault-apps.md) describes it. What is absent is
everything downstream of one undecided question — **where app state lives**, which the PRD's §State
holds open on purpose: it is per-app rather than per-platform (a retro board's state is shared by
nature; a CSV explorer's is nobody else's business), so it waits for real apps to say which kind was
missed. Nothing here is blocked on design; each is additive against the surface that exists:

- `holi.data` and **every write call** — the trust model already permits writes, so this is the
  state question and nothing else.
- The `utilityProcess` **backend** (`server.mjs`) and **personal apps** in `userData/apps/` —
  each waits for an app that needs it.
- **Auto-reload** — deliberately not a second surface. (The command-palette entry was the other half of this line until D102 built it, 2026-09-21.)

No longer absent, as of slice 2 (2026-08-20): the app **manifest** (`app.yaml`, now the
registration marker), a `holi` CLI the agent can type (`app open`, `app init`, `seed refresh`),
and **an agent action that opens an app** — which was the gap that made slice 1's authoring loop
end in "ask the user to go and look".

**The two apps this document keeps using as examples — the retro board and the poll — still cannot
be built**, because both need shared state. That, rather than any missing API, is the measure of the
gap.

**Self-improvement / curator loop.** Designed around headless background forks and dropped from v1:
unproven value, and in a shared vault one person's background agent auto-editing **shared** skills
and memory is a real hazard. **If revived, the shape is already decided:** auto-edits are scoped to
the **personal** layer only, and shared-layer changes become **proposals requiring approval**.

**Agent theme proposals.** The agent authors a vault's theme today
([`architecture.md`](architecture.md) §9); having it *propose* one for approval is not built.

## Telling the agent something, unprompted

Holi has **no way to push text into a live Claude Code session.** Ops runs the other way (the agent
calls Holi), and the only channel into a running session is its PTY — where anything written lands
in the user's input box as if they had typed it, which is worse than saying nothing.

This bites the pre-commit transforms (D76 part 4, [`prd/vaults-sync.md`](prd/vaults-sync.md) FR-9),
which wanted to tell the agent what they rewrote. The runner supports a `notify` callback and main
leaves it unwired. The substitute is a pull surface: a capped, machine-local
`.holi/state/hooks.local.log` the agent reads when asked — the first agent-readable log in Holi, and the
only one.

**Also not built:** D76's floor for when no agent session is open — surfacing a hook failure in the
sync status bar via `pause(reason)`. The log is the only surface today.

## Notes & editor

**True live preview inside an *unfocused* table cell.** A rendered table's cells read as prose since
2026-09-09 (#11, D93): bold is bold, inline code is code, a link is coloured, and `**`, `*` and
`` ` `` are hidden. What is not there is the real thing — a wiki-link is not a chip in a cell, a
markdown link still shows `[text](url)`, and an image is not drawn. **Why, exactly:**
`codemirror-markdown-tables` renders an unfocused cell itself, as a `contenteditable` div whose
spans it classes from `highlightingFor(rootState, tags)`. There are no decorations anywhere in that
path, and everything live preview does beyond colouring — concealing a delimiter, replacing a range
with a widget — *is* a decoration. The only editor in a table is the one that appears in the cell
you have clicked into, and that one already has the full inline stack. **What it would take:**
forking or patching the package so a cell view renders from a decoration set rather than from a
highlighter, or replacing the table widget with one of our own. Both are large, against a dependency
that is otherwise carrying its weight, and the gap is cosmetic — the source stays readable and one
click gives you the real editor. Worth revisiting only if tables become a place where wiki-links are
commonly written.

**A binary with no extension Holi knows opens as text, and looks like corruption.** `fileKind`
defaults to `text` for an unknown extension, which is the forgiving choice and the right one for a
`.env` or a `Makefile` — but a `.ttf` in `.holi/document-templates/_brand/fonts/` opens in the plain
editor as several screens of replacement characters, which reads as a broken file rather than as a
format with no viewer. Noticed 2026-08-20 while verifying the image plate; not fixed, because the
fix is a *third* answer between "editable text" and "typed placeholder" — probably a byte-sniff
rather than a longer extension list, since the whole point is the extensions nobody enumerated.

**Viewing a `.docx` Holi cannot render.** A `.docx` in a vault gets a typed placeholder naming what it is. Opening one in place, `mammoth`-rendered HTML say, is not built. **A PDF is no longer in this entry**: the viewer shipped on 2026-09-21 (D103, [`prd/pdf-export.md`](prd/pdf-export.md) §Viewing a PDF), embedpdf's ready-made viewer over its own PDFium wasm, with marks saved into the file, and an earlier version of this paragraph calling the viewer "genuinely optional" because originals are rarely opened was overtaken by his asking for it. **The framing this inherited is dead:** an earlier design converted incoming PDFs and `.docx` files to markdown on entry and archived the original to object storage, and D62 killed it, because the vault is text-first *by authorship*, so rich documents are what it **emits**, not what it imports. What survives is the viewer, and for `.docx` the same question the PDF answered stands: given how rarely an original is opened, "reveal it in the Finder and let the OS open it" may be the whole feature. The old viewer's lesson is recorded in the PDF design rather than here: the previous app's EmbedPDF integration was ~1550 LOC on the headless route with worker-engine and StrictMode hangs on "Loading PDF…", and the ready-made shape avoided all of it.

**Importing a folder.** Dropping a folder in from Finder is refused with a sentence — the copy is
per file, and recursing means deciding what to do about the files inside it that collide, which is
the same question the flat case answers one at a time and a folder answers all at once.

**Dragging a row out to Finder.** `webContents.startDrag` starts a drag the app's own window
accepts — that round trip is what the in-tree move rides on — but Finder refuses the drop, so
nothing lands. Verified by hand on macOS 2026-08-22; it cannot be covered by a test, because
neither Vitest nor CDP can drive an OS-level drag. The handler matches Electron's documented shape
(`files` + `file` + a non-empty `icon`), so the fault is not obviously in the call; the 1×1
transparent drag icon is the first thing to suspect. **Copy to Folder… / Move to Folder… exist
because of this** and cover the same need without a gesture, so the drag would be a convenience on
top rather than a missing capability.

## Tasks

**A time-grouped secondary board view** — "Today / This week / Later". Post-v1, and it returns as
an *option*, never a mode to configure: a second view earns its place only by not multiplying the
config space that [`prd/tasks.md`](prd/tasks.md) §What the design deliberately excludes closes off.

**Assignees**, and with them per-person reminders on shared tasks. This is the answer if
vault-wide reminders prove noisy — **not** a private reminder channel, which would make a shared
task mean different things to different members.

## Google mail & calendar

**A task that lights up for a recurring event series** — the reminders and agenda tie-in across
[`prd/tasks.md`](prd/tasks.md) and [`prd/daily-notes.md`](prd/daily-notes.md). Untouched by
D67–D70.

## PDF export

**A mermaid diagram renders in the editor and not in the PDF.** Since 2026-09-09 a ```mermaid fence
draws as a diagram in a note ([`#6`](https://github.com/syv-ai/holi/issues/6)); a PDF made from that
note still shows the fence as a code block. That inconsistency is worse than the feature being absent
in both places, so it should not stay open long — but it is a design question rather than a task, and
it is [`#9`](https://github.com/syv-ai/holi/issues/9).

**Why it is not simply "call mermaid in the exporter".** Mermaid needs a DOM, and the two places a
PDF gets made have different amounts of one. `ConvertToPdf` runs in the renderer and has a DOM. The
agent's `md-to-pdf` skill shells `typst compile` directly and never enters Holi at all, so it has
none. Three routes, and the choice between them is the decision:

1. **Pre-render in the renderer.** Cheap, and fixes only the UI path — the agent's PDFs would still
   show code blocks, so the two paths would disagree about what a vault's documents look like.
2. **An offscreen `BrowserWindow` in main, behind an ops endpoint.** Both paths reach it, the agent's
   through the `holi` CLI it already uses. Coherent, and much the most work.
3. **Do not render mermaid in PDFs at all**, and say so in the `md-to-pdf` skill. Honest, and it
   keeps one story rather than two.

Route 2 is the only one where the two PDF paths agree, which is the property that matters. Whether
that earns an offscreen window is what has not been decided.


**Template distribution across vaults.** Templates are per-vault committed content, which is what
makes a team consistent *within* a vault and does nothing across five of them. A shared brand repo
cloned as a vault is the obvious answer and has not been designed.

## Daily notes

**Templates / configurable seed content.** The seed is `type: daily-note` frontmatter plus a title
heading, in code. Deferred post-v1.
