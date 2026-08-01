import boundaries from 'eslint-plugin-boundaries'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// GATE_LEVEL=error flips the un-migrated tree's warns to errors (whole-tree ratchet).
// Independently, the MIGRATED paths below are always error — the pattern is applied
// there, so a regression must fail regardless of GATE_LEVEL.
const LEVEL = process.env.GATE_LEVEL === 'error' ? 'error' : 'warn'

// Paths where the hierarchy is already applied — enforced at error.
const MIGRATED = [
  'src/renderer/src/primitives/**',
  'src/renderer/src/composites/**',
  'src/renderer/src/features/**',
  'src/renderer/src/components/DialogHost.tsx',
  'src/renderer/src/state/dialogs.ts',
]
// The subset that may NOT use native elements (everything migrated except primitives).
const MIGRATED_NO_NATIVE = MIGRATED.filter((p) => !p.includes('/primitives/'))

// AST selectors — not regex over source, so a <button> in a comment or string
// is never a false positive.
const NATIVE = 'JSXOpeningElement[name.name=/^(button|input|select|textarea|dialog|form)$/]'
// Arbitrary COLOUR literals only. `bg-[var(--token)]`, `w-[32px]`, `text-[13px]`
// are fine — only `<colour-prefix>-[<#|rgb|hsl|oklch|oklab|color>…]` is banned.
const COLOUR_BODY =
  '(bg|text|border|ring|fill|stroke|from|via|to|outline|decoration|shadow|caret|accent|divide)-\\[(#|rgb|hsl|oklch|oklab|color)'
const COLOUR_LITERAL = `Literal[value=/${COLOUR_BODY}/]`
const COLOUR_TEMPLATE = `TemplateElement[value.raw=/${COLOUR_BODY}/]`

const nativeRule = {
  selector: NATIVE,
  message:
    'native <element> outside primitives/ — compose a primitive (Button/Input/Dialog) instead.',
}
const colourRules = [
  {
    selector: COLOUR_LITERAL,
    message:
      'arbitrary colour literal (bg-[#…], text-[oklch(…)]) — use a semantic token (bg-background, text-primary). Tokens or nothing.',
  },
  {
    selector: COLOUR_TEMPLATE,
    message: 'arbitrary colour literal in a template string — use a semantic token. Tokens or nothing.',
  },
]
// Native `title=""` on a DOM element (lowercase tag) is a browser tooltip — banned
// in favour of the Tooltip primitive. Component `title` PROPS (uppercase names, e.g.
// <SidePanel title=…>) are not matched. A disabled trigger — where Radix never fires
// — is the one exception; eslint-disable that line with a reason.
const titleRule = {
  selector: "JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name='title']",
  message:
    'native title="" tooltip — use the Tooltip primitive (<Tooltip content>…</Tooltip>) instead. A disabled trigger is the rare exception; eslint-disable this line with a reason.',
}

// Extracted so the base (LEVEL) and migrated (error) blocks share one definition.
const elementTypes = {
  default: 'disallow',
  rules: [
    { from: ['primitives'], allow: [] },
    { from: ['composites'], allow: ['primitives'] },
    {
      from: ['features'],
      allow: ['primitives', 'composites', ['features', { feature: '${from.feature}' }]],
    },
  ],
}
const external = {
  default: 'allow',
  rules: [
    {
      from: ['composites', 'features'],
      disallow: ['@radix-ui/*', 'radix-ui', 'radix-ui/*'],
      message: 'Radix (radix-ui / @radix-ui/*) is a primitive dependency — import it only inside primitives/.',
    },
  ],
}

const LINTED = ['src/renderer/src/**/*.{ts,tsx}', 'test/fixtures/gate/**/*.{ts,tsx}']

export default [
  { ignores: ['out/**', 'dist/**', '**/node_modules/**'] },
  {
    files: LINTED,
    plugins: { boundaries, 'react-hooks': reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    settings: {
      'boundaries/include': LINTED,
      'boundaries/elements': [
        { type: 'primitives', pattern: '**/primitives', mode: 'folder' },
        { type: 'composites', pattern: '**/composites', mode: 'folder' },
        { type: 'features', pattern: '**/features/*', mode: 'folder', capture: ['feature'] },
      ],
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: 'tsconfig.json' },
        node: true,
      },
    },
    rules: {
      // React-hooks baseline — warn (independent of the hierarchy gate's LEVEL),
      // so the existing eslint-disable directives stay meaningful and never fail.
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      // The hierarchy gate — LEVEL over the whole (still-migrating) tree.
      'no-restricted-syntax': [LEVEL, nativeRule, ...colourRules, titleRule],
      'boundaries/element-types': [LEVEL, elementTypes],
      'boundaries/external': [LEVEL, external],
    },
  },
  // primitives/ is the ONE place native elements + Radix are allowed.
  // The colour ban still applies (tokens or nothing, everywhere).
  {
    files: ['src/renderer/src/primitives/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': [LEVEL, ...colourRules, titleRule] },
  },

  // ── Ratchet: migrated paths are enforced at error regardless of GATE_LEVEL. ──
  {
    files: MIGRATED,
    rules: {
      'boundaries/element-types': ['error', elementTypes],
      'boundaries/external': ['error', external],
    },
  },
  {
    files: MIGRATED_NO_NATIVE,
    rules: { 'no-restricted-syntax': ['error', nativeRule, ...colourRules, titleRule] },
  },
  {
    files: ['src/renderer/src/primitives/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...colourRules, titleRule] },
  },
]
