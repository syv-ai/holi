# The renderer

The standing convention for `apps/desktop/src/renderer/src` and for each plugin's `renderer/`:
where code goes, what it is called, how it is tested and styled, and which tool enforces each
rule. Read it before adding a component, a hook, a store or a screen. The rules' registry, with
each rule's message and fix, is [`.agents/skills/holi-rules/SKILL.md`](../.agents/skills/holi-rules/SKILL.md);
the design rules (tokens, focus, motion, baseline) are [ui-system](ui-system.md).

The test for every rule here: an agent that has read `AGENTS.md` and this page always knows where
a new file goes, what to call it and which component to reach for, and if it guesses wrong a
check tells it the fix.

## Layers

Direction only goes down the table. ESLint (`eslint-plugin-boundaries`) fails an upward import.

| Path                  | Holds                                                                                                                                                               | May import                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `main.tsx`, `App.tsx` | Entry and composition root: installs the plugin list, mounts providers and the sign-in / onboarding / vault gate                                                    | anything                                                                       |
| `components/ui/`      | Stock shadcn, installed by the CLI, edited in place, never re-added                                                                                                 | `lib/`, `hooks/`                                                               |
| `components/reui/`    | Stock ReUI components, same rules                                                                                                                                   | `components/ui`, `lib/`, `hooks/`                                              |
| `composites/`         | Holi's own reusable pieces, built only from `components/*`; one concept, one file (`icon-button`, `confirm-dialog`, `empty-state`, `find-bar`, …)                   | `components/*`, `editor/`, `lib/`, `hooks/`, `state/`                          |
| `features/<feature>/` | One folder per screen or area: shell, sidebar, command-menu, status-bar, bottom-panel, documents, files, history, planning, apps, graph, settings, auth, onboarding | everything above, `editor/`, `plugin-api/`, other features (no cycles: review) |
| `editor/`             | CodeMirror extensions, for code files and plain markdown only                                                                                                       | `lib/`, `state/`                                                               |
| `state/`              | Jotai stores                                                                                                                                                        | `lib/`                                                                         |
| `lib/`                | Pure helpers, no JSX                                                                                                                                                | `lib/`                                                                         |
| `hooks/`              | React hooks shared by several features, one per file                                                                                                                | `lib/`, `state/`                                                               |
| `plugin-api/`         | The renderer half of the plugin seam (`@/plugin-api`)                                                                                                               | everything in core                                                             |
| `test/`               | Test helpers (`render.tsx`, which wraps the ambient providers)                                                                                                      | anything                                                                       |

`components/ui` and `components/reui` are the only places for native form elements (`button`,
`input`, `select`, `textarea`, `dialog`, `form`) and for Radix and Base UI imports.

`primitives/` and `components/blocks/` no longer exist. There are no barrels: import each module by
its path (`@/composites/empty-state`, `@/components/ui/button`). A plugin's `index.ts(x)` is an
entry point, not a barrel, and stays.

Notes are edited in Tiptap, in `features/documents/rich-text`; `editor/` is the CodeMirror side,
for code files and plain markdown. Do not build a note feature on `editor/`.

A plugin's renderer (`src/plugins/<id>/renderer/`) is a feature in this model: it imports
`components/*`, `composites/`, `@/plugin-api` and `@/test`, never another plugin, core state or a
core feature. If it needs something from core, export it from `@/plugin-api`. Only `main.tsx`
imports the plugin list (`src/plugins/renderer.ts`), and core never imports from `src/plugins/**`.

## Where does it go?

Ask in order and stop at the first yes. If you have to think hard, it is probably two things.

- **Q1: Is it a stock shadcn component?** Install it with the CLI into `components/ui` and edit
  it there. Never copy it into a feature or write a second Button.
- **Q2: Is it a stock ReUI component** (data-grid, filters, kanban, tree, …)? `components/reui`,
  installed with the CLI, same rules.
- **Q3: Is it a ReUI block** (a page-sized layout such as `app-shell-21`)? Install it, then move it
  into the feature it becomes. See [Add a ReUI block](#add-a-reui-block).
- **Q4: Is it a Holi component with no domain state or fetch, or one that two features need?** A
  button with a tooltip, a confirm dialog, an empty state, an avatar. `composites/`, built from
  `components/*` only. A piece only one feature uses stays in that feature until a second one
  needs it.
- **Q5: Does it need a store, a route-level decision or domain data?** `features/<feature>/`. A
  new screen is a new folder; a new piece of an existing screen is a file in its folder.
- **Q6: Is it state shared across features** (a Jotai atom, a derived atom)? `state/`. State used
  by one feature only may sit in that feature's folder.
- **Q7: Is it a function with no JSX and no React?** `lib/`.
- **Q8: Is it a hook?** Used by several features: `hooks/use-*.ts`. Used by one: beside it.
- **Q9: Is it a CodeMirror extension** for a code file or plain markdown? `editor/`.
- **Q10: Is it part of an optional plugin?** `src/plugins/<id>/renderer/`, reaching core through
  `@/plugin-api`.

Before writing a component, check `components/ui`, then `components/reui`, then `composites/`.
Each thing has one definition: **IconButton** (`composites/icon-button`, stock `Button` ghost
`icon-sm` plus `Tooltip`, with `label` as both the tooltip and the accessible name),
**ConfirmDialog** (`composites/confirm-dialog`, stock `AlertDialog` with a title, a description,
Cancel and one action) and **EmptyState** (`composites/empty-state`). A local `*Button`,
`*Confirm` or `*Empty` wrapper in a feature is a duplicate.

## Names

- Every file and folder under the renderer and the plugin renderers is kebab-case
  (`delete-confirm.tsx`, `use-file-history.ts`). `App.tsx` is the one exception; `__tests__` and
  `__mocks__` are the double-underscore folders.
- A component is a PascalCase export named after its file (`confirm-dialog.tsx` exports
  `ConfirmDialog`). A hook is `use-*.ts` exporting `use…`.
- A feature's entry is `<feature>-view.tsx` (a tab's content) or named after the one component it
  exports.
