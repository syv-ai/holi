import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyVaultSnapshot, formatRecord } from '@holi/shared'
import { storeCapabilities } from '../main/capabilities'
import { noCoreServices } from '../../../main/capabilities/services'
import { vaultCapabilities, VAULT_NAMESPACES } from '../../../main/capabilities/vault-caps'
import {
  createCapabilityRegistry,
  type CapabilityContext,
  type Door,
} from '../../../main/capabilities/registry'

const registry = createCapabilityRegistry()
registry.register(['store'], storeCapabilities())
// `docs.read`, for the refusal of records read as files.
registry.register(
  VAULT_NAMESPACES,
  vaultCapabilities({
    updateSkills: async () => ({ summary: '', conflicts: null }),
    pendingSkills: async () => [],
  }),
)

let root: string
const dirs: string[] = []

const MANIFEST = [
  'collections:',
  '  items:',
  '    schema:',
  '      type: object',
  '      required: [title]',
  '      properties:',
  '        title: { type: string }',
  '        done: { type: boolean }',
  '',
].join('\n')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-app-store-'))
  dirs.push(root)
  await mkdir(join(root, 'Work/Tracker.app'), { recursive: true })
  await writeFile(join(root, 'Work/Tracker.app/index.html'), '<p></p>')
  await writeFile(join(root, 'Work/Tracker.app/app.yaml'), MANIFEST)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** One call as the frame of `Work/Tracker.app` makes it, or as the agent does. */
function call(method: string, params: Record<string, unknown>, door: Door = 'app') {
  const ctx: CapabilityContext = {
    remote: 'syv-ai/vault',
    root,
    bundle: door === 'app' ? 'Work/Tracker.app' : null,
    snapshot: async () => emptyVaultSnapshot(),
    core: noCoreServices(),
  }
  return registry.run(method, door, ctx, params).then((r) => r.value)
}

const dataDir = () => join(root, 'Work/Tracker.app/data/items')

describe('the app store', () => {
  it('round-trips a record through one readable file', async () => {
    const id = await call('store.put', { collection: 'items', value: { title: 'a', done: false } })
    expect(typeof id).toBe('string')
    expect(await call('store.get', { collection: 'items', id })).toEqual({
      title: 'a',
      done: false,
    })
    expect(await readFile(join(dataDir(), `${id}.json`), 'utf8')).toBe(
      formatRecord({ title: 'a', done: false }),
    )
    expect(await call('store.list', { collection: 'items' })).toEqual({
      records: [{ id, value: { title: 'a', done: false } }],
      skipped: [],
    })
    expect(await call('store.delete', { collection: 'items', id })).toBe(true)
    expect(await call('store.get', { collection: 'items', id })).toBeNull()
    expect(await call('store.delete', { collection: 'items', id })).toBe(false)
  })

  it('takes a meaningful id, and lists in id order', async () => {
    await call('store.put', { collection: 'items', id: '2026-10-01', value: { title: 'b' } })
    await call('store.put', { collection: 'items', id: '2026-09-30', value: { title: 'a' } })
    const { records } = (await call('store.list', { collection: 'items' })) as {
      records: { id: string }[]
    }
    expect(records.map((r) => r.id)).toEqual(['2026-09-30', '2026-10-01'])
  })

  it('lists an empty collection as empty', async () => {
    expect(await call('store.list', { collection: 'items' })).toEqual({ records: [], skipped: [] })
  })

  it('refuses an undeclared collection, saying how to declare it', async () => {
    await expect(call('store.list', { collection: 'other' })).rejects.toThrow(
      /undeclared collection: other.*collections:.*app\.yaml/,
    )
  })

  it('never counts a name on every object as declared', async () => {
    for (const collection of ['constructor', 'toString', '__proto__']) {
      await expect(call('store.put', { collection, value: { title: 'a' } })).rejects.toThrow(
        /undeclared collection/,
      )
    }
  })

  it('keeps every app, its own included, out of reading records as files', async () => {
    await call('store.put', { collection: 'items', id: 'x', value: { title: 'a' } })
    for (const path of [
      'Work/Tracker.app/data/items/x.json',
      'Work/Tracker.app/Data/items/x.json',
    ]) {
      await expect(call('docs.read', { path })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })

  it('refuses a record the schema rejects, with its problems', async () => {
    await expect(
      call('store.put', { collection: 'items', value: { done: 'yes' } }),
    ).rejects.toThrow(/title: is required/)
  })

  it('refuses an id that could leave the collection, and a record that is not an object', async () => {
    await expect(
      call('store.put', { collection: 'items', id: '../x', value: { title: 'a' } }),
    ).rejects.toThrow(/id/)
    await expect(call('store.put', { collection: 'items', value: [1] })).rejects.toThrow(/object/)
  })

  it('refuses a record over the size cap', async () => {
    const big = { title: 'x'.repeat(300 * 1024) }
    await expect(call('store.put', { collection: 'items', value: big })).rejects.toThrow(/large/)
  })

  it('skips and reports a hand-broken file rather than failing the list', async () => {
    await call('store.put', { collection: 'items', id: 'good', value: { title: 'a' } })
    await writeFile(join(dataDir(), 'bad.json'), '{ nope')
    expect(await call('store.list', { collection: 'items' })).toEqual({
      records: [{ id: 'good', value: { title: 'a' } }],
      skipped: ['bad.json'],
    })
  })

  it('ignores a bundle param at the app door: an app never names itself', async () => {
    await mkdir(join(root, 'Other.app'), { recursive: true })
    await writeFile(join(root, 'Other.app/app.yaml'), MANIFEST)
    await call('store.put', {
      bundle: 'Other.app',
      collection: 'items',
      id: 'x',
      value: { title: 'a' },
    })
    expect(await readdir(dataDir())).toEqual(['x.json'])
  })

  it('lets the agent name the bundle at the CLI door, and parses a JSON value', async () => {
    await call(
      'store.put',
      { bundle: 'Work/Tracker.app', collection: 'items', id: 'x', value: '{"title":"a"}' },
      'cli',
    )
    expect(await call('store.get', { collection: 'items', id: 'x' })).toEqual({ title: 'a' })
  })

  it('checks a hand-written data file against its schema, CLI door only', async () => {
    await mkdir(dataDir(), { recursive: true })
    await writeFile(join(dataDir(), 'h.json'), '{"done": 1}')
    expect(
      await call('store.check', { path: 'Work/Tracker.app/data/items/h.json' }, 'cli'),
    ).toEqual(['title: is required', 'done: must be a boolean'])
    await expect(
      call('store.check', { path: 'Work/Tracker.app/data/items/h.json' }),
    ).rejects.toThrow(/no such method/)
  })

  // A committed link would otherwise let an app's store write into the agent
  // surface, or out of the vault altogether.
  it('neither reads nor writes through a symlinked collection', async () => {
    await mkdir(join(root, '.holi/memory'), { recursive: true })
    await writeFile(join(root, '.holi/memory/x.json'), '{"title":"secret"}')
    await mkdir(join(root, 'Work/Tracker.app/data'), { recursive: true })
    await symlink('../../../.holi/memory', dataDir())
    await expect(call('store.get', { collection: 'items', id: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(call('store.list', { collection: 'items' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      call('store.put', { collection: 'items', id: 'y', value: { title: 'a' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('store.delete', { collection: 'items', id: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(await readdir(join(root, '.holi/memory'))).toEqual(['x.json'])
  })
})
