import boundaries from 'eslint-plugin-boundaries'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// The migration is complete — the whole renderer tree is on the hierarchy, so the
// gate is ERROR everywhere (no more GATE_LEVEL ratchet). The MIGRATED blocks below
// are now redundant with this but kept as explicit intent. The only exception is the
// self-test fixtures, downgraded to warn at the end (they exist to violate).
const LEVEL = 'error'

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
    message:
      'arbitrary colour literal in a template string — use a semantic token. Tokens or nothing.',
  },
]
// Motion numbers stated at a call site. `index.css` §Motion tier is the ONE
// place a duration or a curve lives, and every animation names which of the four
// behaviours it is (`motion-respond`, `motion-in-*`, `motion-ack-*`,
// `motion-pulse`…). A component that states its own number is how this app
// ended up with `transition-all` on a button, `transition-colors` on a tree row
// and Radix defaults on every overlay, none of which anybody chose.
//
// `duration-(--motion-respond)` — Tailwind v4's CSS-variable shorthand, which
// uses PARENTHESES — is deliberately not matched: that is reading the token,
// which is the point. Only bracketed arbitrary values are.
// `transition-none` is the one form that survives: it says "do not transition",
// which states no number and is a real answer (the checkbox indicator uses it).
// Every other `transition-*` — `transition-all`, `transition-colors`,
// `transition-opacity`, `transition-[a,b]` — is a component picking its own
// property list AND inheriting Tailwind's default duration rather than the
// vocabulary's, which is the whole failure this replaces.
const MOTION_BODY = '(duration|ease|delay|animate)-\\[|transition-(?!none\\b)[a-z\\[]'
// A literal transition/animation in a style object. Constrained to `> Literal`
// (and the template form) ON PURPOSE: the rule bans STATING a number, not
// touching the property, so `animationDelay: staggerDelay(i)` — a CallExpression
// — passes. Banning the property outright would make lib/motion.ts unusable and
// leave no way to stagger a list at all. A quoted key (`{ 'transition': … }`)
// has no `key.name` and slips through; not worth a second selector.
const MOTION_STYLE_KEYS =
  '^(transition|transitionDuration|transitionTimingFunction|transitionDelay|animation|animationDuration|animationTimingFunction|animationDelay)$'
const MOTION_STYLE = `JSXAttribute[name.name='style'] Property[key.name=/${MOTION_STYLE_KEYS}/]`
const motionMessage =
  'motion number stated here — use the vocabulary (motion-respond, motion-in-*, motion-ack-*, motion-pulse) from index.css. Durations and curves live in one place, or they live everywhere.'
const motionRules = [
  { selector: `Literal[value=/${MOTION_BODY}/]`, message: motionMessage },
  { selector: `TemplateElement[value.raw=/${MOTION_BODY}/]`, message: motionMessage },
  { selector: `${MOTION_STYLE} > Literal`, message: motionMessage },
  { selector: `${MOTION_STYLE} > TemplateLiteral`, message: motionMessage },
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
    {
      from: ['plugins'],
      allow: ['primitives', 'composites', ['plugins', { plugin: '${from.plugin}' }]],
    },
  ],
}
const external = {
  default: 'allow',
  rules: [
    {
      from: ['composites', 'features', 'plugins'],
      disallow: ['@radix-ui/*', 'radix-ui', 'radix-ui/*', '@base-ui/react', '@base-ui/react/*'],
      message:
        'Radix (radix-ui / @radix-ui/*) and Base UI (@base-ui/react) are primitive dependencies — import them only inside primitives/.',
    },
  ],
}

// Icons have one home (docs/ui-system.md, Icons). A lucide or simple-icons
// glyph is drawn only through `<Icon>` or `<IconButton>`, which own its size,
// stroke and the clickable look; rendering one directly is how the renderer
// ended up with seven sizes and a dozen hover styles. And an IconButton takes
// no colour, background or hover class, because those are the primitive's.
// Tracked by import, not by name, so a local component called `Search` is not
// mistaken for the glyph.
const GLYPH_SOURCES = new Set(['lucide-react', '@icons-pack/react-simple-icons'])
// Any colour or background, under any variant, and its own hover or press. A
// reveal (`group-hover:opacity-100`, `focus-visible:opacity-100`) is layout, and
// passes.
const ICON_BUTTON_OWNS = /(^|\s)([\w/-]+:)*!?(text|bg|fill|stroke)-|(^|\s)(hover|active):/
const holi = {
  rules: {
    'icon-through-primitive': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const glyphs = new Set()
        const classText = (value) => {
          if (!value) return null
          if (value.type === 'Literal' && typeof value.value === 'string') return value.value
          if (value.type === 'JSXExpressionContainer') {
            const e = value.expression
            if (e.type === 'Literal' && typeof e.value === 'string') return e.value
            if (e.type === 'TemplateLiteral') return e.quasis.map((q) => q.value.raw).join(' ')
          }
          return null
        }
        return {
          ImportDeclaration(node) {
            if (node.importKind === 'type' || !GLYPH_SOURCES.has(node.source.value)) return
            for (const s of node.specifiers) if (s.importKind !== 'type') glyphs.add(s.local.name)
          },
          JSXOpeningElement(node) {
            const name = node.name.type === 'JSXIdentifier' ? node.name.name : null
            if (name !== null && glyphs.has(name)) {
              context.report({
                node,
                message: `<${name}> drawn directly: pass it to <Icon icon={${name}} /> or <IconButton icon={${name}} />, which own an icon's size, stroke and look.`,
              })
            }
            if (name === 'IconButton') {
              const cls = node.attributes.find(
                (a) => a.type === 'JSXAttribute' && a.name.name === 'className',
              )
              const text = classText(cls?.value)
              if (text !== null && ICON_BUTTON_OWNS.test(text)) {
                context.report({
                  node: cls,
                  message:
                    "colour, background or hover class on <IconButton>: those are the primitive's. className is for layout and reveal.",
                })
              }
            }
          },
        }
      },
    },
  },
}

