import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { arch, platform, release } from 'node:os'
import { basename, join } from 'node:path'
import { runCommand } from './host-checks.mjs'

const fileLimit = 128 * 1024
const outputLimit = 64 * 1024
const signals = [
  ['data-migration', /data migration/i],
  ['system-app', /system app/i],
  ['system-services', /system services/i],
  ['xpc', /\bxpc\b/i],
  ['watchdog', /watchdog/i],
  ['launchd', /launchd/i],
  ['boot', /boot/i],
  ['finished', /finished|complete/i],
  ['timeout', /timed? ?out/i],
  ['connection', /connection|connect to/i],
  ['disk', /disk|mount/i],
  ['unavailable', /unavailable|not available/i],
  ['failed', /fail|error/i],
]

// Arbitrary service messages, paths, arguments, environment and usernames never
// reach artifacts. Keep only known boot signals and numeric Darwin error codes.
function projectMessage(text) {
  return {
    signals: signals.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
    codes: [
      ...text.matchAll(
        /\b(NSPOSIXErrorDomain|NSCocoaErrorDomain|SimError|IXErrorDomain)\b[^\n]{0,20}?\b(?:Code=|code[=: ]+)(-?\d{1,10})\b/g,
      ),
    ]
      .slice(0, 10)
      .map((match) => ({ domain: match[1], code: Number(match[2]) })),
    status: text.match(/\bStatus=(\d{1,10})\b/)?.[1],
  }
}

function journal(path, context) {
  const start = performance.now()
  let bytes = 0
  let droppedEvents = 0
  return (event) => {
    const line =
      JSON.stringify({
        schemaVersion: 1,
        ...context,
        at: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - start),
        ...(droppedEvents ? { droppedEvents } : {}),
        ...event,
      }) + '\n'
    // Reserve space for the terminal event even after noisy command output.
    if (
      bytes + Buffer.byteLength(line) > fileLimit - 4096 &&
      ['output', 'waiting'].includes(event.event)
    ) {
      droppedEvents++
      return
    }
    if (bytes + Buffer.byteLength(line) > fileLimit) return
    appendFileSync(path, line)
    bytes += Buffer.byteLength(line)
  }
}

function lines(consume) {
  let pending = ''
  return (data) => {
    pending += data.toString()
    const parts = pending.split(/[\r\n]+/)
    pending = parts.pop().slice(-outputLimit)
    for (const line of parts) if (line) consume(line)
  }
}

function serviceName(path) {
  const name = basename(path)
  if (name === 'com.apple.CoreSimulator.CoreSimulatorService') return 'CoreSimulatorService'
  return ['CoreSimulatorService', 'simdiskimaged'].includes(name) ? name : undefined
}

function runnerMetadata(metadata) {
  const imageVersion = process.env.ImageVersion
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    node: process.version,
    imageOS: /^macos\d+(?:-arm64)?$/.test(process.env.ImageOS ?? '')
      ? process.env.ImageOS
      : undefined,
    imageVersion: /^\d{8}\.\d+\.\d+$/.test(imageVersion ?? '') ? imageVersion : undefined,
    // Only identifiers selected by this harness, not the caller's environment.
    runtime: metadata?.runtime,
    deviceType: metadata?.deviceType,
    xcode: metadata?.xcode?.match(/Xcode [\d.]+\s+Build version [A-Za-z0-9]+/)?.[0],
  }
}

