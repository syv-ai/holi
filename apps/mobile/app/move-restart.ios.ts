import { knownFolders } from '@nativescript/core'
import { createNativeFiles, nativeFiles } from './native-files.ios'
import { nativeIO } from './native-posix.ios'
import { createVaultStorage } from './vault-storage'
import { moveFixtureBytes as images } from './move-fixtures'
import type { StorageCheckpointCallback } from './native-files'
import { stagingDirectory } from './storage-staging'

const encode = (value: string) =>
  new Uint8Array(
    Array.from(unescape(encodeURIComponent(value)), (character) => character.charCodeAt(0)),
  )
const decode = (value: Uint8Array) => decodeURIComponent(escape(String.fromCharCode(...value)))

export const moveCheckpointEvents = [
  { phase: 'journal-before', direction: 'before' },
  { phase: 'journal-after', direction: 'after' },
  ...['from.md', 'to.md', 'back-a.md', 'back-b.md'].flatMap((path) => [
    { phase: 'file-before', direction: 'before', path },
    { phase: 'file-after', direction: 'after', path },
  ]),
  { phase: 'cleanup-before', direction: 'before', path: 'move-journal' },
  { phase: 'cleanup-after', direction: 'after', path: 'move-journal' },
  { phase: 'recovery-file-before', direction: 'before', path: 'to.md' },
] as const

