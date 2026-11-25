import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

const { prepare, finalize, required, smokeSuites, lifecycle } = createRequire(import.meta.url)(
  '../scripts/check-windows-launch-results.cjs',
) as {
  prepare(run: string, env: NodeJS.ProcessEnv): string
  finalize(run: string, hash: string, env: NodeJS.ProcessEnv): void
  required: Record<string, string[]>
  smokeSuites: string[]
  lifecycle: [id: string, title: string, receipt: string, barrier?: string][]
}

const env = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
const controlPrefix = 'HOLI_WINDOWS_OWNED_CONTROL_PROOF '
const producerPrefix = 'HOLI_WINDOWS_OWNED_PRODUCER_PROOF '
const timeoutTitle = 'authenticates EMPTY when a spawn timeout stops a live native tree'
const createFailureTitle = 'reports a missing executable separately from authenticated EMPTY'
const reports = () =>
  [
    ...Object.entries(required),
    ...smokeSuites.map((file): [string, string[]] => [file, ['executed']]),
  ].map(([file, names]) => ({
    name: `C:\\repo\\apps\\desktop\\${file.replaceAll('/', '\\')}`,
    assertionResults: names.map((title) => ({ title, status: 'passed' })),
  }))
// Synthetic checker inputs only. These are not native test outputs, and are
// built independently of the checker's per-case schemas.
type RecordFixture = {
  caseName: string
  proof: Record<string, unknown>
  cleanup: Record<string, unknown>
}

function controlRecord(
  caseName: string,
  proof: RecordFixture['proof'],
  { nativeFixture = true, preAuth = false, revoked = false } = {},
): RecordFixture {
  return {
    caseName,
    proof,
    cleanup: {
      rootExit: preAuth ? 'absent-after-helper-exit' : 'observed',
      helperClosed: true,
      nativeFixtureClosed: nativeFixture,
      witnessClosed: !preAuth,
      socketsClosed: true,
      tempRemoved: true,
      heldHandleFallbacks: 0,
      jobLeaseRevoked: revoked,
    },
  }
}

function controls() {
  const stopped = { pendingWithRootAlive: true, receipt: 'empty', exitCode: 1 }
  const preAuth = {
    completion: 'rejected',
    reason: 'pre-authentication closure',
    exitCode: 125,
    rootStarted: false,
  }
  const replay = {
    injected: 1,
    pendingWithRootAlive: true,
    completion: 'rejected',
    sameOriginalLease: true,
    nativeFailure: 'protocolFailure',
    exitCode: 125,
  }
  return [
    controlRecord('keeps completion authority off child stdout and stderr', {
      ...stopped,
      outputPreserved: true,
    }),
    controlRecord(
      'rejects wrong-secret AUTH on the private pipe',
      { ...preAuth, injected: 1, helperFrames: 1 },
      { nativeFixture: true, preAuth: true },
    ),
    controlRecord('rejects replayed AUTH on the private pipe', { ...replay }, { revoked: true }),
    controlRecord(
      'rejects a replayed STOP sequence on the private pipe',
      { ...replay },
      { revoked: true },
    ),
    controlRecord(
      'rejects a competing client before parent authentication',
      {
        ...preAuth,
        competingClientConnected: true,
        clientPid: 42,
        parentConnections: 0,
        greetingBytes: 0,
        peerCloseError: 109,
      },
      { nativeFixture: true, preAuth: true },
    ),
    controlRecord(
      'refuses a second client after parent authentication',
      {
        ...stopped,
        competingClientConnected: false,
        parentConnections: 1,
        openError: 231,
      },
      { nativeFixture: true },
    ),
    controlRecord(
      'does not inherit the private control pipe or Job handle',
      {
        ...stopped,
        handles: 10,
        inspected: 10,
        namedPipes: 3,
        positivePipeMatches: 1,
        controlPipeMatches: 0,
        jobHandles: 0,
        jobMember: true,
      },
      { nativeFixture: true },
    ),
  ]
}

const registrationTitles = [
  'recovers one parent Job slot after the helper dies before SETUP',
  'recovers both parent Job slots after the helper dies before SETUP',
  'revokes adopted Job slots when REGISTERED is dropped before Root admission',
  'keeps a reused parent slot open after losing the adopted revoke receipt',
] as const

