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
