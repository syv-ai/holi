import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'
import { basename, dirname, join } from 'node:path'
import { storageFaultPhases, storageFixturePaths } from '../app/vault-storage-check.ts'
import {
  interruptionBefore,
  interruptionAfter,
  interruptionArtifacts,
  stagingDirectory,
  stageNamePattern,
} from '../app/storage-staging.ts'

export function validateWorkingCopyResults(results, cases, runId) {
  assert.ok(Array.isArray(results) && results.length > 0, 'Working-copy results are missing')
  assert.equal(results.length, cases.length, 'Working-copy result count mismatch')
  for (const [index, result] of results.entries()) {
    const expected = cases[index]
    assert.equal(result.root, expected.root, `Working-copy root mismatch: ${expected.name}`)
    assert.equal(
      result.refused,
      expected.expectedRefusal,
      `Working-copy refusal mismatch: ${expected.name}`,
    )
    if (expected.expectedRefusal) {
      assert.ok(typeof result.refusal === 'string' && result.refusal.length > 0)
      assert.match(
        result.refusal,
        new RegExp(expected.refusalPattern, 'i'),
        `Wrong refusal for ${expected.name}`,
      )
    } else {
      assert.ok(Array.isArray(result.changes), `Working-copy changes missing: ${expected.name}`)
      const changes = expected.expectedChanges
        .map((entry) => ({
          path: entry.path,
          staged: entry.kind === 'conflict' || (entry.kind !== 'untracked' && entry.index !== '.'),
          worktree:
            entry.kind === 'conflict' || entry.kind === 'untracked' || entry.worktree !== '.',
          conflict: entry.kind === 'conflict',
        }))
        .sort((a, b) => a.path.localeCompare(b.path))
      assert.deepEqual(result.changes, changes, `Working-copy changes mismatch: ${expected.name}`)
    }
  }
  return { runId, roots: results.map(({ root }) => root), cases: results }
}

