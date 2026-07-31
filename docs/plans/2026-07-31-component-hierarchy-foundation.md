# Component Hierarchy — Foundation & Tracer Slice Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the primitives → composites → features hierarchy (shadcn/Radix-based, Tailwind-v4 semantic tokens), prove it end-to-end with one tracer slice (`CreateTask` through `Dialog`), and put an AST-based pre-commit gate behind it.

**Architecture:** Three renderer layers with a strict one-way import rule — `primitives/` (the only place Radix/shadcn and native form elements are touched), `composites/` (domain-agnostic patterns), `features/` (domain-aware content). Dialogs stop being feature components: a **content block** + a **one-line registry entry** (`{ id, size }`) are summoned by a single `activeDialogAtom` + `<DialogHost>`. Everything reaching the screen enters through our own primitives; styling/behaviour/accessibility are fixed once.

**Tech Stack:** React 18 · Jotai · Tailwind v4 (CSS-first `@theme`) · Radix (`@radix-ui/react-dialog`) · `class-variance-authority` + `clsx` + `tailwind-merge` · Vitest 4 + Testing Library (jsdom project) · ESLint flat config + `eslint-plugin-boundaries` (the gate).

**Anti-pattern grounding** (names from the improve-code-design catalog): the registry & variant maps are **Strategy** (fix **Rigidity**); guarded `size`/`id` unions and the arbitrary-colour ban are **Replace Primitive with Object** (fix **Make-it-work / Primitive Obsession**); extracting `Input`/`FormField` out of `TaskDetail` is **Dependency Inversion** (fix the **Structure** inversion); the block/shell split is **Extract Class** (fix **Bloat**); the gate is boundary discipline (fix **Structure**). Guard on this plan itself: **two implementations justify a seam, one does not** — so `Drawer`/`Menu`/`Combobox`/`ConfirmDialog`/`IconButton`/`Select`/`Textarea` are named follow-ons, NOT built here (avoiding **Over-build**).

**Scope boundary.** This plan delivers: the token layer, the test harness, the gate (warn → enforce), and the tracer slice. It does **not** migrate the other 23 components or build the follow-on primitives — those repeat the proven pattern and get their own plan. This plan produces working, tested software on its own: `CreateTask` runs through the new `Dialog`, and the gate is live for migrated paths.

**House gotchas (from auto-memory — obey):**
- Bare `node`/`npx` are broken. Always `pnpm exec`. Bash cwd drifts — use an absolute `cd` in every command.
- Typecheck gate (from `apps/desktop`): `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` must stay **0**.
- Vitest 4 **silently ignores** `poolOptions.forks.singleFork`; the node project keeps `fileParallelism: false`. Do not regress it.
- Run the **full desktop suite** after any `window.holi`/preload/renderer-surface change — typecheck misses fake-preload gaps.
- Main-process edits need a relaunch; renderer edits hot-reload. This plan is renderer-only.

---

## File Structure

**New — foundation**
- `apps/desktop/src/renderer/src/lib/cn.ts` — `cn()` (clsx + tailwind-merge). The one class-merge helper.
- `apps/desktop/src/renderer/src/index.css` *(modify)* — the 3-tier `@theme` token layer + `@custom-variant dark`.
- `apps/desktop/src/renderer/src/primitives/` — `Button.tsx`, `Input.tsx`, `Dialog.tsx`, `index.ts`.
- `apps/desktop/src/renderer/src/composites/` — `FormField.tsx`, `index.ts`.
- `apps/desktop/src/renderer/src/features/` — `tasks/CreateTask.tsx` (block) lands here; existing `components/` migrate later.
- `apps/desktop/src/renderer/src/state/dialogs.ts` — `activeDialogAtom` (discriminated union) + open/close action atoms + the registry type.
- `apps/desktop/src/renderer/src/components/DialogHost.tsx` — reads the atom, renders the block inside `<Dialog>`. Mounted once in `Shell`.

**New — tooling**
- `apps/desktop/eslint.config.js` — flat config; the gate.
- `apps/desktop/test/setup.dom.ts` — jest-dom + Radix jsdom polyfills.
- `apps/desktop/vitest.config.ts` *(modify)* — `test.projects`: node (existing) + jsdom (renderer `.test.tsx`).
- `apps/desktop/tsconfig.json` *(modify)* + `electron.vite.config.ts` *(modify)* — `@/` alias → `src/renderer/src`.
- Root `package.json` *(modify)* — `simple-git-hooks` + `lint-staged` wiring.

