import { Device, File, knownFolders, path } from '@nativescript/core'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'
import { nativeFiles } from './native-files.ios'
import { runVaultStorageCheck } from './vault-storage-check'

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
  let status: string
  let phase = 'format-corpus'
  let operation = 'runVaultFormatCorpus'
  let storageRoot: string | undefined
  let secondRoot: string | undefined
  let evidence: Record<string, unknown>
  try {
    const corpus = runVaultFormatCorpus(nativeUtf8)
    const documents = knownFolders.documents().path
    storageRoot = `${documents}/holi-storage-check-${runId}-${startedAt}`
    secondRoot = `${documents}/holi-storage-other-${runId}-${startedAt}`
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
    phase = 'shared-storage-scenarios'
    operation = 'runVaultStorageCheck'
    const storage = await runVaultStorageCheck(nativeFiles, storageRoot, secondRoot)
    phase = 'native-filename-spellings'
    operation = 'verifyNativeFilenameSpellings'
    const filenameCases = [
      { root: storageRoot, name: 'Native-Café.md', alternate: 'Native-Café.md' },
      { root: secondRoot, name: 'Native-Cafe\u0301.md', alternate: 'Native-Cafe\u0301.md' },
    ]
    const initial = nativeUtf8('native filename bytes')
    const updated = nativeUtf8('updated native filename bytes')
    const initialData =
      NSString.stringWithString('native filename bytes').dataUsingEncoding(NSUTF8StringEncoding)
    if (!initialData) throw new Error('Could not encode native filename fixture')
    for (const item of filenameCases) {
      if (
        !manager.createFileAtPathContentsAttributes(`${item.root}/${item.name}`, initialData, null)
      )
        throw new Error(`Could not create independent native fixture: ${item.name}`)
      const original = await nativeFiles.read(item.root, item.alternate)
      if (
        original.length !== initial.length ||
        original.some((byte, index) => byte !== initial[index])
      )
        throw new Error(`Alternate filename spelling could not read native fixture: ${item.name}`)
      await nativeFiles.publish(item.root, item.name, updated, initial)
      const afterSave = await nativeFiles.read(item.root, item.alternate)
      if (
        afterSave.length !== updated.length ||
        afterSave.some((byte, index) => byte !== updated[index])
      )
        throw new Error(
          `Alternate filename spelling could not read saved native fixture: ${item.name}`,
        )
      const listed = await nativeFiles.list(item.root)
      const normalized = (value: string) =>
        String(NSString.stringWithString(value).decomposedStringWithCanonicalMapping)
      if (listed.filter((entry) => normalized(entry.path) === normalized(item.name)).length !== 1)
        throw new Error(`Native filename was not listed exactly once: ${item.name}`)
    }
    status = `${corpus.passed}/${corpus.total} format cases and storage passed; ${corpus.failed} failed`
    evidence = {
      corpus,
      storage,
      nativeFilenameSpellings: true,
      nativeFilenameRoots: filenameCases.map(({ root, name }) => ({ root, name })),
      storageRoot,
    }
  } catch (error) {
    status = `Compatibility failed during ${phase}/${operation}: ${String(error)}`
    evidence = {
      error: String(error),
      failure: { phase, operation },
      ...(storageRoot ? { storageRoot } : {}),
      ...(secondRoot ? { secondRoot } : {}),
    }
  }
  const report = {
    schemaVersion: 1,
    runId,
    platform: 'ios',
    osVersion: Device.osVersion,
    startedAt,
    finishedAt: Date.now(),
    ...evidence,
  }
  // The driver reads only this app's fresh simulator sandbox, never a checkout path.
  File.fromPath(path.join(knownFolders.documents().path, 'vault-format-report.json')).writeTextSync(
    JSON.stringify(report),
    (error) => {
      if (error) throw error
    },
  )
  return status
}
