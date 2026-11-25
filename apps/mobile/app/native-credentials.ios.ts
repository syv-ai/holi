import type { CredentialStore } from './github-credentials'

type DiagnosticCredentialSlot = 'primary' | 'unrelated'
type CredentialMetadata = { accessible: boolean; synchronizable: boolean }

function nativeError(error: NSError | null, operation: string): Error {
  const status = error?.code ?? -1
  return new Error(`iOS Keychain ${operation} failed (OSStatus ${status})`)
}

function makeStore(native: HoliNativeCredentials): CredentialStore & {
  metadata(): CredentialMetadata | null
} {
  return {
    read() {
      const result = new interop.Reference<NSError>()
      const data = native.read(result)
      if (result.value) throw nativeError(result.value, 'read')
      return data
        ? NSString.alloc().initWithDataEncoding(data, NSUTF8StringEncoding).toString()
        : null
    },
    write(token) {
      const data = NSString.stringWithString(token).dataUsingEncoding(NSUTF8StringEncoding)
      if (!data || !data.length) throw new Error('GitHub credential must not be empty')
      const result = new interop.Reference<NSError>()
      if (!native.writeError(data, result) || result.value) throw nativeError(result.value, 'write')
    },
    remove() {
      const result = new interop.Reference<NSError>()
      if (!native.remove(result) || result.value) throw nativeError(result.value, 'remove')
    },
    metadata() {
      const result = new interop.Reference<NSError>()
      const value = native.metadata(result)
      if (result.value) throw nativeError(result.value, 'metadata')
      return value
        ? {
            accessible: Boolean(value.objectForKey('accessible')),
            synchronizable: Boolean(value.objectForKey('synchronizable')),
          }
        : null
    },
  }
}

export function createNativeCredentialStore(diagnostic?: {
  runId: string
  slot: DiagnosticCredentialSlot
}) {
  if (!diagnostic) return makeStore(HoliNativeCredentials.alloc().init())
  return createDiagnosticCredentialStore(diagnostic.runId, diagnostic.slot)
}

function createDiagnosticCredentialStore(
  runId: string,
  slot: DiagnosticCredentialSlot,
): CredentialStore & { metadata(): CredentialMetadata | null } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error('Diagnostic Keychain runId must be a UUID')
  }
  const nativeSlot = slot === 'primary' ? 0 : slot === 'unrelated' ? 1 : -1
  if (nativeSlot < 0) throw new Error('Invalid diagnostic Keychain slot')
  const native = HoliNativeCredentials.alloc().initWithDiagnosticRunIdSlot(runId, nativeSlot)
  if (!native) throw new Error('Invalid diagnostic Keychain configuration')
  return makeStore(native)
}