**Modified — the tracer**
- `components/CreateTaskDialog.tsx` → **deleted**, becomes `features/tasks/CreateTask.tsx`.
- `components/TaskDetail.tsx` — stops exporting `taskFieldInput`/`Row`; consumes `Input`/`FormField` (in this plan only far enough to remove the upward export; full migration is follow-on).
- `components/Shell.tsx` — the three dialog conditionals collapse to `<DialogHost />`.

---

## Phase 0 — Foundation (tooling & seams; no visible UI yet)

### Task 1: Dependencies, `cn()`, and the `@/` alias

**Files:**
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/renderer/src/lib/cn.ts`
- Modify: `apps/desktop/tsconfig.json`, `apps/desktop/electron.vite.config.ts`, `apps/desktop/vitest.config.ts`

- [ ] **Step 1: Install runtime + dev dependencies**

Run (from repo root):
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/desktop add class-variance-authority@^0.7.1 clsx@^2.1.1 tailwind-merge@^3.3.0 @radix-ui/react-dialog@^1.1.6
pnpm --filter @holi/desktop add -D @testing-library/react@^16.1.0 @testing-library/user-event@^14.5.2 @testing-library/jest-dom@^6.6.3 jsdom@^25.0.1 eslint@^9.18.0 typescript-eslint@^8.20.0 eslint-plugin-boundaries@^5.0.1 eslint-plugin-react@^7.37.4 eslint-plugin-react-hooks@^5.1.0 lint-staged@^15.3.0 simple-git-hooks@^2.11.1
```
Expected: both complete; `pnpm-lock.yaml` updated. `tailwind-merge@^3` is the Tailwind-v4-compatible major (v2 targets v3 utility names).

- [ ] **Step 2: Write `cn()`**

`apps/desktop/src/renderer/src/lib/cn.ts`:
```ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** The one class-merge helper. clsx composes; tailwind-merge lets a caller's
 *  className override a primitive's default deterministically (last wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 3: Add the `@/` alias in three places**

The alias must exist for the compiler, the bundler, and the test runner (three separate configs — miss one and you get a green typecheck but a red test, or vice-versa).

`tsconfig.json` `compilerOptions`: add
```json
"baseUrl": ".",
"paths": { "@/*": ["src/renderer/src/*"] }
```
`electron.vite.config.ts` renderer block: add `resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } }` (import `resolve` from `node:path`).
`vitest.config.ts`: add the same `resolve.alias` (vitest does not read `electron.vite.config.ts`).

- [ ] **Step 4: Typecheck stays clean**

Run:
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: `0`.

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/renderer/src/lib/cn.ts apps/desktop/tsconfig.json apps/desktop/electron.vite.config.ts apps/desktop/vitest.config.ts
git commit -m "chore(ui): add cva/clsx/tailwind-merge/radix + @/ alias + cn()

Claude goes brr.. via Dash"
```

---

### Task 2: The semantic token layer (`@theme`, v4-native)

**Files:**
- Modify: `apps/desktop/src/renderer/src/index.css`

Grounding: **Replace Primitive with Object** — the raw palette (`neutral-800` ×47, `neutral-950` ×11, `sky-700` ×5) is a stringly primitive repeated at every call site; the token layer makes "surface / border / accent" the object the primitives reference. Note: this is the reversal of `architecture.md §9` ("NOT PORTED / raw Tailwind deferred") — recorded in the review, executed here.

- [ ] **Step 1: Add the three token tiers below the existing `@import 'tailwindcss'`**

Insert after line 1 of `index.css` (keep the `.holi-scroll` block below it untouched — it already reads `var(--color-neutral-700)`, which continues to work):
```css
/* Tier 1 — dark-mode switch driven by the data-theme root stamp (not prefers-color-scheme). */
@custom-variant dark (&:where([data-theme='dark'] *));

/* Tier 2 — semantic tokens mapped onto the built-in neutral/sky palette.
   Plain selectors (NOT @theme) so they re-cascade per theme scope. */
:root,
[data-theme='dark'] {
  --surface: var(--color-neutral-950);
  --surface-raised: var(--color-neutral-800);
  --border: var(--color-neutral-800);
  --accent: var(--color-sky-700);
  --accent-fg: var(--color-neutral-50);
  --foreground: var(--color-neutral-100);
  --muted-fg: var(--color-neutral-400);
  --danger: var(--color-red-900);
  --danger-fg: var(--color-red-200);
}
[data-theme='light'] {
  --surface: var(--color-neutral-50);
  --surface-raised: #ffffff;
  --border: var(--color-neutral-200);
  --accent: var(--color-sky-600);
  --accent-fg: #ffffff;
  --foreground: var(--color-neutral-900);
  --muted-fg: var(--color-neutral-500);
  --danger: var(--color-red-600);
  --danger-fg: #ffffff;
}

/* Tier 3 — expose semantics as utilities. @theme inline so the generated utility
   holds the pointer (var(--surface)), letting the tier-2 override re-cascade. */
@theme inline {
  --color-surface: var(--surface);
  --color-surface-raised: var(--surface-raised);
  --color-border: var(--border);
  --color-accent: var(--accent);
  --color-accent-fg: var(--accent-fg);
  --color-foreground: var(--foreground);
  --color-muted-fg: var(--muted-fg);
  --color-danger: var(--danger);
  --color-danger-fg: var(--danger-fg);
}

@theme {
  --radius-control: 0.5rem;
}
```

