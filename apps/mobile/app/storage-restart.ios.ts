import { knownFolders } from '@nativescript/core'
import { createNativeFiles, nativeFiles } from './native-files.ios'
import { nativeIO } from './native-posix.ios'
import { createVaultStorage } from './vault-storage'
import {
  interruptionAfter,
  interruptionArtifacts,
  interruptionBefore,
  interruptionPending,
  stageNamePattern,
  stagingDirectory,
} from './storage-staging'

const encode = (value: string) =>
  new Uint8Array(Array.from(unescape(encodeURIComponent(value)), (char) => char.charCodeAt(0)))
const decode = (value: Uint8Array) => decodeURIComponent(escape(String.fromCharCode(...value)))

/** Only fixed test-owned paths are selectable; no launch value is a filesystem path. */
export async function runRestartPhase(
  phase: 'stage' | 'recovery',
  runId: string,
  startedAt: number,
) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId))
    throw new Error('Invalid compatibility run identity')
  const documents = nativeIO.canonical(knownFolders.documents().path)
  const root = `${documents}/holi-storage-interruption-${runId}`
  const checkpointPath = `${documents}/holi-stage-checkpoint-${runId}.json`
  const store = createVaultStorage(nativeFiles, { remote: 'holi/interruption', root })
  if (phase === 'stage') {
    nativeIO.mkdir(root)
    const original = await store.create('durable.md', encode(interruptionBefore))
    for (const [name, value] of interruptionArtifacts)
      nativeIO.writeExclusive(`${root}/${name}`, encode(value))
    const pending = createVaultStorage(
      createNativeFiles({
        staged: async ({ stage, root: canonicalRoot, relative }) => {
          nativeIO.writeExclusive(
            checkpointPath,
            encode(
              JSON.stringify({
                schemaVersion: 1,
                phase: 'staged',
                runId,
                startedAt,
                readyAt: Date.now(),
                pid: NSProcessInfo.processInfo.processIdentifier,
                root: canonicalRoot,
                relative,
                stage,
              }),
            ),
          )
          await new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error('Host did not terminate the staged save within 60 seconds')),
              60_000,
            ),
          )
        },
      }),
      { remote: 'holi/interruption', root },
    )
    await pending.save('durable.md', encode(interruptionPending), original.revision)
    throw new Error('Staged save unexpectedly completed')
  }
  const markerBytes = nativeIO.read(checkpointPath)
  if (markerBytes.length > 16_384) throw new Error('Oversized interruption checkpoint')
  const marker = JSON.parse(decode(markerBytes)) as Record<string, unknown>
  const expectedParent = stagingDirectory(
    nativeIO.canonical(knownFolders.ios.library().path),
    nativeIO.canonical(root),
  )
  const stage = marker.stage
  if (
    marker.schemaVersion !== 1 ||
    marker.phase !== 'staged' ||
    marker.runId !== runId ||
    marker.root !== root ||
    marker.relative !== 'durable.md' ||
    typeof stage !== 'string' ||
    !stage.startsWith(`${expectedParent}/`) ||
    !stageNamePattern.test(stage.slice(expectedParent.length + 1)) ||
    marker.pid === NSProcessInfo.processInfo.processIdentifier
  )
    throw new Error('Invalid interruption checkpoint')
  const original = await store.read('durable.md')
  if (decode(original.bytes) !== interruptionBefore)
    throw new Error('Interrupted publication changed durable bytes')
  if (nativeIO.kind(stage) !== null) throw new Error('Owned interrupted stage was not recovered')
  for (const [name, value] of interruptionArtifacts)
    if (decode(nativeIO.read(`${root}/${name}`)) !== value)
      throw new Error(`Unowned artifact changed: ${name}`)
  const listed = await store.list()
  if (
    listed.length !== 2 ||
    !listed.includes('durable.md' as never) ||
    !listed.includes('unowned.md' as never)
  )
    throw new Error('Recovery listed an internal artifact')
  const saved = await store.save('durable.md', encode(interruptionAfter), original.revision)
  if (decode(saved.bytes) !== interruptionAfter) throw new Error('Post-recovery save failed')
  const normal = createVaultStorage(nativeFiles, {
    remote: 'holi/storage-check',
    root: `${documents}/holi-storage-check-${runId}`,
  })
  const normalBytes = decode((await normal.read('same/note.md')).bytes)
  if (normalBytes !== 'winner A' && normalBytes !== 'winner B')
    throw new Error('Original vault did not survive restart')
  for (const [index, name] of ['Café.md', 'Cafe\u0301.md'].entries()) {
    const raw = createVaultStorage(nativeFiles, {
      remote: `holi/raw-${index}`,
      root: `${documents}/holi-raw-${runId}-${index}`,
    })
    if (
      decode((await raw.read(name)).bytes) !== 'updated raw native fixture' ||
      (await raw.list()).join() !== name
    )
      throw new Error('Raw filename did not survive restart')
  }
  return {
    root,
    before: interruptionBefore,
    after: interruptionAfter,
    normalBytes,
    ownedStageRemoved: true,
    unownedPreserved: interruptionArtifacts.map(([name]) => name),
    rawNamesPreserved: ['Café.md', 'Cafe\u0301.md'],
  }
}
