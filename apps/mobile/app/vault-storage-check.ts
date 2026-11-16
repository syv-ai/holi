import { createVaultStorage } from './vault-storage'
import type { NativeFiles } from './native-files'

const encoder = {
  encode: (value: string) =>
    new Uint8Array(Array.from(unescape(encodeURIComponent(value)), (char) => char.charCodeAt(0))),
}
const decoder = {
  decode: (value: Uint8Array) => decodeURIComponent(escape(String.fromCharCode(...value))),
}

/** Small portable acceptance scenario, run unchanged by Node and Foundation adapters. */
export async function runVaultStorageCheck(adapter: NativeFiles, root: string, secondRoot: string) {
  const first = createVaultStorage(adapter, { remote: 'holi/storage-check', root })
  const second = createVaultStorage(adapter, { remote: 'holi/storage-other', root: secondRoot })
  const content = encoder.encode('\uFEFF---\r\nunknown: [keep]\r\n---\r\nCafe\u0301\n')
  await first.create('same/note.md', content)
  const other = await second.create('same/note.md', encoder.encode('other vault'))
  const read = await first.read('same/note.md')
  if (decoder.decode(read.bytes) !== decoder.decode(content))
    throw new Error('Byte preservation failed')
  if (decoder.decode((await second.read(other.path)).bytes) !== 'other vault')
    throw new Error('Vault roots collided')
  let caseAliasRejected = false
  try {
    await first.read('same/NOTE.md')
  } catch {
    caseAliasRejected = true
  }
  if (!caseAliasRejected) throw new Error('Case alias was accepted')
  const revision = read.revision
  const writes = await Promise.allSettled([
    first.save('same/note.md', encoder.encode('winner A'), revision),
    first.save('same/note.md', encoder.encode('winner B'), revision),
  ])
  if (writes.filter(({ status }) => status === 'fulfilled').length !== 1)
    throw new Error(
      `Concurrent stale-write exclusion failed: ${JSON.stringify(writes.map((item) => (item.status === 'rejected' ? String(item.reason) : item.status)))}`,
    )
  const current = await first.read('same/note.md')
  let rejected = false
  try {
    await first.save('same/note.md', encoder.encode('stale'), revision)
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('Stale revision was accepted')
  const listed = await first.list()
  if (!listed.some((path) => path === 'same/note.md')) throw new Error('Publishable note missing')
  for (const path of ['private.local.md', '.env', '.secrets/key', '.git/config']) {
    try {
      await first.create(path, encoder.encode('secret'))
    } catch {
      /* rejection is expected */
    }
    if ((await first.list()).includes(path as never)) throw new Error(`Unsafe path listed: ${path}`)
  }
  return {
    schemaVersion: 1,
    passed: 1,
    total: 1,
    failed: 0,
    concurrentFulfilled: 1,
    staleRejected: true,
    isolatedRoots: true,
    exactBytes: true,
    listingFiltered: true,
    caseAliasRejected,
    symlinkRejected: false,
    finalBytes: decoder.decode(current.bytes),
  }
}
