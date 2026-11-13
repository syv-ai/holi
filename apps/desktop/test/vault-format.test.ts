import { expect, it } from 'vitest'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'

it('runs the same complete vault-format corpus as the native mobile runtime', () => {
  const report = runVaultFormatCorpus((text) => new TextEncoder().encode(text))
  expect(report.failed, JSON.stringify(report.results.filter((row) => !row.passed))).toBe(0)
  expect(report.total).toBeGreaterThan(0)
  expect(report.passed).toBe(report.total)
  expect(new Set(report.results.map((row) => row.id)).size).toBe(report.total)
})