function registrations(): RecordFixture[] {
  const outcome = { state: 'closed-zero', before: 1, after: 0, activeBefore: 0, activeAfter: 0 }
  const missing = {
    state: 'absent',
    before: null,
    after: null,
    activeBefore: null,
    activeAfter: null,
  }
  const one = { matches: 1, active: 0, total: 0, openError: null }
  const zero = { ...one, matches: 0 }
  const notFound = { matches: 0, active: null, total: null, openError: 2 }
  return registrationTitles.map((caseName, i) => ({
    caseName,
    proof: {
      kind: 'registration-fault',
      point: (
        ['after-first-dup', 'after-both-dups', 'drop-registered', 'drop-registered'] as const
      )[i],
      receipt: 'rejected',
      completionError:
        i < 2 ? 'owned control ended without terminal receipt' : 'fixture dropped REGISTERED',
      sameReceipt: true,
      sameFailure: true,
      sameCause: true,
      sameLease: true,
      sameRevoke: true,
      sameRevokeOutcome: true,
      stopAccepted: true,
      helperPinnedBeforeAuth: true,
      helperExitCode: 125,
      rootStarted: false,
      rootMatches: 0,
      before: { main: one, guard: i === 0 ? notFound : one, knownSlotsMatch: i < 2 ? null : true },
      after: { main: zero, guard: i === 0 ? notFound : zero, knownSlotsMatch: null },
      broker: {
        action: i < 2 ? 'recover' : 'revoke',
        sweeps: i < 2 ? 2 : 0,
        operations: 1,
        jobActive: i < 2 ? null : 0,
        guardActive: i < 2 ? null : 0,
        exitCode: 0,
        eof: true,
        terminal: i < 2 ? 'recovered' : i === 2 ? 'drained' : null,
        recovered: i < 2 ? { main: outcome, guard: i === 0 ? missing : outcome } : null,
        revokeOutcome: i === 3 ? 'rejected' : 'resolved',
        revokeError: i === 3 ? 'owned Job broker ended without proof' : null,
      },
      reuse:
        i === 3
          ? { reused: true, distinct: true, open: true, openAfterClose: true, openAfterStop: true }
          : null,
    },
    cleanup: {
      helperClosed: true,
      helperHandleExited: true,
      brokerClosed: true,
      helperFallbacks: 0,
      witnessClosed: true,
      tempRemoved: true,
    },
  }))
}

const registrationStopTitles = [
  'does not create the ordinary Root when STOP is queued before AUTH',
  'does not create the retained Root when STOP is queued before AUTH',
] as const

function registrationStops(): RecordFixture[] {
  const before = { matches: 1, active: 0, total: 0, openError: null }
  const after = { ...before, matches: 0 }
  return registrationStopTitles.map((caseName, index) => ({
    caseName,
    proof: {
      kind: 'registration-stop',
      mode: index ? 'retained' : 'ordinary',
      helperPinnedBeforeAuth: true,
      stopRecordedBeforeAuth: true,
      registrationStop: index ? 'SIGTERM' : 'SIGINT',
      createProcessCalls: 0,
      queryActive: 0,
      rootStarted: false,
      rootPid: null,
      sentinelAbsent: true,
      receipt: 'empty',
      sameReceipt: true,
      helperExitCode: 1,
      retained: index
        ? {
            errorName: 'AbortError',
            errorCode: 'ABORT_ERR',
            reasonPreserved: true,
            sameError: true,
            metadata: { kind: 'settled' },
            before: { main: before, guard: before, knownSlotsMatch: true },
            after: { main: after, guard: after, knownSlotsMatch: null },
            sameResourceCleanup: true,
            callbackAfterBrokerClose: true,
            brokerOperations: 1,
            brokerExitCode: 0,
            brokerEof: true,
            brokerTerminal: 'drained',
          }
        : null,
    },
    cleanup: {
      helperClosed: true,
      helperHandleExited: true,
      controlClosed: true,
      brokerClosed: index ? true : null,
      witnessClosed: true,
      tempRemoved: true,
    },
  }))
}

