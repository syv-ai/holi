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

export function validateSharedGraph(graph) {
  const resources = [
    'mobile-path-safety.ts',
    'path-safety.ts',
    'vault-format.ts',
    'vault-format.v1.json',
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
export function runCommand(command, args, { timeout = 120_000, log, signal, ...options } = {}) {
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
    const kill = (sig) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(sig)
        else process.kill(-child.pid, sig)
      } catch (error) {
        if (error.code !== 'ESRCH') failure = error
      }
    }
    const stop = (reason) => {
      if (failure) return
      failure = reason
      kill('SIGTERM')
      killTimer = setTimeout(() => kill('SIGKILL'), 2_000)
    }
    const timer = setTimeout(
      () => stop(new Error(`Timed out: ${command} ${args.join(' ')}`)),
      timeout,
    )
    const abort = () => stop(new Error('Simulator check interrupted'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const receive = (data) => {
      if (log) appendFileSync(log, data)
      output = (output + data.toString()).slice(-100_000)
    }
    child.stdout.on('data', (data) => {
      stdout += data.toString()
      receive(data)
    })
    child.stderr.on('data', receive)
    child.on('error', (error) => {
      failure = error
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      // The leader can exit before a descendant which ignored SIGTERM.
      if (failure) kill('SIGKILL')
      signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) {
        reject(new Error(`${failure?.message ?? `Exit ${code}: ${command}`}\n${output}`))
      } else resolve(stdout.trim())
    })
  })
}
