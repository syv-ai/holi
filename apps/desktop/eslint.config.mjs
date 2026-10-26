// The renderer's lint gate. Every rule here is an error; there is no ratchet and no
// list of files that are "not migrated yet". The rules and the reason for each are
// registered in .agents/skills/holi-rules/SKILL.md, and the layout they enforce is
// in docs/renderer.md.
//
//   layer direction ......... eslint-plugin-boundaries (element-types, below)
//   Radix / Base UI ......... only components/ui and components/reui
//   native form elements .... only components/ui and components/reui
//   motion, type, colour,
//   title= .................. no-restricted-syntax selectors (below)
//   styling contracts ....... @shadcn/lint, policy in design-system.lint.json
//   plugin seam ............. no-restricted-imports (below)
//
// components/ui and components/reui are vendored (installed by the shadcn CLI and
// edited in place), so they are the layer that may do what the rest may not.
import { plugin as shadcn } from '@shadcn/lint'
import boundaries from 'eslint-plugin-boundaries'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import policy from './design-system.lint.json' with { type: 'json' }

// ---------------------------------------------------------------------------
// Where things live. test/fixtures/gate/renderer mirrors src/renderer/src so the
// gate self-test (test/gate.test.ts) exercises the same element patterns.
// ---------------------------------------------------------------------------
// (Two roots per element rather than one brace pattern: boundaries' `capture` only
// reads the right segment from a plain pattern.)
const RENDERER_ROOTS = ['src/renderer/src', 'test/fixtures/gate/renderer']
const PLUGIN_ROOTS = ['src/plugins', 'test/fixtures/gate/plugins']

const LINTED = [
  'src/renderer/src/**/*.{ts,tsx}',
  'src/plugins/**/*.{ts,tsx}',
  'test/fixtures/gate/**/*.{ts,tsx}',
]
// The layer that is allowed native form elements, Radix and its own motion.
const VENDORED = [
  'src/renderer/src/components/ui/**',
  'src/renderer/src/components/reui/**',
  'test/fixtures/gate/renderer/components/ui/**',
  'test/fixtures/gate/renderer/components/reui/**',
]
// Tests render components and fake the world; the layer rules are about shipped code.
const TESTS = [
  '**/__tests__/**',
  '**/*.test.{ts,tsx}',
  'src/plugins/*/test/**',
  'src/renderer/src/test/**',
]
// The files @shadcn/lint reads: everything that draws UI.
const STYLED = [
  'src/renderer/src/**/*.{ts,tsx}',
  'src/plugins/*/renderer/**/*.{ts,tsx}',
  'test/fixtures/gate/**/*.{ts,tsx}',
]

// ---------------------------------------------------------------------------
// no-restricted-syntax: AST selectors, not regex over source, so a <button> in a
// comment or string is never a false positive.
// ---------------------------------------------------------------------------
const NATIVE = 'JSXOpeningElement[name.name=/^(button|input|select|textarea|dialog|form)$/]'
const nativeRule = {
  selector: NATIVE,
  message:
    'native <button>/<input>/<select>/<textarea>/<dialog>/<form> outside components/ui and components/reui. Use the installed component (Button, Input, Select, Textarea, Dialog, Field) from @/components/ui, so focus, disabled and keyboard behaviour stay in one place.',
}

// Arbitrary COLOUR literals only. `bg-[var(--token)]`, `w-[32px]`, `text-[13px]`
// are fine here — only `<colour-prefix>-[<#|rgb|hsl|oklch|oklab|color>…]` is banned.
const COLOUR_BODY =
  '(bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|shadow|caret|accent|divide)-\\[(#|rgb|hsl|oklch|oklab|color)'
