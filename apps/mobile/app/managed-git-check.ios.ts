import { File, knownFolders } from '@nativescript/core'
import { createManagedWorkingCopyIOS } from './managed-working-copy.ios'

/** Executes a run-correlated request from the disposable Simulator controller. */
export async function runManagedGitCheck(runId: string) {
  const environment = NSProcessInfo.processInfo.environment
  const requestPath = environment.objectForKey('HOLI_MANAGED_GIT_REQUEST')
  const documents = knownFolders.documents().path
  if (typeof requestPath !== 'string' || !requestPath.startsWith(`${documents}/`))
    throw new Error('Missing owned managed Git request')
  const request = JSON.parse(File.fromPath(requestPath).readTextSync()) as {
    runId: string
    caseId: string
    action: 'acquire' | 'reopen' | 'fetch' | 'publish'
    target: { remote: string; root: string; branch: string }
    endpoint: string
    username: string
    holdAt?: string
  }
  if (
    request.runId !== runId ||
    !/^[a-z0-9-]{1,80}$/.test(request.caseId) ||
    !['acquire', 'reopen', 'fetch', 'publish'].includes(request.action) ||
    !request.target.root.startsWith(`${documents}/`)
  )
    throw new Error('Invalid managed Git request identity')
  const credential = environment.objectForKey('HOLI_MANAGED_GIT_CREDENTIAL')
  if (typeof credential !== 'string' || !credential) throw new Error('Missing fixture credential')
  const context = {
    runId,
    caseId: request.caseId,
    pid: NSProcessInfo.processInfo.processIdentifier,
    action: request.action,
  }
  try {
    const copy = createManagedWorkingCopyIOS(request.target, credential, {
      endpoint: request.endpoint,
      username: request.username,
      runId,
      async onCheckpoint(phase, paths) {
        File.fromPath(
          `${documents}/managed-checkpoint-${runId}-${request.caseId}.json`,
        ).writeTextSync(JSON.stringify({ ...context, phase, paths }), (error) => {
          if (error) throw error
        })
        if (request.holdAt === phase) await new Promise<void>(() => {})
      },
    })
    const binding = await copy[request.action]()
    return { ...context, ok: true, ...(binding ? { identity: binding } : {}) }
  } catch (error) {
    const refusal = error instanceof Error && 'refusal' in error ? error.refusal : undefined
    return { ...context, ok: false, message: String(error), ...(refusal ? { refusal } : {}) }
  }
}