function producers(): RecordFixture[] {
  const connected = {
    helperClosed: true,
    helperHandleExited: true,
    socketClosed: true,
    socketEof: true,
    wireFinished: true,
    witnessClosed: true,
    rootHandleExited: null,
    grandchildHandleExited: null,
    jobReleased: null,
    parentClosed: null,
  }
  const raw = (caseName: string, proof: RecordFixture['proof'], cleanup = {}): RecordFixture => ({
    caseName,
    proof,
    cleanup: { ...connected, ...cleanup },
  })
  const status = (
    caseName: string,
    proof: RecordFixture['proof'],
    cleanup = {},
  ): RecordFixture => ({
    caseName,
    proof,
    cleanup: {
      helperClosed: true,
      helperHandleExited: true,
      rootHandleExited: true,
      grandchildHandleExited: true,
      witnessClosed: true,
      tempRemoved: true,
      broker: null,
      ...cleanup,
    },
  })
  return [
    raw(createFailureTitle, {
      kind: 'create-process-failure',
      mode: 'ordinary',
      helperExitCode: 125,
      helperRecords: ['hello', 'setup', 'empty'],
      empty: {
        type: 'empty',
        reason: 'launch-failed',
        exitCode: 125,
        rootPid: null,
        rootExitCode: null,
        outputFailed: false,
      },
      nativeErrorCode: 2,
      diagnosticDelivered: true,
    }),
    raw('bounds authentication when the genuine parent connects but sends nothing', {
      kind: 'auth-timeout',
      helperExitCode: 125,
      helloToHelperExitMs: 14987.25,
      helperRecords: ['hello'],
      controlBytesWritten: 0,
      rootOutputSeen: false,
    }),
    raw(
      'exits when the held parent dies before the pipe connects',
      {
        kind: 'parent-before-connect',
        parentHandleReady: true,
        parentExitSignal: 'SIGKILL',
        helperExitCode: 125,
        parentKillToHelperExitMs: 46.5,
        controlConnectAttempts: 0,
      },
      {
        socketClosed: null,
        socketEof: null,
        wireFinished: null,
        helperHandleExited: null,
        witnessClosed: null,
        parentClosed: true,
      },
    ),
    ...[true, false].map((ackFirst) =>
      raw(
        `gives coalesced STOP priority over READY ACK (ACK first: ${ackFirst})`,
        {
          kind: 'stop-ack',
          mode: 'retained',
          helperExitCode: 1,
          helperRecords: ['hello', 'setup', 'ready', 'empty'],
          commandOrder: ackFirst ? ['acknowledge', 'stop'] : ['stop', 'acknowledge'],
          commandSeqs: [2, 3],
          coalescedWrites: 1,
          rootExitedAtReady: true,
          grandchildAliveAtReady: true,
          empty: { reason: 'stopped', exitCode: 1, rootExitCode: 0, outputFailed: false },
        },
        { rootHandleExited: true, grandchildHandleExited: true, jobReleased: true },
      ),
    ),
    ...[
      ['rejects duplicate decoded keys after registration', 'duplicate-decoded-key'],
      ['rejects noncanonical uint tokens after registration', 'noncanonical-uint'],
      ['bounds a partial native control frame from its first byte', 'partial-frame'],
    ].map(([title, malformed]) =>
      raw(
        title!,
        {
          kind: 'schema-rejection',
          malformed,
          mode: 'ordinary',
          helperExitCode: 125,
          helperRecords: ['hello', 'setup', 'error'],
          nativeError: 'protocolFailure',
          rootAliveBeforeWrite: true,
          ...(malformed === 'partial-frame'
            ? { commandWrites: 3, firstByteToErrorMs: 5010.5, lastByteToErrorMs: 1010.5 }
            : { commandWrites: 1 }),
        },
        { rootHandleExited: true },
      ),
    ),
    status(timeoutTitle, {
      kind: 'spawn-timeout',
      receipt: 'empty',
      sameReceipt: true,
      sameLease: true,
      rootAliveBeforeTimeout: true,
      grandchildAliveBeforeTimeout: true,
      helperExitCode: 1,
      rootExitCode: 1,
      grandchildExitCode: 1,
      joinOwnership: 'empty',
    }),
    status('preserves AbortError and authenticates EMPTY for a live native tree', {
      kind: 'abort',
      receipt: 'empty',
      sameReceipt: true,
      helperExitCode: 1,
      errorName: 'AbortError',
      errorCode: 'ABORT_ERR',
      reasonPreserved: true,
      sameError: true,
      rootAliveBeforeAbort: true,
      grandchildAliveBeforeAbort: true,
      joinOwnership: 'empty',
    }),
    ...(
      [
        ['259', 259],
        ['0x80000017', 0x80000017],
      ] as const
    ).map(([title, code]) =>
      status(
        `preserves native ExitProcess DWORD ${title}`,
        {
          kind: 'exit-status',
          receipt: 'empty',
          sameReceipt: true,
          rootAliveBeforeRelease: true,
          rootExitCode: code,
          helperExitCode: code,
          nodeExitCode: code,
        },
        { grandchildHandleExited: null },
      ),
    ),
    status('fails closed when the native job query handle is invalid', {
      kind: 'query-fault',
      receipt: 'rejected',
      sameReceipt: true,
      sameLease: true,
      nativeError: 'nativeQueryFailure',
      helperExitCode: 125,
      rootExitCode: 0,
      grandchildExitCode: 1,
      rootAliveBeforeRelease: true,
      grandchildAliveBeforeRelease: true,
      revokeRejectedWithOriginalFailure: true,
    }),
    ...['before-clear', 'after-clear'].map((point) =>
      status(
        `revokes the original Job when the helper dies ${point}`,
        {
          kind: 'handoff-fault',
          point,
          receipt: 'rejected',
          sameReceipt: true,
          sameLease: true,
          readyReceived: true,
          acknowledged: true,
          helperExitCode: 125,
          rootExitCode: 0,
          grandchildExitedBeforeRevoke: point === 'before-clear',
          revokeIdempotent: true,
          grandchildExitedAfterRevoke: true,
        },
        { broker: 'drained' },
      ),
    ),
    ...registrations(),
    ...registrationStops(),
    status(
      'proves EMPTY without waiting for blocked provider stderr or its retained relay',
      {
        kind: 'blocked-stderr',
        receipt: 'empty',
        sameReceipt: true,
        outputFailed: true,
        stderrWritePending: true,
        stderrRelayBackpressured: true,
        rootAliveBeforeStop: true,
        stopAccepted: true,
        helperExitCode: 1,
        stdoutRelayClosed: true,
        stderrRelayClosed: true,
      },
      { grandchildHandleExited: null, broker: 'released' },
    ),
  ]
}

let temp: string
let run: string
let workspace: string
let candidate: string
let final: string
const json = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data))
const report = (testResults: ReturnType<typeof reports>) =>
  json(join(workspace, 'vitest.json'), { success: true, numFailedTests: 0, testResults })
const logFile = () => join(workspace, 'vitest.log')
const runLog = (controlRecords = controls(), producerRecords = producers()) =>
  writeFileSync(
    logFile(),
    [
      ...controlRecords.map((record) => controlPrefix + JSON.stringify(record)),
      ...producerRecords.map((record) => producerPrefix + JSON.stringify(record)),
    ].join('\n'),
  )
