import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/semver'

describe('compareVersions', () => {
  it('orders by major, minor, patch, numerically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0)
  })

  it('sorts a prerelease below its release, and prereleases by their identifiers', () => {
    expect(compareVersions('1.2.0-dev.3', '1.2.0')).toBeLessThan(0)
    expect(compareVersions('1.2.0-dev.10', '1.2.0-dev.9')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0-dev', '1.2.0-dev.1')).toBeLessThan(0)
  })
})
