/**
 * The one synced setting the large-file gate reads: `maxCommittedFileBytes` from
 * `.holi/settings.json`. Deliberately minimal (one key), and default-on-anything-
 * wrong so a corrupt or absent config never breaks the commit path.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_COMMITTED_FILE_BYTES } from '../src/main/vault/large-files'
import { readMaxCommittedFileBytes } from '../src/main/vault/vault-settings'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function vault(settings?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-vs-'))
  dirs.push(root)
  if (settings !== undefined) {
    await mkdir(join(root, '.holi'), { recursive: true })
    await writeFile(join(root, '.holi', 'settings.json'), settings, 'utf8')
  }
  return root
}

describe('readMaxCommittedFileBytes', () => {
  it('defaults when there is no settings file', async () => {
    expect(await readMaxCommittedFileBytes(await vault())).toBe(DEFAULT_MAX_COMMITTED_FILE_BYTES)
  })

  it('reads a valid positive integer', async () => {
    expect(await readMaxCommittedFileBytes(await vault('{"maxCommittedFileBytes": 5242880}'))).toBe(
      5_242_880,
    )
  })

  it('defaults on malformed JSON', async () => {
    expect(await readMaxCommittedFileBytes(await vault('{ not json'))).toBe(
      DEFAULT_MAX_COMMITTED_FILE_BYTES,
    )
  })

  it('defaults when the key is missing, non-numeric, or not positive', async () => {
    for (const s of ['{}', '{"maxCommittedFileBytes": "big"}', '{"maxCommittedFileBytes": 0}', '{"maxCommittedFileBytes": -5}']) {
      expect(await readMaxCommittedFileBytes(await vault(s))).toBe(DEFAULT_MAX_COMMITTED_FILE_BYTES)
    }
  })
})