const nativeFile = (id: string) => join(workspace, 'native', `${id}.json`)
const removeWorkspace = () => rmSync(workspace, { recursive: true })

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'holi-checker-unit-'))
  run = join(temp, `windows-agent-${env.GITHUB_SHA}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`)
  workspace = join(run, 'proof-workspace')
  candidate = join(run, 'owned-process-candidate.json')
  final = join(run, 'owned-process-proof.json')
  mkdirSync(join(workspace, 'native'), { recursive: true })
  report(reports())
  runLog()
  for (const [id, caseName, receiptKind, barrier] of lifecycle) {
    const before = id === 'retained-precommit-parent-death'
    const after = id === 'retained-postcommit-parent-death'
    const parent = id === 'parent-death' || before || after || barrier
    const committed = receiptKind === 'handoff' && !before && !barrier
    json(nativeFile(id), {
      caseName,
      platformVersion: release(),
      receiptKind,
      cleanup: { witnessClosed: true, tempRemoved: true },
      actualNativeObservations:
        before || barrier
          ? {
              handoffExitCode: 0,
              uncommittedLeaseObserved: true,
              preParentDeathAlive: true,
              parentLossCleanup: true,
              ...(barrier
                ? {
                    commitRollback: {
                      barrier,
                      guardArmedAtBarrier: false,
                      activeAtBarrier: 1,
                      guardRearmed: true,
                      activeAfterRollback: 0,
                      brokerExitCode: 125,
                      grandchildExitCode: 1,
                    },
                  }
                : {}),
            }
          : after
            ? {
                handoffExitCode: 0,
                commitVerified: true,
                preParentDeathAlive: true,
                postcommitAlive: true,
                postParentDeathAlive: true,
              }
            : parent
              ? { parentLossCleanup: true }
              : committed
                ? { commitVerified: true, postcommitAlive: true }
                : {},
      processes: [
        ...(parent ? ['parent'] : []),
        'helper',
        'root',
        'grandchild',
        ...(barrier ? ['broker'] : []),
      ].map((role, index) => {
        const retained = committed && role === 'grandchild'
        return {
          role,
          pid: 100 + index,
          creationFiletime: '134000000000000000',
          pinnedAlive: true,
          observedExit: !retained,
          cleanup: retained ? 'terminated-held-handle' : 'already-exited',
          cleanupExitObserved: true,
        }
      }),
    })
  }
})
afterEach(() => rmSync(temp, { force: true, recursive: true }))

it('selects every required evidence suite in the Windows CI run', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  )
  const windowsJob = workflow.split('\n  windows-agent-launch:')[1]!.split(/\n  \S/)[0]!
  const selection = windowsJob.match(/exec vitest run (.+) --project node/)![1]!.split(' ')
  for (const file of [...Object.keys(required), ...smokeSuites]) {
    expect(selection).toContain(file)
  }
  expect(required['test/owned-process-windows.test.ts']).toContain(timeoutTitle)
  expect(required).not.toHaveProperty('test/owned-process.test.ts')
})

it('rejects native cases reported under the old non-Windows suite', () => {
  const suites = reports()
  const core = suites.find(({ name }) => name.endsWith('\\owned-process-windows.test.ts'))!
  core.name = core.name.replace('owned-process-windows.test.ts', 'owned-process.test.ts')
  report(suites)
  expect(() => prepare(run, env)).toThrow()
  expect(existsSync(candidate)).toBe(false)
  expect(existsSync(final)).toBe(false)
})

it('stages without a verdict and refuses publication before proof-workspace removal', () => {
  const hash = prepare(run, env)
  expect(JSON.parse(readFileSync(candidate, 'utf8'))).not.toHaveProperty('verdict')
  expect(() => finalize(run, hash, env)).toThrow('Proof workspace was not removed')
  expect(existsSync(final)).toBe(false)
})

it('cannot publish after a real failed delete leaves the proof workspace present', () => {
  const hash = prepare(run, env)
  expect(() => rmdirSync(workspace)).toThrow() // Non-empty directory; no synthetic cleanup flag.
  expect(() => finalize(run, hash, env)).toThrow('Proof workspace was not removed')
  expect(existsSync(final)).toBe(false)
})

it.each(['gitSha', 'runId', 'runAttempt', 'platformVersion'])(
  'rejects a candidate bound to the wrong %s',
  (key) => {
    prepare(run, env)
    const stage = JSON.parse(readFileSync(candidate, 'utf8'))
    stage.binding[key] = 'different'
    json(candidate, stage)
    const matchingHash = createHash('sha256').update(readFileSync(candidate)).digest('hex')
    removeWorkspace()
    expect(() => finalize(run, matchingHash, env)).toThrow(
      'Candidate belongs to another run or platform',
    )
    expect(existsSync(final)).toBe(false)
  },
)

it('rejects a missing or changed candidate after cleanup', () => {
  const hash = prepare(run, env)
  removeWorkspace()
  writeFileSync(candidate, 'changed')
  expect(() => finalize(run, hash, env)).toThrow('Prepared candidate changed')
  rmSync(candidate)
  expect(() => finalize(run, hash, env)).toThrow('ENOENT')
  expect(existsSync(final)).toBe(false)
})

it.each(['missing', 'duplicate', 'skipped', 'failed'] as const)(
  'rejects a %s required native title',
  (failure) => {
    const suites = reports()
    const witness = suites.find(({ name }) =>
      name.endsWith('windows-owned-process-witness.test.ts'),
    )!
    const title = 'drains verified handles on abnormal witness stdin EOF'
    const index = witness.assertionResults.findIndex((test) => test.title === title)
    const test = witness.assertionResults[index]!
    if (failure === 'missing') witness.assertionResults.splice(index, 1)
    if (failure === 'duplicate') witness.assertionResults.push({ ...test })
    if (failure === 'skipped' || failure === 'failed') test.status = failure
    report(suites)
    expect(() => prepare(run, env)).toThrow()
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(final)).toBe(false)
  },
)