const colourRules = [
  {
    selector: `Literal[value=/${COLOUR_BODY}/]`,
    message:
      'arbitrary colour literal (bg-[#…], text-[oklch(…)]). Use a semantic token (bg-background, text-primary), so light and dark themes both work.',
  },
  {
    selector: `TemplateElement[value.raw=/${COLOUR_BODY}/]`,
    message:
      'arbitrary colour literal in a template string. Use a semantic token (bg-background, text-primary), so light and dark themes both work.',
  },
]

// Motion numbers stated at a call site. `index.css` is the ONE place a duration
// or a curve lives, and every animation names which behaviour it is
// (`motion-respond`, `motion-in-*`, `motion-ack-*`, `motion-pulse`…).
//
// `duration-(--motion-respond)` — Tailwind v4's CSS-variable shorthand, with
// PARENTHESES — is deliberately not matched: that is reading the token. Only
// bracketed arbitrary values are. `transition-none` survives too: it states no
// number. Every other `transition-*` picks its own property list AND inherits
// Tailwind's default duration rather than the vocabulary's.
const MOTION_BODY = '(duration|ease|delay|animate)-\\[|transition-(?!none\\b)[a-z\\[]'
// A literal transition/animation in a style object. Constrained to `> Literal`
// (and the template form) ON PURPOSE: the rule bans STATING a number, not
// touching the property, so `animationDelay: staggerDelay(i)` passes.
const MOTION_STYLE_KEYS =
  '^(transition|transitionDuration|transitionTimingFunction|transitionDelay|animation|animationDuration|animationTimingFunction|animationDelay)$'
const MOTION_STYLE = `JSXAttribute[name.name='style'] Property[key.name=/${MOTION_STYLE_KEYS}/]`
const motionMessage =
  'motion number stated here. Use the vocabulary from index.css (motion-respond, motion-in-*, motion-out-*, motion-ack-*, motion-pulse), so durations and curves live in one place.'
const motionRules = [
  { selector: `Literal[value=/${MOTION_BODY}/]`, message: motionMessage },
  { selector: `TemplateElement[value.raw=/${MOTION_BODY}/]`, message: motionMessage },
  { selector: `${MOTION_STYLE} > Literal`, message: motionMessage },
  { selector: `${MOTION_STYLE} > TemplateLiteral`, message: motionMessage },
]

// Type under the floor: body is `text-sm`, meta `text-xs`, nothing is smaller. An
// arbitrary `text-[11px]` or `text-[0.6875rem]` is how a page ends up two steps
// under the rest of the app. 12px and up, and `text-(--token)`, pass.
const TYPE_BODY =
  'text-\\[(?:(?:[0-9]|1[01])(?:\\.\\d+)?px|0?\\.(?:[0-6]\\d*|7(?:[0-4]\\d*)?)rem)\\]'
const typeMessage =
  'type under the floor (text-[10px], text-[11px]). Use text-xs for meta and text-sm for body, since nothing is smaller than text-xs.'
const typeRules = [
  { selector: `Literal[value=/${TYPE_BODY}/]`, message: typeMessage },
  { selector: `TemplateElement[value.raw=/${TYPE_BODY}/]`, message: typeMessage },
]

// Native `title=""` on a DOM element (lowercase tag) is a browser tooltip. Component
// `title` PROPS (uppercase names, e.g. <SidePanel title=…>) are not matched. A
// disabled trigger — where the tooltip never fires — is the one exception;
// eslint-disable that line with a reason.
const titleRule = {
  selector: "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='title']",
  message:
    'native title="" tooltip. Wrap the element in <Tooltip> from @/components/ui/tooltip, so the hint is styled, delayed and reachable by keyboard (a disabled trigger is the rare exception: eslint-disable this line with a reason).',
}

// One list, composed once. Flat config replaces a rule's options wholesale per
// block, so a second copy of this list would drift.
const GATE = [...colourRules, ...motionRules, titleRule, ...typeRules]

