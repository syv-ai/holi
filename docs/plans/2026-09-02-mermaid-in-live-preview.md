# Mermaid in Live Preview Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fenced ` ```mermaid ` block draws as a diagram in the editor, and reverts to source when the caret enters it.

**Architecture:** One more case in the live-preview decoration builder. `livePreview.ts` already handles `FencedCode` and already has `activeHere` in scope, which is the whole reveal rule; a mermaid fence becomes a `Decoration.replace` carrying a block widget instead of the per-line `codeLine` decoration. Mermaid itself is dynamically imported on first use and renders asynchronously into a placeholder the widget puts up synchronously.

**Tech Stack:** TypeScript, CodeMirror 6 (`WidgetType`, `Decoration.replace`), `mermaid` (new dependency, lazy), Vitest (`dom` project).

**Adopted from:** `syv-ai/ailex-but-better-private`'s `MermaidCodeBlock.tsx`, which is a TipTap node view. Only the idea ports; the mechanism is CodeMirror's.

---

## Scope

**In:** the editor. **Out, and deliberately:** the PDF. See §The export half below, which needs its own design before anything is built for it.

## Constraints

- **The reveal rule is not reimplemented.** A fence the selection touches renders raw, because `activeHere` already says so for every other node type. Do not add a second notion of "the caret is here".
- **Rendering must not run on every rebuild.** `livePreview` rebuilds on `docChanged`, `selectionSet` **and** viewport change, so a widget whose `eq` is wrong re-runs mermaid on every arrow key. `eq` compares the fence source, and nothing else.
- **A broken diagram is not an error state.** Mermaid throws on invalid syntax. The widget shows the source, the way a broken image falls back to alt text.
- **No new dependency in the main process.** Mermaid needs a DOM and belongs to the renderer alone.

## File structure

| File | Responsibility |
|---|---|
| `renderer/src/editor/mermaidWidget.ts` (create) | The widget: placeholder now, SVG when the render resolves, source on failure. |
| `renderer/src/editor/livePreview.ts` (modify) | The `FencedCode` case branches on `fenceLanguageId(info) === 'mermaid'`. |
| `apps/desktop/package.json` (modify) | `mermaid` as a dependency. |

Test commands:

```bash
pnpm -C apps/desktop exec vitest run --project dom src/renderer/src/editor/__tests__/mermaid.test.tsx
pnpm -C apps/desktop test
pnpm typecheck && pnpm lint
```

---

### Task 1: The dependency

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1** `pnpm -C apps/desktop add mermaid`. Pin the exact version, matching how the rest of the file pins.
- [ ] **Step 2** Confirm it is imported nowhere yet, so this commit changes no behaviour.
- [ ] **Step 3** Run `pnpm -C apps/desktop test` to confirm the install disturbed nothing.
- [ ] **Step 4** Commit.

**Gotcha:** pnpm 10 requires an `onlyBuiltDependencies` entry for any package wanting a build script. Check the install output and add one if it asks.

---

### Task 2: The widget

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/mermaidWidget.ts`
- Test: `apps/desktop/src/renderer/src/editor/__tests__/mermaid.test.tsx`

**Contract:**

```ts
/**
 * A rendered mermaid diagram, replacing its fence in live preview. `source` is
 * the fence body without the delimiters. Renders asynchronously: `toDOM` returns
 * a sized placeholder immediately and swaps in the SVG when mermaid resolves, so
 * an invalid diagram degrades to its own source rather than an error.
 */