it.each(['missing', 'duplicate', 'skipped'] as const)(
  'rejects a %s spawn timeout title even with valid native proof',
  (failure) => {
    const suites = reports()
    const core = suites.find(({ name }) => name.endsWith('\\owned-process-windows.test.ts'))!
    const index = core.assertionResults.findIndex((test) => test.title === timeoutTitle)
    const test = core.assertionResults[index]!
    if (failure === 'missing') core.assertionResults.splice(index, 1)
    if (failure === 'duplicate') core.assertionResults.push({ ...test })
    if (failure === 'skipped') test.status = 'skipped'
    report(suites)
    expect(() => prepare(run, env)).toThrow(timeoutTitle)
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(final)).toBe(false)
  },
)

it.each([
  'missing',
  'extra',
  'rejected',
  'wrong-release',
  'no-native-exit',
  'no-native-cleanup',
] as const)('rejects %s lifecycle proof', (failure) => {
  const file = nativeFile('resistant-ignore-exit')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (failure === 'rejected') data.receiptKind = 'rejected'
  if (failure === 'wrong-release') data.platformVersion = 'wrong'
  if (failure === 'no-native-exit') data.processes[0].observedExit = false
  if (failure === 'no-native-cleanup') data.cleanup.witnessClosed = false
  if (failure === 'extra') json(nativeFile('unlisted'), data)
  if (failure === 'missing') rmSync(file)
  else json(file, data)
  expect(() => prepare(run, env)).toThrow()
  expect(existsSync(candidate)).toBe(false)
})

it.each([
  'missing-lease',
  'unexpected-commit',
  'wrong-helper-exit',
  'missing-parent',
  'cleanup-killed-descendant',
  'lost-committed-descendant',
] as const)('rejects invalid retained parent-death evidence: %s', (failure) => {
  const file = nativeFile(
    failure === 'lost-committed-descendant'
      ? 'retained-postcommit-parent-death'
      : 'retained-precommit-parent-death',
  )
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const descendant = data.processes.find(({ role }: { role: string }) => role === 'grandchild')
  if (failure === 'missing-lease') delete data.actualNativeObservations.uncommittedLeaseObserved
  if (failure === 'unexpected-commit') data.actualNativeObservations.commitVerified = true
  if (failure === 'wrong-helper-exit') data.actualNativeObservations.handoffExitCode = 125
  if (failure === 'missing-parent') data.processes.shift()
  if (failure === 'cleanup-killed-descendant') descendant.cleanup = 'terminated-held-handle'
  if (failure === 'lost-committed-descendant') descendant.observedExit = true
  json(file, data)
  expect(() => prepare(run, env)).toThrow(data.caseName)
  expect(existsSync(candidate)).toBe(false)
  expect(existsSync(final)).toBe(false)
})

it.each(['wrong-barrier', 'no-zero', 'missing-broker', 'fallback'] as const)(
  'rejects an invalid during-commit parent-death proof: %s',
  (failure) => {
    const file = nativeFile('retained-commit-parent-death-before-send')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const rollback = data.actualNativeObservations.commitRollback
    if (failure === 'wrong-barrier') rollback.barrier = 'after-send'
    if (failure === 'no-zero') rollback.activeAfterRollback = 1
    if (failure === 'missing-broker') data.processes.pop()
    if (failure === 'fallback') data.processes[0].cleanup = 'terminated-held-handle'
    json(file, data)
    expect(() => prepare(run, env)).toThrow(data.caseName)
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(final)).toBe(false)
  },
)

it.each(['openError', 'peerCloseError', 'exitCode', 'inspected', 'positivePipeMatches'])(
  'rejects invalid native proof code or count: %s',
  (field) => {
    const records = controls()
    const record = records.find(({ proof }) => field in proof)!
    record.proof[field] = 0
    if (field === 'exitCode') record.proof[field] = 126
    runLog(records)
    expect(() => prepare(run, env)).toThrow(record.caseName)
    expect(existsSync(candidate)).toBe(false)
  },
)

it('rejects duplicate, extra, and missing native control records', () => {
  const records = controls()
  const others = records.slice(1)
  for (const altered of [
    others,
    [...records, records[0]!],
    [...others, others[0]!],
    [...others, { ...records[0]!, caseName: 'unlisted' }],
  ]) {
    runLog(altered)
    expect(() => prepare(run, env)).toThrow()
    expect(existsSync(candidate)).toBe(false)
  }
})

it.each([
  ['windows-owned-process-status.test.ts', 'preserves native ExitProcess DWORD 259'],
  ...registrationStopTitles.map(
    (title) => ['windows-owned-process-status.test.ts', title] as const,
  ),
  ['owned-process-windows.test.ts', 'bounds a partial native control frame from its first byte'],
  ['owned-process-windows.test.ts', 'fails closed on post-auth EOF'],
  [
    'owned-program-host.test.ts',
    'keeps approved Claude launches and same-id HTTP rows bound to their own vaults',
  ],
] as const)('rejects a skip in %s even with all proof records present', (file, title) => {
  const suites = reports()
  const suite = suites.find(({ name }) => name.endsWith(`\\${file}`))!
  suite.assertionResults.find((test) => test.title === title)!.status = 'skipped'
  report(suites)
  expect(() => prepare(run, env)).toThrow(`did not pass: ${title}`)
  expect(existsSync(candidate)).toBe(false)
  expect(existsSync(final)).toBe(false)
})

