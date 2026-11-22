import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { watch } from 'chokidar'
import { createAppCode } from '../main/code'
import { bundleCodeHash } from '../main/grants'

vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: vi.fn(actual.watch) }
})
vi.mock('../main/grants', async (original) => {
  const actual = await original<typeof import('../main/grants')>()
  return { ...actual, bundleCodeHash: vi.fn(actual.bundleCodeHash) }
})

let root: string
let code: ReturnType<typeof createAppCode>
const changed = vi.fn()
const bundle = 'Mail.app'
const hash = vi.mocked(bundleCodeHash)

async function put(path: string, text: string) {
  await mkdir(join(root, bundle, path, '..'), { recursive: true })
  await writeFile(join(root, bundle, path), text)
}

beforeEach(async () => {
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'holi-app-code-'))
  await put('index.html', '<p>mail</p>')
  await put('app.yaml', 'dangerously-allow: [mail]')
  code = createAppCode(root, changed)
})
afterEach(async () => {
  await code.close()
  await rm(root, { recursive: true, force: true })
})

const watcher = () => vi.mocked(watch).mock.results[0]!.value as ReturnType<typeof watch>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

test('enrolls only used apps and watches exactly the consent hash surface', async () => {
  await mkdir(join(root, 'Unused.app/node_modules/lib'), { recursive: true })
  const before = await code.read(root, bundle)
  expect(changed).not.toHaveBeenCalled()
  expect(watch).toHaveBeenCalledTimes(1)
  const options = vi.mocked(watch).mock.calls[0]![1]!
  const ignored = options.ignored as (path: string) => boolean
  for (const path of ['node_modules', 'node_modules/lib/index.js', '.hidden', '.git']) {
    expect(ignored(join(root, bundle, path))).toBe(false)
  }
  for (const path of ['data', 'data/items/a.json', 'log.local.txt']) {
    expect(ignored(join(root, bundle, path))).toBe(true)
  }
  expect(options.followSymlinks).toBe(false)
  await put('data/items/a.json', '{}')
  await put('log.local.txt', 'a line')
  await code.scan()
  expect(changed).not.toHaveBeenCalled()
  expect(await code.read(root, bundle)).toBe(before)
  expect(hash.mock.calls.every(([, path]) => path === bundle)).toBe(true)
})

test.each(['index.html', 'app.yaml', 'node_modules/lib/index.js', '.hidden'])(
  'publishes the exact hash after a %s change, not a byte-identical write',
  async (path) => {
    const before = await code.read(root, bundle)
    await put(path, 'v2')
    await code.scan()
    const next = await code.read(root, bundle)
    expect(next).not.toBe(before)
    expect(changed).toHaveBeenCalledExactlyOnceWith(bundle, next)
    await put(path, 'v2')
    await code.scan()
    expect(changed).toHaveBeenCalledTimes(1)
  },
)

test('directory names, removals, and symlink targets are code too', async () => {
  await code.read(root, bundle)
  await mkdir(join(root, bundle, 'empty'))
  await code.scan()
  expect(changed).toHaveBeenCalledTimes(1)
  await rename(join(root, bundle, 'empty'), join(root, bundle, 'renamed'))
  await code.scan()
  expect(changed).toHaveBeenCalledTimes(2)
  await rm(join(root, bundle, 'renamed'), { recursive: true })
  await code.scan()
  expect(changed).toHaveBeenCalledTimes(3)
  await symlink('index.html', join(root, bundle, 'link.js'))
  await code.scan()
  expect(changed).toHaveBeenCalledTimes(4)
  await rm(join(root, bundle, 'link.js'))
  await symlink('app.yaml', join(root, bundle, 'link.js'))
  await code.scan()
  expect(changed).toHaveBeenCalledTimes(5)
})

test('a watcher hint during a delayed hash discards it; queued scans cannot publish stale generations', async () => {
  const before = await code.read(root, bundle)
  const entered = deferred()
  const release = deferred()
  hash.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return before
  })
  const first = code.scan()
  await entered.promise
  await put('node_modules/lib/index.js', 'v2')
  // Deliver a filesystem hint deterministically; scan/hash/signal are real.
  watcher().emit('all', 'change', join(root, bundle, 'node_modules/lib/index.js'))
  const second = code.scan()
  release.resolve()
  await Promise.all([first, second])
  const next = await code.read(root, bundle)
  expect(next).not.toBe(before)
  expect(changed).toHaveBeenCalledExactlyOnceWith(bundle, next)
})

test('watcher hints run the scanner without a vault snapshot', async () => {
  await code.read(root, bundle)
  await put('node_modules/lib/index.js', 'v2')
  watcher().emit('all', 'change', join(root, bundle, 'node_modules/lib/index.js'))
  await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
  expect(changed).toHaveBeenCalledWith(bundle, await code.read(root, bundle))
})

test('disposal fences a pending scan and rejects any new enrollment', async () => {
  const before = await code.read(root, bundle)
  const entered = deferred()
  const release = deferred()
  hash.mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return before
  })
  const pending = code.scan()
  const rejected = expect(pending).rejects.toThrow('closed')
  await entered.promise
  await code.close()
  release.resolve()
  await rejected
  expect(changed).not.toHaveBeenCalled()
  await expect(code.read(root, bundle)).rejects.toThrow('closed')
})
