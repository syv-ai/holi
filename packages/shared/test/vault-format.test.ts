import { describe, expect, it } from 'vitest'
import { runVaultFormatCorpus } from '../src/vault-format'
import corpus from '../src/vault-format.v1.json'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('vault-format corpus', () => {
  it('exercises every explicit expectation, including exact Unicode bytes', () => {
    const report = runVaultFormatCorpus(encode)
    expect(report.failed, JSON.stringify(report.results.filter((row) => !row.passed))).toBe(0)
    expect(report.total).toBe(corpus.cases.length)
    expect(report.passed).toBe(report.total)
    expect(report.results.map((row) => row.id)).toEqual(corpus.cases.map((row) => row.id))
  })

  it('does not pass incorrect expected paths, booleans, errors or UTF-8 bytes', () => {
    for (const expected of [
      { path: 'wrong.md', utf8: [119] },
      { path: 'café.md', utf8: [99, 97, 102, 101, 204, 129, 46, 109, 100] },
      { error: 'PathSafetyError' },
    ]) {
      const report = runVaultFormatCorpus(encode, {
        version: 1,
        cases: [{ id: 'wrong', operation: 'vaultRelPath', input: 'café.md', expected }],
      })
      expect(report.failed).toBe(1)
      expect(report.results[0]?.passed).toBe(false)
    }
    expect(
      runVaultFormatCorpus(encode, {
        version: 1,
        cases: [{ id: 'wrong', operation: 'isRemote', input: 'owner/repo', expected: false }],
      }).failed,
    ).toBe(1)
  })

  it('detects a broken encoding adapter', () => {
    expect(runVaultFormatCorpus(() => new Uint8Array()).failed).toBeGreaterThan(0)
  })

  it.each([
    null,
    {},
    { ...corpus, version: 2 },
    { ...corpus, extra: true },
    { version: 1, cases: [] },
    { version: 1, cases: [corpus.cases[0], corpus.cases[0]] },
    ...[
      { id: '' },
      { operation: 'futureOperation' },
      { input: 42 },
      { expected: 'yes' },
      { expected: { path: 'a', utf8: [-1] } },
      { expected: { path: 'a', utf8: [256] } },
      { expected: { path: 'a', utf8: [1.5] } },
      { expected: { path: 'a', utf8: [] } },
      { expected: { error: 'OtherError' } },
      { extra: true },
    ].map((patch) => ({ version: 1, cases: [{ ...corpus.cases[0], ...patch }] })),
  ])('rejects malformed or unsupported corpora before dispatch: %j', (source) => {
    expect(() => runVaultFormatCorpus(encode, source)).toThrow()
  })
})