it.each(['commitVerified', 'postcommitAlive'])('requires retained success to prove %s', (key) => {
  const file = nativeFile('retained-success')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  data.actualNativeObservations[key] = false
  json(file, data)
  expect(() => prepare(run, env)).toThrow(`actualNativeObservations.${key}`)
  expect(existsSync(candidate)).toBe(false)
})

it('rejects a claim of authenticated parent death instead of the held-process exits', () => {
  const file = nativeFile('parent-death')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  delete data.actualNativeObservations
  data.parentDeathDetected = true
  json(file, data)
  expect(() => prepare(run, env)).toThrow('wrong fields')
  expect(existsSync(candidate)).toBe(false)
})

it.each(['wrong-secret AUTH', 'competing client before parent authentication'])(
  'rejects an unobservable pre-auth native reason for %s',
  (title) => {
    const records = controls()
    const record = records.find(({ caseName }) => caseName.includes(title))!
    record.proof.reason = 'protocolFailure'
    runLog(records)
    expect(() => prepare(run, env)).toThrow(`${record.caseName}.proof.reason`)
    record.proof.reason = 'pre-authentication closure'
    record.proof.nativeFailure = 'protocolFailure'
    runLog(records)
    expect(() => prepare(run, env)).toThrow(`${record.caseName}.proof: wrong fields`)
    expect(existsSync(candidate)).toBe(false)
  },
)

it('rejects duplicate, extra, and missing native producer records even when titles pass', () => {
  const records = producers()
  const timeout = records.find(({ caseName }) => caseName === timeoutTitle)!
  const others = records.filter((record) => record !== timeout)
  const foreign = { ...timeout, caseName: 'unlisted' }
  for (const altered of [
    others,
    [...records, timeout],
    [...others.slice(1), timeout, timeout],
    [...others, foreign],
    [...records, foreign],
  ]) {
    runLog(controls(), altered)
    expect(() => prepare(run, env)).toThrow(
      /HOLI_WINDOWS_OWNED_PRODUCER_PROOF|Duplicate native proof/,
    )
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(final)).toBe(false)
  }
})

it.each([
  ['proof', 'nativeErrorCode', '2'],
  ['proof', 'diagnosticDelivered', false],
  ['proof', 'helperExitCode', 2],
  ['proof', 'helperRecords', ['hello', 'setup']],
  ['cleanup', 'socketEof', false],
] as const)('rejects a native create failure with wrong %s.%s', (section, field, value) => {
  const records = producers()
  records.find(({ caseName }) => caseName === createFailureTitle)![section][field] = value
  runLog(controls(), records)
  expect(() => prepare(run, env)).toThrow(`${createFailureTitle}.${section}.${field}`)
  expect(existsSync(candidate)).toBe(false)
})

it('rejects raw stderr in native create-failure evidence', () => {
  const records = producers()
  records.find(({ caseName }) => caseName === createFailureTitle)!.proof.stderr = 'private output'
  runLog(controls(), records)
  expect(() => prepare(run, env)).toThrow(`${createFailureTitle}.proof: wrong fields`)
  expect(existsSync(candidate)).toBe(false)
})

it.each([...registrationTitles, ...registrationStopTitles, createFailureTitle])(
  'requires both the native case title and proof: %s',
  (title) => {
    const records = producers()
    runLog(
      controls(),
      records.filter(({ caseName }) => caseName !== title),
    )
    expect(() => prepare(run, env)).toThrow(
      'Wrong number of HOLI_WINDOWS_OWNED_PRODUCER_PROOF records',
    )
    runLog(controls(), records)
    const suites = reports()
    const file =
      title === createFailureTitle
        ? '\\owned-process-windows.test.ts'
        : '\\windows-owned-process-status.test.ts'
    const suite = suites.find(({ name }) => name.endsWith(file))!
    const test = suite.assertionResults.find((test) => test.title === title)!
    test.title = 'an unlisted passing status title'
    report(suites)
    expect(() => prepare(run, env)).toThrow(title)
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(final)).toBe(false)
  },
)