const LINTED = [
  'src/renderer/src/**/*.{ts,tsx}',
  'src/plugins/**/*.{ts,tsx}',
  'test/fixtures/gate/**/*.{ts,tsx}',
]

// Plugins (src/plugins/<id>/) and core meet at two modules, one per process:
// `@/plugin-api` and `src/main/plugin-api.ts` (docs/architecture.md, Plugins).
// Core never imports a plugin; only the two composition roots install the lists.
const PLUGIN_FILES = ['src/plugins/**/*.{ts,tsx}']
const CORE_RENDERER_FILES = ['src/renderer/src/**/*.{ts,tsx}']
const ROOT_FILES = ['src/renderer/src/main.tsx']
const intoPlugins = {
  regex: '^(\\.\\./)+plugins(/|$)',
  message: 'core does not import a plugin: only main.tsx installs the list.',
}
const pluginImports = [
  {
    group: [
      '@/*',
      '!@/primitives',
      '!@/primitives/*',
      '!@/composites',
      '!@/composites/*',
      '!@/plugin-api',
      '!@/test',
      '!@/test/*',
    ],
    message: 'a plugin reaches core through @/plugin-api (plus primitives and composites).',
  },
  {
    // Into core's main or renderer by a relative path: from inside
    // src/plugins/<id>/, anything two levels up is outside the plugin.
    regex: '^(\\.\\./){2,}(?!main/plugin-api$)(main|renderer|preload)(/|$)',
    message: "a plugin's main side reaches core only through main/plugin-api.",
  },
]

export default [
  { ignores: ['out/**', 'dist/**', '**/node_modules/**'] },
  {
    files: LINTED,
    plugins: { boundaries, 'react-hooks': reactHooks, holi },
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
        { type: 'plugins', pattern: 'src/plugins/*', mode: 'folder', capture: ['plugin'] },
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
      'no-restricted-syntax': [LEVEL, nativeRule, ...colourRules, ...motionRules, titleRule],
      'boundaries/element-types': [LEVEL, elementTypes],
      'boundaries/external': [LEVEL, external],
      'holi/icon-through-primitive': LEVEL,
    },
  },
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
    files: ['src/plugins/*/renderer/**/*.{ts,tsx}'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^\\.\\./main(/|$)',
              allowTypeImports: true,
              message: "a plugin's renderer imports its main side as types only.",
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
  // primitives/ is the ONE place native elements + Radix are allowed.
  // The colour ban still applies (tokens or nothing, everywhere).
  {
    files: ['src/renderer/src/primitives/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': [LEVEL, ...colourRules, ...motionRules, titleRule] },
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
    rules: {
      'no-restricted-syntax': ['error', nativeRule, ...colourRules, ...motionRules, titleRule],
    },
  },
  {
    files: ['src/renderer/src/primitives/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...colourRules, ...motionRules, titleRule] },
  },

  // The onboarding ritual is the ONE motion exemption. It is a one-time ceremony
  // with its own stylesheet, its own palette and its own spring (`--ease-spring`
  // and the `obrit-*` keyframes live in onboarding-ritual.css, and nowhere else
  // in the app may have them). Everything ELSE still applies here — native
  // elements, colour literals and native titles are banned in the ritual as
  // anywhere. Listed after the blocks above so it wins for these paths.
  {
    files: ['src/renderer/src/features/onboarding/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', nativeRule, ...colourRules, titleRule] },
  },

  // Gate self-test fixtures deliberately CONTAIN every violation. Keep the rules
  // active (so test/gate.test.ts still sees them reported — warnings carry a ruleId
  // too) but at 'warn', so the now-error-by-default tree lint doesn't fail on files
  // whose whole purpose is to violate.
  {
    files: ['test/fixtures/gate/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['warn', nativeRule, ...colourRules, ...motionRules, titleRule],
      'boundaries/element-types': ['warn', elementTypes],
      'boundaries/external': ['warn', external],
    },
  },
]
