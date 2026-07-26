import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assetAbsPath, mimeFor } from '../src/main/vault/asset-protocol'

const ROOT = '/vault/root'

describe('assetAbsPath', () => {
  it('maps a vault-relative image path to an absolute path under the root', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/projects/logo.png')).toBe(
      `${ROOT}${sep}projects${sep}logo.png`,
    )
  })

  it('contains traversal within the root — the URL parser clamps "../" and "%2e%2e" to the host root', () => {
    // Both raw and percent-encoded dot-segments are normalized away by the URL
    // parser (clamped to root) before vaultRelPath ever sees them, so an escape
    // attempt maps to a harmless in-root path (which then 404s), never outside.
    for (const url of [
      'holi-vault://vault/../../../etc/passwd',
      'holi-vault://vault/%2e%2e/%2e%2e/etc/passwd',
    ]) {
      const out = assetAbsPath(ROOT, url)
      expect(out).not.toBeNull()
      expect(out!.startsWith(`${ROOT}${sep}`)).toBe(true)
    }
  })

  it('rejects an empty path', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/')).toBeNull()
  })

  it('rejects a NUL byte (vaultRelPath throws)', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/a%00b.png')).toBeNull()
  })

  it('decodes percent-encoded spaces in a legitimate name', () => {
    expect(assetAbsPath(ROOT, 'holi-vault://vault/my%20image.png')).toBe(`${ROOT}${sep}my image.png`)
  })
})

describe('mimeFor', () => {
  it('maps known image extensions', () => {
    expect(mimeFor('a.png')).toBe('image/png')
    expect(mimeFor('a.JPG')).toBe('image/jpeg')
    expect(mimeFor('a.svg')).toBe('image/svg+xml')
  })
  it('falls back to octet-stream', () => {
    expect(mimeFor('a.unknown')).toBe('application/octet-stream')
  })
})