export function validateReport(report, context) {
  const { runId, launchedAt, now, osVersion, storageRoot, library, phase = 'normal' } = context
  assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.phase, phase)
  assert.equal(report.runId, runId, 'Stale or unrelated simulator report')
  assert.equal(report.platform, 'ios')
  assert.equal(report.osVersion, osVersion)
  assert.ok(Number.isSafeInteger(report.startedAt) && report.startedAt >= launchedAt)
  assert.ok(Number.isSafeInteger(report.finishedAt) && report.finishedAt >= report.startedAt)
  assert.ok(report.finishedAt <= now && now - report.finishedAt < 120_000)
  assert.equal(report.error, undefined, `Native corpus error: ${report.error}`)
  if (phase === 'normal') {
    assert.ok(
      [
        'available',
        'device-not-eligible',
        'apple-intelligence-not-enabled',
        'model-not-ready',
        'unknown',
      ].includes(report.foundationModels),
      'Foundation Models availability evidence is missing or invalid',
    )
    const git = report.git
    assert.ok(git && typeof git === 'object', 'Native Git transport proof is missing')
    assert.equal(git.schemaVersion, 1)
    assert.equal(git.runId, runId, 'Stale native Git evidence')
    assert.match(git.libgit2Version, /^\d+\.\d+\.\d+$/)
    assert.match(git.fetchedRef, /^[a-f0-9]{40}$/)
    assert.match(git.pushedHead, /^[a-f0-9]{40}$/)
    for (const field of [
      'clone',
      'fetch',
      'push',
      'credentialChallenge',
      'invalidTlsRejected',
      'authenticationRejected',
      'transportRejected',
      'branchPreserved',
      'modePreserved',
      'binaryPreserved',
      'nonNotePreserved',
      'hooksDisabled',
      'filtersDisabled',
      'helpersDisabled',
      'remoteConstrained',
      'unsafeConfigRejected',
      'queuedFetchDuringSave',
      'queuedFetchFinalBytes',
      'conflictingMoveFetchRejected',
      'conflictingMoveBytesPreserved',
      'conflictingMoveJournalPreserved',
    ])
      assert.equal(git[field], true, `Native Git proof failed: ${field}`)
    assert.equal(git.invalidTlsErrorCode, -17, 'Invalid TLS must be a certificate error')
    assert.equal(git.invalidTlsErrorClass, 16, 'Invalid TLS must be a TLS-class error')
    assert.equal(git.authenticationErrorCode, -16, 'Credential rejection must be an auth error')
    assert.ok(Number.isInteger(git.authenticationErrorClass))
    assert.ok(Number.isInteger(git.transportErrorCode))
    assert.ok(Number.isInteger(git.transportErrorClass))
    assert.notEqual(git.transportErrorCode, git.invalidTlsErrorCode)
    assert.notEqual(git.transportErrorCode, git.authenticationErrorCode)
    assert.notEqual(git.transportErrorClass, git.invalidTlsErrorClass)
    assert.equal(
      readFileSync(join(storageRoot, `holi-git-${runId}-operation-gate`, 'gate.md'), 'utf8'),
      'after',
    )
    const moveRoot = join(storageRoot, `holi-git-move-recovery-${runId}`)
    assert.equal(git.conflictingMoveRoot, moveRoot)
    assert.equal(git.conflictingMoveJournalName, 'move-30000000-0000-4000-8000-000000000719.json')
    assert.equal(readFileSync(join(moveRoot, 'from.md'), 'utf8'), 'newer user bytes')
    assert.equal(existsSync(join(moveRoot, 'to.md')), false)
    const journalPath = join(stagingDirectory(library, moveRoot), git.conflictingMoveJournalName)
    const originalBytes = [...new TextEncoder().encode('original bytes')]
    const expectedJournal = {
      schema: 2,
      root: moveRoot,
      operationId: '30000000-0000-4000-8000-000000000719',
      from: 'from.md',
      to: 'to.md',
      changes: [
        { path: 'from.md', before: originalBytes, after: null },
        { path: 'to.md', before: null, after: originalBytes },
      ],
    }
    assert.deepEqual(readFileSync(journalPath), Buffer.from(JSON.stringify(expectedJournal)))
  }
  const reference = runVaultFormatCorpus((text) => new TextEncoder().encode(text))
  assert.ok(reference.total > 0)
  assert.equal(reference.failed, 0)
  assert.deepEqual(report.corpus, reference, 'Native report is partial, mismatched or failed')
  if (phase === 'recovery') {
    assert.deepEqual(report.recovery, {
      root: join(storageRoot, `holi-storage-interruption-${runId}`),
      before: interruptionBefore,
      after: interruptionAfter,
      normalBytes: context.normalBytes,
      ownedStageRemoved: true,
      unownedPreserved: interruptionArtifacts.map(([name]) => name),
      rawNamesPreserved: ['Café.md', 'Cafe\u0301.md'],
    })
    assert.ok(['winner A', 'winner B'].includes(context.normalBytes))
    return
  }
  assert.equal(phase, 'normal')
  assert.deepEqual(
    report.storage,
    {
      schemaVersion: 3,
      faultPhases: [...storageFaultPhases],
      faultOperations: 10,
      fixturesPreserved: [...storageFixturePaths],
      passed: 1,
      total: 1,
      failed: 0,
      concurrentFulfilled: 1,
      staleRejected: true,
      isolatedRoots: true,
      exactBytes: true,
      listingFiltered: true,
      caseAliasRejected: true,
      symlinkRejected: true,
      finalBytes: report.storage?.finalBytes,
    },
    'Native storage evidence is missing or failed',
  )
  assert.ok(['winner A', 'winner B'].includes(report.storage.finalBytes))
  assert.equal(report.storageRoot, join(storageRoot, `holi-storage-check-${runId}`))
  const names = ['Café.md', 'Cafe\u0301.md'].map((name, index) => ({
    root: join(storageRoot, `holi-raw-${runId}-${index}`),
    name,
    names: [name],
    aliasRejected: true,
    originalText: 'raw native fixture',
    saved: 'updated raw native fixture',
  }))
  assert.equal(report.nativeFilenameSpellings, true)
  const prefix = join(storageRoot, `holi-prefix-${runId}-`)
  const padding = 'a'.repeat((32 - (Buffer.byteLength(prefix) % 32)) % 32)
  const rootA = `${prefix}${padding}`
  const rootB = `${rootA}x`
  assert.deepEqual(report.prefixNamespace, {
    rootA,
    rootB,
    privateA: stagingDirectory(library, rootA),
    privateB: stagingDirectory(library, rootB),
    bytesA: 'root A saved',
    bytesB: 'root B bytes',
    malformedReadRejected: true,
    malformedListRejected: true,
    poisonName: 'move-00000000-0000-4000-8000-000000000589.json',
    poisonBytes: '{malformed B journal',
    poisonRetained: true,
  })
  assert.equal(Buffer.byteLength(rootA) % 32, 0)
  assert.ok(!report.prefixNamespace.privateB.startsWith(`${report.prefixNamespace.privateA}/`))
  assert.ok(!report.prefixNamespace.privateA.startsWith(`${report.prefixNamespace.privateB}/`))
  assert.deepEqual(report.rawNames, names)
  assert.deepEqual(report.nativeFilenameRoots, names)
}