- [ ] **Step 2: Verify utilities generate (manual, dev app)**

Run `pnpm dev`, open devtools, confirm an element with `class="bg-surface border-border"` resolves to the neutral values and that stamping `data-theme="light"` on `<html>` flips them. (No automated assertion — Tailwind utility generation is the framework's contract, not ours.)

- [ ] **Step 3: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/index.css
git commit -m "feat(ui): semantic @theme token layer, data-theme dark variant

Claude goes brr.. via Dash"
```

---

### Task 3: Component-test harness (Testing Library on a jsdom Vitest project)

**Files:**
- Create: `apps/desktop/test/setup.dom.ts`
- Modify: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/src/renderer/src/primitives/__tests__/harness.test.tsx` (smoke, deleted at end of task)

Best practice: isolate DOM tests in a Vitest **project** so the existing node/watcher suite keeps `environment: 'node'` + `fileParallelism: false` untouched. Renderer component tests are `*.test.tsx` colocated under `src/renderer`.

- [ ] **Step 1: Write the jsdom setup file**

`apps/desktop/test/setup.dom.ts`:
```ts
import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())

// Radix relies on DOM APIs jsdom omits. Polyfill the ones its Dialog touches,
// or focus-trap/pointer interactions throw instead of exercising real behaviour.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
```

- [ ] **Step 2: Convert `vitest.config.ts` to two projects**

Keep the existing `test` block's settings for the node project verbatim (including the `fileParallelism: false` comment and `testTimeout`). New shape:
```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } }, // from Task 1
  test: {
    projects: [
      {
        // Existing main/state/git suite — unchanged behaviour.
        test: {
          name: 'node',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          passWithNoTests: true,
          fileParallelism: false, // Vitest 4 lever; poolOptions.singleFork is silently ignored.
          testTimeout: 20_000,
        },
      },
      {
        // Renderer component behaviour — jsdom + Testing Library.
        test: {
          name: 'dom',
          include: ['src/renderer/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['test/setup.dom.ts'],
        },
      },
    ],
  },
})
```
Gotcha: the node project's `include` stays `.test.ts` and the dom project's is `.test.tsx` — the split is by extension, so a component test must be `.tsx`.

- [ ] **Step 3: Write a failing smoke test**

`src/renderer/src/primitives/__tests__/harness.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

test('dom harness renders and jest-dom matchers work', () => {
  render(<button type="button">hello</button>)
  expect(screen.getByRole('button', { name: 'hello' })).toBeInTheDocument()
})
```

- [ ] **Step 4: Run the dom project — verify it passes**

Run:
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom
```
Expected: 1 passed. If `toBeInTheDocument` is not a function, the setup file did not load — check `setupFiles`.

- [ ] **Step 5: Confirm the node project still runs isolated**

Run:
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node 2>&1 | tail -5
```
Expected: the existing suite runs under `environment: node` (no jsdom), green. (Long — background + parse JSON if it exceeds the Bash timeout, per house practice.)

- [ ] **Step 6: Delete the smoke test, commit the harness**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
rm apps/desktop/src/renderer/src/primitives/__tests__/harness.test.tsx
git add apps/desktop/test/setup.dom.ts apps/desktop/vitest.config.ts
git commit -m "test(ui): jsdom Vitest project + Testing Library harness

Claude goes brr.. via Dash"
```

---

## Phase 1 — The gate (authored now, warns during migration)

### Task 4: ESLint flat config + `eslint-plugin-boundaries` (the hierarchy gate)

**Files:**
- Create: `apps/desktop/eslint.config.js`
- Create: `apps/desktop/test/fixtures/gate/` (fixture files that MUST fail)
- Create: `apps/desktop/test/gate.test.ts` (runs eslint on fixtures, asserts violations)
- Modify: root `package.json`

Grounding: **Structure** family — the gate mechanically enforces the DIP/boundary remedies (no upward imports, no cross-feature imports, no bypassed abstraction). AST-based, not regex, so `<button>` in a comment or string is not a false positive.

The gate's rules:
1. **Layers** (`eslint-plugin-boundaries`): element types `primitives` / `composites` / `features` by path; `allow` only downward (`features → composites,primitives`; `composites → primitives`; `primitives → ` nothing in-layer-up).
2. **Radix/shadcn only in primitives**: `no-restricted-imports` pattern `@radix-ui/*` disallowed outside `src/renderer/src/primitives/**` (boundaries `external` rule).
3. **Cross-feature**: a file in `features/<A>` may not import `features/<B>` (boundaries element `features` disallowed from other `features` instances).
4. **Native elements outside primitives**: `no-restricted-syntax` on `JSXOpeningElement[name.name=/^(button|input|select|textarea|dialog|form)$/]`, disabled (overridden) for `primitives/**`.
5. **Arbitrary colour literals everywhere**: `no-restricted-syntax` on a JSX `Literal`/`TemplateElement` whose value matches `/\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|shadow|caret|accent|divide)-\[(?:#|rgb|hsl|oklch|oklab|color)\b/`. `var(--token)` and `-(--token)` forms are allowed (they ARE tokens); only colour *literals* are banned.

- [ ] **Step 1: Write the flat config**

`apps/desktop/eslint.config.js` — a `boundaries` block with the three element types + `rules` for 2/4/5. Set the whole config's severity via an env switch so migration can run in warn mode:
```js
// GATE_LEVEL=error flips warns to errors (used once migration of a path is done).
const LEVEL = process.env.GATE_LEVEL === 'error' ? 'error' : 'warn'
```
Wire `boundaries/element-types`, `boundaries/external`, and two `no-restricted-syntax` selectors (native elements; colour literals) all at `LEVEL`, with a `files: ['src/renderer/src/primitives/**']` override that turns the native-element and radix rules off. (Full config is mechanical — assemble from the rule list above; keep each selector's `message` explanatory, e.g. "native <select> outside primitives/ — wrap it in a primitive".)

- [ ] **Step 2: Write fixtures that MUST fail (one per rule)**

Create under `apps/desktop/test/fixtures/gate/`:
- `features/a/upward.tsx` — imports from `../../../composites` is fine; add one importing `features/b` (cross-feature) → rule 3.
- `features/b/native.tsx` — contains `<select>` → rule 4.
- `features/b/arbitrary-color.tsx` — `className="bg-[#ff0000]"` → rule 5.
- `composites/radix.tsx` — `import * as Dialog from '@radix-ui/react-dialog'` → rule 2.
Each fixture is minimal valid TSX otherwise.

- [ ] **Step 3: Write the failing test**

`apps/desktop/test/gate.test.ts` (node project) — runs eslint programmatically over the fixtures dir with `GATE_LEVEL=error` and asserts each expected ruleId fires:
```ts
import { ESLint } from 'eslint'
import { expect, test } from 'vitest'

test('gate flags every hierarchy violation in the fixtures', async () => {
  const eslint = new ESLint({ cwd: __dirname + '/..', overrideConfigFile: 'eslint.config.js' })
  const results = await eslint.lintFiles(['test/fixtures/gate/**/*.tsx'])
  const ruleIds = results.flatMap((r) => r.messages.map((m) => m.ruleId))
  expect(ruleIds).toEqual(
    expect.arrayContaining([
      'boundaries/element-types', // upward / cross-feature
      'boundaries/external', // radix outside primitives
      'no-restricted-syntax', // native element + colour literal
    ]),
  )
})
```

- [ ] **Step 4: Run — verify it passes**

Run:
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
GATE_LEVEL=error pnpm exec vitest run --project node test/gate.test.ts
```
Expected: PASS. If a ruleId is missing, the corresponding rule/selector is misconfigured — fix the config, not the test.