- One name per concept: `*Dialog` for a modal, `*Sheet` for a side panel, `*View` for a tab's
  content, `*Page` for a settings page, `*Section` for a sidebar group. The
  [glossary](glossary.md) is canonical for domain names.
- On macOS (a case-insensitive disk) rename `Foo.tsx` to `foo.tsx` in two steps
  (`git mv Foo.tsx tmp && git mv tmp foo.tsx`) and check `git ls-files`.

## Tests

| Code under test                                  | Test lives in                                       |
| ------------------------------------------------ | --------------------------------------------------- |
| `src/main`, `src/preload`, shared node behaviour | `apps/desktop/test/` (vitest project `node`)        |
| Renderer core                                    | `__tests__/` beside the code (vitest project `dom`) |
| A plugin, either side                            | `src/plugins/<id>/test/`                            |

No colocated `*.test.ts`, no loose `src/plugins/*.test.ts`.

rulecast refuses a renderer test under `apps/desktop/test/` (`tests/renderer-behaviour-in-node-suite`).

The node project runs one file at a time on purpose (`fileParallelism: false`, a 20 s timeout):
watcher and git tests contend for the file system. Do not parallelise it or widen waits to cure a
flake. Run one file with `pnpm --filter @holi/desktop exec vitest run test/<file>`. The dom project
needs `test/setup.dom.ts`; a test that imports `@/plugin-api` or the editor stack needs the
`server.deps.inline` entry for `codemirror-markdown-tables` already in the config. Render with
`render` from `@/test/render`, which mounts the root `TooltipProvider`.

Some tests read source or CSS as text (`focus-treatment`, `motion`, `theme-tokens`,
`syntax-tokens`). They break silently when the file they read moves: after moving a file, grep
`apps/desktop/test` for its old path.

## Styling

Stock components are used as shipped. A caller places a component (margin, width, flex position)
and picks its `variant` and `size`; it never sets height, radius, padding, shadow or motion on one.
Need something the component lacks? Add a variant or size to its file in `components/ui` or
`components/reui`, so every caller gets it. The full design rules are [ui-system](ui-system.md);
the summary:

- **Colour** is a semantic token (`bg-background`, `text-muted-foreground`). State is a `Badge`
  variant (`success-light`) or an `Alert` variant. A raw palette class is for categorical identity
  only (a tag colour, a file type), always with its `dark:` pair. No `bg-[#fff]` literals.
- **Spacing** is `gap-*` on the parent: `gap-1` to `gap-2` in a row, `gap-3` to `gap-4` between
  groups, `gap-6` to `gap-8` between sections.
- **Type**: `text-sm` body, `text-xs` meta, nothing smaller. Never resize `CardTitle` or
  `FrameTitle`. No native `title=` tooltip; use `Tooltip`.
- **Motion** goes through the utilities in `index.css`: `motion-respond` for hover, `motion-in-*` and `motion-out-*` for arriving
  and leaving, `motion-ack-*` once for a committed act, `motion-pulse` and `motion-shimmer` while
  waiting. Transform and opacity only; never `transition-all`, never a stagger on 20+ rows, one
  entrance per view. No `duration-[…]`, `ease-[…]` or `delay-[…]` at a call site. This overrides the
  `transition-colors` and `duration-200` values in the ReUI skill and the ReUI MCP instructions.
- **Data regions** have an empty state with an action, a `Skeleton` loading state and an inline
  error with Retry.
- **Toasts**: `toast()` from `sonner`; `<Toaster />` from `@/components/ui/sonner`, mounted once.
- A ReUI Pro block's markup and classes are kept as published; the contracts deny only what the
  ReUI rule forbids on installed components. `components/ui` and `components/reui` are exempt from
  the class-shape rules (`no-restyle`, `no-arbitrary-values`, `no-inline-styles`,
  `require-static-classes`); everything else is not.

## Rules

