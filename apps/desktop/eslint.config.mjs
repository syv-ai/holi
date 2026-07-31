import boundaries from 'eslint-plugin-boundaries'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// GATE_LEVEL=error flips warns to errors (used once a path's migration is done).
// Default is warn so the un-migrated tree does not fail the build mid-migration.
const LEVEL = process.env.GATE_LEVEL === 'error' ? 'error' : 'warn'

// AST selectors — not regex over source, so a <button> in a comment or string
// is never a false positive.
const NATIVE =
  'JSXOpeningElement[name.name=/^(button|input|select|textarea|dialog|form)$/]'
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
      'arbitrary colour literal (bg-[#…], text-[oklch(…)]) — use a semantic token (bg-surface, text-accent). Tokens or nothing.',
  },
  {
    selector: COLOUR_TEMPLATE,
    message: 'arbitrary colour literal in a template string — use a semantic token. Tokens or nothing.',
  },
]

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
      // native elements + colour literals, everywhere in the linted tree.
      'no-restricted-syntax': [LEVEL, nativeRule, ...colourRules],
      // one-way layer imports.
      'boundaries/element-types': [
        LEVEL,
        {
          default: 'disallow',
          rules: [
            { from: ['primitives'], allow: [] },
            { from: ['composites'], allow: ['primitives'] },
            {
              from: ['features'],
              allow: ['primitives', 'composites', ['features', { feature: '${from.feature}' }]],
            },
          ],
        },
      ],
      // Radix (and shadcn) may only be imported inside primitives/.
      'boundaries/external': [
        LEVEL,
        {
          default: 'allow',
          rules: [
            {
              from: ['composites', 'features'],
              disallow: ['@radix-ui/*'],
              message: 'Radix is a primitive dependency — import it only inside primitives/.',
            },
          ],
        },
      ],
    },
  },
  // primitives/ is the ONE place native elements + Radix are allowed.
  // The colour ban still applies here (tokens or nothing, everywhere).
  {
    files: ['src/renderer/src/primitives/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': [LEVEL, ...colourRules] },
  },
]