const {
  source: sourceBytes,
  backA: backABytes,
  backB: backBBytes,
  moved: movedBytes,
  movedA: movedABytes,
  movedB: movedBBytes,
} = images
/** Fixed native crash fixtures; launch values select only a compiled case ordinal. */
export async function runMoveRestart(
  action: 'stage' | 'recovery',
  runId: string,
  ordinal: number,
  startedAt: number,
) {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('Invalid move run identity')
  const selected = moveCheckpointEvents[ordinal]
  if (!selected) throw new Error('Invalid compiled move checkpoint case')
  const expected: { phase: string; direction: string; path?: string } = selected
  const documents = nativeIO.canonical(knownFolders.documents().path)
  const root = `${documents}/holi-move-${runId}-${ordinal}`
  const markerPath = `${documents}/holi-move-checkpoint-${runId}-${ordinal}.json`
  if (action === 'stage') {
    nativeIO.mkdir(root)
    const setup = createVaultStorage(nativeFiles, { remote: 'holi/move-restart', root })
    const source = await setup.create('from.md', encode(sourceBytes))
    await setup.create('back-a.md', encode(backABytes))
    await setup.create('back-b.md', encode(backBBytes))
    await setup.create('occupied.md', encode('occupied'))
    await setup.create('Case.md', encode('case alias fixture'))
    const otherRoot = `${documents}/holi-move-other-${runId}-${ordinal}`
    nativeIO.mkdir(otherRoot)
    const otherStore = createVaultStorage(nativeFiles, {
      remote: 'holi/move-other',
      root: otherRoot,
    })
    await otherStore.create('from.md', encode('other root'))
    const symlinkError = new interop.Reference<NSError>()
    const linked = NSFileManager.defaultManager.createSymbolicLinkAtPathWithDestinationPathError(
      `${root}/linked`,
      otherRoot,
      symlinkError,
    )
    if (symlinkError.value || !linked)
      throw new Error(symlinkError.value?.localizedDescription ?? 'Could not create move symlink')
    const rejectMove = async (from: string, to: string, revision: string) => {
      try {
        await setup.move(from, to, revision)
      } catch {
        return
      }
      throw new Error(`Unsafe move accepted: ${from} -> ${to}`)
    }
    await rejectMove('from.md', 'occupied.md', source.revision)
    await rejectMove('from.md', 'case.md', source.revision)
    await rejectMove('from.md', 'linked/escape.md', source.revision)
    await rejectMove('from.md', 'stale.md', 'stale-revision')
    await nativeFiles.create(root, 'private.local.md', encode('local source'))
    const privateSource = await setup.read('private.local.md')
    const privateJournalsBefore = await nativeFiles.privateList(root)
    await rejectMove('private.local.md', 'public-from-local.md', privateSource.revision)
    if (decode(await nativeFiles.read(root, 'private.local.md')) !== 'local source')
      throw new Error('Rejected local-source move changed private bytes')
    if ((await nativeFiles.privateList(root)).join('\0') !== privateJournalsBefore.join('\0'))
      throw new Error('Rejected local-source move created or changed a journal')
    for (const privatePath of ['private.local.md', '.env', '.hidden.md'])
      await rejectMove('from.md', privatePath, source.revision)
    await rejectMove('from.md', 'from.md', source.revision)
    if (decode((await otherStore.read('from.md')).bytes) !== 'other root')
      throw new Error('Identical path in another root was modified')
    const markerFor = (event: {
      operationId: string
      phase: string
      direction: string
      path?: string
    }) =>
      nativeIO.writeExclusive(
        markerPath,
        encode(
          JSON.stringify({
            schemaVersion: 1,
            runId,
            ordinal,
            startedAt,
            readyAt: Date.now(),
            pid: NSProcessInfo.processInfo.processIdentifier,
            root,
            privatePath: stagingDirectory(
              nativeIO.canonical(knownFolders.ios.library().path),
              root,
            ),
            operationId: event.operationId,
            phase: event.phase,
            direction: event.direction,
            path: event.path ?? null,
          }),
        ),
      )
    if (ordinal === 12) {
      const stopAfterJournal: StorageCheckpointCallback = async (event) => {
        if (event.phase === 'journal-after' && event.direction === 'after')
          throw new Error('compiled interruption before recovery')
      }
      const interrupted = createVaultStorage(
        createNativeFiles(),
        { remote: 'holi/move-interrupted', root },
        { checkpoint: stopAfterJournal },
      )
      try {
        await interrupted.move('from.md', 'to.md', source.revision)
      } catch {
        // This case deliberately begins with a durable journal.
      }
      if ((await nativeFiles.privateList(root)).length !== 1)
        throw new Error('Repeated-recovery fixture did not retain its journal')
      const recoveryCheckpoint: StorageCheckpointCallback = async (event) => {
        if (event.phase !== 'file-before' || event.direction !== 'before' || event.path !== 'to.md')
          return
        markerFor({ ...event, phase: 'recovery-file-before' })
        await new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('host kill timeout')), 60_000),
        )
      }
      await createVaultStorage(
        createNativeFiles(),
        { remote: 'holi/move-recovery-interrupted', root },
        { checkpoint: recoveryCheckpoint },
      ).list()
      throw new Error('Recovery checkpoint was not interrupted')
    }
    const checkpoint: StorageCheckpointCallback = async (event) => {
      const matches =
        event.phase === expected.phase &&
        event.direction === expected.direction &&
        (expected.path === undefined ||
          event.path === expected.path ||
          event.path === `move-${event.operationId}.json`)
      if (!matches) return
      markerFor(event)
      await new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('host kill timeout')), 60_000),
      )
    }
    const interrupted = createVaultStorage(
      createNativeFiles(),
      { remote: 'holi/move-interrupted', root },
      { checkpoint },
    )
    await interrupted.move('from.md', 'to.md', source.revision)
    throw new Error('Native move checkpoint was not interrupted')
  }

  const store = createVaultStorage(nativeFiles, { remote: 'holi/move-recovery', root })
  const listed = await store.list()
  if (expected.phase === 'journal-before') {
    if (!listed.includes('from.md' as never) || listed.includes('to.md' as never))
      throw new Error('Pre-journal kill did not preserve original names')
    if (decode((await store.read('from.md')).bytes) !== sourceBytes)
      throw new Error('Pre-journal kill changed source bytes')
    if (
      decode((await store.read('back-a.md')).bytes) !== backABytes ||
      decode((await store.read('back-b.md')).bytes) !== backBBytes
    )
      throw new Error('Pre-journal kill changed backlinks')
  } else {
    if (!listed.includes('to.md' as never) || listed.includes('from.md' as never))
      throw new Error('Journaled move did not recover destination')
    if (decode((await store.read('to.md')).bytes) !== movedBytes)
      throw new Error('Recovered destination bytes differ')
    if (
      decode((await store.read('back-a.md')).bytes) !== movedABytes ||
      decode((await store.read('back-b.md')).bytes) !== movedBBytes
    )
      throw new Error('Recovered backlink bytes differ')
  }
  if ((await nativeFiles.privateList(root)).length !== 0)
    throw new Error('Recovered move journal was not cleaned up')

  const malformedRoot = `${documents}/holi-move-malformed-${runId}-${ordinal}`
  nativeIO.mkdir(malformedRoot)
  const malformed = createVaultStorage(nativeFiles, {
    remote: 'holi/malformed',
    root: malformedRoot,
  })
  await malformed.create('keep.md', encode('malformed fixture preserved'))
  const malformedId = `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`
  const malformedName = `move-${malformedId}.json`
  await nativeFiles.privatePublish(malformedRoot, malformedName, encode('{bad'), null)
  let malformedError = ''
  try {
    await malformed.list()
  } catch (error) {
    malformedError = String(error)
  }
  if (!malformedError.includes('Malformed move recovery journal'))
    throw new Error('Malformed journal did not fail with its expected validation error')
  if (
    decode(await nativeFiles.read(malformedRoot, 'keep.md')) !== 'malformed fixture preserved' ||
    !(await nativeFiles.privateList(malformedRoot)).includes(malformedName)
  )
    throw new Error('Malformed journal did not retain its evidence and original bytes')

  const conflictRoot = `${documents}/holi-move-conflict-${runId}-${ordinal}`
  nativeIO.mkdir(conflictRoot)
  const conflict = createVaultStorage(nativeFiles, { remote: 'holi/conflict', root: conflictRoot })
  await conflict.create('from.md', encode('newer user bytes'))
  const conflictId = `10000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`
  const conflictName = `move-${conflictId}.json`
  const conflictBytes = encode('original bytes')
  await nativeFiles.privatePublish(
    conflictRoot,
    conflictName,
    encode(
      JSON.stringify({
        schema: 2,
        root: conflictRoot,
        operationId: conflictId,
        from: 'from.md',
        to: 'to.md',
        changes: [
          { path: 'from.md', before: [...conflictBytes], after: null },
          { path: 'to.md', before: null, after: [...conflictBytes] },
        ],
      }),
    ),
    null,
  )
  let conflictError = ''
  try {
    await conflict.list()
  } catch (error) {
    conflictError = String(error)
  }
  if (!conflictError.includes('Move recovery conflict at from.md'))
    throw new Error('Conflicting journal did not fail with its expected conflict error')
  if (
    decode(await nativeFiles.read(conflictRoot, 'from.md')) !== 'newer user bytes' ||
    !(await nativeFiles.privateList(conflictRoot)).includes(conflictName)
  )
    throw new Error('Conflicting journal changed newer bytes or lost its evidence')
  const wrongRoot = `${documents}/holi-move-wrong-root-${runId}-${ordinal}`
  const namedRoot = `${documents}/holi-move-named-root-${runId}-${ordinal}`
  nativeIO.mkdir(wrongRoot)
  nativeIO.mkdir(namedRoot)
  const wrongRootStore = createVaultStorage(nativeFiles, {
    remote: 'holi/wrong-root',
    root: wrongRoot,
  })
  const wrongRootSource = encode('[[from.md]]')
  const wrongRootMoved = encode('[[to.md]]')
  await wrongRootStore.create('from.md', wrongRootSource)
  await createVaultStorage(nativeFiles, { remote: 'holi/named-root', root: namedRoot }).create(
    'keep.md',
    encode('named root preserved'),
  )
  const canonicalWrongRoot = nativeIO.canonical(wrongRoot)
  const canonicalNamedRoot = nativeIO.canonical(namedRoot)
  const wrongRootId = `20000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`
  const wrongRootName = `move-${wrongRootId}.json`
  const wrongRootJournal = encode(
    JSON.stringify({
      schema: 2,
      root: canonicalNamedRoot,
      operationId: wrongRootId,
      from: 'from.md',
      to: 'to.md',
      changes: [
        { path: 'from.md', before: [...wrongRootSource], after: null },
        { path: 'to.md', before: null, after: [...wrongRootMoved] },
      ],
    }),
  )
  await nativeFiles.privatePublish(canonicalWrongRoot, wrongRootName, wrongRootJournal, null)
  let wrongRootError = ''
  try {
    await wrongRootStore.list()
  } catch (error) {
    wrongRootError = String(error)
  }
  if (!wrongRootError.includes('Invalid move recovery journal identity'))
    throw new Error('Wrong-root journal was not refused for its root identity')
  if (
    decode(await nativeFiles.read(canonicalWrongRoot, 'from.md')) !== '[[from.md]]' ||
    (await nativeFiles.readOptional(canonicalWrongRoot, 'to.md')) !== null ||
    decode(await nativeFiles.read(canonicalNamedRoot, 'keep.md')) !== 'named root preserved' ||
    !(await nativeFiles.privateList(canonicalWrongRoot)).includes(wrongRootName) ||
    (await nativeFiles.privateRead(canonicalWrongRoot, wrongRootName)).join(',') !==
      wrongRootJournal.join(',')
  )
    throw new Error('Wrong-root refusal changed fixture bytes or lost exact journal evidence')
  const wrongRootRefusal = {
    receivingRoot: canonicalWrongRoot,
    namedRoot: canonicalNamedRoot,
    journalName: wrongRootName,
    error: wrongRootError,
    sourceUnchanged: true,
    destinationAbsent: true,
    namedRootUnchanged: true,
    journalBytesPreserved: true,
  }
  return {
    root,
    listed,
    recovered: expected.phase !== 'journal-before',
    wrongRootRefusal,
    malformedJournalRefused: true,
    conflictJournalRefused: true,
  }
}