async function captureHost({
  simulator,
  artifacts,
  runId,
  metadata,
  command,
  diagnosticBudget,
  diagnosticTimeout,
}) {
  const record = journal(join(artifacts, 'boot-host-diagnostics.jsonl'), { runId, simulator })
  const deadline = performance.now() + diagnosticBudget
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), diagnosticBudget)
  record({
    event: 'started',
    budgetMs: diagnosticBudget,
    maximumExtraMs: diagnosticBudget + 2000,
    commandTimeoutMs: diagnosticTimeout,
    killGraceMs: 2000,
    outputLimitChars: outputLimit,
    artifactLimitBytes: fileLimit,
    metadata: runnerMetadata(metadata),
  })
  // Host-only commands run first and do not require a responsive guest or simctl.
  // No diagnose archive, full environment, process arguments or other device list.
  const probes = [
    [
      'os',
      '/usr/bin/sw_vers',
      [],
      (text) => ({
        version: text.match(/ProductVersion:\s*([\d.]+)/)?.[1],
        build: text.match(/BuildVersion:\s*([A-Za-z0-9]+)/)?.[1],
      }),
    ],
    [
      'resources',
      '/usr/sbin/sysctl',
      ['-n', 'hw.memsize', 'hw.logicalcpu', 'vm.loadavg'],
      (text) => {
        const values =
          text
            .match(/\d+(?:\.\d+)?/g)
            ?.slice(0, 5)
            .map(Number) ?? []
        return { memoryBytes: values[0], logicalCpu: values[1], loadAverage: values.slice(2) }
      },
    ],
    [
      'memory',
      '/usr/bin/vm_stat',
      [],
      (text) => ({
        pageSizeBytes: Number(text.match(/page size of (\d+) bytes/)?.[1]) || undefined,
        counters: [...text.matchAll(/^([A-Za-z -]+):\s+(\d+)\./gm)]
          .slice(0, 40)
          .map((match) => ({ name: match[1], value: Number(match[2]) })),
      }),
    ],
    [
      'disk',
      '/bin/df',
      ['-k', artifacts],
      (text) => ({
        blocks: text
          .split('\n')
          .at(-1)
          ?.trim()
          .split(/\s+/)
          .slice(1, 5)
          .map((value) => (/^\d+%?$/.test(value) ? value : null)),
      }),
    ],
    [
      'services',
      '/bin/ps',
      ['-A', '-o', 'pid=,ppid=,%cpu=,%mem=,rss=,etime=,state=,comm='],
      (text) => ({
        processes: text
          .split('\n')
          .flatMap((line) => {
            const match = line
              .trim()
              .match(
                /^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+([\d:-]+)\s+([A-Z+<Ns]+)\s+(.+)$/,
              )
            if (!match || !serviceName(match[8])) return []
            return [
              {
                name: serviceName(match[8]),
                pid: Number(match[1]),
                parentPid: Number(match[2]),
                cpu: Number(match[3]),
                memoryPercent: Number(match[4]),
                rssKiB: Number(match[5]),
                elapsed: match[6],
                state: match[7],
              },
            ]
          })
          .slice(0, 10),
      }),
    ],
    [
      'host-log',
      '/usr/bin/log',
      [
        'show',
        '--last',
        '3m',
        '--style',
        'ndjson',
        '--info',
        '--predicate',
        `(process == "com.apple.CoreSimulator.CoreSimulatorService" OR process == "CoreSimulatorService" OR process == "simdiskimaged") AND eventMessage CONTAINS[c] "${simulator}"`,
      ],
      (text) => {
        let value
        try {
          value = JSON.parse(text)
        } catch {
          return undefined
        }
        if (!String(value.eventMessage).toUpperCase().includes(simulator.toUpperCase()))
          return undefined
        const name = serviceName(value.processImagePath ?? '')
        if (!name) return undefined
        return {
          process: name,
          timestamp: /^[\d +:.-]+$/.test(value.timestamp ?? '') ? value.timestamp : undefined,
          ...projectMessage(String(value.eventMessage)),
        }
      },
    ],
  ]
  try {
    for (const [probe, exe, args, project] of probes) {
      const remaining = deadline - performance.now()
      if (remaining <= 0 || controller.signal.aborted) {
        record({ event: 'command-finished', probe, status: 'budget-exhausted' })
        continue
      }
      record({ event: 'command-started', probe })
      try {
        const output = await command(exe, args, {
          timeout: Math.min(diagnosticTimeout, remaining),
          signal: controller.signal,
          outputLimit,
          ...(probe === 'host-log' || probe === 'services'
            ? {
                onOutput: lines((line) => {
                  const value = project(line)
                  if (value && (probe !== 'services' || value.processes.length))
                    record({ event: 'output', probe, value })
                }),
              }
            : {}),
        })
        record({
          event: 'command-finished',
          probe,
          status: 'ok',
          ...(probe === 'host-log' || probe === 'services' ? {} : { value: project(output) }),
        })
      } catch (error) {
        record({
          event: 'command-finished',
          probe,
          status: error.timedOut || controller.signal.aborted ? 'timeout' : 'error',
          exitCode: error.exitCode ?? null,
        })
      }
    }
  } finally {
    clearTimeout(timer)
    record({
      event: 'finished',
      budgetExhausted: controller.signal.aborted || performance.now() >= deadline,
    })
  }
}