it.each([
  [0, 'proof.before.main.matches', '1'],
  [0, 'proof.before.guard.active', 0],
  [0, 'proof.before.guard.openError', 5],
  [0, 'proof.broker.recovered.guard.after', 0],
  [1, 'proof.before.guard.matches', 0],
  [1, 'proof.after.main.matches', 1],
  [1, 'proof.after.guard.total', 1],
  [1, 'proof.broker.recovered.main.activeAfter', 1],
  [1, 'proof.rootMatches', 1],
  [1, 'proof.helperPinnedBeforeAuth', false],
  [2, 'proof.before.knownSlotsMatch', null],
  [2, 'proof.broker.sweeps', 2],
  [2, 'proof.broker.terminal', 'recovered'],
  [2, 'proof.broker.guardActive', null],
  [3, 'proof.broker.terminal', 'drained'],
  [3, 'proof.broker.exitCode', 125],
  [3, 'proof.broker.eof', false],
  [3, 'proof.broker.revokeOutcome', 'resolved'],
  [3, 'proof.broker.revokeError', null],
  [3, 'proof.sameLease', false],
  [3, 'proof.sameCause', false],
  [3, 'proof.sameRevoke', false],
  [3, 'proof.sameRevokeOutcome', false],
  [3, 'proof.reuse.distinct', false],
  [3, 'proof.reuse.openAfterClose', false],
  [3, 'proof.reuse.openAfterStop', false],
  [3, 'proof.broker.operations', 2],
  [3, 'cleanup.helperFallbacks', 1],
  [3, 'cleanup.brokerClosed', false],
  [3, 'cleanup.witnessClosed', false],
  [3, 'cleanup.tempRemoved', false],
  [4, 'proof.stopRecordedBeforeAuth', false],
  [4, 'proof.registrationStop', null],
  [4, 'proof.createProcessCalls', 1],
  [4, 'proof.queryActive', '0'],
  [4, 'proof.rootStarted', true],
  [4, 'proof.rootPid', 41],
  [4, 'proof.sentinelAbsent', false],
  [4, 'proof.receipt', 'not-started'],
  [4, 'proof.helperExitCode', 0],
  [4, 'cleanup.controlClosed', false],
  [5, 'proof.retained.sameError', false],
  [5, 'proof.retained.reasonPreserved', false],
  [5, 'proof.retained.metadata.kind', 'unconfirmed'],
  [5, 'proof.retained.after.guard.matches', 1],
  [5, 'proof.retained.sameResourceCleanup', false],
  [5, 'proof.retained.callbackAfterBrokerClose', false],
  [5, 'proof.retained.brokerTerminal', 'recovered'],
  [5, 'cleanup.brokerClosed', false],
  [5, 'cleanup.witnessClosed', false],
  [5, 'cleanup.tempRemoved', false],
] as const)('rejects registration case %s with wrong %s', (index, path, value) => {
  const title = [...registrationTitles, ...registrationStopTitles][index]
  const records = JSON.parse(JSON.stringify(producers())) as RecordFixture[]
  const record = records.find(({ caseName }) => caseName === title)!
  const keys = path.split('.')
  const field = keys.pop()!
  const parent = keys.reduce<Record<string, unknown>>(
    (object, key) => object[key] as Record<string, unknown>,
    record,
  )
  parent[field] = value
  runLog(controls(), records)
  expect(() => prepare(run, env)).toThrow(`${title}.${path}`)
  expect(existsSync(candidate)).toBe(false)
  expect(existsSync(final)).toBe(false)
})

it.each([
  [0, 'proof', 'queryActive', undefined],
  [0, 'cleanup', 'rootHandleExited', true],
  [1, 'proof', 'retained', undefined],
  [1, 'cleanup', 'brokerClosed', undefined],
] as const)(
  'rejects a stopped registration schema change in %s %s.%s',
  (index, section, field, value) => {
    const records = producers()
    const title = registrationStopTitles[index]
    records.find(({ caseName }) => caseName === title)![section][field] = value
    runLog(controls(), records)
    expect(() => prepare(run, env)).toThrow(`${title}.${section}: wrong fields`)
    expect(existsSync(candidate)).toBe(false)
    expect(existsSync(final)).toBe(false)
  },
)

it.each([
  ['proof', 'reuse', undefined],
  ['proof', 'jobName', 'synthetic-private-data'],
  ['cleanup', 'helperHandleExited', undefined],
] as const)('rejects a registration schema change in %s.%s', (section, field, value) => {
  const records = producers()
  const title = registrationTitles[3]
  const record = records.find(({ caseName }) => caseName === title)!
  record[section][field] = value
  runLog(controls(), records)
  expect(() => prepare(run, env)).toThrow(`${title}.${section}: wrong fields`)
  expect(existsSync(candidate)).toBe(false)
  expect(existsSync(final)).toBe(false)
})

