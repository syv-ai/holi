// Native fixtures write to proof-workspace/native. Extend the manifest alongside the
// producer when adding a native case; exact sets intentionally reject unlisted records.
const lifecycle = [
  [
    'retained-success',
    'hands off an execProgram success with output and a live pinned descendant',
    'handoff',
  ],
  ['retained-nonzero', 'drains a retained execProgram nonzero exit without handing off', 'empty'],
  [
    'retained-cancelled',
    'drains a cancelled retained execProgram launch without handing off',
    'empty',
  ],
  [
    'resistant-ignore-exit',
    'drains a resistant grandchild with ignore stdio when the root exits',
    'empty',
  ],
  [
    'resistant-inherit-exit',
    'drains a resistant grandchild with inherit stdio when the root exits',
    'empty',
  ],
  [
    'resistant-ignore-cancel',
    'drains a resistant grandchild with ignore stdio when the root is cancelled',
    'empty',
  ],
  [
    'resistant-inherit-cancel',
    'drains a resistant grandchild with inherit stdio when the root is cancelled',
    'empty',
  ],
  [
    'helper-death',
    'rejects ownership completion after abnormal helper death and observes job kill-on-close',
    'rejected',
  ],
  [
    'parent-death',
    'drains the pinned tree and helper after the disposable Node parent dies',
    'unobservable-parent-death',
  ],
  [
    'retained-precommit-parent-death',
    'kills the pinned descendant when the Node parent dies after HANDOFF but before commit',
    'handoff',
  ],
  ...['before-send', 'after-send'].map((point) => [
    `retained-commit-parent-death-${point}`,
    `rolls back the native commit when the Node parent dies at the ${point} barrier`,
    'handoff',
    point,
  ]),
  [
    'retained-postcommit-parent-death',
    'preserves the pinned descendant when the Node parent dies after native commit',
    'handoff',
  ],
]

const dwordPid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
const inRange = (min, max) => (value) => Number.isFinite(value) && value >= min && value <= max
const positiveCount = (value) => Number.isSafeInteger(value) && value > 0

function lifecycleExpectation([id, caseName, receiptKind, barrier], platformVersion) {
  const parentLoss = id === 'parent-death'
  const precommit = id === 'retained-precommit-parent-death'
  const postcommit = id === 'retained-postcommit-parent-death'
  const committed = receiptKind === 'handoff' && !precommit && !barrier
  const roles = [
    ...(parentLoss || precommit || postcommit || barrier ? ['parent'] : []),
    'helper',
    'root',
    'grandchild',
    ...(barrier ? ['broker'] : []),
  ]
  return {
    roles,
    recordShape: {
      caseName,
      platformVersion,
      receiptKind,
      actualNativeObservations: {
        ...(committed ? { commitVerified: true, postcommitAlive: true } : {}),
        ...(parentLoss || precommit || barrier ? { parentLossCleanup: true } : {}),
        ...(precommit || postcommit || barrier
          ? { handoffExitCode: 0, preParentDeathAlive: true }
          : {}),
        ...(precommit || barrier ? { uncommittedLeaseObserved: true } : {}),
        ...(postcommit ? { postParentDeathAlive: true } : {}),
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
      },
      cleanup: { witnessClosed: true, tempRemoved: true },
      processes: (value) => Array.isArray(value) && value.length === roles.length,
    },
    processShape(role) {
      const retained = committed && role === 'grandchild'
      return {
        role,
        pid: dwordPid,
        creationFiletime: (value) => typeof value === 'string' && /^[1-9]\d{16,18}$/.test(value),
        pinnedAlive: true,
        observedExit: !retained,
        cleanup: retained ? 'terminated-held-handle' : 'already-exited',
        cleanupExitObserved: true,
      }
    },
  }
}

const emptyStop = { pendingWithRootAlive: true, receipt: 'empty', exitCode: 1 }
const preAuthClosure = {
  completion: 'rejected',
  reason: 'pre-authentication closure',
  exitCode: 125,
  rootStarted: false,
}
const replayFailure = {
  injected: 1,
  pendingWithRootAlive: true,
  completion: 'rejected',
  sameOriginalLease: true,
  nativeFailure: 'protocolFailure',
  exitCode: 125,
}

