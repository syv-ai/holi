import { Device, File, knownFolders, path } from '@nativescript/core'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'

// Foundation must encode the original spelling, not normalize NFC/NFD for us.
function nativeUtf8(text: string): Uint8Array {
  const data = NSString.stringWithString(text).dataUsingEncoding(NSUTF8StringEncoding)
  if (!data) throw new Error('Foundation could not encode UTF-8')
  return new Uint8Array(interop.bufferFromData(data))
}

/** The only iOS adapter: launch identity, native encoding and sandbox evidence. */
export function checkCompatibility(): string {
  const startedAt = Date.now()
  const runId = NSProcessInfo.processInfo.environment.objectForKey('HOLI_COMPAT_RUN_ID') ?? 'manual'
  let status: string
  let evidence: Record<string, unknown>
  try {
    const corpus = runVaultFormatCorpus(nativeUtf8)
    status = `${corpus.passed}/${corpus.total} cases passed; ${corpus.failed} failed`
    evidence = { corpus }
  } catch (error) {
    status = `Compatibility failed: ${String(error)}`
    evidence = { error: String(error) }
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
      throw error
    },
  )
  return status
}