- [ ] **Step 5: Add scripts + run the gate in WARN mode over the real tree**

Root `package.json` scripts: `"lint": "pnpm --filter @holi/desktop exec eslint 'src/renderer/src/**/*.{ts,tsx}'"`, `"lint:gate": "GATE_LEVEL=error <same>"`.
Run `pnpm lint` — expect a **wall of warnings** (65 native buttons, arbitrary values, etc.). That is correct: the gate warns today and will not fail the build until paths are migrated. Do not fix them here.

- [ ] **Step 6: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/eslint.config.js apps/desktop/test/fixtures/gate apps/desktop/test/gate.test.ts package.json
git commit -m "feat(ui): hierarchy gate (eslint-plugin-boundaries), warn mode

Claude goes brr.. via Dash"
```

---

## Phase 2 — The tracer slice (`CreateTask` through `Dialog`)

### Task 5: `Button` primitive

**Files:**
- Create: `apps/desktop/src/renderer/src/primitives/Button.tsx`, `primitives/index.ts`
- Test: `apps/desktop/src/renderer/src/primitives/__tests__/Button.test.tsx`

Grounding: **Strategy** — the cva variant map replaces the ~6 copy-pasted className dialects and the `on ? a : b` inline conditionals (**Rigidity**). Justified: ~50 real call sites (two-implementations rule cleared many times over).

Contract: `variant: 'solid' | 'surface' | 'ghost' | 'danger' | 'link'` (default `solid`), `size: 'sm' | 'md' | 'lg'` (default `md`), plus all native `button` props. Base uses semantic tokens only; hover shades derived (`hover:bg-accent/90`); explicit `focus-visible:ring-2 ring-accent` (v4 ring default is `currentColor`/1px). `data-slot="button"`. `className` merged via `cn()` so callers can override.

- [ ] **Step 1: Write failing tests**
```tsx
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Button } from '../Button'

