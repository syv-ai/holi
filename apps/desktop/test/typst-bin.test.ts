import { describe, expect, it } from 'vitest'
import {
  cachedBinPath,
  TYPST_VERSION,
  typstDownloadUrl,
  typstReleaseAsset,
} from '../src/main/pdf/typst-bin'

describe('typstReleaseAsset', () => {
  it('maps darwin/arm64 to the aarch64-apple-darwin tar.xz', () => {
    expect(typstReleaseAsset('darwin', 'arm64')).toEqual({
      archive: 'typst-aarch64-apple-darwin.tar.xz',
      binInArchive: 'typst-aarch64-apple-darwin/typst',
      format: 'tar.xz',
    })
  })
  it('maps win32/x64 to the msvc zip carrying typst.exe', () => {
    expect(typstReleaseAsset('win32', 'x64')).toEqual({
      archive: 'typst-x86_64-pc-windows-msvc.zip',
      binInArchive: 'typst-x86_64-pc-windows-msvc/typst.exe',
      format: 'zip',
    })
  })
  it('throws for an unsupported platform', () => {
    expect(() => typstReleaseAsset('sunos', 'sparc')).toThrow(/no typst release/)
  })
})

describe('typstDownloadUrl', () => {
  it('builds a pinned github release URL', () => {
    expect(typstDownloadUrl(typstReleaseAsset('darwin', 'arm64'))).toBe(
      `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-aarch64-apple-darwin.tar.xz`,
    )
  })
})

describe('cachedBinPath', () => {
  it('is versioned so a pin bump lands in a fresh dir', () => {
    // The binary name follows process.platform; on a unix dev machine it is `typst`.
    expect(cachedBinPath('/u/typst')).toBe(`/u/typst/typst-${TYPST_VERSION}/typst`)
  })
})