export class MermaidWidget extends WidgetType {
  constructor(readonly source: string)
  override eq(other: MermaidWidget): boolean   // source equality, nothing else
  override toDOM(): HTMLElement
}
```

- [ ] **Step 1** Write the test with mermaid mocked: `toDOM` returns an element synchronously; the SVG lands once the mocked render resolves; a rejected render leaves the source text visible; `eq` is true for equal sources and false otherwise; two `toDOM` calls for the same source do not both invoke mermaid (the module import is memoised).
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement. `const { default: mermaid } = await import('mermaid')` behind a module-level promise so the import happens once; `mermaid.initialize({ startOnLoad: false })`; render with a unique id per call.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

**Gotcha:** `mermaid.render` appends a temporary element to `document.body` and can leave it behind on failure. Clean up in a `finally`, or a long session accumulates orphans.

**Gotcha:** the widget is destroyed when the decoration is rebuilt, which can happen before the render resolves. Guard the swap on the element still being connected, or you write an SVG into a detached node every caret move.

**Gotcha:** mermaid reads colours at initialize time. The vault theme can change while the app runs (D64, and `colorScheme` follows the OS live). Re-initialize on a theme flip, or diagrams rendered before it keep the old palette. If that turns out to need real work, render the theme-neutral variant and note the gap rather than growing this task.

---

### Task 3: Wire it into live preview

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/livePreview.ts` (the `FencedCode` case, ~line 146)
- Test: extend `__tests__/mermaid.test.tsx`

- [ ] **Step 1** Write the test: a ` ```mermaid ` fence with the caret elsewhere renders the widget; the same fence with the caret inside it renders raw source lines; a ` ```python ` fence is untouched by this change; a fence with no info string is untouched.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement. Read the info string from the fence's first line, pass it through `fenceLanguageId`, and when it is `mermaid` and `!activeHere`, push one `Decoration.replace({ widget: new MermaidWidget(body), block: true })` over the whole node instead of the per-line `codeLine` decorations. Otherwise fall through to the existing behaviour unchanged.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

**Gotcha:** a block-level `Decoration.replace` must cover whole lines. Span from the start of the fence's first line to the end of its last, or CodeMirror throws on a block decoration with partial line coverage.

---

### Task 4: Verify in the running app

- [ ] **Step 1** `pnpm dev:debug`, write a mermaid fence in a note.
- [ ] **Step 2** Confirm it renders, and that clicking into it shows the source.
- [ ] **Step 3** Confirm an invalid diagram shows its source and does not blank the editor.
- [ ] **Step 4** Hold an arrow key through a note containing three diagrams and confirm the editor stays responsive. This is the `eq` check, and it is the one thing that will not show up in a unit test.
- [ ] **Step 5** Screenshot with `pnpm exec node apps/desktop/cdp.mjs --shot`.

---

### Task 5: Documentation

- [ ] **Step 1** Add it to [`docs/prd/notes-editor.md`](../prd/notes-editor.md) beside the inline-images paragraph, which is the same kind of statement about the same mechanism.
- [ ] **Step 2** Add an entry to `docs/not-built.md` under §PDF export for the export half below, naming the three routes and what would decide between them.
- [ ] **Step 3** Add the verified entry to `docs/upcoming.md`.
- [ ] **Step 4** Commit.

---

## The export half, which this plan does not build

A diagram that renders in the editor and not in the PDF is a worse inconsistency than one that renders nowhere, so this cannot stay unanswered for long. It is out of scope here because it is a design question, not a task:

Mermaid needs a DOM, and the two places a PDF gets made have different amounts of DOM available. `ConvertToPdf` runs in the renderer, which has one. The agent's `md-to-pdf` skill shells `typst compile` directly and never enters Holi at all, so it has none. The three routes:

1. **Pre-render in the renderer.** Cheap, and fixes only the UI path. The agent's PDFs would still show code blocks, so the two paths would disagree.
2. **An offscreen `BrowserWindow` in main, behind an ops endpoint.** Both paths reach it, including the agent's through the `holi` CLI it already uses. Coherent, and the most work.
3. **Do not render mermaid in PDFs at all**, and say so in the `md-to-pdf` skill. Honest, and it keeps one story rather than two.

Route 2 is the only one where the two PDF paths agree, which is the property that matters. Whether it earns an offscreen window is the decision to make.

---

## Gates before done

```bash
pnpm -C apps/desktop test
pnpm typecheck
pnpm lint
```