export function validateCheckpoint(marker, { runId, pid, launchedAt, now, documents, library }) {
  assert.equal(marker.schemaVersion, 1)
  assert.equal(marker.phase, 'staged')
  assert.equal(marker.runId, runId)
  assert.equal(marker.pid, pid)
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.ok(Number.isSafeInteger(marker.startedAt) && marker.startedAt >= launchedAt)
  assert.ok(
    Number.isSafeInteger(marker.readyAt) &&
      marker.readyAt >= marker.startedAt &&
      marker.readyAt <= now &&
      now - marker.readyAt < 60_000,
  )
  const root = join(documents, `holi-storage-interruption-${runId}`)
  assert.equal(marker.root, root)
  assert.equal(marker.relative, 'durable.md')
  assert.equal(typeof marker.stage, 'string')
  assert.equal(dirname(marker.stage), stagingDirectory(library, root))
  assert.match(basename(marker.stage), stageNamePattern)
}

export function moveCrashCases() {
  return [
    { ordinal: 0, phase: 'journal-before', direction: 'before', path: null },
    { ordinal: 1, phase: 'journal-after', direction: 'after', path: null },
    ...['from.md', 'to.md', 'back-a.md', 'back-b.md'].flatMap((path, index) => [
      { ordinal: 2 + index * 2, phase: 'file-before', direction: 'before', path },
      { ordinal: 3 + index * 2, phase: 'file-after', direction: 'after', path },
    ]),
    { ordinal: 10, phase: 'cleanup-before', direction: 'before', path: 'journal' },
    { ordinal: 11, phase: 'cleanup-after', direction: 'after', path: 'journal' },
    { ordinal: 12, phase: 'recovery-file-before', direction: 'before', path: 'to.md' },
  ]
}

export function moveCheckpointState(caseInfo, operationId, images, root) {
  const before = {
    'from.md': images.source,
    'to.md': null,
    'back-a.md': images.backA,
    'back-b.md': images.backB,
  }
  const after = {
    'from.md': null,
    'to.md': images.moved,
    'back-a.md': images.movedA,
    'back-b.md': images.movedB,
  }
  let files
  let journal
  if (caseInfo.phase === 'journal-before') {
    files = before
    journal = false
  } else if (caseInfo.phase === 'journal-after') {
    files = before
    journal = true
  } else if (caseInfo.phase === 'file-before' || caseInfo.phase === 'file-after') {
    const order = ['from.md', 'to.md', 'back-a.md', 'back-b.md']
    const current = order.indexOf(caseInfo.path)
    assert.notEqual(current, -1, 'Unknown file checkpoint path')
    const applied = current + (caseInfo.phase === 'file-after' ? 1 : 0)
    files = Object.fromEntries(
      order.map((path, index) => [path, index < applied ? after[path] : before[path]]),
    )
    journal = true
  } else if (caseInfo.phase === 'cleanup-before') {
    files = after
    journal = true
  } else if (caseInfo.phase === 'cleanup-after') {
    files = after
    journal = false
  } else if (caseInfo.phase === 'recovery-file-before') {
    files = { ...before, 'from.md': null }
    journal = true
  } else {
    throw new Error(`Unknown move checkpoint phase: ${caseInfo.phase}`)
  }
  return { files, journal, operationId, images, root }
}

