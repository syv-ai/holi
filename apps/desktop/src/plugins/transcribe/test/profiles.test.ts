/**
 * Meeting profiles: kept on this machine, a Default to start with, and every
 * field checked before it is saved.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jsonFileStore } from '../../../main/json-file-store'
import { createProfiles, DEFAULT_PROFILE, parseProfilesFile, profileParam } from '../main/profiles'

async function rig() {
  const path = join(await mkdtemp(join(tmpdir(), 'holi-profiles-')), 'meeting-profiles.json')
  return { path, profiles: createProfiles(jsonFileStore(path, parseProfilesFile)) }
}

describe('meeting profiles', () => {
  it('start with a Default: Danish, private minutes, no audio kept', async () => {
    const { profiles } = await rig()
    expect(await profiles.list()).toEqual([DEFAULT_PROFILE])
    expect(DEFAULT_PROFILE).toMatchObject({
      name: 'Default',
      language: 'da',
      shareMinutes: false,
      keepAudio: false,
    })
  })

  it('save a new one under a fresh id, and replace one by its id', async () => {
    const { profiles, path } = await rig()
    const made = await profiles.save(
      profileParam({
        name: 'Holi planning',
        platform: 'Holi, Electron + React',
        repoPath: '/Users/me/holi',
        glossary: [{ term: 'Claude', heardAs: ['klod', 'klort'] }],
        language: 'auto',
        asrModel: 'syvai/hviske-v5.3',
        roomDiarize: true,
        mcpConfig: '/Users/me/linear.mcp.json',
      }),
    )
    expect(made.id).toMatch(/^[0-9a-f]{8}$/)
    expect((await profiles.list()).map((p) => p.name)).toEqual(['Default', 'Holi planning'])
    await profiles.save({ ...made, name: 'Planning' })
    expect((await profiles.get(made.id)).name).toBe('Planning')
    expect((await profiles.get(made.id)).asrModel).toBe('syvai/hviske-v5.3')
    // On disk, outside the vault.
    expect(JSON.parse(await readFile(path, 'utf8')).profiles).toHaveLength(2)
  })

  it('delete one, and an empty store reads as the Default again', async () => {
    const { profiles } = await rig()
    await profiles.delete('default')
    expect(await profiles.list()).toEqual([DEFAULT_PROFILE])
    await expect(profiles.delete('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(profiles.get('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuse a field of the wrong kind', () => {
    const bad = (over: Record<string, unknown>) => () => profileParam({ name: 'X', ...over })
    expect(bad({ name: '' })).toThrow(/name/)
    expect(bad({ language: 'de' })).toThrow(/language/)
    expect(bad({ repoPath: 'relative/repo' })).toThrow(/repoPath/)
    expect(bad({ mcpConfig: '/Users/me/mcp.yaml' })).toThrow(/mcpConfig/)
    expect(bad({ glossary: [{ term: '' }] })).toThrow(/glossary/)
    expect(bad({ keepAudio: 'yes' })).toThrow(/keepAudio/)
    expect(bad({ id: '../x' })).toThrow(/id/)
  })

  it('drop a profile a hand edit broke, not the whole file', async () => {
    const { path, profiles } = await rig()
    await writeFile(
      path,
      JSON.stringify({
        profiles: [
          { id: 'ok', name: 'Fine' },
          { id: 'bad', name: 3 },
        ],
      }),
    )
    expect((await profiles.list()).map((p) => p.id)).toEqual(['ok'])
  })
})
