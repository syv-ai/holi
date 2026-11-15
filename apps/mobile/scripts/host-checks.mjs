import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { runVaultFormatCorpus } from '@holi/shared/vault-format'

export function validateReport(report, { runId, launchedAt, now, osVersion }) {
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.runId, runId, 'Stale or unrelated simulator report')
  assert.equal(report.platform, 'ios')
  assert.equal(report.osVersion, osVersion)
  assert.ok(Number.isSafeInteger(report.startedAt) && report.startedAt >= launchedAt)
  assert.ok(Number.isSafeInteger(report.finishedAt) && report.finishedAt >= report.startedAt)
  assert.ok(report.finishedAt <= now && now - report.finishedAt < 120_000)
  assert.equal(report.error, undefined, `Native corpus error: ${report.error}`)
  const reference = runVaultFormatCorpus((text) => new TextEncoder().encode(text))
  assert.ok(reference.total > 0)
  assert.equal(reference.failed, 0, 'The canonical corpus has incorrect expectations')
  assert.deepEqual(report.corpus, reference, 'Native report is partial, mismatched or failed')
}

export function validateSharedGraph(graph) {
  const resources = ['path-safety.ts', 'vault-format.ts', 'vault-format.v1.json']
  assert.equal(graph.schemaVersion, 1)
  assert.deepEqual(graph.resources, resources)
  assert.ok(Array.isArray(graph.edges) && graph.edges.length > 0)
  for (const edge of graph.edges) {
    assert.equal(edge.from, 'vault-format.ts')
    assert.ok(
      (edge.request === './path-safety' && edge.to === 'path-safety.ts') ||
        (edge.request === './vault-format.v1.json' && edge.to === 'vault-format.v1.json'),
      `Unexpected shared dependency: ${JSON.stringify(edge)}`,
    )
  }
  assert.ok(graph.edges.some((edge) => edge.to === 'path-safety.ts'))
  assert.ok(graph.edges.some((edge) => edge.to === 'vault-format.v1.json'))
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
