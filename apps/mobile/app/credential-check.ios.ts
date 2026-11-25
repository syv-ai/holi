import { File, knownFolders, path } from '@nativescript/core'
import { createGitHubCredentials } from './github-credentials'
import { createNativeCredentialStore } from './native-credentials.ios'
import type { DeviceAuthHttp } from './device-auth'

const token = 'synthetic-diagnostic-token-never-report'
const phases = [
  'store',
  'read',
  'replace',
  'sign-out',
  'verify-absent',
  'delete-unrelated',
  'verify-empty',
]

export async function runCredentialCheck(runId: string, phase: string): Promise<string> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId) ||
    !phases.includes(phase)
  )
    throw new Error('Invalid credential diagnostic configuration')
  const store = createNativeCredentialStore({ runId, slot: 'primary' })
  const unrelated = createNativeCredentialStore({ runId, slot: 'unrelated' })
  const reportPath = path.join(knownFolders.documents().path, `credential-diagnostic-${runId}.json`)
  const report = (outcome: Record<string, unknown>) =>
    File.fromPath(reportPath).writeTextSync(
      JSON.stringify({
        schemaVersion: 1,
        runId,
        phase,
        pid: NSProcessInfo.processInfo.processIdentifier,
        observedAt: Date.now(),
        build: NSBundle.mainBundle.infoDictionary?.objectForKey('CFBundleVersion') ?? 'unknown',
        source: 'diagnostic-keychain-namespace',
        ...outcome,
      }),
      (error) => {
        if (error) throw error
      },
    )
  const credentials = createGitHubCredentials(store)
  const syntheticHttp: DeviceAuthHttp = async (url, init) => {
    if (init.method !== 'POST') throw new Error('Unexpected diagnostic HTTP method')
    if (url === 'https://github.com/login/device/code')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'synthetic',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://example.invalid',
          expires_in: 60,
          interval: 1,
        }),
      }
    if (url !== 'https://github.com/login/oauth/access_token')
      throw new Error('Unexpected diagnostic endpoint')
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: token, token_type: 'bearer', scope: 'repo' }),
    }
  }
  try {
    if (phase === 'store') {
      unrelated.write('synthetic-unrelated')
      const auth = await credentials.authorize({
        fetch: syntheticHttp,
        clientId: 'diagnostic-client-id',
      })
      await auth.wait()
      const metadata = store.metadata()
      if (store.read() !== token || !metadata?.accessible || metadata.synchronizable)
        throw new Error('Credential store phase failed')
      report({ outcome: 'stored', metadata, tokenRecorded: false })
    } else if (phase === 'read' || phase === 'replace') {
      const expected = phase === 'replace' ? token : 'synthetic-replacement'
      if (store.read() !== expected) throw new Error('Persisted credential missing')
      if (phase === 'replace') {
        store.write('synthetic-replacement')
        if (store.read() !== 'synthetic-replacement') throw new Error('Replacement failed')
      }
      report({
        outcome: phase === 'read' ? 'persisted' : 'replaced',
        metadata: store.metadata(),
        tokenRecorded: false,
      })
    } else if (phase === 'sign-out') {
      credentials.signOut()
      if (store.read() !== null || unrelated.read() !== 'synthetic-unrelated')
        throw new Error('Sign-out isolation failed')
      report({ outcome: 'signed-out', unrelatedPreserved: true, tokenRecorded: false })
    } else if (phase === 'verify-absent') {
      if (store.read() !== null || unrelated.read() !== 'synthetic-unrelated')
        throw new Error('Credential absence/isolation failed')
      report({ outcome: 'primary-absent', unrelatedPreserved: true, tokenRecorded: false })
    } else if (phase === 'delete-unrelated') {
      unrelated.remove()
      if (store.read() !== null || unrelated.read() !== null)
        throw new Error('Diagnostic cleanup failed')
      report({ outcome: 'empty', tokenRecorded: false })
    } else {
      if (store.read() !== null || unrelated.read() !== null)
        throw new Error('Diagnostic namespace is not empty')
      report({ outcome: 'empty', tokenRecorded: false })
    }
    return `Credential diagnostic ${phase} passed`
  } catch (error) {
    report({ outcome: 'failed', error: 'Credential diagnostic phase failed', tokenRecorded: false })
    throw error
  }
}