test('renders a button with its label', () => {
  render(<Button>Save</Button>)
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
})

test('danger variant carries the danger token class', () => {
  render(<Button variant="danger">Delete</Button>)
  expect(screen.getByRole('button')).toHaveClass('bg-danger')
})

test('caller className overrides the default (tailwind-merge wins)', () => {
  render(<Button className="bg-surface">x</Button>)
  const el = screen.getByRole('button')
  expect(el).toHaveClass('bg-surface')
  expect(el).not.toHaveClass('bg-accent')
})

test('disabled prop reaches the element', () => {
  render(<Button disabled>x</Button>)
  expect(screen.getByRole('button')).toBeDisabled()
})
```

- [ ] **Step 2: Run — verify fail** (`Cannot find module '../Button'`).
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/primitives/__tests__/Button.test.tsx
```

- [ ] **Step 3: Implement `Button.tsx`** per the contract above (cva base + variants over tokens; `cn(button({variant,size}), className)`; `data-slot`). Re-export from `primitives/index.ts`.

- [ ] **Step 4: Run — verify pass** (same command). Expected: 4 passed.

- [ ] **Step 5: Commit** (`feat(ui): Button primitive` + trailer).

---

### Task 6: `Dialog` primitive (Radix, guarded `size`, Header/Body/Footer slots)

**Files:**
- Create: `apps/desktop/src/renderer/src/primitives/Dialog.tsx`
- Test: `apps/desktop/src/renderer/src/primitives/__tests__/Dialog.test.tsx`

Grounding: **Extract Class** + **Replace Primitive with Object** — the overlay/panel copy-pasted across 4 features collapses into one module; `DialogSize` is a guarded union, not a free-form string. Radix supplies focus-trap + portal + escape (the mechanics that were absent or drifting). This is the depth we are adding, so the tests are behavioural.

Contract:
```ts
export type DialogSize = 'sm' | 'md' | 'lg'
// open: boolean; onClose(): void; size?: DialogSize (default 'md'); children.
// Panel width map (Strategy): { sm:'max-w-sm', md:'max-w-md', lg:'max-w-2xl' }.
// Dialog.Header / Dialog.Body / Dialog.Footer are layout slots (Footer = 'flex justify-end gap-2').
```
Built on `@radix-ui/react-dialog`: `Root(open, onOpenChange→onClose)` · `Portal` · `Overlay` (bg tokened) · `Content` (sized panel, `data-slot="dialog"`). Escape + backdrop close come from Radix `onOpenChange`.

- [ ] **Step 1: Write failing behavioural tests**
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { Dialog } from '../Dialog'

