import { knownFolders } from '@nativescript/core'
import { nativeGit } from './native-git.ios'
import { nativeIO } from './native-posix.ios'
import { nativeFiles } from './native-files.ios'
import { createVaultStorage } from './vault-storage'

const encode = (value: string) =>
  new Uint8Array(Array.from(unescape(encodeURIComponent(value)), (char) => char.charCodeAt(0)))
const decode = (value: Uint8Array) => decodeURIComponent(escape(String.fromCharCode(...value)))

export interface GitCompatibilityEvidence {
  schemaVersion: 1
  runId: string
  libgit2Version: string
  fetchedRef: string
  pushedHead: string
  clone: boolean
  fetch: boolean
  push: boolean
  credentialChallenge: boolean
  invalidTlsRejected: boolean
  invalidTlsErrorCode: number
  invalidTlsErrorClass: number
  authenticationRejected: boolean
  authenticationErrorCode: number
  authenticationErrorClass: number
  transportRejected: boolean
  transportErrorCode: number
  transportErrorClass: number
  branchPreserved: boolean
  modePreserved: boolean
  binaryPreserved: boolean
  nonNotePreserved: boolean
  hooksDisabled: boolean
  filtersDisabled: boolean
  helpersDisabled: boolean
  remoteConstrained: boolean
  unsafeConfigRejected: boolean
  queuedFetchDuringSave: boolean
  queuedFetchFinalBytes: boolean
  conflictingMoveFetchRejected: boolean
  conflictingMoveBytesPreserved: boolean
  conflictingMoveJournalPreserved: boolean
  conflictingMoveRoot: string
  conflictingMoveJournalName: string
}

