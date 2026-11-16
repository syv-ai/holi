import { createVaultStorage } from './vault-storage'
import type { NativeFiles } from './native-files'

const bytes = (value: string) =>
  new Uint8Array(
    Array.from(unescape(encodeURIComponent(value)), (character) => character.charCodeAt(0)),
  )
const text = (value: Uint8Array) => decodeURIComponent(escape(String.fromCharCode(...value)))

/** Portable adversarial acceptance run unchanged against each real filesystem adapter. */
export async function runVaultStorageCheck(adapter: NativeFiles, root: string, secondRoot: string) {
  const first = createVaultStorage(adapter, { remote: 'holi/storage-check', root })
  const firstAgain = createVaultStorage(adapter, { remote: 'holi/storage-check', root })
  const second = createVaultStorage(adapter, { remote: 'holi/storage-other', root: secondRoot })
  const original = bytes('\uFEFF---\r\nunknown: [keep]\r\n---\r\nCafe\u0301\n')
  const created = await first.create('same/note.md', original)
  const other = await second.create('same/note.md', bytes('other vault'))
  // iOS filesystems expose canonical filenames in NFD; only that exact spelling is valid.
  await first.create('Cafe\u0301.md', bytes('unicode spelling'))
  if (text((await first.read(created.path)).bytes) !== text(original))
    throw new Error('Byte preservation failed')
  if (text((await second.read(other.path)).bytes) !== 'other vault')
    throw new Error('Vault roots collided')

  for (const path of [
    '../escape.md',
    'same/../../escape.md',
    'same/NOTE.md',
    'same/note.MD',
    'Caf\u00e9.md',
  ]) {
    let rejected = false
    try {
      await first.read(path)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`Unsafe or aliased read accepted: ${path}`)
  }
  for (const path of ['same/note.md', 'same/NOTE.md', 'Café.md']) {
    let rejected = false
    try {
      await first.create(path, bytes('collision'))
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`Exclusive create collision accepted: ${path}`)
  }

  for (const path of ['linked/same/note.md', 'leaf-link.md', 'dangling-link.md']) {
    for (const operation of ['read', 'create', 'save'] as const) {
      let rejected = false
      try {
        if (operation === 'read') await first.read(path)
        if (operation === 'create') await first.create(path, bytes('must not write'))
        if (operation === 'save')
          await first.save(path, bytes('must not publish'), created.revision)
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error(`Symlink ${operation} accepted: ${path}`)
    }
  }

  const revision = created.revision
  const attempts = await Promise.allSettled([
    first.save(created.path, bytes('winner A'), revision),
    firstAgain.save(created.path, bytes('winner B'), revision),
  ])
  if (attempts.filter(({ status }) => status === 'fulfilled').length !== 1)
    throw new Error('Same-root handles did not exclude stale concurrent saves')
  const current = await first.read(created.path)
  let staleRejected = false
  try {
    await firstAgain.save(created.path, bytes('stale'), revision)
  } catch {
    staleRejected = true
  }
  if (!staleRejected) throw new Error('Stale revision was accepted')

  for (const path of [
    'private.local.md',
    '.env',
    '.secrets/key',
    '.git/config',
    '.holi-storage-unowned.tmp',
  ]) {
    try {
      await first.create(path, bytes('private'))
    } catch {
      // The storage policy may reject creation before listing.
    }
    if ((await first.list()).includes(path as never)) throw new Error(`Unsafe path listed: ${path}`)
  }
  const listed = await first.list()
  if (!listed.includes('same/note.md' as never)) throw new Error('Publishable note missing')
  return {
    schemaVersion: 2,
    passed: 1,
    total: 1,
    failed: 0,
    concurrentFulfilled: 1,
    staleRejected,
    isolatedRoots: true,
    exactBytes: true,
    listingFiltered: true,
    caseAliasRejected: true,
    symlinkRejected: true,
    finalBytes: text(current.bytes),
  }
}
