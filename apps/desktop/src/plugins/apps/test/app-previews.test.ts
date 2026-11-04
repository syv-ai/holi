/**
 * An app's preview on this machine (`main/previews.ts`): kept per vault and
 * bundle, never under a path-shaped name, and served only while the app's
 * code is as it was when the picture was taken.
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundleStamp, createAppPreviews, previewKey } from '../main/previews'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
const dirs: string[] = []
let root: string
let store: string

async function put(rel: string, text: string, mtime: number): Promise<void> {
  const abs = join(root, rel)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, text)
  await utimes(abs, mtime, mtime)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-previews-'))
  store = join(await mkdtemp(join(tmpdir(), 'holi-previews-store-')), 'app-previews')
  dirs.push(root, dirname(store))
  await put('Finance/Budget.app/index.html', '<p>budget</p>', 1_000)
  await put('Finance/Budget.app/app.yaml', '', 1_000)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('previewKey', () => {
  it('is one per vault and bundle, and no path', () => {
    const a = previewKey('ada/vault', 'Finance/Budget.app')
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(previewKey('ada/vault', 'Finance/Budget.app')).toBe(a)
    expect(previewKey('bo/vault', 'Finance/Budget.app')).not.toBe(a)
    expect(previewKey('ada/vault', 'Budget.app')).not.toBe(a)
  })
})

describe('bundleStamp', () => {
  it("is the newest of the app's files, its records, log and manifest aside", async () => {
    await put('Finance/Budget.app/lib/chart.js', '', 2_000)
    await put('Finance/Budget.app/app.yaml', 'archived: true\n', 9_000)
    await put('Finance/Budget.app/data/items/a.json', '{}', 9_000)
    await put('Finance/Budget.app/log.local.txt', 'oops', 9_000)
    expect(await bundleStamp(root, 'Finance/Budget.app')).toBe(2_000_000)
  })
})

describe('createAppPreviews', () => {
  it('serves what was saved as a data URL, for that vault and app only', async () => {
    const previews = createAppPreviews(store)
    await previews.save('ada/vault', root, 'Finance/Budget.app', JPEG)
    expect(await previews.read('ada/vault', root, 'Finance/Budget.app')).toBe(
      `data:image/jpeg;base64,${JPEG.toString('base64')}`,
    )
    expect(await previews.read('bo/vault', root, 'Finance/Budget.app')).toBeNull()
    // Nothing under userData is named after the app.
    for (const name of await readdir(store)) expect(name).toMatch(/^[0-9a-f]{32}\.(jpg|json)$/)
  })

  it('goes stale when the app changes, and not when its records do', async () => {
    const previews = createAppPreviews(store)
    await previews.save('ada/vault', root, 'Finance/Budget.app', JPEG)
    await put('Finance/Budget.app/data/items/a.json', '{}', 5_000)
    expect(await previews.read('ada/vault', root, 'Finance/Budget.app')).not.toBeNull()
    await put('Finance/Budget.app/index.html', '<p>budget, again</p>', 5_000)
    expect(await previews.read('ada/vault', root, 'Finance/Budget.app')).toBeNull()
  })

  it('has none before one is taken, and none once it is forgotten', async () => {
    const previews = createAppPreviews(store)
    expect(await previews.read('ada/vault', root, 'Finance/Budget.app')).toBeNull()
    await previews.save('ada/vault', root, 'Finance/Budget.app', JPEG)
    await previews.forget('ada/vault', 'Finance/Budget.app')
    expect(await previews.read('ada/vault', root, 'Finance/Budget.app')).toBeNull()
  })
})
