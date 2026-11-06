import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isInIgnoredDir,
  isLocalOnlyPath,
  isRemote,
  isSecretPath,
  vaultRelPath,
} from '../src/path-safety.js'

type Case = { op: string; input: string; expected?: string | boolean; error?: boolean }
const corpus = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      '../../../apps/ios/Tests/HoliVaultFormatTests/Fixtures/vault-paths.json',
    ),
    'utf8',
  ),
) as {
  version: number
  cases: Case[]
}

describe('shared vault path compatibility corpus', () => {
  it('supports the checked-in corpus version and every known operation', () => {
    expect(corpus.version).toBe(1)
    expect(corpus.cases.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    const operations = new Set(['path', 'local', 'secret', 'ignored', 'remote'])
    for (const item of corpus.cases) {
      expect(operations.has(item.op), `unknown operation ${item.op}`).toBe(true)
      const key = `${item.op}:${item.input}`
      expect(seen.has(key), `duplicate case ${key}`).toBe(false)
      seen.add(key)
      if (item.op === 'path') {
        if (item.error === true) {
          expect(item.expected).toBeUndefined()
          expect(() => vaultRelPath(item.input)).toThrow()
        } else {
          expect(typeof item.expected).toBe('string')
          expect(vaultRelPath(item.input)).toBe(item.expected)
        }
      } else {
        expect(item.error).toBeUndefined()
        expect(typeof item.expected).toBe('boolean')
        const actual =
          item.op === 'local'
            ? isLocalOnlyPath(item.input)
            : item.op === 'secret'
              ? isSecretPath(item.input)
              : item.op === 'ignored'
                ? isInIgnoredDir(item.input)
                : isRemote(item.input)
        expect(actual, key).toBe(item.expected)
      }
    }
    expect(new Set(corpus.cases.map(({ op }) => op))).toEqual(operations)
  })
})
