import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkPiRpcProducer } from './pi-rpc-producer.mjs'
import { leaseBuildScript } from './producer-command.mjs'

async function checkFixture(t, params, adapter) {
  const handles = []
  const calls = []
  const result = await checkPiRpcProducer({
    ...params,
    adapter: {
      spawnChild(command, args, options) {
        calls.push(args)
        if (adapter) return adapter.spawnChild(command, args, options)
        const child = spawn(command, args[0] === leaseBuildScript ? ['-e', ''] : args, options)
        handles.push({ child, settled: new Promise((resolve) => child.once('close', resolve)) })
        return child
      },
      probePresence: adapter?.probePresence ?? ((pid) => process.kill(pid, 0)),
    },
  })
  t.after(async (t) => {
    for (const { child, settled } of handles) {
      await settled
      if (child.pid && process.platform !== 'win32') {
        for (const id of [child.pid, -child.pid])
          assert.throws(() => process.kill(id, 0), { code: 'ESRCH' })
      }
    }
    // The real fixture executables never launch descendants; fake PIDs only
    // ever go through their injected adapter, never to the kernel.
    if (result.cleanup.retainedRoot) rmSync(result.cleanup.retainedRoot, { recursive: true })
  })
  assert.deepEqual(calls[0], [leaseBuildScript])
  return result
}

function runner(source) {
  const directory = mkdtempSync(join(tmpdir(), 'holi-pi-producer-test-'))
  const executable = join(directory, 'pnpm')
  writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
  chmodSync(executable, 0o755)
  return { directory, executable }
}

test('requires exact Pi version and binary for native producer probe', async () => {
  await assert.rejects(checkPiRpcProducer({}), /binary and exact expected version/)
  await assert.rejects(
    checkPiRpcProducer({ bin: '/missing/pi' }),
    /binary and exact expected version/,
  )
})

