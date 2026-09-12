import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { expect, test } from 'vitest'

// Force the gate to error so every violation surfaces as a message.
process.env.GATE_LEVEL = 'error'

const cwd = fileURLToPath(new URL('..', import.meta.url)) // apps/desktop

test('gate flags every hierarchy violation in the fixtures', async () => {
  const eslint = new ESLint({ cwd, overrideConfigFile: `${cwd}/eslint.config.mjs` })
  const results = await eslint.lintFiles(['test/fixtures/gate/**/*.tsx'])
  const messages = results.flatMap((r) => r.messages)
  const ruleIds = messages.map((m) => m.ruleId).filter(Boolean)
  expect(ruleIds).toEqual(
    expect.arrayContaining([
      'boundaries/element-types', // feature a → feature b (cross-feature)
      'boundaries/external', // Radix imported in a composite
      'no-restricted-syntax', // native <select> + arbitrary colour literal + native title
    ]),
  )
  // The native title="" ban specifically (shares the no-restricted-syntax id).
  expect(messages.some((m) => /native title=/.test(m.message))).toBe(true)
})

/**
 * Motion numbers come from the vocabulary or not at all.
 *
 * The same shape as the colour gate: a component that states its own duration
 * or curve is how the app ended up with `transition-all` on a button and Radix
 * defaults on every overlay, none of which anybody chose. `index.css` is the
 * one place a number lives.
 */
test('gate flags a motion number stated at the call site', async () => {
  const eslint = new ESLint({ cwd, overrideConfigFile: `${cwd}/eslint.config.mjs` })
  const [result] = await eslint.lintFiles(['test/fixtures/gate/features/b/motion.tsx'])
  const motion = result.messages.filter((m) => /motion/i.test(m.message))

  // One per violation in the fixture: arbitrary duration, ease, delay and
  // animation; `transition-all`; the same reached through a template quasi; a
  // literal transition and animationDelay in a style object; and a raw
  // `transition-colors`.
  expect(motion).toHaveLength(9)
  expect(motion.every((m) => m.ruleId === 'no-restricted-syntax')).toBe(true)
})

/**
 * And the other half, which matters more than it looks: the rule bans STATING a
 * number, not touching the property. `animationDelay: staggerDelay(i)` is a call
 * rather than a literal and must pass, or there is no way to stagger a list at
 * all and `lib/motion.ts` is unusable.
 */
test('gate leaves a computed delay and the motion utilities alone', async () => {
  const eslint = new ESLint({ cwd, overrideConfigFile: `${cwd}/eslint.config.mjs` })
  const [result] = await eslint.lintFiles(['test/fixtures/gate/features/b/motion-ok.tsx'])
  expect(result.messages.filter((m) => /motion/i.test(m.message))).toEqual([])
})