export function validateMoveCheckpointState(state, { caseInfo, operationId, files, journal }) {
  assert.equal(operationId, state.operationId)
  const bytes = Object.fromEntries(
    Object.entries(files).map(([path, value]) => [
      path,
      value === null ? null : Buffer.from(value),
    ]),
  )
  const expectedBytes = Object.fromEntries(
    Object.entries(state.files).map(([path, value]) => [
      path,
      value === null ? null : Buffer.from(value),
    ]),
  )
  assert.deepEqual(
    bytes,
    expectedBytes,
    `Wrong native bytes at ${caseInfo.phase}:${caseInfo.path ?? ''}`,
  )
  assert.equal(journal !== null, state.journal, `Wrong journal presence at ${caseInfo.phase}`)
  if (!state.journal) return
  const expectedChanges = [
    ['from.md', 'source', null],
    ['to.md', null, 'moved'],
    ['back-a.md', 'backA', 'movedA'],
    ['back-b.md', 'backB', 'movedB'],
  ].map(([path, before, after]) => ({
    path,
    before: before === null ? null : [...new TextEncoder().encode(state.images[before])],
    after: after === null ? null : [...new TextEncoder().encode(state.images[after])],
  }))
  assert.deepEqual(journal, {
    schema: 3,
    root: state.root,
    operationId,
    from: 'from.md',
    to: 'to.md',
    changes: expectedChanges,
  })
}

export function validateMoveCheckpoint(marker, context) {
  const { runId, caseInfo, pid, launchedAt, now, root, privatePath } = context
  assert.equal(marker.schemaVersion, 1)
  assert.equal(marker.runId, runId)
  assert.equal(marker.ordinal, caseInfo.ordinal)
  assert.equal(marker.phase, caseInfo.phase)
  assert.equal(marker.direction, caseInfo.direction)
  assert.equal(marker.path, caseInfo.path === 'journal' ? marker.path : caseInfo.path)
  assert.equal(marker.root, root)
  assert.equal(marker.privatePath, privatePath)
  assert.equal(marker.pid, pid)
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.ok(Number.isSafeInteger(marker.startedAt) && marker.startedAt >= launchedAt)
  assert.ok(Number.isSafeInteger(marker.readyAt) && marker.readyAt >= marker.startedAt)
  assert.ok(marker.readyAt <= now && now - marker.readyAt < 60_000)
  assert.match(
    marker.operationId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  )
  if (caseInfo.path === null) assert.equal(marker.path, null)
  else if (caseInfo.path === 'journal') assert.equal(marker.path, `move-${marker.operationId}.json`)
  else assert.equal(marker.path, caseInfo.path)
  return marker
}

export function validateSharedGraph(graph) {
  const resources = [
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/markdown',
    'entities/decode',
    'entities/decode-codepoint',
    'entities/decode-data-html',
    'entities/decode-data-xml',
    'markdown-move-links.ts',
    'mobile-path-safety.ts',
    'path-safety.ts',
    'vault-format.ts',
    'vault-format.v1.json',
    'wiki-links.ts',
  ]
  const allowed = new Set([
    'vault-format.ts|./path-safety|path-safety.ts',
    'vault-format.ts|./vault-format.v1.json|vault-format.v1.json',
    'mobile-path-safety.ts|./path-safety|path-safety.ts',
    'markdown-move-links.ts|@lezer/markdown|@lezer/markdown',
    'markdown-move-links.ts|entities/decode|entities/decode',
    'entities/decode|./decode-codepoint.js|entities/decode-codepoint',
    'entities/decode|./generated/decode-data-html.js|entities/decode-data-html',
    'entities/decode|./generated/decode-data-xml.js|entities/decode-data-xml',
    '@lezer/markdown|@lezer/common|@lezer/common',
    '@lezer/markdown|@lezer/highlight|@lezer/highlight',
    '@lezer/highlight|@lezer/common|@lezer/common',
  ])
  assert.equal(graph.schemaVersion, 2)
  assert.deepEqual(graph.resources, resources)
  assert.ok(Array.isArray(graph.edges))
  const observed = new Set()
  for (const edge of graph.edges) {
    const identity = `${edge.from}|${edge.request}|${edge.to}`
    assert.ok(allowed.has(identity), `Unexpected shared dependency: ${JSON.stringify(edge)}`)
    observed.add(identity)
  }
  assert.deepEqual(observed, allowed)
}

