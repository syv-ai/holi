# Ask Claude About a Selection Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select a passage in a note, press one button, and the agent panel opens seeded with that note's path, the exact line range, and the quoted text.

**Architecture:** A CodeMirror tooltip over a non-empty selection, provided by a `StateField` through the `showTooltip` facet. Its button calls a new `askAgent` seam on `EditorDeps`, following the `nav` seam exactly. `EditorPane` wires the seam to `agentSeedPromptAtom` and `agentPanelOpenAtom`, both of which already exist and already have two callers between them.

**Tech Stack:** TypeScript, CodeMirror 6 (`showTooltip`, `StateField`), Jotai, Vitest (`dom` project).

**Adopted from:** `syv-ai/ailex-but-better-private`'s `DocumentPane.handleChatAboutSelection` and its TipTap `BubbleMenu`. The prompt shape is theirs. The line numbers are not: Ailex recovers them by searching the markdown source for the selected substring, which is approximate by construction, and CodeMirror hands over the exact range from the selection.

---

## Constraints

- **The mail composer must not get this.** `mailComposerExtensions` is a separate stack precisely because it knows nothing about a vault, and a seeded vault prompt is exactly the kind of thing it must not grow. The seam goes on `EditorDeps`, which only `baseEditorExtensions` takes.
- **The plain-text stack does not get it either.** `plainTextExtensions` takes a path and a read-only flag and nothing else. A `.json` is not a note.
- **No new transport.** `agentSeedPromptAtom` is the whole wire.
- **Read-only files show no button.** A reconcile is resolving them (`vaults-sync.md` FR-19); handing that file to a second agent conversation mid-merge is the one case this must not offer.

## File structure

| File | Responsibility |
|---|---|
| `renderer/src/editor/askAgent.ts` (create) | The selection tooltip and the prompt text. Nothing else. |
| `renderer/src/editor/extensions.ts` (modify) | `askAgent` on `EditorDeps`; the extension in `baseEditorExtensions` only. |
| `renderer/src/composites/EditorPane.tsx` (modify) | Wires the seam to the two atoms, through a ref like `navRef`. |

Test commands:

```bash
pnpm -C apps/desktop exec vitest run --project dom src/renderer/src/editor/__tests__/askAgent.test.tsx
pnpm -C apps/desktop test
pnpm typecheck && pnpm lint
```

---

### Task 1: The prompt text

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/askAgent.ts`
- Test: `apps/desktop/src/renderer/src/editor/__tests__/askAgent.test.tsx`

**Contract:**

```ts
/** The seeded turn for a selection. `from`/`to` are 1-based inclusive line
 *  numbers, `path` is the note's vault path. */
export function selectionPrompt(path: string, from: number, to: number, text: string): string
```

Output, matching Ailex's shape with Holi's path grammar:

```
[From projects/roadmap.md, lines 12-18]
> Ship the thing by June.
> Then the other thing.
```

A single-line selection reads `line 12`, not `lines 12-12`.

- [ ] **Step 1** Write the test: a multi-line selection quotes every line with `> `; a single line says `line 12`; an empty line inside the selection still gets its `> `; the path appears verbatim.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

---

### Task 2: The selection tooltip

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/askAgent.ts`
- Test: extend `__tests__/askAgent.test.tsx`

**Contract:**

```ts
/** Shows an "Ask Claude" button over a non-empty selection. `notePath` is
 *  static per editor instance (the view is rebuilt per doc), `onAsk` is called
 *  with the finished prompt. Contributes nothing when the state is read-only. */
export function askAgentTooltip(notePath: string, onAsk: (prompt: string) => void): Extension
```

- [ ] **Step 1** Write the test: an empty selection provides no tooltip; a non-empty one does; clicking the button calls `onAsk` with `selectionPrompt`'s output for the selected range; a read-only state provides no tooltip.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement as a `StateField<readonly Tooltip[]>` provided through `showTooltip.computeN`, recomputed on selection change. Derive the line numbers with `state.doc.lineAt(range.from).number` and `.lineAt(range.to).number`, and the text with `state.sliceDoc(range.from, range.to)`.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

**Gotcha:** the tooltip's DOM must not steal the selection. Give the button `onMouseDown` with `preventDefault`, or clicking it collapses the very selection it is about to send.

**Gotcha:** `EditorState.readOnly.of(...)` is what `baseEditorExtensions` sets for a locked file. Read `state.readOnly`, not the `editable` facet, since only the former is a state field.

---

### Task 3: The seam

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts` (`EditorDeps`, and `baseEditorExtensions` only)
- Modify: `apps/desktop/src/renderer/src/composites/EditorPane.tsx` (~line 88, beside `navRef`; and the `baseEditorExtensions` call at ~160)
- Test: extend `apps/desktop/src/renderer/src/composites/__tests__/` for `EditorPane`, or the editor tests if that is where the stack is exercised

`EditorDeps` gains:

```ts
/** Hand the current selection to the agent as a seeded turn. */
askAgent: (prompt: string) => void
```

- [ ] **Step 1** Write the test: a selection plus a click sets `agentSeedPromptAtom` to the prompt and `agentPanelOpenAtom` to true; `mailComposerExtensions` and `plainTextExtensions` produce no such tooltip.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement. Hold the callback in a ref exactly as `navRef` is held, so the extension list does not rebuild per render.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

---

### Task 4: Verify in the running app

- [ ] **Step 1** `pnpm dev:debug`, open a note, select two paragraphs.
- [ ] **Step 2** Confirm the button appears over the selection, and that clicking it opens the panel with the quoted text and the right line range already typed.
- [ ] **Step 3** Confirm the agent's answer refers to the right lines.
- [ ] **Step 4** Confirm no button appears in the mail composer or in an open `.json`.
- [ ] **Step 5** Screenshot with `pnpm exec node apps/desktop/cdp.mjs --shot`.

---

### Task 5: Documentation

- [ ] **Step 1** Add a line to [`docs/prd/notes-editor.md`](../prd/notes-editor.md) describing the affordance, and cross-reference it from [`docs/prd/agent.md`](../prd/agent.md) beside the other seeded-prompt producer (the reconcile).
- [ ] **Step 2** Add the verified entry to `docs/upcoming.md`.
- [ ] **Step 3** Commit.

---

## Gates before done

```bash
pnpm -C apps/desktop test
pnpm typecheck
pnpm lint
```
