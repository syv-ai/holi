import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { beforeAll, describe, expect, test } from 'vitest'

/**
 * The lint gate's self-test. `test/fixtures/gate/` mirrors the renderer layout
 * (`renderer/{components/ui,components/ui,composites,features,lib,state}`) and
 * the plugin layout (`plugins/<id>/renderer`), and each fixture states in its
 * first line whether it must fail or pass. This file asserts the exact rules
 * each one trips, so deleting a rule, loosening a pattern or moving a layer
 * fails here and not in a review.
 *
 * Every rule in `eslint.config.mjs` is registered in
 * `.agents/skills/holi-rules/SKILL.md`; a new rule gets a fixture here.
 */
const cwd = fileURLToPath(new URL('..', import.meta.url)) // apps/desktop
const G = 'test/fixtures/gate'

type Message = { ruleId: string | null; message: string; line: number }
const results = new Map<string, Message[]>()

beforeAll(async () => {
  const eslint = new ESLint({ cwd, overrideConfigFile: `${cwd}/eslint.config.mjs` })
  for (const r of await eslint.lintFiles([`${G}/**/*.{ts,tsx}`])) {
    results.set(
      r.filePath.slice(r.filePath.indexOf(`${G}/`) + G.length + 1),
      r.messages as Message[],
    )
  }
})

const msgs = (file: string): Message[] => {
  const m = results.get(file)
  if (!m) throw new Error(`fixture not linted: ${file}`)
  return m
}
/** The rules a file trips, without the styling rules (those have their own tests). */
const gateRules = (file: string): string[] =>
  [
    ...new Set(
      msgs(file)
        .map((m) => m.ruleId ?? 'PARSE-ERROR')
        .filter((id) => !id.startsWith('shadcn/')),
    ),
  ].sort()

describe('layers and the plugin seam', () => {
  const expected: Record<string, string[]> = {
    // The vendored layer may use native elements, Radix, its own motion and type.
    'renderer/components/ui/vendored.tsx': [],
    // Direction only goes down: components/ui < composites < features, lib at the bottom.
    'renderer/components/ui/imports-composite.tsx': ['boundaries/element-types'],
    'renderer/composites/imports-feature.tsx': ['boundaries/element-types'],
    'renderer/lib/imports-state.ts': ['boundaries/element-types'],
    'renderer/state/count.ts': [],
    // Radix only inside components/ui.
    'renderer/composites/radix.tsx': ['boundaries/external'],
    // A feature may import another feature; it may not import a plugin.
    'renderer/features/a/uses-feature-b.tsx': [],
    'renderer/features/a/imports-plugin.tsx': ['boundaries/element-types', 'no-restricted-imports'],
    // Plugins: components, composites and @/plugin-api; never core directly or another plugin.
    'plugins/p/renderer/ok.tsx': [],
    'plugins/p/renderer/reaches-core.ts': ['boundaries/element-types', 'no-restricted-imports'],
    'plugins/p/renderer/reaches-plugin.tsx': ['boundaries/element-types'],
    'plugins/p/renderer/main-by-value.ts': ['@typescript-eslint/no-restricted-imports'],
    'plugins/q/renderer/other.tsx': [],
  }
  test.each(Object.entries(expected))('%s trips exactly %j', (file, rules) => {
    expect(gateRules(file)).toEqual(rules)
  })

  test('no fixture fails to parse', () => {
    for (const [file, m] of results) {
      expect(
        m.filter((x) => x.ruleId === null),
        file,
      ).toEqual([])
    }
  })
})

describe('native elements, colour and title', () => {
  test('native elements are flagged outside the vendored layer', () => {
    expect(gateRules('renderer/features/b/native.tsx')).toEqual(['no-restricted-syntax'])
    expect(msgs('renderer/features/b/native.tsx').some((m) => /native </.test(m.message))).toBe(
      true,
    )
  })

  test('an arbitrary colour literal is flagged', () => {
    const colour = msgs('renderer/features/b/arbitrary-color.tsx').filter(
      (m) => m.ruleId === 'no-restricted-syntax',
    )
    expect(colour).toHaveLength(1)
    expect(colour[0].message).toMatch(/colour literal/)
  })

  test('native title="" is flagged', () => {
    const m = msgs('renderer/features/b/native-title.tsx')
    expect(m.some((x) => /native title=/.test(x.message))).toBe(true)
  })
})

/**
 * Motion numbers come from the vocabulary or not at all.
 *
 * A component that states its own duration or curve is how the app ended up
 * with `transition-all` on a button and Radix defaults on every overlay, none of
 * which anybody chose. `index.css` is the one place a number lives.
 */
test('a motion number stated at the call site is flagged', () => {
  const motion = msgs('renderer/features/b/motion.tsx').filter((m) => /motion/i.test(m.message))
  // One per violation in the fixture: arbitrary duration, ease, delay and
  // animation; `transition-all`; the same reached through a template quasi; a
  // literal transition and animationDelay in a style object; and a raw
  // `transition-colors`. (The shadcn rules also see some of these.)
  const gate = motion.filter((m) => m.ruleId === 'no-restricted-syntax')
  expect(gate).toHaveLength(9)
})

/**
 * The other half, which matters more than it looks: the rule bans STATING a
 * number, not touching the property. `animationDelay: staggerDelay(i)` is a call
 * rather than a literal and must pass, or there is no way to stagger a list at
 * all and `lib/motion.ts` is unusable.
 */
test('a computed delay and the motion utilities are left alone', () => {
  expect(gateRules('renderer/features/b/motion-ok.tsx')).toEqual([])
  // ... and @shadcn/lint agrees: animationDelay is the one allowed style property.
  expect(msgs('renderer/features/b/motion-ok.tsx')).toEqual([])
})

/**
 * Nothing is smaller than `text-xs`. An arbitrary size under 12px, in px or rem,
 * in a string or a template, is flagged; 12px and up passes.
 */
test('type under the floor is flagged, and only that', () => {
  const type = msgs('renderer/features/b/type.tsx').filter((m) => /under the floor/.test(m.message))
  expect(type.map((m) => m.line)).toEqual([3, 5, 6])
})

describe('@shadcn/lint', () => {
  const byLine = (file: string, rule: string): number[] => [
    ...new Set(
      msgs(file)
        .filter((m) => m.ruleId === rule)
        .map((m) => m.line),
    ),
  ]

  test('no-restyle: a caller places a component and does not restyle it', () => {
    // Button p-4/rounded-full (9), DialogContent padding (12), CardTitle resize
    // (17), Badge shadow (20). A width on DialogContent and a colour are placement and pass. `<Button className="w-full mt-4">` (8) passes.
    expect(byLine('renderer/features/b/restyle.tsx', 'shadcn/no-restyle')).toEqual([9, 12, 17, 20])
  })

  test('the token rules each catch their own violation', () => {
    const f = 'renderer/features/b/styles.tsx'
    expect(byLine(f, 'shadcn/no-arbitrary-values')).toEqual([6])
    expect(byLine(f, 'shadcn/no-inline-styles')).toEqual([7])
    expect(byLine(f, 'shadcn/no-unknown-classes')).toEqual([8])
    expect(byLine(f, 'shadcn/require-static-classes')).toEqual([9])
    // line 13: a custom property + a motion utility + a declared token pass.
    expect(msgs(f).filter((m) => m.line >= 12)).toEqual([])
  })

  test('the vendored layer is exempt from no-restyle and the arbitrary-value rules', () => {
    expect(msgs('renderer/components/ui/vendored.tsx')).toEqual([])
  })
})