test('Pi only removes a successful probe root after worker settlement', async (t) => {
  const markers = mkdtempSync(join(tmpdir(), 'holi-pi-test-markers-'))
  const evidenceRootFile = join(markers, 'probe-root.txt')
  const fixture = runner(`
    const fs = require('node:fs')
    const path = require('node:path')
    if (fs.existsSync(${JSON.stringify(join(markers, 'retain-fixture'))}))
      fs.mkdirSync(path.join(process.env.TMPDIR, 'holi-pi-version-leftover'))
    fs.writeFileSync(${JSON.stringify(evidenceRootFile)}, process.env.PI_NATIVE_PROBE_EVIDENCE)
    fs.writeFileSync(${JSON.stringify(evidenceRootFile + '.env')}, JSON.stringify(Object.keys(process.env)))
    fs.writeFileSync(process.env.PI_NATIVE_PROBE_EVIDENCE, JSON.stringify({expectedVersion:process.env.PI_NATIVE_PROBE_VERSION,observedVersion:process.env.PI_NATIVE_PROBE_VERSION,package:'@earendil-works/pi-coding-agent',scenarios:{...Object.fromEntries(['streamCompletion','consecutiveTurns','modelError','cancel','noToolsRequest','appendSystemPrompt','statsResponse','steerAndFollowUp'].map(k=>[k,'pass'])),modelErrorReported:true},recordCount:5,commandCount:2,records:[{type:'agent_start'},{type:'agent_settled'},{type:'response',command:'set_model',success:true},{type:'response',command:'prompt',success:true},{type:'response',command:'get_session_stats',success:true}],commands:[{argv:['--no-tools'],noTools:true},{type:'abort'}],tools:[],cleanup:{piRunDrained:true,fixtureServerClosed:true,localRootRemoved:true}}))
  `)
  const previousPath = process.env.PATH
  const previousNodeOptions = process.env.NODE_OPTIONS
  const previousProxy = process.env.HTTPS_PROXY
  const previousSecret = process.env.PI_NATIVE_PROBE_SECRET
  try {
    process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
    process.env.NODE_OPTIONS = '--require=/tmp/must-not-inherit.js'
    process.env.HTTPS_PROXY = 'http://must-not-inherit.invalid'
    process.env.PI_NATIVE_PROBE_SECRET = 'must-not-inherit'
    const result = await checkFixture(t, { bin: '/synthetic/pi', expectedVersion: '9.8.7' })
    assert.equal(result.outcome, 'pass', result.detail)
    assert.equal(result.evidence.observedVersion, '9.8.7')
    assert.deepEqual(result.cleanup, { temporaryRootRemoved: true })
    assert.deepEqual(result.evidence.cleanup, {
      piRunDrained: true,
      fixtureServerClosed: true,
      localRootRemoved: true,
    })
    const evidencePath = readFileSync(evidenceRootFile, 'utf8')
    assert.equal(existsSync(evidencePath), false)
    const childEnv = JSON.parse(readFileSync(`${evidenceRootFile}.env`, 'utf8'))
    for (const key of ['NODE_OPTIONS', 'HTTPS_PROXY', 'PI_NATIVE_PROBE_SECRET'])
      assert.equal(childEnv.includes(key), false)

    writeFileSync(join(markers, 'retain-fixture'), '')
    const unfinished = await checkFixture(t, { bin: '/synthetic/pi', expectedVersion: '9.8.7' })
    assert.equal(unfinished.outcome, 'unverified')
    assert.equal(unfinished.stage, 'cleanup')
    assert.match(unfinished.cleanup.error, /still contains fixture evidence/)
    assert.ok(
      existsSync(join(unfinished.cleanup.retainedRoot, 'worker-tmp', 'holi-pi-version-leftover')),
    )
  } finally {
    process.env.PATH = previousPath
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previousProxy
    if (previousSecret === undefined) delete process.env.PI_NATIVE_PROBE_SECRET
    else process.env.PI_NATIVE_PROBE_SECRET = previousSecret
    rmSync(markers, { recursive: true, force: true })
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects version drift in captured native evidence', async (t) => {
  const fixture = runner(
    `require('node:fs').writeFileSync(process.env.PI_NATIVE_PROBE_EVIDENCE, JSON.stringify({expectedVersion:process.env.PI_NATIVE_PROBE_VERSION,observedVersion:'wrong',package:'@earendil-works/pi-coding-agent',scenarios:{},recordCount:3,commandCount:1,records:[],commands:[{}],tools:[],cleanup:{piRunDrained:true,fixtureServerClosed:true,localRootRemoved:true}}))`,
  )
  const previousPath = process.env.PATH
  try {
    process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
    const result = await checkFixture(t, { bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(result.outcome, 'mismatch')
    assert.match(result.detail, /Observed Pi version/)
    assert.deepEqual(result.cleanup, { temporaryRootRemoved: true })
    assert.deepEqual(result.evidence.cleanup, {
      piRunDrained: true,
      fixtureServerClosed: true,
      localRootRemoved: true,
    })
  } finally {
    process.env.PATH = previousPath
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects empty, malformed, oversized and incomplete evidence', async (t) => {
  const good = {
    observedVersion: '1.0.0',
    expectedVersion: '1.0.0',
    package: '@earendil-works/pi-coding-agent',
    scenarios: {
      ...Object.fromEntries(
        [
          'streamCompletion',
          'consecutiveTurns',
          'modelError',
          'cancel',
          'noToolsRequest',
          'appendSystemPrompt',
          'statsResponse',
          'steerAndFollowUp',
        ].map((key) => [key, 'pass']),
      ),
      modelErrorReported: true,
    },
    recordCount: 5,
    commandCount: 2,
    records: [
      { type: 'agent_start' },
      { type: 'agent_settled' },
      { type: 'response', command: 'set_model', success: true },
      { type: 'response', command: 'prompt', success: true },
      { type: 'response', command: 'get_session_stats', success: true },
    ],
    commands: [{ argv: ['--no-tools'], noTools: true }, { type: 'abort' }],
    tools: [],
    cleanup: { piRunDrained: true, fixtureServerClosed: true, localRootRemoved: true },
  }
  const invalidEvidence = [
    {},
    { ...good, recordCount: 0 },
    { ...good, commandCount: -1 },
    { ...good, scenarios: { ...good.scenarios, steerAndFollowUp: 'unverified' } },
    { ...good, package: 'different-package' },
    { ...good, commands: [{ argv: ['--mode', 'rpc'], noTools: false }, { type: 'abort' }] },
  ].map((item) => JSON.stringify(item))
  for (const body of ['{}', '{', ' '.repeat(65 * 1024), ...invalidEvidence]) {
    const fixture = runner(
      `require('node:fs').writeFileSync(process.env.PI_NATIVE_PROBE_EVIDENCE, ${JSON.stringify(body)})`,
    )
    const previousPath = process.env.PATH
    try {
      process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
      const result = await checkFixture(t, { bin: '/synthetic/pi', expectedVersion: '1.0.0' })
      assert.equal(result.outcome, 'unverified')
    } finally {
      process.env.PATH = previousPath
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  }
})

test('classifies setup failures and incomplete evidence as unverified', async (t) => {
  const previousPath = process.env.PATH
  const noRunner = mkdtempSync(join(tmpdir(), 'holi-pi-no-runner-'))
  try {
    process.env.PATH = noRunner
    const unavailable = await checkFixture(t, {
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 100,
    })
    assert.equal(unavailable.outcome, 'unverified')
    assert.equal(unavailable.stage, 'runner')
    assert.equal(unavailable.cleanup.temporaryRootRemoved, true)
  } finally {
    process.env.PATH = previousPath
    rmSync(noRunner, { recursive: true, force: true })
  }

  const failing = runner(`process.exit(7)`)
  try {
    process.env.PATH = `${failing.directory}:${previousPath ?? ''}`
    const result = await checkFixture(t, { bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(result.outcome, 'unverified')
    assert.equal(result.stage, 'evidence')
    assert.equal(result.cleanup.temporaryRootRemoved, false)
  } finally {
    process.env.PATH = previousPath
    rmSync(failing.directory, { recursive: true, force: true })
  }
})

test('classifies evidenced native consumer assertions as mismatches', async (t) => {
  const fixture = runner(`
    const fs = require('node:fs')
    fs.writeFileSync(process.env.PI_NATIVE_PROBE_EVIDENCE, JSON.stringify({
      expectedVersion: process.env.PI_NATIVE_PROBE_VERSION,
      observedVersion: process.env.PI_NATIVE_PROBE_VERSION,
      failure: { stage: 'native-rpc', message: 'consumer assertion failed' }
    }))
    process.exit(1)
  `)
  const previousPath = process.env.PATH
  try {
    process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
    const result = await checkFixture(t, { bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(result.outcome, 'mismatch')
    assert.equal(result.stage, 'native-rpc')
    assert.match(result.detail, /consumer assertion failed/)
    assert.equal(result.evidence.failure.stage, 'native-rpc')
    assert.equal(result.cleanup.status, 'incomplete')
    assert.ok(existsSync(join(result.cleanup.retainedRoot, 'evidence.json')))
  } finally {
    process.env.PATH = previousPath
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

function fakeProcess({ onWorker, probePresence, buildCode = 0 }) {
  const fakePid = 12345
  const commands = []
  const stops = []
  const probes = []
  return {
    commands,
    stops,
    probes,
    spawnChild(command, args, options) {
      commands.push([command, args])
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.unref = () => {}
      child.kill = (signal) => {
        stops.push(signal)
        if (signal === 'SIGTERM') throw Object.assign(new Error('signal EPERM'), { code: 'EPERM' })
        close(null, signal)
        return true
      }
      const close = (code, signal = null) => {
        child.emit('exit', code, signal)
        child.stdout.destroy()
        child.stderr.destroy()
        child.emit('close', code, signal)
      }
      queueMicrotask(() => {
        if (args[0] === leaseBuildScript) {
          child.pid = fakePid
          child.emit('spawn')
          close(buildCode)
        } else onWorker({ child, close, fakePid: fakePid + 1, env: options.env })
      })
      return child
    },
    probePresence(pid) {
      probes.push(pid)
      assert.ok([fakePid, -fakePid, fakePid + 1, -(fakePid + 1)].includes(pid))
      if (Math.abs(pid) !== fakePid && probePresence?.(pid) === true) return
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    },
  }
}

const input = { bin: '/fake/pi', expectedVersion: '1.0.0' }

test('a failed helper build never enters the Pi worker', async (t) => {
  const adapter = fakeProcess({ buildCode: 1, onWorker: () => assert.fail('worker started') })
  const result = await checkFixture(t, input, adapter)
  assert.equal(adapter.commands.length, 1)
  assert.equal(result.stage, 'setup')
  assert.match(result.detail, /helper build exited 1/)
  assert.equal(result.cleanup.temporaryRootRemoved, true)
})

test('runner group absence without a detached lease receipt retains evidence', async (t) => {
  const adapter = fakeProcess({
    onWorker({ child, close, fakePid, env }) {
      child.pid = fakePid
      child.emit('spawn')
      writeFileSync(join(dirname(env.PI_NATIVE_PROBE_EVIDENCE), 'reaper.receipt'), 'simulated')
      close(7)
    },
  })
  const result = await checkFixture(t, input, adapter)
  assert.match(result.detail, /runner exit 7/)
  assert.match(result.cleanup.error, /detached worker lease settlement receipt/)
  assert.ok(existsSync(join(result.cleanup.retainedRoot, 'reaper.receipt')))
  assert.deepEqual(adapter.stops, [])
  if (process.platform !== 'win32') assert.deepEqual(adapter.probes, [12345, -12345, 12346, -12346])
})

test('a close without a PID receipt does not prove the worker never launched', async (t) => {
  const adapter = fakeProcess({
    onWorker({ child, close }) {
      child.emit('spawn')
      close(7)
    },
  })
  const result = await checkFixture(t, input, adapter)
  assert.match(result.detail, /runner exit 7/)
  assert.match(result.cleanup.error, /Missing runner launch or exit receipt/)
  assert.equal(result.cleanup.temporaryRootRemoved, false)
  assert.deepEqual(adapter.stops, [])
})

test('only ESRCH proves a POSIX group absent; preserve overflow and signal errors', async (t) => {
  if (process.platform === 'win32') return
  for (const mode of ['transient EPERM', 'EPERM', 'zombie', 'unexpected EINVAL']) {
    let attempts = 0
    const adapter = fakeProcess({
      onWorker({ child, fakePid }) {
        child.pid = fakePid
        child.emit('spawn')
        child.stdout.write(Buffer.alloc(256 * 1024 + 1))
      },
      probePresence(pid) {
        if (pid > 0) return
        if (mode === 'transient EPERM' && attempts++ > 0) return
        if (mode === 'zombie') return true
        throw Object.assign(new Error(mode), { code: mode.endsWith('EINVAL') ? 'EINVAL' : 'EPERM' })
      },
    })
    const result = await checkFixture(t, input, adapter)
    assert.equal(result.stage, 'runner')
    assert.match(result.detail, /output exceeded bound/)
    assert.match(result.cleanup.error, /signal EPERM/)
    assert.match(
      result.cleanup.error,
      new RegExp(
        {
          'transient EPERM': 'detached worker lease settlement receipt',
          EPERM: 'group 12346 absent: EPERM',
          zombie: 'group 12346 absent: still present',
          'unexpected EINVAL': 'group 12346 absent: EINVAL',
        }[mode],
      ),
    )
    assert.deepEqual(adapter.stops, ['SIGTERM', 'SIGKILL'])
    assert.equal(result.cleanup.temporaryRootRemoved, false)
  }
})

test('runner exit with a held pipe still honours timeout without signalling the exited handle', async (t) => {
  const adapter = fakeProcess({
    onWorker({ child, fakePid }) {
      child.pid = fakePid
      child.emit('spawn')
      child.emit('exit', 7, null)
    },
  })
  const result = await checkFixture(t, { ...input, timeout: 20 }, adapter)
  assert.match(result.detail, /timed out/)
  assert.match(result.cleanup.error, /Runner close was not observed/)
  assert.deepEqual(adapter.stops, [])
  assert.equal(result.cleanup.temporaryRootRemoved, false)
})
