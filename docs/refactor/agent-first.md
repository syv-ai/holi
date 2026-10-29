# Agent-first renderer — execution plan

One design system, one place for every kind of file, one name for every
concept, and every rule enforced by a tool rather than remembered. Modelled on
aka-ai-platform's frontend layering programme (`docs/frontend-refactor/` on its
`refac/frontend` branch), cut down to what a single-app Electron renderer needs.

The test for every decision in this plan: **an agent that has read `AGENTS.md`
and nothing else always knows where a new file goes, what to call it, and which
component to reach for — and if it guesses wrong, a check tells it the fix.**

Decisions taken on the user's behalf while executing this plan are logged in
[`design-decisions.md`](design-decisions.md). The standing convention it
produces is [`docs/renderer.md`](../renderer.md); this page is the plan, that
page is the result.

## Where we start (2026-10-26, `feat/fresh-frontend`)

The fresh frontend rebuilt the renderer on stock shadcn and ReUI, but the old
design system was kept alongside it for the three screens carried over (sign-in,
onboarding, the agents sidebar). The result is two layer models in one tree:

| Finding                         | Evidence                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two primitive sets              | 26 components exist both as a Holi fork in `primitives/` and as stock in `components/ui` or `components/reui` (Button, Dialog, Badge, Tooltip, Tabs, Input, …). 68 files import `@/primitives`. |
| A third layer outside the model | `components/blocks/` holds most of the app (shell, documents, planning, settings) under ReUI install names (`app-shell-21`, `kanban-board-4`, `profile-9`), with no lint boundary.              |
| Stale docs                      | `AGENTS.md` says `components.json` maps `ui` to `@/primitives`; it maps to `@/components/ui`. The lint `MIGRATED` list names two files that do not exist.                                       |
| Four file-naming styles         | kebab in `components/`, `lib/`, `state/`; PascalCase in `primitives/`, `composites/`, `features/`; camelCase in `editor/`; every plugin mixes two.                                              |
| Four test locations             | `apps/desktop/test/`, `__tests__/`, colocated `*.test.ts`, `src/plugins/<id>/test/`, plus loose `src/plugins/*.test.ts`.                                                                        |
| Duplicate definitions           | Three IconTiles, three empty states, four confirm dialogs, two `PriorityBadge`s, two `SessionCard`s, `SettingCard` vs `SettingsCard`, eight local `*Button` wrappers.                           |
| Dead code                       | `components/examples/`, `components/bencho/`, likely unused stock files in `components/ui`.                                                                                                     |
| Rules not in CI                 | CI only builds previews and releases; tests, typecheck and lint run nowhere but a developer's machine.                                                                                          |

## The target

### Layout of `apps/desktop/src/renderer/src`

| Path                  | Holds                                                                                 | May import                                                                |
| --------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `main.tsx`, `App.tsx` | Entry and composition root (installs the plugin list)                                 | anything                                                                  |
| `components/ui/`      | Stock shadcn, installed by the CLI, edited in place, never re-added                   | `lib/`, `hooks/`                                                          |
| `components/reui/`    | Stock ReUI components, same rules                                                     | `components/ui`, `lib/`, `hooks/`                                         |
| `composites/`         | Holi's own reusable components, built only from `components/*`; one concept, one file | `components/*`, `lib/`, `hooks/`, `state/`                                |
| `features/<feature>/` | One folder per screen or area of the app                                              | everything above, `editor/`, `plugin-api/`, other features without cycles |
| `editor/`             | CodeMirror extensions                                                                 | `lib/`, `state/`                                                          |
| `state/`              | Jotai stores                                                                          | `lib/`                                                                    |
| `lib/`                | Pure helpers, no JSX                                                                  | `lib/`                                                                    |
| `hooks/`              | React hooks, one per file                                                             | `lib/`, `state/`                                                          |
| `plugin-api/`         | The renderer half of the plugin seam                                                  | everything core                                                           |
| `test/`               | Test helpers                                                                          | anything                                                                  |

`primitives/` and `components/blocks/` are gone. A ReUI block installed by the
CLI is moved into the feature it becomes the day it gets real data, and its
install name is kept in a one-line comment at the top of its entry file so
`shadcn view @reui/<name>` still finds the source.

A plugin's renderer (`src/plugins/<id>/renderer/`) is a feature in this model:
it imports `components/*`, `composites/` and `@/plugin-api`, never another
plugin or core feature.

### Names

- Every file and folder under the renderer and plugin renderers is kebab-case
  (`delete-confirm.tsx`, `use-file-history.ts`). That is shadcn's and ReUI's
  convention, and the majority of the tree already.
