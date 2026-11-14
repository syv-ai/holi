import corpus from './vault-format.v1.json'
import {
  isInIgnoredDir,
  isLocalOnlyPath,
  isRemote,
  isSecretPath,
  PathSafetyError,
  vaultRelPath,
} from './path-safety'

type PathOutput = { path: string; utf8: number[] } | { error: 'PathSafetyError' }
type Output = boolean | PathOutput
type Operation = 'vaultRelPath' | 'isLocalOnlyPath' | 'isSecretPath' | 'isInIgnoredDir' | 'isRemote'
type Case = { id: string; operation: Operation; input: string; expected: Output }

/** Complete, ordered evidence: no case is skipped, including failures. */
export interface VaultFormatReport {
  version: 1
  total: number
  passed: number
  failed: number
  results: (Case & { actual: Output; passed: boolean })[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a corpus object')
  }
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, names: string[]): void {
  if (
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  ) {
    throw new Error(`Expected exactly these corpus fields: ${names.join(', ')}`)
  }
}

function parse(value: unknown): Case[] {
  const root = object(value)
  keys(root, ['version', 'cases'])
  if (root.version !== 1) throw new Error('Unsupported vault-format corpus version')
  if (!Array.isArray(root.cases) || root.cases.length === 0) {
    throw new Error('Corpus must contain cases')
  }
  const ids = new Set<string>()
  return root.cases.map((raw: unknown) => {
    const item = object(raw)
    keys(item, ['id', 'operation', 'input', 'expected'])
    if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) {
      throw new Error('Case IDs must be nonempty and unique')
    }
    ids.add(item.id)
    if (typeof item.input !== 'string') throw new Error(`Invalid input: ${item.id}`)
    switch (item.operation) {
      case 'vaultRelPath': {
        const expected = object(item.expected)
        if (Object.hasOwn(expected, 'error')) {
          keys(expected, ['error'])
          if (expected.error !== 'PathSafetyError') throw new Error('Invalid expected error')
        } else {
          keys(expected, ['path', 'utf8'])
          if (
            typeof expected.path !== 'string' ||
            expected.path.length === 0 ||
            !Array.isArray(expected.utf8) ||
            expected.utf8.length === 0 ||
            !expected.utf8.every(
              (byte: unknown) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255,
            )
          ) {
            throw new Error(`Invalid path expectation: ${item.id}`)
          }
        }
        break
      }
      case 'isLocalOnlyPath':
      case 'isSecretPath':
      case 'isInIgnoredDir':
      case 'isRemote':
        if (typeof item.expected !== 'boolean') throw new Error('Expected a boolean')
        break
      default:
        throw new Error(`Unsupported corpus operation: ${String(item.operation)}`)
    }
    return item as Case
  })
}

function dispatch(item: Case, encodeUtf8: (text: string) => Uint8Array): Output {
  switch (item.operation) {
    case 'vaultRelPath': {
      let path: string
      try {
        path = vaultRelPath(item.input)
      } catch (error) {
        if (!(error instanceof PathSafetyError)) throw error
        return { error: 'PathSafetyError' }
      }
      return { path, utf8: Array.from(encodeUtf8(path)) }
    }
    case 'isLocalOnlyPath':
      return isLocalOnlyPath(item.input)
    case 'isSecretPath':
      return isSecretPath(item.input)
    case 'isInIgnoredDir':
      return isInIgnoredDir(item.input)
    case 'isRemote':
      return isRemote(item.input)
  }
}

function equal(actual: Output, expected: Output): boolean {
  if (typeof actual === 'boolean' || typeof expected === 'boolean') return actual === expected
  if ('error' in actual || 'error' in expected) return 'error' in actual && 'error' in expected
  return (
    actual.path === expected.path &&
    actual.utf8.length === expected.utf8.length &&
    actual.utf8.every((byte, index) => byte === expected.utf8[index])
  )
}

/**
 * Run the statically bundled corpus, or strictly validate and run a supplied corpus.
 * Invalid schemas throw before dispatch; expectation mismatches remain in the complete
 * report with failed > 0. Callers must require failed === 0. The encoding seam uses
 * TextEncoder on browser/Node and a native UTF-8 adapter on NativeScript.
 */
export function runVaultFormatCorpus(
  encodeUtf8: (text: string) => Uint8Array,
  source: unknown = corpus,
): VaultFormatReport {
  const cases = parse(source)
  const results = cases.map((item) => {
    const actual = dispatch(item, encodeUtf8)
    return { ...item, actual, passed: equal(actual, item.expected) }
  })
  const passed = results.filter((result) => result.passed).length
  return { version: 1, total: cases.length, passed, failed: cases.length - passed, results }
}