it.each([
  ['auth-timeout', 'proof', 'helloToHelperExitMs', 11999],
  ['auth-timeout', 'proof', 'controlBytesWritten', '0'],
  ['parent-before-connect', 'proof', 'controlConnectAttempts', 1],
  ['parent-before-connect', 'proof', 'parentKillToHelperExitMs', 3000],
  ['parent-before-connect', 'cleanup', 'witnessClosed', true],
  ['schema-rejection', 'proof', 'helperRecords', ['hello', 'setup', 'empty']],
  ['partial-frame', 'proof', 'firstByteToErrorMs', 6501],
  ['partial-frame', 'proof', 'lastByteToErrorMs', 0],
  ['stop-ack', 'proof', 'commandSeqs', [3, 2]],
  ['stop-ack', 'cleanup', 'jobReleased', false],
  ['abort', 'proof', 'sameError', false],
  ['spawn-timeout', 'proof', 'kind', 'auth-timeout'],
  ['spawn-timeout', 'proof', 'receipt', 'handoff'],
  ['spawn-timeout', 'proof', 'joinOwnership', 'rejected'],
  ['spawn-timeout', 'proof', 'sameReceipt', 'true'],
  ['spawn-timeout', 'proof', 'sameLease', false],
  ['spawn-timeout', 'proof', 'rootAliveBeforeTimeout', false],
  ['spawn-timeout', 'proof', 'grandchildAliveBeforeTimeout', false],
  ['spawn-timeout', 'proof', 'helperExitCode', '1'],
  ['spawn-timeout', 'proof', 'rootExitCode', 0],
  ['spawn-timeout', 'proof', 'grandchildExitCode', 1.5],
  ['spawn-timeout', 'cleanup', 'helperClosed', false],
  ['spawn-timeout', 'cleanup', 'helperHandleExited', false],
  ['spawn-timeout', 'cleanup', 'rootHandleExited', false],
  ['spawn-timeout', 'cleanup', 'grandchildHandleExited', false],
  ['spawn-timeout', 'cleanup', 'broker', 'released'],
  ['spawn-timeout', 'cleanup', 'witnessClosed', false],
  ['spawn-timeout', 'cleanup', 'tempRemoved', false],
  ['query-fault', 'proof', 'nativeError', 'protocolFailure'],
  ['query-fault', 'cleanup', 'rootHandleExited', false],
  ['259', 'proof', 'rootExitCode', 0],
  ['0x80000017', 'proof', 'helperExitCode', 23],
  ['0x80000017', 'proof', 'nodeExitCode', 23],
  ['after-clear', 'proof', 'grandchildExitedBeforeRevoke', true],
  ['before-clear', 'cleanup', 'broker', 'released'],
  ['blocked-stderr', 'proof', 'outputFailed', false],
  ['blocked-stderr', 'cleanup', 'tempRemoved', false],
] as const)('rejects invalid %s %s.%s', (selector, section, field, value) => {
  const records = producers()
  const record = records.find(({ proof, caseName }) =>
    [proof.kind, proof.malformed, proof.point, caseName.split(' ').at(-1)].includes(selector),
  )!
  record[section][field] = value
  runLog(controls(), records)
  expect(() => prepare(run, env)).toThrow(`${record.caseName}.${section}.${field}`)
  expect(existsSync(candidate)).toBe(false)
})

it.each([
  ['proof', 'joinOwnership', undefined],
  ['proof', 'timeoutMs', 25_000],
  ['cleanup', 'broker', undefined],
  ['cleanup', 'socketClosed', true],
] as const)('rejects a spawn timeout schema change in %s.%s', (section, field, value) => {
  const records = producers()
  const timeout = records.find(({ caseName }) => caseName === timeoutTitle)!
  timeout[section][field] = value
  runLog(controls(), records)
  expect(() => prepare(run, env)).toThrow(`${timeoutTitle}.${section}: wrong fields`)
  expect(existsSync(candidate)).toBe(false)
  expect(existsSync(final)).toBe(false)
})

it('rejects extra record, nested proof, and cleanup fields without echoing untrusted values', () => {
  const privateValue = 'synthetic-private-data'
  const records = producers()
  const [record, ...others] = records
  const stop = records.find(({ proof }) => proof.kind === 'stop-ack')!
  for (const altered of [
    [{ ...record!, spec: privateValue }, ...others],
    [{ ...record!, cleanup: { ...record!.cleanup, env: privateValue } }, ...others],
    records.map((item) =>
      item === stop
        ? {
            ...stop,
            proof: { ...stop.proof, empty: { ...(stop.proof.empty as object), mac: privateValue } },
          }
        : item,
    ),
  ]) {
    runLog(controls(), altered)
    expect(() => prepare(run, env)).toThrow(/^(?!.*synthetic-private-data).*wrong fields/)
    expect(existsSync(candidate)).toBe(false)
  }
  runLog()
  const goodLog = readFileSync(logFile(), 'utf8')
  writeFileSync(
    logFile(),
    goodLog.replace(/HOLI_WINDOWS_OWNED_PRODUCER_PROOF .*/, producerPrefix + privateValue),
  )
  expect(() => prepare(run, env)).toThrow(/^Malformed JSON: HOLI_WINDOWS_OWNED_PRODUCER_PROOF$/)
  expect(existsSync(candidate)).toBe(false)
})

it('publishes only the finalized evidence by atomic rename and does not overwrite', () => {
  const hash = prepare(run, env)
  removeWorkspace()
  const pending = `${final}.tmp`
  writeFileSync(pending, 'blocked publication')
  expect(() => finalize(run, hash, env)).toThrow('EEXIST')
  expect(existsSync(final)).toBe(false)
  rmSync(pending)
  finalize(run, hash, env)
  expect(existsSync(pending)).toBe(false)
  const published = readFileSync(final, 'utf8')
  const proof = JSON.parse(published)
  expect(proof).toMatchObject({
    schema: 'holi.windows-owned-process.v4',
    verdict: 'pass',
    nativeExecution: false,
    candidateSha256: hash,
    gitSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    platformVersion: release(),
    cleanup: { proofWorkspaceRemoved: true },
    skippedRequiredCases: 0,
  })
  expect(proof.requiredCases).toEqual(
    Object.entries(required).flatMap(([file, titles]) =>
      titles.map((title) => ({ file, title, status: 'passed' })),
    ),
  )
  expect(proof.nativeCases).toHaveLength(13)
  expect(proof.controlCases).toHaveLength(7)
  expect(proof.producerCases).toHaveLength(22)
  expect(proof.producerCases.length + proof.nativeCases.length + proof.controlCases.length).toBe(42)
  expect(proof.producerCases).toEqual(expect.arrayContaining(producers()))
  expect(() => finalize(run, hash, env)).toThrow('Final evidence already exists')
  expect(readFileSync(final, 'utf8')).toBe(published)
})