// ---------------------------------------------------------------------------
// Layers (docs/renderer.md). Direction only goes down this table.
// ---------------------------------------------------------------------------
const elements = [
  ...RENDERER_ROOTS.flatMap((root) => [
    { type: 'ui', pattern: `${root}/components/ui`, mode: 'folder' },
    { type: 'reui', pattern: `${root}/components/reui`, mode: 'folder' },
    { type: 'composites', pattern: `${root}/composites`, mode: 'folder' },
    { type: 'features', pattern: `${root}/features/*`, mode: 'folder', capture: ['feature'] },
    { type: 'editor', pattern: `${root}/editor`, mode: 'folder' },
    { type: 'state', pattern: `${root}/state`, mode: 'folder' },
    { type: 'lib', pattern: `${root}/lib`, mode: 'folder' },
    { type: 'hooks', pattern: `${root}/hooks`, mode: 'folder' },
    { type: 'plugin-api', pattern: `${root}/plugin-api`, mode: 'folder' },
  ]),
  ...PLUGIN_ROOTS.map((root) => ({
    type: 'plugins',
    pattern: `${root}/*`,
    mode: 'folder',
    capture: ['plugin'],
  })),
]
const elementTypes = {
  default: 'disallow',
  rules: [
    { from: ['ui'], allow: ['lib', 'hooks'] },
    { from: ['reui'], allow: ['ui', 'lib', 'hooks'] },
    { from: ['composites'], allow: ['ui', 'reui', 'lib', 'hooks', 'state'] },
    {
      from: ['features'],
      // Another feature is allowed (a feature may open another's view); cycles are
      // not expressible here and are a review finding.
      allow: [
        'ui',
        'reui',
        'composites',
        'lib',
        'hooks',
        'state',
        'editor',
        'plugin-api',
        'features',
      ],
    },
    { from: ['editor'], allow: ['lib', 'state'] },
    { from: ['state'], allow: ['lib'] },
    { from: ['hooks'], allow: ['lib', 'state'] },
    { from: ['lib'], allow: [] },
    {
      from: ['plugin-api'],
      allow: ['ui', 'reui', 'composites', 'features', 'editor', 'state', 'lib', 'hooks'],
    },
    {
      // A plugin's renderer is a feature that reaches core through @/plugin-api only.
      from: ['plugins'],
      allow: ['ui', 'reui', 'composites', 'plugin-api', ['plugins', { plugin: '${from.plugin}' }]],
    },
  ],
}
// Radix and Base UI are the vendored layer's dependencies.
const external = {
  default: 'allow',
  rules: [
    {
      from: ['composites', 'features', 'editor', 'state', 'lib', 'hooks', 'plugin-api', 'plugins'],
      disallow: ['@radix-ui/*', 'radix-ui', 'radix-ui/*', '@base-ui/react', '@base-ui/react/*'],
      message:
        'Radix (radix-ui, @radix-ui/*) and Base UI (@base-ui/react) are imported only inside components/ui and components/reui. Use the installed component, or add one with the shadcn CLI, so every overlay and control behaves the same.',
    },
  ],
}

// ---------------------------------------------------------------------------
// The plugin seam. Plugins (src/plugins/<id>/) and core meet at two modules, one
// per process: `@/plugin-api` and `src/main/plugin-api.ts` (docs/architecture.md,
// Plugins). Core never imports a plugin; only the composition root installs the list.
// ---------------------------------------------------------------------------
const PLUGIN_FILES = ['src/plugins/**/*.{ts,tsx}', 'test/fixtures/gate/plugins/**/*.{ts,tsx}']
const CORE_RENDERER_FILES = [
  'src/renderer/src/**/*.{ts,tsx}',
  'test/fixtures/gate/renderer/**/*.{ts,tsx}',
]
const ROOT_FILES = ['src/renderer/src/main.tsx']
const intoPlugins = {
  regex: '^(\\.\\./)+plugins(/|$)',
  message:
    'core does not import a plugin. Only main.tsx installs the plugin list, so core stays plugin-free.',
}
const pluginImports = [
  {
    // A regex, not a gitignore-style group: `@/*` swallows `@/components` as a
    // directory, and a child (`@/components/ui`) cannot be re-included from it.
    regex: '^@/(?!(components/(ui|reui)|composites|plugin-api|test)(/|$))',
    message:
      'a plugin reaches core through @/plugin-api (plus components/ui, components/reui and composites). Export what you need from plugin-api instead, so core can change without breaking plugins.',
  },
  {
    // Into core's main or renderer by a relative path: from inside
    // src/plugins/<id>/, anything two levels up is outside the plugin.
    regex: '^(\\.\\./){2,}(?!main/plugin-api$)(main|renderer|preload)(/|$)',
    message:
      "a plugin's main side reaches core only through main/plugin-api, so core's internals stay private.",
  },
]

