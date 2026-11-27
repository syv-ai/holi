import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeCompilerArtifacts } from './helpers/compiler-artifact-observation'

describe('observeCompilerArtifacts', () => {
  it('bounds real directory observations and discloses truncation, oversize files, and per-extension caps', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'compiler-artifacts-'))
    try {
      for (let index = 0; index < 17; index++) {
        await writeFile(join(directory, `${String(index).padStart(2, '0')}.cs`), 'x')
      }
      await writeFile(join(directory, 'huge.dll'), Buffer.alloc(16 * 1024 * 1024 + 1))
      const result = observeCompilerArtifacts(directory)
      expect(result.files.cs).toEqual({ count: 16, bytes: 16 })
      expect(result.capped).toBe(1)
      expect(result.oversized).toBe(1)
      expect(result.limitReached).toBe(false)
      for (let index = 0; index < 50; index++) {
        await writeFile(join(directory, `other-${index}.txt`), '')
      }
      const truncated = observeCompilerArtifacts(directory)
      expect(truncated.entriesRead).toBe(64)
      expect(truncated.limitReached).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports metadata and close failures without leaking entry names', async () => {
    let closed = false
    const result = observeCompilerArtifacts('ignored', {
      openDirectory: () => ({
        read: () => (closed ? null : ((closed = true), { name: 'private.cs' })),
        close: () => {
          throw new Error('close failed')
        },
      }),
      stat: () => {
        throw new Error('disappeared')
      },
    })
    expect(result.metadataErrors).toBe(1)
    expect(result.scanFailed).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private.cs')
  })
})
