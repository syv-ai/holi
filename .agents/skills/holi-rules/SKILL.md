---
name: holi-rules
description: Use when a lint, rulecast, knip or hook check fails, or when adding, changing or removing a rule
---

# The rules

Seven tools enforce the repository's structure. This page is the registry: what each rule
forbids, how to fix it, and where its exemptions live. The layout and names the rules
protect are in `docs/renderer.md`.

Run everything from the repository root. A rule that is not in CI does not exist, so every
tool below runs in `.github/workflows/ci.yml`.

| Command                                        | Runs                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm lint`                                    | ESLint: layers, styling (`@shadcn/lint`), motion, plugin seam             |
| `pnpm typecheck`                               | `tsc --noEmit` per package                                                |
| `pnpm test`                                    | Vitest, including `apps/desktop/test/gate.test.ts` (rule fixtures)        |
| `pnpm knip` / `pnpm knip:production`           | Dead files, exports, dependencies (production: only what the app reaches) |
| `pnpm rulecast`                                | rulecast over the whole tree (`pnpm exec rulecast run` = staged files)    |
| `pnpm check:commit-msg -- --message "feat: x"` | The commit message rule                                                   |
| `pnpm rulecast:install`                        | Once per clone, to deliver findings to Claude Code while it edits         |

## Registry

Exemptions are listed per rule. There is no ratchet list of files that are "not migrated
yet": a rule is an error everywhere it applies, or it is not in this table.

### ESLint (`apps/desktop/eslint.config.mjs`)

| Id                                                          | Forbids                                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                              | Exemptions                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `boundaries/element-types`                                  | An import against the layer table: `ui` and `lib` import below only (`lib` nothing), `reui` only `ui`, `composites` never a feature, `state` only `lib`, `editor` only `lib`/`state`, a plugin renderer only `components/*`, `composites/`, `plugin-api` and itself. Layers are listed in `docs/renderer.md`. | Move the code down a layer, or move the importer up. Never reach up. A plugin needs something from core: export it from `@/plugin-api`.                                          | Tests (`__tests__/`, `*.test.*`, `src/plugins/*/test/`, `src/renderer/src/test/`) |
| `boundaries/external`                                       | Importing `radix-ui`, `@radix-ui/*` or `@base-ui/react` outside `components/ui` and `components/reui`.                                                                                                                                                                                                        | Use the installed component, or add one with `pnpm exec shadcn add`.                                                                                                             | `components/ui`, `components/reui`, tests                                         |
| `no-restricted-syntax` (native element)                     | `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>`, `<form>` outside `components/ui` and `components/reui`.                                                                                                                                                                                          | `Button`, `Input`, `Select`, `Textarea`, `Dialog`, `Field` from `@/components/ui`.                                                                                               | `components/ui`, `components/reui`, tests                                         |
| `no-restricted-syntax` (colour literal)                     | `bg-[#fff]`, `text-[oklch(...)]`, any colour prefix with an arbitrary colour.                                                                                                                                                                                                                                 | A semantic token: `bg-background`, `text-primary`.                                                                                                                               | `components/ui`, `components/reui`, tests                                         |
| `no-restricted-syntax` (motion)                             | `duration-[..]`, `ease-[..]`, `delay-[..]`, `animate-[..]`, any `transition-*` except `transition-none`, literal `transition`/`animation*` in `style`.                                                                                                                                                        | `motion-respond` (hover), `motion-in-*` / `motion-out-*` (arrive, leave), `motion-ack-*`, `motion-pulse`, from `index.css`. A computed `animationDelay: staggerDelay(i)` passes. | `components/ui`, `components/reui`, tests                                         |
| `no-restricted-syntax` (type floor)                         | `text-[10px]`, `text-[11px]`, `text-[0.6875rem]` and anything under 12px.                                                                                                                                                                                                                                     | `text-xs` for meta, `text-sm` for body.                                                                                                                                          | `components/ui`, `components/reui`, tests                                         |
| `no-restricted-syntax` (native title)                       | `title="..."` on a DOM element (a browser tooltip).                                                                                                                                                                                                                                                           | Wrap the element in `Tooltip` from `@/components/ui/tooltip`. A disabled trigger is the one exception: `eslint-disable` that line with a reason.                                 | `components/ui`, `components/reui`, tests                                         |
| `no-restricted-imports` (plugin to core)                    | A plugin importing `@/<anything>` except `components/ui`, `components/reui`, `composites`, `plugin-api`, `test`; or reaching core's `main/`, `renderer/`, `preload/` by a relative path.                                                                                                                      | Export what you need from `@/plugin-api` (renderer) or `src/main/plugin-api.ts` (main).                                                                                          | Plugin node tests (`src/plugins/*/test/**/*.ts`) may import core's main side      |
| `no-restricted-imports` (core to plugin)                    | Core renderer code importing from `src/plugins/**`.                                                                                                                                                                                                                                                           | Only `main.tsx` installs the plugin list. Core reads plugins through the registry.                                                                                               | `src/renderer/src/main.tsx`                                                       |
| `@typescript-eslint/no-restricted-imports`                  | A plugin renderer importing its own `../main` as a value.                                                                                                                                                                                                                                                     | `import type { ... } from '../main/...'`; call main through `capClient`.                                                                                                         | Type imports                                                                      |
| `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps` | A hook called conditionally; a missing dependency.                                                                                                                                                                                                                                                            | Fix the call or the dependency array; a justified `eslint-disable-next-line` carries its reason.                                                                                 | `components/ui`, `components/reui`                                                |

### `@shadcn/lint` (same ESLint run; policy in `apps/desktop/design-system.lint.json`)

Applies to the renderer and plugin renderers, not tests. The policy file's `notes` explain
each choice. `components/ui` and `components/reui` are exempt from `no-restyle`,
`no-arbitrary-values`, `no-inline-styles` and `require-static-classes` (stock code uses them
by design).

| Id                              | Forbids                                                                                                                                                                                                                                                                                       | Fix                                                                                                                                                                                            | Exemptions (policy `rules` / `overrides`)                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `shadcn/no-restyle`             | A `className` on an installed or composite component beyond layout (`w-full`, margins, flex placement). `Button` and `Badge`: layout only. `DialogContent`, `AlertDialogContent`, `SheetContent`, `PopoverContent`: no className. `CardTitle`, `FrameTitle`: no text size, weight or leading. | Use the component's `variant` and `size` props. A treatment the component lacks is a variant added in place in `components/ui` or `components/reui`, so every caller gets it.                  | Contracts in the policy file                                                                                                          |
| `shadcn/no-raw-colors`          | A palette class or an undeclared token (`bg-focus`).                                                                                                                                                                                                                                          | A declared token. A raw palette hue is allowed only for categorical identity and with its `dark:` pair (the policy lists the hues).                                                            | Hue allow list in the policy `rules`                                                                                                  |
| `shadcn/no-arbitrary-values`    | `w-[13px]`, `p-[7px]` and other off-scale values.                                                                                                                                                                                                                                             | A scale or theme value (`w-3.25`, `gap-2`), or a CSS variable in the class (`w-(--sidebar-width)`).                                                                                            | `components/ui`, `components/reui`                                                                                                    |
| `shadcn/no-inline-styles`       | A `style` prop or a `<style>` element.                                                                                                                                                                                                                                                        | A class. For a runtime value pass a CSS custom property: `style={{ '--row-depth': depth }}`. Geometry that must be measured needs a scoped override in the policy file with a note saying why. | `--*` properties and `animationDelay` pass; `components/ui`, `components/reui`                                                        |
| `shadcn/no-unknown-classes`     | A class Tailwind cannot generate (`rounded-huge`, a misspelling).                                                                                                                                                                                                                             | The real utility. A class from a stylesheet that exists goes in the policy `allow` list with a note.                                                                                           | `motion-*`, `ProseMirror*`, `tiptap*`, `cm-*`, `xterm*`, `rdp-*`, `cn-*`, `toaster`, `obrit-*`, `onboarding-ritual`, `pixel-persona*` |
| `shadcn/require-static-classes` | A class built at runtime on a component (`` `bg-${c}` ``).                                                                                                                                                                                                                                    | A lookup of whole class strings, or a `cva` variant.                                                                                                                                           | `components/ui`, `components/reui`                                                                                                    |

### rulecast (`.rulecast-config.yaml`)

Runs at edit time in Claude Code (after `pnpm rulecast:install`), at pre-commit on staged
files, and in CI on the changed range. A finding names the file, the fix and the reason.

| Id                                              | Forbids                                                                                                          | Fix                                                                                                  | Exemptions                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `renderer/kebab-case-names`                     | An uppercase letter or a single `_` in any path segment under `src/renderer/src` or `src/plugins/<id>/renderer`. | Rename (macOS: `git mv Foo.tsx tmp && git mv tmp foo.tsx`), keep the export PascalCase, fix imports. | `App.tsx`; `__tests__`, `__mocks__` (double underscore) |
| `renderer/retired-folders`                      | Any write under `primitives/` or `components/blocks/` (the write is refused).                                    | Put it in `components/ui`, `components/reui`, `composites/` or `features/<feature>/`.                | None                                                    |
| `renderer/open-external-through-helper`         | `window.holi.openExternal(` in renderer or plugin-renderer code.                                                 | Call `openExternal(url)` from `@/lib/open-external` (core) or `@/plugin-api` (plugins).              | `lib/open-external.ts`, tests                           |
| `renderer/components-only-in-component-folders` | An exported PascalCase function or component in `editor/`, `state/`, `lib/`, `hooks/` or `plugin-api/`.          | Move it to `composites/` (reusable, built from `components/*`) or `features/<feature>/`.             | Tests                                                   |
| `renderer/no-jsx-below-composites`              | A `.tsx` file in `lib/`, `state/` or `hooks/`.                                                                   | Move the markup up; keep the logic as `.ts`.                                                         | Tests                                                   |
| `tests/renderer-colocated`                      | A `*.test.ts(x)` in `src/renderer/src` outside `__tests__/`.                                                     | Move it to `__tests__/` beside the code.                                                             | None                                                    |
| `tests/plugin-location`                         | A plugin test outside `src/plugins/<id>/test/`, or a loose `src/plugins/*.test.ts(x)`.                           | Move it to the owning plugin's `test/`.                                                              | None                                                    |
| `tests/main-location`                           | A test next to `src/main` or `src/preload` code.                                                                 | Move it to `apps/desktop/test/`.                                                                     | None                                                    |
| `tests/renderer-behaviour-in-node-suite`        | A test in `apps/desktop/test/` importing renderer code (`../src/renderer/src/..` or `@/state                     | lib                                                                                                  | editor                                                  | ...`). | Move it to `__tests__/` beside that code and import with `@/`. | None |
| `docs/renderer-conventions` (touch)             | Not a check: injects `docs/renderer.md` the first time an agent touches renderer or plugin renderer code.        | Read it.                                                                                             | Tests                                                   |
| `docs/main-architecture` (touch)                | Not a check: injects `docs/architecture.md` on main, preload and plugin main code.                               | Read it.                                                                                             | Tests                                                   |
| `docs/vault-seeds` (touch)                      | Not a check: injects the seeded-file rules from `AGENTS.md` for `vault/once/**` and `vault/shipped/**`.          | A seeded once file is frozen once written; ask how existing vaults are reached.                      | None                                                    |

Native form elements outside `components/ui|reui` are not a rulecast rule: ESLint sees them
(AST), so it owns them.

### knip (`knip.jsonc`)

| Category                                                                                       | Severity                                        | Fix                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files` (unused file), `dependencies`, `devDependencies`, `unlisted`, `binaries`, `unresolved` | error                                           | Delete it, or import it from a real entry. A package used only from CSS or as a binary goes in the workspace's `ignoreDependencies` with a line saying why.                         |
| `exports`, `types`, `duplicates`                                                               | warn until the dead code is deleted, then error | Delete the export, or make it non-exported. Exempt one export with a `/** @public */` tag. `pnpm knip:production` ignores tests, so it finds code kept alive only by its own tests. |

Entries are listed in `knip.jsonc` with a comment each; a new Worker file, plugin list or
HTML entry is added there.

### Hooks and commit messages

| Id                  | Forbids                                                                                                                                                                             | Fix                                                                 | Where                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `commit-msg/format` | A subject not matching `^(feat\|fix\|chore\|doc\|refac)(\([a-z0-9-]+\))?: .+`; a body or trailers; `Co-Authored-By`, `Claude-Session`, "Generated with Claude Code", session links. | `git commit --amend -m "type: subject"`; keep detail in the PR.     | `commit-msg` hook from `scripts/install-hooks.mjs` (`HOLI_SKIP_HOOKS=1` skips), CI (`--range`) |
| `pre-commit`        | Staged renderer files failing ESLint (`--max-warnings 0`); staged files failing `prettier --check`; staged files failing rulecast.                                                  | Fix the file; `pnpm exec prettier --write <file>` for format.       | `scripts/install-hooks.mjs` (run by `prepare`); `HOLI_SKIP_HOOKS=1` skips                      |
| `gate-self-test`    | A change to `eslint.config.mjs` or `design-system.lint.json` that stops a fixture failing (or makes a clean one fail).                                                              | Fix the config, or update the fixture and its expectation together. | `apps/desktop/test/gate.test.ts`                                                               |

Formatting: `.prettierignore` skips the vendored `components/ui` and `components/reui`.
Never run the repo-wide `pnpm format` for a scoped change.

## Reading a failure

1. Find the rule id in the output (`boundaries/element-types`, `shadcn/no-restyle`,
   `renderer/kebab-case-names`, `knip: Unused files`). Look it up in the table above.
2. The message already says what is wrong and the fix. Do the fix; do not add a
   suppression. If you believe the finding is wrong, say so to the person you work for.
3. Never edit `eslint.config.mjs`, `design-system.lint.json`, `.rulecast-config.yaml`,
   `knip.jsonc` or a fixture to make your change pass. Changing a rule is a change of its own
   (below).
4. `eslint-disable` is allowed for exactly the cases the table names (a disabled tooltip
   trigger) and always with a reason after `--`. `// rulecast-ignore: <rule> <reason>`
   needs a reason or it suppresses nothing.