- Components are PascalCase exports named after their file
  (`confirm-dialog.tsx` exports `ConfirmDialog`). Hooks are `use-*.ts`.
- A feature's entry is `<feature>-view.tsx` (a tab's content) or named after
  the one component it exports.
- One name per concept: `*Dialog` for a modal, `*Sheet` for a side panel,
  `*View` for a tab's content, `*Page` for a settings page, `*Section` for a
  sidebar group. The glossary is canonical for domain names.

### Tests

| Code under test                                           | Test lives in                |
| --------------------------------------------------------- | ---------------------------- |
| `apps/desktop/src/main`, `preload`, shared node behaviour | `apps/desktop/test/`         |
| Renderer core                                             | `__tests__/` beside the code |
| A plugin (either side)                                    | `src/plugins/<id>/test/`     |

No colocated `*.test.ts`, no loose `src/plugins/*.test.ts`.

### One definition per thing

Before writing a component, an agent checks `components/ui`, `components/reui`
and `composites/` in that order. Button, IconButton look, confirm dialog, empty
state, icon tile, badge, card, header: each has exactly one definition, and
local re-definitions in a feature are lint errors where a tool can see them and
review findings where it cannot.

## Rule ownership — one tool per rule

| Tool                                               | Owns                                                                                                                                                                                                         | Runs in                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| **ESLint** (`apps/desktop/eslint.config.mjs`)      | Layer direction (`eslint-plugin-boundaries`), the plugin seam, native elements only in `components/ui` + `components/reui`, Radix only there, the motion, type-floor and `title=` rules                      | lint-staged pre-commit, CI        |
| **`@shadcn/lint`** (inside the same ESLint config) | Styling: `no-restyle` contracts on stock components, `no-raw-colors`, `no-arbitrary-values`, `no-inline-styles`, `no-unknown-classes`, `require-static-classes`                                              | lint-staged pre-commit, CI        |
| **rulecast** (`.rulecast-config.yaml`)             | Repository structure: kebab-case names, folder placement, test locations, retired folders staying retired, docs injected when an agent touches an area. Also delivers findings to Claude Code while it edits | Claude Code hooks, pre-commit, CI |
| **knip** (`knip.json`)                             | Dead files, unused exports and dependencies                                                                                                                                                                  | CI                                |
| **TypeScript**                                     | Types                                                                                                                                                                                                        | CI                                |
| **Vitest**                                         | Behaviour, plus the gate self-test                                                                                                                                                                           | CI                                |
| **commit-msg hook**                                | `type: subject` single line, type in `feat fix chore doc refac`                                                                                                                                              | commit-msg                        |

A rule that is not in CI does not exist.

## Phases

| #     | Title                    | Exit                                                                                                                                                                      |
| ----- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0** | Plan, analysis, baseline | This page; a findings list from reviewing the branch against it; `pnpm test`, `typecheck`, `lint` results recorded                                                        |
| **1** | Delete dead code         | Unused files and stock components gone; tests green                                                                                                                       |
| **2** | Move and rename          | The layout and names above; `components/blocks/` and colocated tests gone; imports rewritten; tests green                                                                 |
| **3** | One design system        | `primitives/` gone, its importers on `components/ui` + `components/reui`; duplicate composites merged; local `*Button`/`*Confirm`/`*Empty` wrappers replaced; tests green |
| **4** | Review findings          | The design and simplification findings from Phase 0 fixed, or logged as declined with a reason                                                                            |
| **5** | Enforcement              | ESLint boundaries for the new layout, `@shadcn/lint`, rulecast, knip, commit-msg, a `ci.yml` running all of it; every check green on the tree                             |
| **6** | Docs for the next agent  | `docs/renderer.md` (the standing convention), `AGENTS.md` corrected and pointing at it, a rules registry skill, everything learned on the way written down                |

Phases 1–3 move files that phases 4–5 then check, so they run in order. Within
a phase, work is split by folder so parallel agents never touch the same file.

## Already settled

- **Stock shadcn and ReUI are the design system.** The Holi forks in
  `primitives/` are retired, not merged into the stock files (the fresh
  frontend exists to stop carrying the old design system forward).
- **`components.json` keeps `ui` at `@/components/ui`.** Blocks keep being
  installed with `npx shadcn@latest add @reui/<name>`.
- **Scope is the renderer and plugin renderers.** Main, preload and
  `packages/shared` keep their names; they are only touched where a rename
  forces an import change.
- **Fix, then block.** Every rule ends as an error with the tree clean; anything
  that cannot be fixed in this pass is an explicit, commented exemption.