export default [
  { ignores: ['out/**', 'dist/**', '**/node_modules/**'] },

  // Parser, plugins and settings for every linted file (the vendored layer too, so
  // lint-staged can be handed any file).
  {
    files: LINTED,
    plugins: { boundaries, 'react-hooks': reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    settings: {
      'boundaries/include': LINTED,
      'boundaries/elements': elements,
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: 'tsconfig.json' },
        node: true,
      },
    },
  },

  // Layer direction and Radix apply to every layer, the vendored one included.
  {
    files: LINTED,
    rules: {
      'boundaries/element-types': ['error', elementTypes],
      'boundaries/external': ['error', external],
    },
  },
  // Native elements, colour, motion, type and title: everything except the vendored layer.
  {
    files: LINTED,
    ignores: VENDORED,
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-syntax': ['error', nativeRule, ...GATE],
    },
  },

  // Tests render and fake; the layer rules and the colour/motion gate are for shipped code.
  {
    files: TESTS,
    rules: {
      'no-restricted-syntax': 'off',
      'boundaries/element-types': 'off',
      'boundaries/external': 'off',
    },
  },

  // @shadcn/lint: styling. Severities and contracts live in design-system.lint.json.
  {
    files: STYLED,
    ignores: TESTS,
    plugins: { shadcn },
    settings: {
      shadcn: {
        // Recognised as "ours" besides components.json's @/components/ui.
        componentImports: ['^@/components/reui(/|$)', '^@/composites(/|$)'],
        note: 'Styling rules: docs/renderer.md. Every lint rule and its fix: .agents/skills/holi-rules/SKILL.md.',
      },
    },
    rules: { ...policy.rules },
  },
  // The policy file's own overrides (no-restyle off inside the vendored layer).
  ...policy.overrides,

  // The plugin seam, in both directions.
  {
    files: CORE_RENDERER_FILES,
    ignores: ROOT_FILES,
    rules: { 'no-restricted-imports': ['error', { patterns: [intoPlugins] }] },
  },
  {
    files: PLUGIN_FILES,
    rules: { 'no-restricted-imports': ['error', { patterns: pluginImports }] },
  },
  // A plugin's renderer names its own capability table for `capClient`, as a
  // type: a value import would bundle main-process code into the renderer.
  {
    files: [
      'src/plugins/*/renderer/**/*.{ts,tsx}',
      'test/fixtures/gate/plugins/*/renderer/**/*.{ts,tsx}',
    ],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./main(/|$)',
              allowTypeImports: true,
              message:
                "a plugin's renderer imports its main side as types only, so main-process code never reaches the renderer bundle.",
            },
          ],
        },
      ],
    },
  },
  // A plugin's node tests drive core's registry with the plugin's table, so
  // they may import core's main side. Shipped plugin code may not.
  {
    files: ['src/plugins/*/test/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [pluginImports[0]] }] },
  },
  // Plugin main sides draw no UI, so the renderer-only rules do not apply to them.
  {
    files: ['src/plugins/*/main/**/*.{ts,tsx}', 'src/plugins/*/shared/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
]
