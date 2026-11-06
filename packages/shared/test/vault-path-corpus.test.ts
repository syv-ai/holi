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

type Operation = 'path' | 'local' | 'secret' | 'ignored' | 'remote'
type Case =
  | { op: 'path'; input: string; expected: string; error?: never }
  | { op: 'path'; input: string; error: true; expected?: never }
  | { op: Exclude<Operation, 'path'>; input: string; expected: boolean; error?: never }
type Corpus = { version: 1; cases: Case[] }
const operations = ['path', 'local', 'secret', 'ignored', 'remote'] as const

function parseCorpus(value: unknown): Corpus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('corpus must be an object')
  }
  const root = value as Record<string, unknown>
  if (Object.keys(root).some((key) => !['version', 'cases'].includes(key))) {
    throw new Error('corpus has unknown fields')
  }
  if (root.version !== 1 || !Array.isArray(root.cases) || root.cases.length === 0) {
    throw new Error('invalid corpus version or cases')
  }

  const seen = new Set<string>()
  const covered = new Set<Operation>()
  const cases = root.cases.map((value): Case => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('case must be an object')
    }
    const item = value as Record<string, unknown>
    if (Object.keys(item).some((key) => !['op', 'input', 'expected', 'error'].includes(key))) {
      throw new Error('case has unknown fields')
    }
    if (!operations.includes(item.op as Operation) || typeof item.input !== 'string') {
      throw new Error('case has invalid operation or input')
    }
    const op = item.op as Operation
    covered.add(op)
    const key = `${op}:${Buffer.from(item.input).toString('hex')}`
    if (seen.has(key)) throw new Error(`duplicate case ${key}`)
    seen.add(key)

    if (op === 'path') {
      if (item.error === true && !('expected' in item)) {
        return { op, input: item.input, error: true }
      }
      if (typeof item.expected === 'string' && !('error' in item)) {
        return { op, input: item.input, expected: item.expected }
      }
    } else if (typeof item.expected === 'boolean' && !('error' in item)) {
      return { op, input: item.input, expected: item.expected }
    }
    throw new Error(`case has invalid expectations: ${key}`)
  })
  if (covered.size !== operations.length) throw new Error('corpus is missing operation coverage')
  return { version: 1, cases }
}

const corpus = parseCorpus(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../apps/ios/Tests/HoliVaultFormatTests/Fixtures/vault-paths.json',
      ),
      'utf8',
    ),
  ) as unknown,
)

describe('shared vault path compatibility corpus', () => {
  it('rejects malformed fixtures before executing cases', () => {
    const valid = [
      { op: 'path', input: 'a', expected: 'a' },
      { op: 'local', input: 'a', expected: false },
      { op: 'secret', input: 'a', expected: false },
      { op: 'ignored', input: 'a', expected: false },
      { op: 'remote', input: 'a', expected: false },
    ]
    const malformed: unknown[] = [
      { version: true, cases: valid },
      { version: 2, cases: valid },
      {
        version: 1,
        cases: valid.map((item, index) => (index === 1 ? { ...item, expected: 1 } : item)),
      },
      {
        version: 1,
        cases: valid.map((item, index) => (index === 0 ? { ...item, expected: true } : item)),
      },
      {
        version: 1,
        cases: valid.map((item, index) => (index === 0 ? { ...item, error: 'false' } : item)),
      },
      {
        version: 1,
        cases: valid.map((item, index) => (index === 1 ? { ...item, error: 'false' } : item)),
      },
      {
        version: 1,
        cases: valid.map((item, index) =>
          index === 0 ? { op: item.op, input: item.input } : item,
        ),
      },
      { version: 1, cases: valid.slice(0, -1) },
      { version: 1, cases: [...valid, valid[0]] },
      { version: 1, cases: valid, unexpected: true },
      {
        version: 1,
        cases: valid.map((item, index) => (index === 0 ? { ...item, extra: true } : item)),
      },
      { version: 1, cases: valid.map((item, index) => (index === 1 ? { op: item.op } : item)) },
    ]
    for (const fixture of malformed) expect(() => parseCorpus(fixture)).toThrow()
  })

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