export async function whileCommandPending(command, observe, delay = 60_000, { signal } = {}) {
  let observation
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      observation = Promise.resolve()
        .then(() => observe(controller.signal))
        .catch(() => {})
    }
  }, delay)
  try {
    return await command
  } finally {
    clearTimeout(timer)
    controller.abort()
    signal?.removeEventListener('abort', abort)
    if (observation) await observation
  }
}

/** Stop the owned CLI group on timeout/cancellation; forced build shutdown is not drain proof. */
export function runCommand(
  command,
  args,
  {
    timeout = 120_000,
    log,
    signal,
    onOutput,
    outputLimit = Infinity,
    killGrace = 2_000,
    drainProcessGroup = false,
    ...options
  } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Simulator check interrupted'))
      return
    }
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let stdout = ''
    let failure
    let killTimer
    let settled = false
    let terminationRequested = false
    const finish = async (code, exitSignal = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', abort)
      let drainUnconfirmed = drainProcessGroup && (terminationRequested || exitSignal !== null)
      if (drainProcessGroup && child.pid && process.platform !== 'win32') {
        // Natural pipe closure alone doesn't prove that the owned group stopped.
        // Conversely, after forced shutdown an empty group doesn't rule out escaped
        // fixture writers. Never infer that they stopped or signal a shared service.
        try {
          const start = performance.now()
          while (true) {
            try {
              process.kill(-child.pid, 0)
            } catch (error) {
              if (error.code === 'ESRCH') break
              throw error
            }
            const elapsed = performance.now() - start
            if (elapsed >= killGrace + 2_000) throw new Error('Build process group did not drain')
            if (drainUnconfirmed || elapsed >= killGrace) {
              drainUnconfirmed = true
              kill('SIGKILL')
            }
            await new Promise((done) => setTimeout(done, 25))
          }
        } catch (error) {
          drainUnconfirmed = true
          failure ??= error
        }
      } else if (failure) kill('SIGKILL')
      if (drainUnconfirmed) failure ??= new Error('Build process drain could not be confirmed')
      if (failure || code !== 0) {
        reject(
          Object.assign(new Error(`${failure?.message ?? `Exit ${code}: ${command}`}\n${output}`), {
            exitCode: code,
            signal: exitSignal,
            code: failure?.code,
            drainUnconfirmed,
            timedOut: failure?.message.startsWith('Timed out:') ?? false,
          }),
        )
      } else resolve(stdout.trim())
    }
    const kill = (sig) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(sig)
        else process.kill(-child.pid, sig)
      } catch (error) {
        if (error.code !== 'ESRCH' && !failure) failure = error
      }
    }
    const stop = (reason) => {
      if (failure) return
      failure = reason
      terminationRequested = Boolean(child.pid)
      kill('SIGTERM')
      killTimer = setTimeout(() => {
        kill('SIGKILL')
        // Do not wait forever for inherited pipes held by an escaped descendant.
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(null)
      }, killGrace)
    }
    const timer = setTimeout(
      () => stop(new Error(`Timed out: ${command} ${args.join(' ')}`)),
      timeout,
    )
    const abort = () => stop(new Error('Simulator check interrupted'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const receive = (data, stream) => {
      if (log) appendFileSync(log, data)
      output = (output + data.toString()).slice(-Math.min(100_000, outputLimit))
      try {
        onOutput?.(data, stream)
      } catch (error) {
        stop(error)
      }
    }
    child.stdout.on('data', (data) => {
      stdout = (stdout + data.toString()).slice(-outputLimit)
      receive(data, 'stdout')
    })
    child.stderr.on('data', (data) => receive(data, 'stderr'))
    child.on('error', (error) => {
      failure ??= error
    })
    // The leader can exit before a descendant which ignored SIGTERM.
    child.on('close', finish)
  })
}