One rule, one tool. A rule that is not in CI does not exist: `.github/workflows/ci.yml` runs every
tool below.

| Tool                                                                     | Owns                                                                                                                                                            | Command                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ESLint (`apps/desktop/eslint.config.mjs`)                                | Layer direction, the plugin seam, native elements and Radix only in `components/ui` + `components/reui`, motion, type floor, colour literals, `title=`          | `pnpm lint`                                               |
| `@shadcn/lint` (same ESLint run; `apps/desktop/design-system.lint.json`) | Styling: `no-restyle` contracts on stock components, `no-raw-colors`, `no-arbitrary-values`, `no-inline-styles`, `no-unknown-classes`, `require-static-classes` | `pnpm lint`                                               |
| rulecast (`.rulecast-config.yaml`)                                       | Repository structure: kebab-case names, folder placement, test locations, retired folders staying retired; injects docs when an agent touches an area           | `pnpm rulecast`, `pnpm rulecast:install` (once per clone) |
| knip (`knip.jsonc`)                                                      | Dead files, unused exports and dependencies (all error level; `/** @public */` exempts an export a test reaches)                                                | `pnpm knip`, `pnpm knip:production`                       |
| TypeScript                                                               | Types                                                                                                                                                           | `pnpm typecheck`                                          |
| Vitest                                                                   | Behaviour, plus the gate self-test (`apps/desktop/test/gate.test.ts`: fixtures that must fail or pass)                                                          | `pnpm test`                                               |
| commit-msg hook (`scripts/check-commit-msg.mjs`)                         | A single subject line `type: subject` with type `feat`, `fix`, `chore`, `doc` or `refac`; no attribution trailers                                               | `pnpm check:commit-msg -- --message "feat: x"`            |

`pnpm lint` covers `src/renderer/src/**` and `src/plugins/**`; main and preload are covered by
typecheck, tests and the Electron build. When a check fails, read the rule id in the output and
look it up in the [rules registry](../.agents/skills/holi-rules/SKILL.md): it says what the rule
forbids, the fix, and where its exemptions live. Do not add a suppression; if the finding is wrong,
change the rule as that page describes (fixture first, then config, then registry row).

## Recipes

### Add a component

1. Stock shadcn or ReUI part? `pnpm exec shadcn add <name>` from `apps/desktop`; see
   [Add a ReUI block](#add-a-reui-block) for the CLI's quirks.
2. Otherwise check `components/ui`, `components/reui`, `composites/`. If it exists, use it.
3. If it is new, reusable and domain-free, add `composites/<name>.tsx` built from `components/*`,
   with a test in `composites/__tests__/`. If one feature uses it, put it in that feature. A
   reusable control with its own behaviour is a composite over the existing one, named for what
   it does: a copy button is `composites/copy-button.tsx` exporting `CopyButton`, built on
   `IconButton`; it is not a second button.

### Add a feature

1. Create `features/<feature>/` with `<feature>-view.tsx` as the entry, kebab-case files, tests in
   `features/<feature>/__tests__/`.
2. Register the tab or section where the shell reads it (`state/tab-descriptor.ts`,
   `features/shell/tab-view.tsx`). Keep vault-scoped stores mounted in the shell, not in the view.
3. Give every data region an empty state, a skeleton and an inline error with Retry.
4. Add or update the feature page in `docs/features/` and list new docs in `docs/README.md`.

### Add a ReUI block

1. From `apps/desktop` (where `components.json` is): `pnpm exec shadcn add @reui/<name>`. The CLI is
   pinned in `package.json`; `npx shadcn@latest add @reui/<name>` is the same command. Pro blocks
   need `REUI_LICENSE_KEY` in `apps/desktop/.env.local` (gitignored, so a fresh worktree lacks it
   and gets a 401).
2. Answer no to every overwrite prompt. The CLI may install `cn` from npm; remove it and use
   `@/lib/cn`. Check `git status` for a rewritten `index.css`.
3. ReUI files land in `apps/desktop/src/components/reui`. Move them to
   `src/renderer/src/components/reui`, and the block itself into the feature it becomes
   (`features/<feature>/`), renamed to kebab-case domain names.
4. Make the first line of the block's entry file `// ReUI block: @reui/<name>`, so
   `shadcn view @reui/<name>` still finds the source for a diff.
5. Wire real data. Keep the block's markup and classes; fix only what lint reports.

### Add a plugin view

1. In `src/plugins/<id>/renderer/`, kebab-case files, tests in `src/plugins/<id>/test/`.
2. Import only `@/components/ui`, `@/components/reui`, `@/composites/*`, `@/plugin-api` and
   `@/test`; reach your main side through `capClient`, with `import type` from `../main`.
3. Register the view on the plugin's `RendererPlugin` in `index.ts(x)`; the list is
   `src/plugins/renderer.ts`.
4. A view in the sidebar, a tab, a settings section or a slash command is a slot of
   `RendererPlugin` (see `plugin-api/types.ts`, defined in `state/plugin-types.ts` so core state can read it), not a core import.