/** Boot only this run's freshly created UUID; evidence is durable before caller teardown. */
export async function bootSimulator({
  simulator,
  artifacts,
  runId,
  metadata,
  command = runCommand,
  signal,
  diagnosticBudget = 18_000,
  diagnosticTimeout = 3_000,
}) {
  assert.match(simulator, /^[A-F0-9-]{36}$/i)
  const record = journal(join(artifacts, 'boot-progress.jsonl'), { runId, simulator })
  let stage = 'boot'
  let receivedBytes = 0
  const onOutput = lines((line) => record({ event: 'output', stage, ...projectMessage(line) }))
  record({ event: 'started', stage })
  const heartbeat = setInterval(() => {
    try {
      record({ event: 'waiting', stage, receivedBytes })
    } catch {
      /* Keep teardown reachable if the artifact disk fails. */
    }
  }, 5000)
  try {
    for (const args of [
      ['boot', simulator],
      ['bootstatus', simulator, '-b'],
    ]) {
      stage = args[0]
      record({ event: 'command-started', stage })
      await command('xcrun', ['simctl', ...args], {
        signal,
        timeout: stage === 'bootstatus' ? 300_000 : undefined,
        outputLimit,
        env: { ...process.env, NSUnbufferedIO: 'YES' },
        onOutput: (data, stream) => {
          receivedBytes += data.length
          onOutput(data, stream)
        },
      })
      record({ event: 'command-finished', stage })
    }
    record({ event: 'ready' })
  } catch (error) {
    clearInterval(heartbeat)
    try {
      record({
        event: 'failed',
        stage,
        status: error.timedOut ? 'timeout' : signal?.aborted ? 'interrupted' : 'error',
        exitCode: error.exitCode ?? null,
      })
    } catch {
      /* Preserve the original failure even if the artifact disk failed. */
    }
    try {
      // Independent of the failed/interrupted boot signal; bounded before teardown.
      await captureHost({
        simulator,
        artifacts,
        runId,
        metadata,
        command,
        diagnosticBudget,
        diagnosticTimeout,
      })
    } catch {
      // A diagnostic write/adapter failure must never replace the boot failure.
      try {
        record({ event: 'capture-failed' })
      } catch {
        /* Artifact disk failed. */
      }
    }
    throw error
  } finally {
    clearInterval(heartbeat)
  }
}

export async function cleanupSimulator({ simulator, artifacts, command = runCommand }) {
  const failures = []
  for (const action of ['shutdown', 'delete']) {
    try {
      await command('xcrun', ['simctl', action, simulator], { timeout: 60_000 })
    } catch (error) {
      failures.push(String(error))
    }
  }
  try {
    await writeFile(
      join(artifacts, 'cleanup.json'),
      JSON.stringify({ simulator, failures }, null, 2),
    )
  } catch {
    failures.push('Cleanup receipt could not be written')
  }
  return failures
}
