import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
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

export function validateReport(report, context) {
  const { runId, launchedAt, now, osVersion, storageRoot, phase = 'normal' } = context
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
    schema: 2,
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
    'mobile-path-safety.ts',
    'path-safety.ts',
    'vault-format.ts',
    'vault-format.v1.json',
    'wiki-links.ts',
  ]
  assert.equal(graph.schemaVersion, 1)
  assert.deepEqual(graph.resources, resources)
  assert.ok(Array.isArray(graph.edges) && graph.edges.length > 0)
  for (const edge of graph.edges) {
    assert.ok(
      (edge.from === 'vault-format.ts' &&
        edge.request === './path-safety' &&
        edge.to === 'path-safety.ts') ||
        (edge.from === 'vault-format.ts' &&
          edge.request === './vault-format.v1.json' &&
          edge.to === 'vault-format.v1.json') ||
        (edge.from === 'mobile-path-safety.ts' &&
          edge.request === './path-safety' &&
          edge.to === 'path-safety.ts'),
      `Unexpected shared dependency: ${JSON.stringify(edge)}`,
    )
  }
  assert.ok(graph.edges.some((edge) => edge.to === 'path-safety.ts'))
  assert.ok(graph.edges.some((edge) => edge.to === 'vault-format.v1.json'))
  assert.ok(graph.edges.some((edge) => edge.from === 'mobile-path-safety.ts'))
}

/** Kill the complete CLI/build process group on timeout or cancellation. */
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
    ...options
  } = {},
) {
  return new Promise((resolve, reject) => {
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
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (failure) kill('SIGKILL')
      signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) {
        reject(
          Object.assign(new Error(`${failure?.message ?? `Exit ${code}: ${command}`}\n${output}`), {
            exitCode: code,
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