function controlCase(proof, nativeFixtureClosed = true) {
  const preAuth = proof.rootStarted === false
  return {
    proof,
    cleanup: {
      rootExit: preAuth ? 'absent-after-helper-exit' : 'observed',
      helperClosed: true,
      nativeFixtureClosed,
      witnessClosed: !preAuth,
      socketsClosed: true,
      tempRemoved: true,
      heldHandleFallbacks: 0,
      jobLeaseRevoked: proof.nativeFailure === 'protocolFailure',
    },
  }
}

const control = {
  'keeps completion authority off child stdout and stderr': controlCase({
    ...emptyStop,
    outputPreserved: true,
  }),
  'rejects wrong-secret AUTH on the private pipe': controlCase(
    {
      ...preAuthClosure,
      injected: 1,
      helperFrames: 1,
    },
    true,
  ),
  'rejects replayed AUTH on the private pipe': controlCase(replayFailure),
  'rejects a replayed STOP sequence on the private pipe': controlCase(replayFailure),
  'rejects a competing client before parent authentication': controlCase(
    {
      ...preAuthClosure,
      competingClientConnected: true,
      clientPid: dwordPid,
      parentConnections: 0,
      greetingBytes: 0,
      peerCloseError: (error) => [109, 232, 233].includes(error),
    },
    true,
  ),
  'refuses a second client after parent authentication': controlCase(
    {
      ...emptyStop,
      competingClientConnected: false,
      parentConnections: 1,
      openError: 231,
    },
    true,
  ),
  'does not inherit the private control pipe or Job handle': controlCase(
    {
      ...emptyStop,
      handles: positiveCount,
      inspected: positiveCount,
      namedPipes: positiveCount,
      positivePipeMatches: positiveCount,
      controlPipeMatches: 0,
      jobHandles: 0,
      jobMember: true,
    },
    true,
  ),
}

function rawCase(proof) {
  const connected = proof.kind !== 'parent-before-connect'
  const stoppedAtReady = proof.kind === 'stop-ack'
  const heldRoot = stoppedAtReady || proof.kind === 'schema-rejection'
  return {
    proof,
    cleanup: {
      helperClosed: true,
      socketClosed: connected ? true : null,
      socketEof: connected ? true : null,
      wireFinished: connected ? true : null,
      helperHandleExited: connected ? true : null,
      rootHandleExited: heldRoot ? true : null,
      grandchildHandleExited: stoppedAtReady ? true : null,
      jobReleased: stoppedAtReady ? true : null,
      witnessClosed: connected ? true : null,
      parentClosed: connected ? null : true,
    },
  }
}

function stopAck(ackFirst) {
  return rawCase({
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
  })
}

function schemaRejection(malformed) {
  const partial = malformed === 'partial-frame'
  return rawCase({
    kind: 'schema-rejection',
    malformed,
    mode: 'ordinary',
    helperExitCode: 125,
    helperRecords: ['hello', 'setup', 'error'],
    nativeError: 'protocolFailure',
    rootAliveBeforeWrite: true,
    commandWrites: partial ? 3 : 1,
    ...(partial
      ? {
          firstByteToErrorMs: inRange(4900, 6500),
          lastByteToErrorMs: (value) => Number.isFinite(value) && value > 0 && value < 3000,
        }
      : {}),
  })
}

