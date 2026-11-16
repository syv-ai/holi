import { createVaultStorage } from './vault-storage'
import type { NativeFiles } from './native-files'

const bytes = (value: string) =>
  new Uint8Array(
    Array.from(unescape(encodeURIComponent(value)), (character) => character.charCodeAt(0)),
  )
const text = (value: Uint8Array) => decodeURIComponent(escape(String.fromCharCode(...value)))

/** Portable adversarial acceptance run unchanged against each real filesystem adapter. */
export async function runVaultStorageCheck(
  adapter: NativeFiles,
  root: string,
  secondRoot: string,
  faultAdapter?: (
    phase: 'stage-open' | 'stage-write' | 'stage-sync' | 'stage-close' | 'publish',
  ) => NativeFiles,
) {
  const first = createVaultStorage(adapter, { remote: 'holi/storage-check', root })
  const firstAgain = createVaultStorage(adapter, { remote: 'holi/storage-check', root })
  const second = createVaultStorage(adapter, { remote: 'holi/storage-other', root: secondRoot })
  const original = bytes('\uFEFF---\r\nunknown: [keep]\r\n---\r\nCafe\u0301\n')
  const created = await first.create('same/note.md', original)
  const other = await second.create('same/note.md', bytes('other vault'))
  await first.create('Café.md', bytes('unicode spelling'))
  if (text((await first.read('Café.md')).bytes) !== 'unicode spelling')
    throw new Error('NFC filename spelling was not preserved')
  const decomposed = await second.create('Cafe\u0301.md', bytes('decomposed spelling'))
  if (text((await second.read('Cafe\u0301.md')).bytes) !== 'decomposed spelling')
    throw new Error('NFD filename spelling was not preserved')
  await second.save('Cafe\u0301.md', bytes('decomposed saved'), decomposed.revision)
  if (text((await second.read('Cafe\u0301.md')).bytes) !== 'decomposed saved')
    throw new Error('Unicode spelling save changed the file identity')
  for (const [store, alias] of [
    [first, 'Cafe\u0301.md'],
    [second, 'Café.md'],
  ] as const) {
    let rejected = false
    try {
      await store.read(alias)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error('Unicode filename alias was accepted')
  }
  if (text((await first.read(created.path)).bytes) !== text(original))
    throw new Error('Byte preservation failed')
  if (text((await second.read(other.path)).bytes) !== 'other vault')
    throw new Error('Vault roots collided')

  for (const path of ['../escape.md', 'same/../../escape.md', 'same/NOTE.md', 'same/note.MD']) {
    let rejected = false
    try {
      await first.read(path)
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`Unsafe or aliased read accepted: ${path}`)
  }
  for (const path of ['same/note.md', 'same/NOTE.md', 'Cafe\u0301.md']) {
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
  // Plant real adversarial files before listing; rejected storage creates are not fixtures.
  for (const path of [
    '.git/ignored.md',
    'private.local.md',
    '.env',
    '.secrets/key',
    '.holi-storage-unowned.tmp',
    'unowned.md',
    'mismatched.md.holi-sidecar',
    'malformed.md.holi-meta',
  ]) {
    try {
      await adapter.create(await adapter.canonicalRoot(root), path, bytes(`fixture:${path}`))
    } catch {
      // Some adapters prohibit fixture placement at the filesystem seam.
    }
  }
  const listed = await first.list()
  for (const excludedPath of ['.git/ignored.md', 'private.local.md', '.env', '.secrets/key'])
    if (listed.includes(excludedPath as never))
      throw new Error(`Excluded fixture listed: ${excludedPath}`)
  if (!listed.includes('same/note.md' as never)) throw new Error('Publishable note missing')
  if (
    text(await adapter.read(await adapter.canonicalRoot(root), 'unowned.md')) !==
    'fixture:unowned.md'
  )
    throw new Error('Unowned fixture bytes changed')
  if (
    text(await adapter.read(await adapter.canonicalRoot(root), 'mismatched.md.holi-sidecar')) !==
    'fixture:mismatched.md.holi-sidecar'
  )
    throw new Error('Mismatched sidecar fixture bytes changed')
  if (
    text(await adapter.read(await adapter.canonicalRoot(root), 'malformed.md.holi-meta')) !==
    'fixture:malformed.md.holi-meta'
  )
    throw new Error('Malformed sidecar fixture bytes changed')

  if (faultAdapter) {
    for (const phase of [
      'stage-open',
      'stage-write',
      'stage-sync',
      'stage-close',
      'publish',
    ] as const) {
      const base = createVaultStorage(adapter, { remote: 'holi/fault-base', root })
      const failing = createVaultStorage(faultAdapter(phase), { remote: 'holi/fault', root })
      const before = bytes('durable previous bytes')
      const note = `fault-${phase}.md`
      await base.create(note, before)
      await Promise.all([
        failing.create(`failed-create-${phase}.md`, bytes('must not publish')).then(
          () => {
            throw new Error(`Create fault ${phase} was ignored`)
          },
          () => {},
        ),
        failing.save(note, bytes('partial replacement'), (await base.read(note)).revision).then(
          () => {
            throw new Error(`Save fault ${phase} was ignored`)
          },
          () => {},
        ),
      ])
      if (text((await base.read(note)).bytes) !== text(before))
        throw new Error(`Save fault ${phase} changed durable bytes`)
      if ((await base.list()).includes(`failed-create-${phase}.md` as never))
        throw new Error(`Create fault ${phase} published a note`)
    }
  }
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
