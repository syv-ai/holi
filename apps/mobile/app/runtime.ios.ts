import { Device, File, knownFolders, path } from '@nativescript/core'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'
import { createNativeFiles, nativeFiles } from './native-files.ios'
import { runVaultStorageCheck } from './vault-storage-check'
import { nativeIO } from './native-posix.ios'
import { createVaultStorage } from './vault-storage'
import { noteMetadataSettings } from './note-metadata-settings.ios'
import { createNoteMetadata } from './note-metadata'
import { stagingDirectory } from './storage-staging'
import { runRestartPhase } from './storage-restart.ios'
import { runMoveRestart } from './move-restart.ios'
import { runGitCompatibilityCheck } from './compatibility-check.ios'
import { runWorkingCopyCheck, runWorkingCopyTreeCheck } from './working-copy-check.ios'

// Foundation must encode the original spelling, not normalize NFC/NFD for us.
function nativeUtf8(text: string): Uint8Array {
  const data = NSString.stringWithString(text).dataUsingEncoding(NSUTF8StringEncoding)
  if (!data) throw new Error('Foundation could not encode UTF-8')
  return new Uint8Array(interop.bufferFromData(data))
}

/** The only iOS adapter: launch identity, native encoding and sandbox evidence. */
export async function checkCompatibility(): Promise<string> {
  const startedAt = Date.now()
  const runId = NSProcessInfo.processInfo.environment.objectForKey('HOLI_COMPAT_RUN_ID') ?? 'manual'
  const launchPhase =
    NSProcessInfo.processInfo.environment.objectForKey('HOLI_STORAGE_PHASE') ?? 'normal'
  const persist = (value: Record<string, unknown>) =>
    File.fromPath(
      path.join(knownFolders.documents().path, 'vault-format-report.json'),
    ).writeTextSync(
      JSON.stringify({
        schemaVersion: 2,
        runId,
        phase: launchPhase,
        platform: 'ios',
        osVersion: Device.osVersion,
        startedAt,
        finishedAt: Date.now(),
        ...value,
      }),
      (error) => {
        if (error) throw error
      },
    )
  let status: string
  let phase = 'format-corpus'
  let operation = 'runVaultFormatCorpus'
  let storageRoot: string | undefined
  let secondRoot: string | undefined
  let evidence: Record<string, unknown>
  let rawNames: unknown
  let prefixNamespace: Record<string, unknown>
  let git: Awaited<ReturnType<typeof runGitCompatibilityCheck>> | undefined
  let workingCopy:
    | (Awaited<ReturnType<typeof runWorkingCopyCheck>> & {
        cases?: Awaited<ReturnType<typeof runWorkingCopyCheck>>[]
        treeCases?: Awaited<ReturnType<typeof runWorkingCopyTreeCheck>>[]
      })
    | undefined
  try {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(runId))
      throw new Error('Invalid compatibility run identity')
    if (!['normal', 'stage', 'recovery', 'move-stage', 'move-recovery'].includes(launchPhase))
      throw new Error('Invalid storage phase')
    phase = 'note-metadata'
    operation = 'persist/reconstruct/remove'
    const metadata = createNoteMetadata(noteMetadataSettings, 'holi/diagnostic')
    metadata.recent('diagnostic.md')
    if (!metadata.visible(['diagnostic.md']).recents.includes('diagnostic.md'))
      throw new Error('Note metadata persistence check failed')
    const restoredMetadata = createNoteMetadata(noteMetadataSettings, 'holi/diagnostic')
    if (!restoredMetadata.visible(['diagnostic.md']).recents.includes('diagnostic.md'))
      throw new Error('Note metadata reconstruction check failed')
    restoredMetadata.remove('diagnostic.md')
    phase = 'format-corpus'
    operation = 'runVaultFormatCorpus'
    const corpus = runVaultFormatCorpus(nativeUtf8)
    if (launchPhase === 'move-stage' || launchPhase === 'move-recovery') {
      phase = launchPhase
      operation = 'runMoveRestart'
      const ordinal = Number(
        NSProcessInfo.processInfo.environment.objectForKey('HOLI_MOVE_CASE') ?? '-1',
      )
      const moveRestart = await runMoveRestart(
        launchPhase === 'move-stage' ? 'stage' : 'recovery',
        runId,
        ordinal,
        startedAt,
      )
      persist({ corpus, moveRestart })
      return 'Native move recovery passed'
    }
    if (launchPhase === 'stage' || launchPhase === 'recovery') {
      phase = launchPhase
      operation = 'runRestartPhase'
      const recovery = await runRestartPhase(launchPhase, runId, startedAt)
      persist({ corpus, recovery })
      return 'Interrupted save recovery passed'
    }
    phase = 'native-git-transport'
    operation = 'runGitCompatibilityCheck'
    git = await runGitCompatibilityCheck(runId)
    phase = 'native-working-copy-status'
    operation = 'runWorkingCopyCheck'
    const gitEnvironment = NSProcessInfo.processInfo.environment
    const manifestPath = gitEnvironment.objectForKey('HOLI_GIT_FIXTURE_MANIFEST')
    if (typeof manifestPath !== 'string') throw new Error('Missing working-copy fixture manifest')
    const manifestText = File.fromPath(manifestPath).readTextSync((error) => {
      if (error) throw error
    })
    const fixture = JSON.parse(manifestText) as {
      cases: Array<{ name: string; root: string; remote: string; branch: string | null }>
    }
    if (!Array.isArray(fixture.cases) || fixture.cases.length === 0)
      throw new Error('Working-copy fixture manifest has no cases')
    const results = []
    for (const item of fixture.cases) {
      results.push(
        await runWorkingCopyCheck(item.root, item.remote, item.branch ?? 'fixture-start'),
      )
    }
    if (!results[0]) throw new Error('Missing status matrix results')
    workingCopy = { ...results[0], cases: results }
    const treeResults = []
    for (const item of fixture.cases) {
      treeResults.push(
        await runWorkingCopyTreeCheck(item.root, item.remote, item.branch ?? 'fixture-start'),
      )
    }
    workingCopy.treeCases = treeResults
    const documents = knownFolders.documents().path
    phase = 'raw-native-bindings'
    operation = 'nativeNames/nativeRead'
    rawNames = await Promise.all(
      ['Café.md', 'Cafe\u0301.md'].map(async (name, index) => {
        const root = `${documents}/holi-raw-${runId}-${index}`
        const names = nativeIO.names(root)
        if (names.length !== 1 || names[0] !== name)
          throw new Error(`Raw spelling mismatch: ${JSON.stringify(names)}`)
        const store = createVaultStorage(nativeFiles, { remote: `holi/raw-${index}`, root })
        const original = await store.read(name)
        const originalText = String.fromCharCode(...original.bytes)
        if (originalText !== 'raw native fixture' && originalText !== 'updated raw native fixture')
          throw new Error('Raw file content mismatch')
        const updated = await store.save(
          name,
          nativeUtf8('updated raw native fixture'),
          original.revision,
        )
        if (String.fromCharCode(...updated.bytes) !== 'updated raw native fixture')
          throw new Error('Raw save mismatch')
        const listed = await store.list()
        if (listed.length !== 1 || listed[0] !== name)
          throw new Error('Raw listing spelling mismatch')
        const alias = index === 0 ? 'Cafe\u0301.md' : 'Café.md'
        let aliasRejected = false
        try {
          await store.read(alias)
        } catch {
          aliasRejected = true
        }
        if (!aliasRejected)
          throw new Error(
            `Unicode alias was accepted: ${JSON.stringify({ name, alias, entries: nativeIO.names(root), codepoints: Array.from(alias, (char) => char.codePointAt(0)) })}`,
          )
        return {
          root,
          name,
          names,
          aliasRejected,
          originalText,
          saved: 'updated raw native fixture',
        }
      }),
    )
    storageRoot = `${documents}/holi-storage-check-${runId}`
    secondRoot = `${documents}/holi-storage-other-${runId}`
    phase = 'create-storage-fixtures'
    operation = 'createDirectory'
    for (const root of [storageRoot, secondRoot]) {
      const error = new interop.Reference<NSError>()
      const created =
        NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
          root,
          true,
          null,
          error,
        )
      if (error.value || !created)
        throw new Error(error.value?.localizedDescription ?? 'Could not create storage test root')
    }
    phase = 'prepare-adversarial-fixtures'
    operation = 'createSymlinks'
    await nativeFiles.create(secondRoot, 'symlink-target.md', nativeUtf8('outside'))
    const manager = NSFileManager.defaultManager
    const symlinkFixtures: Array<[string, string]> = [
      ['linked', secondRoot],
      ['leaf-link.md', `${secondRoot}/symlink-target.md`],
      ['dangling-link.md', `${secondRoot}/missing.md`],
    ]
    for (const [name, destination] of symlinkFixtures) {
      const error = new interop.Reference<NSError>()
      const made = manager.createSymbolicLinkAtPathWithDestinationPathError(
        `${storageRoot}/${name}`,
        destination,
        error,
      )
      if (error.value || !made)
        throw new Error(error.value?.localizedDescription ?? `Could not create ${name} fixture`)
    }
    phase = 'prefix-private-namespace-proof'
    operation = 'exercisePrefixRoots'
    const namespacePrefix = `${documents}/holi-prefix-${runId}-`
    const padding = 'a'.repeat((32 - (nativeUtf8(namespacePrefix).length % 32)) % 32)
    const prefixRoot = `${namespacePrefix}${padding}`
    const nestedRoot = `${prefixRoot}x`
    const createPrefixRoot = (root: string) => {
      const error = new interop.Reference<NSError>()
      const created = manager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
        root,
        true,
        null,
        error,
      )
      if (error.value || !created)
        throw new Error(error.value?.localizedDescription ?? 'Could not create prefix fixture')
    }
    createPrefixRoot(prefixRoot)
    createPrefixRoot(nestedRoot)
    if (nativeUtf8(prefixRoot).length % 32 !== 0)
      throw new Error('Prefix fixture root is not chunk-aligned')
    const prefixPrivate = stagingDirectory(knownFolders.ios.library().path, prefixRoot)
    const nestedPrivate = stagingDirectory(knownFolders.ios.library().path, nestedRoot)
    const prefixStore = createVaultStorage(nativeFiles, {
      remote: 'holi/prefix-a',
      root: prefixRoot,
    })
    const nestedStore = createVaultStorage(nativeFiles, {
      remote: 'holi/prefix-b',
      root: nestedRoot,
    })
    await nestedStore.create('same/note.md', nativeUtf8('root B bytes'))
    await prefixStore.create('same/note.md', nativeUtf8('root A bytes'))
    const poisonName = 'move-00000000-0000-4000-8000-000000000589.json'
    const poisonBytes = nativeUtf8('{malformed B journal')
    await nativeFiles.privatePublish(nestedRoot, poisonName, poisonBytes, null)
    const prefixRead = await prefixStore.read('same/note.md')
    const prefixSaved = await prefixStore.save(
      'same/note.md',
      nativeUtf8('root A saved'),
      prefixRead.revision,
    )
    const prefixList = await prefixStore.list()
    const rawNestedBytes = await nativeFiles.read(nestedRoot, 'same/note.md')
    const malformedRejected = async (operation: () => Promise<unknown>) => {
      try {
        await operation()
      } catch (error) {
        if (String(error).includes('Malformed move recovery journal')) return true
        throw error
      }
      return false
    }
    const nestedReadRejected = await malformedRejected(() => nestedStore.read('same/note.md'))
    const nestedListRejected = await malformedRejected(() => nestedStore.list())
    if (
      String.fromCharCode(...prefixSaved.bytes) !== 'root A saved' ||
      String.fromCharCode(...rawNestedBytes) !== 'root B bytes' ||
      !nestedReadRejected ||
      !nestedListRejected ||
      prefixList.length !== 1 ||
      prefixList[0] !== 'same/note.md' ||
      nestedPrivate.startsWith(`${prefixPrivate}/`) ||
      prefixPrivate.startsWith(`${nestedPrivate}/`)
    )
      throw new Error('Prefix private namespace isolation failed')
    prefixNamespace = {
      rootA: prefixRoot,
      rootB: nestedRoot,
      privateA: prefixPrivate,
      privateB: nestedPrivate,
      bytesA: 'root A saved',
      bytesB: 'root B bytes',
      malformedReadRejected: nestedReadRejected,
      malformedListRejected: nestedListRejected,
      poisonName,
      poisonBytes: '{malformed B journal',
      poisonRetained:
        (await nativeFiles.privateRead(nestedRoot, poisonName)).length === poisonBytes.length,
    }
    if (!prefixNamespace.poisonRetained) throw new Error('B journal evidence was not retained')
    phase = 'shared-storage-scenarios'
    operation = 'runVaultStorageCheck'
    const storage = await runVaultStorageCheck(nativeFiles, storageRoot, secondRoot, (fault) =>
      createNativeFiles({ fault }),
    )
    phase = 'native-filename-spellings'
    operation = 'verifyHostCreatedRawFilenameSpellings'
    status = `${corpus.passed}/${corpus.total} format cases and storage passed; ${corpus.failed} failed`
    evidence = {
      corpus,
      storage,
      git,
      prefixNamespace,
      nativeFilenameSpellings: true,
      nativeFilenameRoots: rawNames,
      storageRoot,
    }
  } catch (error) {
    status = `Compatibility failed during ${phase}/${operation}: ${String(error)}`
    evidence = {
      error: String(error),
      failure: { phase, operation },
      ...(storageRoot ? { storageRoot } : {}),
      ...(secondRoot ? { secondRoot } : {}),
      ...(git ? { git } : {}),
    }
  }
  persist({ rawNames, workingCopy, ...evidence })
  return status
}