/** Exercises only the narrow native transport bridge; it is not the vault Git adapter. */
export async function runGitCompatibilityCheck(runId: string): Promise<GitCompatibilityEvidence> {
  const env = NSProcessInfo.processInfo.environment
  const required = (name: string) => {
    const value = env.objectForKey(name)
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`Missing Git fixture setting ${name}`)
    return value as string
  }
  const root = required('HOLI_GIT_FIXTURE_ROOT')
  const remote = required('HOLI_GIT_FIXTURE_URL')
  const invalidTls = required('HOLI_GIT_INVALID_TLS_URL')
  const username = required('HOLI_GIT_FIXTURE_USER')
  const password = required('HOLI_GIT_FIXTURE_PASSWORD')
  const clone = await nativeGit.run('clone', root, remote, username, password)
  const poisoned = await nativeGit.run('poison', root, remote, username, password)
  if (poisoned.hooksDisabled || poisoned.filtersDisabled || poisoned.helpersDisabled)
    throw new Error('Native Git sentinel configuration was not planted')
  const fetch = await nativeGit.run('fetch', root, remote, username, password)
  const diagnosticPath = `${root}-operation-gate`
  await nativeGit.run('clone', diagnosticPath, remote, username, password)
  let releasePublish!: () => void
  let publishPaused!: () => void
  const paused = new Promise<void>((resolve) => (publishPaused = resolve))
  const released = new Promise<void>((resolve) => (releasePublish = resolve))
  const wrapped = Object.create(nativeFiles) as typeof nativeFiles
  wrapped.publish = async (...args) => {
    publishPaused()
    await released
    return nativeFiles.publish(...args)
  }
  const diagnostic = createVaultStorage(wrapped, {
    remote: 'holi/native-diagnostic',
    root: diagnosticPath,
  })
  const saved = await diagnostic.create('gate.md', encode('before'))
  const saving = diagnostic.save('gate.md', encode('after'), saved.revision)
  await paused
  const fetching = nativeGit.run('fetch', diagnosticPath, remote, username, password)
  let fetchSettled = false
  void fetching.then(
    () => {
      fetchSettled = true
    },
    () => {
      fetchSettled = true
    },
  )
  let queuedFetchDuringSave = false
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    queuedFetchDuringSave = !fetchSettled
  } finally {
    releasePublish()
    await Promise.all([saving, fetching])
  }
  const queuedFetchFinalBytes =
    decode(await nativeFiles.read(diagnosticPath, 'gate.md')) === 'after'
  if (!queuedFetchDuringSave || !queuedFetchFinalBytes)
    throw new Error('Native Git did not wait for save publication and preserve final bytes')
  const gateRecoveryRoot = `${nativeIO.canonical(knownFolders.documents().path)}/holi-git-move-recovery-${runId}`
  nativeIO.mkdir(gateRecoveryRoot)
  const gateRecoveryStore = createVaultStorage(nativeFiles, {
    remote: 'holi/native-move-recovery',
    root: gateRecoveryRoot,
  })
  await gateRecoveryStore.create('from.md', encode('newer user bytes'))
  const gateRecoveryId = '30000000-0000-4000-8000-000000000719'
  const gateRecoveryJournalName = `move-${gateRecoveryId}.json`
  const gateRecoveryJournal = encode(
    JSON.stringify({
      schema: 2,
      root: gateRecoveryRoot,
      operationId: gateRecoveryId,
      from: 'from.md',
      to: 'to.md',
      changes: [
        { path: 'from.md', before: [...encode('original bytes')], after: null },
        { path: 'to.md', before: null, after: [...encode('original bytes')] },
      ],
    }),
  )
  await nativeFiles.privatePublish(
    gateRecoveryRoot,
    gateRecoveryJournalName,
    gateRecoveryJournal,
    null,
  )
  let gateRecoveryError: unknown
  try {
    await nativeGit.run('fetch', gateRecoveryRoot, remote, username, password)
  } catch (error) {
    gateRecoveryError = error
  }
  if (!gateRecoveryError) throw new Error('Native Git accepted conflicting move recovery')
  const conflictingMoveFetchRejected = String(gateRecoveryError).includes(
    'Move recovery conflict at from.md',
  )
  const conflictingMoveBytesPreserved =
    decode(await nativeFiles.read(gateRecoveryRoot, 'from.md')) === 'newer user bytes'
  const gateRecoveryJournals = await nativeFiles.privateList(gateRecoveryRoot)
  const conflictingMoveJournalPreserved =
    gateRecoveryJournals.includes(gateRecoveryJournalName) &&
    (await nativeFiles.privateRead(gateRecoveryRoot, gateRecoveryJournalName)).join(',') ===
      Array.from(gateRecoveryJournal).join(',')
  if (
    !conflictingMoveFetchRejected ||
    !conflictingMoveBytesPreserved ||
    !conflictingMoveJournalPreserved
  )
    throw new Error(
      'Native Git did not refuse conflicting move recovery without preserving evidence',
    )
  const push = await nativeGit.run('push', root, remote, username, password)
  const captureFailure = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
    } catch (error) {
      return error
    }
    throw new Error('Native Git unexpectedly accepted a failing transport fixture')
  }
  const invalidTlsFailure = await captureFailure(() =>
    nativeGit.run('clone', `${root}-invalid-tls`, invalidTls, username, password),
  )
  const authenticationFailure = await captureFailure(() =>
    nativeGit.run('clone', `${root}-invalid-auth`, remote, username, 'incorrect-fixture-password'),
  )
  const unreachable = new URL(remote)
  unreachable.port = '1'
  const transportFailure = await captureFailure(() =>
    nativeGit.run('clone', `${root}-invalid-transport`, unreachable.toString(), username, password),
  )
  const nativeFailure = (error: unknown, expectedCode: number | undefined, label: string) => {
    if (!(error instanceof Error) || !('code' in error) || !('gitErrorClass' in error))
      throw new Error(`${label} did not return structured native Git error evidence`)
    const code = Number(error.code)
    const errorClass = Number(error.gitErrorClass)
    if (!Number.isInteger(code) || !Number.isInteger(errorClass))
      throw new Error(`${label} returned malformed native Git error evidence`)
    if (expectedCode !== undefined && code !== expectedCode)
      throw new Error(`${label} returned libgit2 code ${code}, expected ${expectedCode}`)
    return { code, errorClass }
  }
  const tlsError = nativeFailure(invalidTlsFailure, -17, 'Invalid TLS')
  const authenticationError = nativeFailure(authenticationFailure, -16, 'Invalid credentials')
  const transportError = nativeFailure(transportFailure, undefined, 'Transport')
  const { code: invalidTlsErrorCode, errorClass: invalidTlsErrorClass } = tlsError
  const { code: authenticationErrorCode, errorClass: authenticationErrorClass } =
    authenticationError
  const { code: transportErrorCode, errorClass: transportErrorClass } = transportError
  if (
    !Number.isInteger(transportErrorCode) ||
    transportErrorCode === authenticationErrorCode ||
    transportErrorCode === invalidTlsErrorCode ||
    transportErrorClass === invalidTlsErrorClass
  )
    throw new Error('Transport failure was not distinguished from TLS and authentication failures')
  const invalidTlsRejected = true
  const binary = nativeIO.read(`${root}/fixture.bin`)
  const nonNote = nativeIO.read(`${root}/fixture.dat`)
  const attributesError = new interop.Reference<NSError>()
  const mode = NSFileManager.defaultManager.attributesOfItemAtPathError(
    `${root}/executable.sh`,
    attributesError,
  )
  if (attributesError.value) throw new Error(attributesError.value.localizedDescription)
  const modeValue = Number(mode?.objectForKey(NSFilePosixPermissions))
  const version = nativeGit.version()
  if (version !== '1.9.7') throw new Error(`Unexpected embedded libgit2 version ${version}`)
  return {
    schemaVersion: 1,
    runId,
    libgit2Version: version,
    fetchedRef: fetch.fetchTarget,
    pushedHead: push.headTarget,
    clone: clone.success,
    fetch: fetch.success,
    push: push.success,
    credentialChallenge:
      clone.credentialChallenge && fetch.credentialChallenge && push.credentialChallenge,
    invalidTlsRejected,
    invalidTlsErrorCode,
    invalidTlsErrorClass,
    authenticationRejected: true,
    authenticationErrorCode,
    authenticationErrorClass,
    transportRejected: true,
    transportErrorCode,
    transportErrorClass,
    branchPreserved:
      clone.branch === 'refs/heads/fixture-start' &&
      fetch.branch === clone.branch &&
      clone.headTarget === fetch.headTarget &&
      fetch.headTarget === push.headTarget,
    modePreserved: (modeValue & 0o111) !== 0,
    binaryPreserved:
      binary.length === 5 &&
      binary[0] === 0 &&
      binary[1] === 1 &&
      binary[2] === 2 &&
      binary[3] === 255 &&
      binary[4] === 128,
    nonNotePreserved:
      String.fromCharCode(...nonNote) === 'non-note fixture\n' && fetch.fetchTarget.length === 40,
    hooksDisabled: clone.hooksDisabled && fetch.hooksDisabled && push.hooksDisabled,
    filtersDisabled: clone.filtersDisabled && fetch.filtersDisabled && push.filtersDisabled,
    helpersDisabled: clone.helpersDisabled && fetch.helpersDisabled && push.helpersDisabled,
    remoteConstrained: clone.remoteConstrained && fetch.remoteConstrained && push.remoteConstrained,
    unsafeConfigRejected:
      fetch.hooksDisabled &&
      fetch.filtersDisabled &&
      fetch.helpersDisabled &&
      push.hooksDisabled &&
      push.filtersDisabled &&
      push.helpersDisabled,
    queuedFetchDuringSave,
    queuedFetchFinalBytes,
    conflictingMoveFetchRejected,
    conflictingMoveBytesPreserved,
    conflictingMoveJournalPreserved,
    conflictingMoveRoot: gateRecoveryRoot,
    conflictingMoveJournalName: gateRecoveryJournalName,
  }
}