test('renders content only when open', () => {
  const { rerender } = render(<Dialog open={false} onClose={() => {}}>hi</Dialog>)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  rerender(<Dialog open onClose={() => {}}>hi</Dialog>)
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

test('Escape asks to close', async () => {
  const onClose = vi.fn()
  render(<Dialog open onClose={onClose}>hi</Dialog>)
  await userEvent.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledOnce()
})

test('size maps to the panel width class', () => {
  render(<Dialog open size="lg" onClose={() => {}}>hi</Dialog>)
  expect(screen.getByRole('dialog')).toHaveClass('max-w-2xl')
})

test('renders through a portal (into document.body, not the mount node)', () => {
  const { container } = render(<Dialog open onClose={() => {}}>hi</Dialog>)
  expect(container).not.toHaveTextContent('hi')
  expect(screen.getByRole('dialog')).toHaveTextContent('hi')
})
```

- [ ] **Step 2: Run — verify fail.**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/primitives/__tests__/Dialog.test.tsx
```

- [ ] **Step 3: Implement `Dialog.tsx`** per contract. Attach `Header`/`Body`/`Footer` as `Dialog.Header` etc. Overlay/Content use semantic tokens; Content gets the size class from the width map via `cn()`.

- [ ] **Step 4: Run — verify pass.** Expected: 4 passed. (If Escape test hangs, the Radix jsdom polyfills in `setup.dom.ts` are missing — Task 3 Step 1.)

- [ ] **Step 5: Commit** (`feat(ui): Dialog primitive on Radix, guarded size + slots` + trailer).

---

### Task 7: `Input` primitive + `FormField` composite (un-invert the seam)

**Files:**
- Create: `apps/desktop/src/renderer/src/primitives/Input.tsx`
- Create: `apps/desktop/src/renderer/src/composites/FormField.tsx`, `composites/index.ts`
- Modify: `apps/desktop/src/renderer/src/components/TaskDetail.tsx`
- Test: `primitives/__tests__/Input.test.tsx`, `composites/__tests__/FormField.test.tsx`

Grounding: **Dependency Inversion** — `taskFieldInput` and `Row` are currently exported from `TaskDetail` (a feature) and imported upward by `CreateTaskDialog`. Extract the primitive (`Input`) and the composite (`FormField` = label · caption · error, generalising `Row`), then make `TaskDetail` a **consumer**. The upward edge disappears; both features depend downward.

Contract:
- `Input` — native `input` props + tokened className (`border-border bg-surface-raised focus:border-accent`), `data-slot="input"`, `cn()` merge.
- `FormField` — `{ label: string; error?: string; children: ReactNode }`; renders `<label>` + caption span + children + optional `text-danger` error line. The error line bundled *into* the field (today it is ad-hoc `text-red-400` scattered).

- [ ] **Step 1: Write failing tests**

`Input.test.tsx`: renders with a role/placeholder, forwards `value`/`onChange`, caller className overrides. `FormField.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { FormField } from '../FormField'
import { Input } from '../../primitives/Input'

test('associates label with its control and shows the error', () => {
  render(
    <FormField label="Title" error="required">
      <Input aria-label="Title" defaultValue="" />
    </FormField>,
  )
  expect(screen.getByText('Title')).toBeInTheDocument()
  expect(screen.getByText('required')).toHaveClass('text-danger')
})

test('no error node when error is absent', () => {
  render(<FormField label="Folder"><Input aria-label="Folder" /></FormField>)
  expect(screen.queryByText('required')).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run — verify fail.**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/primitives/__tests__/Input.test.tsx src/renderer/src/composites/__tests__/FormField.test.tsx
```

- [ ] **Step 3: Implement `Input.tsx` and `FormField.tsx`.**

- [ ] **Step 4: Remove the upward export from `TaskDetail.tsx`.** Delete the `export` on `taskFieldInput` and `Row`; replace `TaskDetail`'s own uses with `Input`/`FormField`. (Full field-by-field migration of `TaskDetail` is follow-on; here, do only what removes the export so no feature imports upward. If a residual internal use of the old string remains, keep it file-*local* and un-exported.)

- [ ] **Step 5: Run — verify pass; typecheck clean.**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/composites src/renderer/src/primitives/__tests__/Input.test.tsx
pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: tests pass; typecheck `0` (note: `CreateTaskDialog` still imports the now-unexported symbols — it is rewritten in Task 9, so expect a transient break only if you stop here. Sequence Tasks 7→9 without an intermediate typecheck gate, or temporarily keep the symbols exported until Task 9 deletes `CreateTaskDialog`).

- [ ] **Step 6: Commit** (`feat(ui): Input primitive + FormField composite; drop TaskDetail upward export` + trailer).

---

### Task 8: The dialog registry — `activeDialogAtom` + `DialogHost`

**Files:**
- Create: `apps/desktop/src/renderer/src/state/dialogs.ts`
- Create: `apps/desktop/src/renderer/src/components/DialogHost.tsx`
- Test: `apps/desktop/test/dialogs-state.test.ts` (node project — pure atom logic, no DOM)

Grounding: **Strategy** (registry: `id → {size, block}`) replacing **Rigidity** (Shell's `{createTaskMode && …}` conditional chain). The atom lives in the Jotai store mounted once — **not** a Singleton: state is passed through the store, not a global mutable module value.

Contract:
```ts
// state/dialogs.ts
import type { DialogSize } from '../primitives/Dialog'
export type ActiveDialog =
  | { id: 'create-task'; size: 'md'; mode: CreateTaskMode }
// (union grows one entry per migrated dialog — that is the whole point.)
export const activeDialogAtom = atom<ActiveDialog | null>(null)
export const openDialogAtom = atom(null, (_get, set, d: ActiveDialog) => set(activeDialogAtom, d))
export const closeDialogAtom = atom(null, (_get, set) => set(activeDialogAtom, null))
```
`DialogHost` reads `activeDialogAtom`, switches on `id` to the block, renders `<Dialog open size={d.size} onClose={close}><Block .../></Dialog>`. The `id→component` switch is the Strategy dispatch; keep it a small explicit map/switch in `DialogHost`.

- [ ] **Step 1: Write failing atom test**
```ts
import { createStore } from 'jotai'
import { expect, test } from 'vitest'
import { activeDialogAtom, closeDialogAtom, openDialogAtom } from '../src/renderer/src/state/dialogs'

test('open sets the active dialog; close clears it', () => {
  const store = createStore()
  expect(store.get(activeDialogAtom)).toBeNull()
  store.set(openDialogAtom, { id: 'create-task', size: 'md', mode: 'quick' })
  expect(store.get(activeDialogAtom)).toMatchObject({ id: 'create-task', size: 'md' })
  store.set(closeDialogAtom)
  expect(store.get(activeDialogAtom)).toBeNull()
})
```

- [ ] **Step 2: Run — verify fail** (node project).
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project node test/dialogs-state.test.ts
```

- [ ] **Step 3: Implement `state/dialogs.ts`** (block-free part) and pass. Leave `DialogHost` for Task 9 (it needs the `CreateTask` block).

- [ ] **Step 4: Run — verify pass. Commit** (`feat(ui): activeDialogAtom + open/close actions` + trailer).

---

### Task 9: `CreateTask` block; wire `DialogHost` into Shell; delete `CreateTaskDialog`

**Files:**
- Create: `apps/desktop/src/renderer/src/features/tasks/CreateTask.tsx`
- Modify: `apps/desktop/src/renderer/src/components/DialogHost.tsx` (add the `create-task` case)
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`
- Delete: `apps/desktop/src/renderer/src/components/CreateTaskDialog.tsx`
- Test: `apps/desktop/src/renderer/src/features/tasks/__tests__/CreateTask.test.tsx`

Grounding: **Extract Class** — `CreateTaskDialog` (314 lines, chrome+form+submit fused) becomes `CreateTask` (a block: `Dialog.Header/Body/Footer` + `FormField` + `Input` + `Button`), owning its submit state (**footer stays a slot** — the grilling decision). The dialog-ness moves entirely to `Dialog` + the registry entry.

Contract: `CreateTask({ mode, onClose })` renders the form (reuse the existing draft/submit logic verbatim — the domain logic is fine; only the chrome changes) inside `Dialog.Body`, with `Dialog.Footer` holding `<Button variant="ghost" onClick={onClose}>` + `<Button disabled={!title.trim() || busy} onClick={submit}>`. No overlay, no size, no escape wiring — those belong to `Dialog`.

- [ ] **Step 1: Write failing test**
```tsx
import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { Dialog } from '../../../primitives/Dialog'
import { CreateTask } from '../CreateTask'

test('confirm is disabled until a title is entered', async () => {
  render(<Dialog open onClose={() => {}}><CreateTask mode="quick" onClose={() => {}} /></Dialog>)
  expect(screen.getByRole('button', { name: /create/i })).toBeDisabled()
})
```
(Keep it to the block's own contract; the create/patch atoms are exercised by existing state tests — do not re-test them here.)

- [ ] **Step 2: Run — verify fail.**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom src/renderer/src/features/tasks/__tests__/CreateTask.test.tsx
```

- [ ] **Step 3: Implement `CreateTask.tsx`** (move the body of `CreateTaskDialog` here, swap chrome for `Dialog.*`/`FormField`/`Input`/`Button`). Add the `create-task` case to `DialogHost`. In `Shell.tsx`, replace the `{createTaskMode && <CreateTaskDialog .../>}` block (and its `createTaskDialogAtom` usage) with `<DialogHost />`, and change the ⌘T/⌘⇧T handler to `set(openDialogAtom, { id: 'create-task', size: 'md', mode })`. Delete `CreateTaskDialog.tsx`.

- [ ] **Step 4: Run — verify pass; typecheck 0; full dom suite green.**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop
pnpm exec vitest run --project dom
pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"
```
Expected: dom tests green; typecheck `0`. Then run the **full node suite** (background if long) — the CreateTaskDialog deletion touches Shell wiring; confirm nothing referencing the old atom/component remains.

- [ ] **Step 5: Manual smoke in the dev app.** `pnpm dev`; ⌘T opens the new dialog; Escape and backdrop close it; a title enables Create; ⌘⇧T opens the full mode. (Renderer hot-reloads.)

- [ ] **Step 6: Commit** (`feat(ui): CreateTask block via Dialog + registry; delete CreateTaskDialog` + trailer).

---

## Phase 3 — Enforce the gate for migrated paths + install the hook

### Task 10: Ratchet the gate to `error` for the tracer paths; wire pre-commit

**Files:**
- Modify: `apps/desktop/eslint.config.js` (add a migrated-paths allowlist that runs at `error`)
- Modify: root `package.json` (`simple-git-hooks` + `lint-staged`)

Rather than flip the whole tree to `error` (still 20+ un-migrated components), enforce `error` only where the pattern is already applied: `primitives/**`, `composites/**`, `features/**`, `state/dialogs.ts`, `components/DialogHost.tsx`, `components/Shell.tsx`. Everything else stays `warn` until its own migration plan.

- [ ] **Step 1: Add a `files`-scoped override** in `eslint.config.js` that sets the boundary + native + colour rules to `error` for the migrated globs above (independent of `GATE_LEVEL`).

- [ ] **Step 2: Verify migrated paths are clean at `error`.**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
pnpm --filter @holi/desktop exec eslint 'src/renderer/src/primitives/**' 'src/renderer/src/composites/**' 'src/renderer/src/features/**'
```
Expected: no errors. (If the `Dialog` primitive trips the radix rule, confirm the `primitives/**` override that permits `@radix-ui/*` is present.)

- [ ] **Step 3: Wire the pre-commit hook.**

Root `package.json`:
```json
"simple-git-hooks": { "pre-commit": "pnpm exec lint-staged" },
"lint-staged": { "apps/desktop/src/renderer/src/**/*.{ts,tsx}": "pnpm --filter @holi/desktop exec eslint" }
```
Run `pnpm exec simple-git-hooks` to install `.git/hooks/pre-commit`. (No hook exists today — `.git/hooks` holds only samples.)

- [ ] **Step 4: Prove the hook blocks a violation.** Temporarily add `className="bg-[#fff]"` to a primitive, `git add`, attempt commit → expect the hook to fail with the colour-literal message. Revert.

- [ ] **Step 5: Commit** (`chore(ui): enforce hierarchy gate on migrated paths + pre-commit hook` + trailer).

---

## Follow-on (NOT this plan — each its own slice, each justified by ≥2 uses)

Named here so they are not forgotten and not pre-built (avoiding **Over-build**):
- **`Drawer` composite** — VaultSettings · HistoryPanel · AgentPanel (3 uses).
- **`ConfirmDialog` composite** (declarative/stateless on `Dialog`) — DeleteConfirm + the 3 currently-unguarded destructive actions.
- **`Menu` composite** (Radix dropdown) — VaultPicker · TreeContextMenu · TaskDetail dismiss (3).
- **`Combobox` composite** — folder datalist · onboarding repo search (2).
- **`IconButton`, `Select`, `Textarea` primitives** — many.
- **Bulk migration** of the remaining ~20 components into `features/`, each swapping native/raw-Tailwind for primitives; then flip the whole-tree gate to `error` and drop `GATE_LEVEL`.
- **`OnboardingRitual`** `.obrit-*` CSS — decide: fold into tokens or keep as a standalone fullscreen surface.
- **`panel/Panel.tsx`** dev harness — exempt from the gate (add to eslint `ignores`) or delete.

---

## Self-Review

- **Spec coverage:** three layers ✓ (Task 4 folders + gate) · shadcn/Radix only in primitives ✓ (Task 4 rule 2, Task 6) · native-element ban ✓ (rule 4) · cross-feature/upward ban ✓ (rules 1/3) · arbitrary-colour ban ✓ (rule 5, per the added requirement) · guarded `size` prop ✓ (Task 6) · dialog-as-block + registry ✓ (Tasks 8/9) · footer-as-slot ✓ (Task 9) · Dialog+Drawer split ✓ (Drawer deferred, not merged) · v4 tokens ✓ (Task 2) · proper component testing ✓ (Task 3).
- **Type consistency:** `DialogSize` defined in `Dialog.tsx` (Task 6), imported by `state/dialogs.ts` (Task 8) and used in the registry union — same name throughout. `cn()`, `activeDialogAtom`, `openDialogAtom`, `closeDialogAtom` referenced consistently.
- **Sequencing hazard flagged:** Task 7 removes `TaskDetail`'s upward export while `CreateTaskDialog` still imports it; Task 9 deletes `CreateTaskDialog`. Execute 7→9 without stopping at an intermediate typecheck gate, or keep the symbols exported until Task 9 (noted in Task 7 Step 5).
- **Over-build check:** every primitive/composite built here has ≥2 real call sites; all single-slice abstractions are deferred to Follow-on.