const raw = {
  'exits when the held parent dies before the pipe connects': rawCase({
    kind: 'parent-before-connect',
    parentHandleReady: true,
    parentExitSignal: 'SIGKILL',
    helperExitCode: 125,
    parentKillToHelperExitMs: (value) => Number.isFinite(value) && value >= 0 && value < 3000,
    controlConnectAttempts: 0,
  }),
  'bounds authentication when the genuine parent connects but sends nothing': rawCase({
    kind: 'auth-timeout',
    helperExitCode: 125,
    helloToHelperExitMs: inRange(12000, 16000),
    helperRecords: ['hello'],
    controlBytesWritten: 0,
    rootOutputSeen: false,
  }),
  'reports a missing executable separately from authenticated EMPTY': rawCase({
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
  'rejects duplicate decoded keys after registration': schemaRejection('duplicate-decoded-key'),
  'rejects noncanonical uint tokens after registration': schemaRejection('noncanonical-uint'),
  'bounds a partial native control frame from its first byte': schemaRejection('partial-frame'),
  'gives coalesced STOP priority over READY ACK (ACK first: true)': stopAck(true),
  'gives coalesced STOP priority over READY ACK (ACK first: false)': stopAck(false),
}

function statusCase(proof, grandchildHandleExited, broker = null) {
  return {
    proof,
    cleanup: {
      helperClosed: true,
      helperHandleExited: true,
      rootHandleExited: true,
      grandchildHandleExited,
      broker,
      witnessClosed: true,
      tempRemoved: true,
    },
  }
}

const originalEmpty = { receipt: 'empty', sameReceipt: true }
const rejectedLease = {
  receipt: 'rejected',
  sameReceipt: true,
  sameLease: true,
  helperExitCode: 125,
}

function exitStatus(code) {
  return statusCase(
    {
      kind: 'exit-status',
      ...originalEmpty,
      rootAliveBeforeRelease: true,
      rootExitCode: code,
      helperExitCode: code,
      nodeExitCode: code,
    },
    null,
  )
}

function handoffFault(point) {
  return statusCase(
    {
      kind: 'handoff-fault',
      point,
      ...rejectedLease,
      readyReceived: true,
      acknowledged: true,
      rootExitCode: 0,
      grandchildExitedBeforeRevoke: point === 'before-clear',
      revokeIdempotent: true,
      grandchildExitedAfterRevoke: true,
    },
    true,
    'drained',
  )
}

function registrationCase(point, lostReceipt = false) {
  const adopted = point === 'drop-registered'
  const absent = point === 'after-first-dup'
  const query = (matches) => ({ matches, active: 0, total: 0, openError: null })
  const missing = { matches: 0, active: null, total: null, openError: 2 }
  const closedZero = { state: 'closed-zero', before: 1, after: 0, activeBefore: 0, activeAfter: 0 }
  return {
    proof: {
      kind: 'registration-fault',
      point,
      receipt: 'rejected',
      completionError: adopted
        ? 'fixture dropped REGISTERED'
        : 'owned control ended without terminal receipt',
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
      before: {
        main: query(1),
        guard: absent ? missing : query(1),
        knownSlotsMatch: adopted ? true : null,
      },
      after: { main: query(0), guard: absent ? missing : query(0), knownSlotsMatch: null },
      broker: {
        action: adopted ? 'revoke' : 'recover',
        sweeps: adopted ? 0 : 2,
        jobActive: adopted ? 0 : null,
        guardActive: adopted ? 0 : null,
        operations: 1,
        exitCode: 0,
        eof: true,
        terminal: lostReceipt ? null : adopted ? 'drained' : 'recovered',
        recovered: adopted
          ? null
          : {
              main: closedZero,
              guard: absent
                ? {
                    state: 'absent',
                    before: null,
                    after: null,
                    activeBefore: null,
                    activeAfter: null,
                  }
                : closedZero,
            },
        revokeOutcome: lostReceipt ? 'rejected' : 'resolved',
        revokeError: lostReceipt ? 'owned Job broker ended without proof' : null,
      },
      reuse: lostReceipt
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
  }
}

function registrationStopCase(mode) {
  const retained = mode === 'retained'
  const zeroJob = (matches) => ({ matches, active: 0, total: 0, openError: null })
  return {
    proof: {
      kind: 'registration-stop',
      mode,
      helperPinnedBeforeAuth: true,
      stopRecordedBeforeAuth: true,
      registrationStop: retained ? 'SIGTERM' : 'SIGINT',
      createProcessCalls: 0,
      queryActive: 0,
      rootStarted: false,
      rootPid: null,
      sentinelAbsent: true,
      ...originalEmpty,
      helperExitCode: 1,
      retained: retained
        ? {
            errorName: 'AbortError',
            errorCode: 'ABORT_ERR',
            reasonPreserved: true,
            sameError: true,
            metadata: { kind: 'settled' },
            before: { main: zeroJob(1), guard: zeroJob(1), knownSlotsMatch: true },
            after: { main: zeroJob(0), guard: zeroJob(0), knownSlotsMatch: null },
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
      brokerClosed: retained ? true : null,
      witnessClosed: true,
      tempRemoved: true,
    },
  }
}

const nativeStatus = {
  'does not create the ordinary Root when STOP is queued before AUTH':
    registrationStopCase('ordinary'),
  'does not create the retained Root when STOP is queued before AUTH':
    registrationStopCase('retained'),
  'recovers one parent Job slot after the helper dies before SETUP':
    registrationCase('after-first-dup'),
  'recovers both parent Job slots after the helper dies before SETUP':
    registrationCase('after-both-dups'),
  'revokes adopted Job slots when REGISTERED is dropped before Root admission':
    registrationCase('drop-registered'),
  'keeps a reused parent slot open after losing the adopted revoke receipt': registrationCase(
    'drop-registered',
    true,
  ),
  'preserves AbortError and authenticates EMPTY for a live native tree': statusCase(
    {
      kind: 'abort',
      ...originalEmpty,
      errorName: 'AbortError',
      errorCode: 'ABORT_ERR',
      reasonPreserved: true,
      sameError: true,
      helperExitCode: 1,
      rootAliveBeforeAbort: true,
      grandchildAliveBeforeAbort: true,
      joinOwnership: 'empty',
    },
    true,
  ),
  'preserves native ExitProcess DWORD 259': exitStatus(259),
  'preserves native ExitProcess DWORD 0x80000017': exitStatus(0x80000017),
}

// These status fixtures live alongside the raw producer in the core test file.
const coreStatus = {
  'authenticates EMPTY when a spawn timeout stops a live native tree': statusCase(
    {
      kind: 'spawn-timeout',
      ...originalEmpty,
      sameLease: true,
      rootAliveBeforeTimeout: true,
      grandchildAliveBeforeTimeout: true,
      helperExitCode: 1,
      rootExitCode: 1,
      grandchildExitCode: 1,
      joinOwnership: 'empty',
    },
    true,
  ),
  'fails closed when the native job query handle is invalid': statusCase(
    {
      kind: 'query-fault',
      ...rejectedLease,
      nativeError: 'nativeQueryFailure',
      rootExitCode: 0,
      grandchildExitCode: 1,
      rootAliveBeforeRelease: true,
      grandchildAliveBeforeRelease: true,
      revokeRejectedWithOriginalFailure: true,
    },
    true,
  ),
  'revokes the original Job when the helper dies before-clear': handoffFault('before-clear'),
  'revokes the original Job when the helper dies after-clear': handoffFault('after-clear'),
  // This fixture starts an inline root only; there is no grandchild to witness.
  'proves EMPTY without waiting for blocked provider stderr or its retained relay': statusCase(
    {
      kind: 'blocked-stderr',
      ...originalEmpty,
      outputFailed: true,
      stderrWritePending: true,
      stderrRelayBackpressured: true,
      rootAliveBeforeStop: true,
      stopAccepted: true,
      helperExitCode: 1,
      stdoutRelayClosed: true,
      stderrRelayClosed: true,
    },
    null,
    'released',
  ),
}

const producer = { ...raw, ...nativeStatus, ...coreStatus }

const required = {
  'test/owned-windows-pty.test.ts': [
    'exposes the actual PTY PID, replays early Unicode output and sends input and resize frames',
    'waits for native emptiness after root exit and stops only the original child idempotently',
    'preserves native rejection and treats protocol failure as cleanup, not an empty receipt',
    'cancels before readiness through the original native owner without inventing a PTY',
    'keeps simultaneous launches independent',
  ],
  'src/plugins/agent/test/windows-owned-runtime.test.ts': [
    'queues input and latest resize until actual readiness, and waits for native completion after root exit',
    'cancels before readiness, discards queued input and joins late native readiness and completion',
    'retains native cleanup rejection as the cause for repeated kill and refuses replacement',
    'keeps runtimes with matching process identifiers independent',
  ],
  'src/plugins/agent/test/windows-owned-fenced.test.ts': [
    'joins Windows native drainage, real fenced copy and provider release without retiring another vault',
    'keeps the original failed Windows session and scratch across Stop, leave and activation replacement while another vault closes',
  ],
  'test/launch.test.ts': [
    'receives every argument exactly as given',
    'resolves filename-only Windows commands, including node.exe',
    'resolves relative executables from the requested cwd',
    'resolves node.exe from PATH on Windows',
    'really stops a program and what it started',
    'stops a .cmd and the program behind it at the timeout',
    'reports cold-start timeout using the actual root state',
    'times out a running root and grandchild within the original execution budget',
    'completes after natural root exit and drains its output-holding descendant',
    'keeps a successful explicitly detached Claude background child alive',
    'times out and drains a root-exited descendant holding root stdout',
    'drains failed detached background launches before callback',
    'drains timed-out detached background launches before callback',
    'stops descendants after maxBuffer cleanup',
    'stops descendants after stdin error cleanup',
  ],
  'test/owned-process-windows.test.ts': [
    'creates a console root without a visible console',
    'resolves a relative executable against the requested cwd',
    'terminates descendants before reporting root exit (pipes: false)',
    'terminates descendants before reporting root exit (pipes: true)',
    'stops the entire owned job and leaves no stop artifact (stdin failure: false)',
    'stops the entire owned job and leaves no stop artifact (stdin failure: true)',
    'fails closed when its parent is gone',
    'does not resolve the helper from a poisoned vault cwd',
    'handles a missing helper without leaking stdin errors',
    'authenticates empty completion for a successful root',
    'settles ordinary roots only after empty owned completion',
    'rejects a local pipe client whose PID does not match the held parent',
    ...['EOF', 'early ACK', 'replay', 'fractional sequence', 'invalid UTF-8'].map(
      (failure) => `fails closed on post-auth ${failure}`,
    ),
    'reports the actual root exit code after stopping a still-running job',
    ...Object.keys(raw),
    ...Object.keys(coreStatus),
  ],
  'test/windows-owned-process-witness.test.ts': [
    'holds the original process handle, verifies identity, terminates, and observes exit',
    'drains verified handles on abnormal witness stdin EOF',
    'drains verified handles when the held witness parent dies with stdin open',
    'joins native drain after a request timeout with a live handed-off descendant',
  ],
  'test/windows-owned-process-lifecycle.test.ts': lifecycle.map(([, name]) => name),
  'test/windows-owned-process-control.test.ts': Object.keys(control),
  'test/windows-owned-process-status.test.ts': Object.keys(nativeStatus),
  'src/plugins/agent/test/owned-program-host.test.ts': [
    'launches Pi through the UI door and refuses the same launch through CLI',
    'routes UI agent.job through PluginHost and CapabilityHost, while authenticated HTTP cli sees sessions and refuses job creation',
    'holds completion and finalization to the originating vault despite concurrent same-host work',
    'copies back each held Windows job only to its own vault after authenticated empty receipts',
    'retains a receipt failure before and after physical close',
    'retains a receipt failure through repeated stop and blocked restart while the other vault remains usable',
    'keeps approved Claude launches and same-id HTTP rows bound to their own vaults',
  ],
}

const smokeSuites = [
  'test/tool-lookup.test.ts',
  'test/owned-process-protocol.test.ts',
  'test/owned-process-completion.test.ts',
  'test/owned-process-launch.test.ts',
  'test/owned-process-broker.test.ts',
  'test/owned-program-lifetime.test.ts',
  'src/plugins/agent/test/windows-agents.test.ts',
  'src/plugins/agent/test/agent-runtime.test.ts',
]

module.exports = { required, smokeSuites, lifecycle, lifecycleExpectation, control, producer }