5. Re-run the one tool (`pnpm lint`, `pnpm rulecast`, `pnpm knip`), then the touched
   package's tests.

## Adding a rule

1. Pick the one tool that sees the problem best: ESLint for what is inside a file's AST or
   its imports, `@shadcn/lint` for class names and styles, rulecast for where files live and
   what they are called, knip for dead code, the commit-msg script for messages. One rule,
   one tool.
2. Write the rule. For rulecast, give it `examples` (`good` and `bad`) and run
   `pnpm exec rulecast validate` and `pnpm exec rulecast test`.
3. Write the agent-facing message: what is wrong, the fix, and why in one clause. A message
   that only says "not allowed" is a rule that costs a review round.
4. Add a failing fixture and its expectation: an ESLint or `@shadcn/lint` rule gets a file in
   `apps/desktop/test/fixtures/gate/` (first line `// FIXTURE - must fail: <rule>` or
   `must PASS`) and an assertion in `apps/desktop/test/gate.test.ts`. A rulecast rule gets
   `examples`. A script gets a unit test.
5. Keep the tree green: fix every existing violation in the same change, or make the rule a
   narrower pattern. A rule that fails on the tree is not merged; "warn until cleaned up" is
   allowed for knip exports only.
6. Add a row to the registry above (tool, id, forbids, fix, exemptions), and a line to
   `docs/renderer.md` if it changes what an agent must know.
7. Run `pnpm lint`, `pnpm test`, `pnpm knip`, `pnpm exec rulecast run --all-files`.

## Changing a rule

- Loosening or tightening a pattern: change the fixture first so it fails for the right
  reason, then the config, then the registry row. The gate test names the exact rules each
  fixture trips, so a drift fails loudly.
- An exemption: add it to the rule's own list (the policy file's `allow`/`overrides`, a
  rulecast `exclude`, a knip `ignore*`), with a comment saying why and what deletes it again.
  There are no global off-switches for folders.
- Removing a rule: delete the config, its fixture and its test expectation, then its row.
  If a stale `eslint-disable` for it remains, ESLint reports it as unused; remove those too.
- Renaming a layer or a folder: update the `boundaries/elements` patterns in
  `eslint.config.mjs`, the same patterns in `design-system.lint.json` `overrides`, the
  `.rulecast-config.yaml` regexes, `knip.jsonc` entries, and the table in `docs/renderer.md`
  together, and run the gate self-test.
