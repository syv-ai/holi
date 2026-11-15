import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkPiRpcProducer } from './pi-rpc-producer.mjs'

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

test('returns bounded evidence and removes its temporary evidence root', async () => {
  const evidenceRootFile = join(tmpdir(), `holi-producer-root-${process.pid}.txt`)
  const fixture = runner(`
    const fs = require('node:fs')
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
    const result = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '9.8.7' })
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
    assert.equal(existsSync(evidencePath), false)
  } finally {
    process.env.PATH = previousPath
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
    if (previousProxy === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = previousProxy
    if (previousSecret === undefined) delete process.env.PI_NATIVE_PROBE_SECRET
    else process.env.PI_NATIVE_PROBE_SECRET = previousSecret
    rmSync(evidenceRootFile, { force: true })
    rmSync(`${evidenceRootFile}.env`, { force: true })
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects version drift in captured native evidence', async () => {
  const fixture = runner(
    `require('node:fs').writeFileSync(process.env.PI_NATIVE_PROBE_EVIDENCE, JSON.stringify({expectedVersion:process.env.PI_NATIVE_PROBE_VERSION,observedVersion:'wrong',package:'@earendil-works/pi-coding-agent',scenarios:{},recordCount:3,commandCount:1,records:[],commands:[{}],tools:[],cleanup:{piRunDrained:true,fixtureServerClosed:true,localRootRemoved:true}}))`,
  )
  const previousPath = process.env.PATH
  try {
    process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
    const result = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '1.0.0' })
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

test('rejects empty, malformed, oversized and incomplete evidence', async () => {
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
      const result = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '1.0.0' })
      assert.equal(result.outcome, 'unverified')
    } finally {
      process.env.PATH = previousPath
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  }
})

test('classifies setup failures and incomplete evidence as unverified', async () => {
  const previousPath = process.env.PATH
  const noRunner = mkdtempSync(join(tmpdir(), 'holi-pi-no-runner-'))
  try {
    process.env.PATH = noRunner
    const unavailable = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 100,
    })
    assert.equal(unavailable.outcome, 'unverified')
    assert.equal(unavailable.stage, 'runner')
  } finally {
    process.env.PATH = previousPath
    rmSync(noRunner, { recursive: true, force: true })
  }

  const failing = runner(`process.exit(7)`)
  try {
    process.env.PATH = `${failing.directory}:${previousPath ?? ''}`
    const result = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(result.outcome, 'unverified')
    assert.equal(result.stage, 'evidence')
  } finally {
    process.env.PATH = previousPath
    rmSync(failing.directory, { recursive: true, force: true })
  }
})

test('classifies evidenced native consumer assertions as mismatches', async () => {
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
    const result = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(result.outcome, 'mismatch')
    assert.equal(result.stage, 'native-rpc')
    assert.match(result.detail, /consumer assertion failed/)
    assert.equal(result.evidence.failure.stage, 'native-rpc')
  } finally {
    process.env.PATH = previousPath
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('drains SIGTERM-resistant process-group descendants on timeout and overflow', async () => {
  if (process.platform === 'win32') return
  const pidFile = join(tmpdir(), `holi-producer-descendant-${process.pid}.txt`)
  const fixtureSource = (overflow) => `
    const { spawn } = require('node:child_process')
    const fs = require('node:fs')
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'})
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
    ${overflow ? "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)" : 'setInterval(() => {}, 1000)'}
  `
  const timeoutFixture = runner(fixtureSource(false))
  const overflowFixture = runner(fixtureSource(true))
  const previousPath = process.env.PATH
  const descendantGone = async () => {
    const deadline = Date.now() + 2000
    while (!existsSync(pidFile) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const drainDeadline = Date.now() + 2000
    while (Date.now() < drainDeadline) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return true
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }
  try {
    process.env.PATH = `${timeoutFixture.directory}:${previousPath ?? ''}`
    const timeout = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 1000,
    })
    assert.equal(timeout.outcome, 'unverified')
    assert.equal(await descendantGone(), true)
    process.env.PATH = `${overflowFixture.directory}:${previousPath ?? ''}`
    const overflow = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 5000,
    })
    assert.equal(overflow.outcome, 'unverified')
    assert.equal(await descendantGone(), true)
  } finally {
    process.env.PATH = previousPath
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {}
    rmSync(pidFile, { force: true })
    rmSync(timeoutFixture.directory, { recursive: true, force: true })
    rmSync(overflowFixture.directory, { recursive: true, force: true })
  }
})

test('does not let a transient process-group probe EPERM mask overflow', async () => {
  if (process.platform === 'win32') return
  const fixture = runner(
    `process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'.repeat(65536)),1)`,
  )
  const previousPath = process.env.PATH
  const originalKill = process.kill
  let ownedGroup
  let injected = false
  try {
    process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
    process.kill = function (pid, signal) {
      if (pid < 0 && signal === 'SIGKILL') ownedGroup = pid
      if (pid === ownedGroup && signal === 0 && !injected) {
        injected = true
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      }
      return originalKill.call(process, pid, signal)
    }
    const result = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 5000,
    })
    assert.equal(injected, true)
    assert.equal(result.outcome, 'unverified')
    assert.match(result.detail, /output exceeded bound/)
    assert.doesNotMatch(result.detail, /EPERM/)
  } finally {
    process.kill = originalKill
    process.env.PATH = previousPath
    if (ownedGroup) {
      try {
        originalKill.call(process, ownedGroup, 'SIGKILL')
      } catch {}
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('fails closed when process-group absence remains uncertain', async () => {
  if (process.platform === 'win32') return
  const fixture = runner(
    `process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'.repeat(65536)),1)`,
  )
  const previousPath = process.env.PATH
  const originalKill = process.kill
  let ownedGroup
  try {
    process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
    process.kill = function (pid, signal) {
      if (pid < 0 && signal === 'SIGKILL') ownedGroup = pid
      if (pid === ownedGroup && signal === 0)
        throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      return originalKill.call(process, pid, signal)
    }
    const result = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 5000,
    })
    assert.equal(result.outcome, 'unverified')
    assert.match(result.detail, /EPERM/)
    assert.doesNotMatch(result.detail, /output exceeded bound/)
  } finally {
    process.kill = originalKill
    process.env.PATH = previousPath
    if (ownedGroup) {
      try {
        originalKill.call(process, ownedGroup, 'SIGKILL')
      } catch {}
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('preserves process-group signal delivery errors after confirmed drain', async () => {
  if (process.platform === 'win32') return
  const fixture = runner(
    `process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'.repeat(65536)),1)`,
  )
  const previousPath = process.env.PATH
  const originalKill = process.kill
  let ownedGroup
  let injected = false
  try {
    process.env.PATH = `${fixture.directory}:${previousPath ?? ''}`
    process.kill = function (pid, signal) {
      if (pid < 0 && (signal === 'SIGTERM' || signal === 'SIGKILL')) ownedGroup = pid
      if (pid === ownedGroup && signal === 'SIGTERM' && !injected) {
        injected = true
        throw Object.assign(new Error('signal EPERM'), { code: 'EPERM' })
      }
      return originalKill.call(process, pid, signal)
    }
    const result = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 5000,
    })
    assert.equal(injected, true)
    assert.equal(result.outcome, 'unverified')
    assert.match(result.detail, /signal EPERM/)
  } finally {
    process.kill = originalKill
    process.env.PATH = previousPath
    if (ownedGroup) {
      try {
        originalKill.call(process, ownedGroup, 'SIGKILL')
      } catch {}
    }
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('drains descendants after normal runner exits before resolving', async () => {
  if (process.platform === 'win32') return
  const pidFile = join(tmpdir(), `holi-producer-normal-descendant-${process.pid}.txt`)
  const evidenceFile = join(tmpdir(), `holi-producer-normal-evidence-${process.pid}.txt`)
  const fixtureSource = (exitCode) => `
    const { spawn } = require('node:child_process')
    const fs = require('node:fs')
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'})
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
    fs.writeFileSync(${JSON.stringify(evidenceFile)}, process.env.PI_NATIVE_PROBE_EVIDENCE)
    ${exitCode === 0 ? `fs.writeFileSync(process.env.PI_NATIVE_PROBE_EVIDENCE, JSON.stringify({expectedVersion:process.env.PI_NATIVE_PROBE_VERSION,observedVersion:process.env.PI_NATIVE_PROBE_VERSION,package:'@earendil-works/pi-coding-agent',scenarios:{...Object.fromEntries(['streamCompletion','consecutiveTurns','modelError','cancel','noToolsRequest','appendSystemPrompt','statsResponse','steerAndFollowUp'].map(k=>[k,'pass'])),modelErrorReported:true},recordCount:5,commandCount:2,records:[{type:'agent_start'},{type:'agent_settled'},{type:'response',command:'set_model',success:true},{type:'response',command:'prompt',success:true},{type:'response',command:'get_session_stats',success:true}],commands:[{argv:['--no-tools'],noTools:true},{type:'abort'}],tools:[],cleanup:{piRunDrained:true,fixtureServerClosed:true,localRootRemoved:true}}))` : ''}
    process.exit(${exitCode})
  `
  const failingFixture = runner(fixtureSource(7))
  const passingFixture = runner(fixtureSource(0))
  const previousPath = process.env.PATH
  const descendantGone = async () => {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return true
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return false
  }
  try {
    process.env.PATH = `${failingFixture.directory}:${previousPath ?? ''}`
    const failure = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(failure.outcome, 'unverified')
    assert.equal(failure.stage, 'evidence')
    assert.equal(await descendantGone(), true)
    assert.equal(existsSync(readFileSync(evidenceFile, 'utf8')), false)

    process.env.PATH = `${passingFixture.directory}:${previousPath ?? ''}`
    const success = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(success.outcome, 'pass', success.detail)
    assert.equal(await descendantGone(), true)
    assert.equal(existsSync(readFileSync(evidenceFile, 'utf8')), false)
  } finally {
    process.env.PATH = previousPath
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL')
    } catch {}
    rmSync(pidFile, { force: true })
    rmSync(evidenceFile, { force: true })
    rmSync(failingFixture.directory, { recursive: true, force: true })
    rmSync(passingFixture.directory, { recursive: true, force: true })
  }
})

test('reports child failure and timeout as bounded results', async () => {
  const failing = runner(`process.stderr.write('x'.repeat(5000)); process.exit(7)`)
  const hanging = runner(`setTimeout(() => {}, 10_000)`)
  const flooding = runner(
    `process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('x'.repeat(65536)),1)`,
  )
  const previousPath = process.env.PATH
  try {
    process.env.PATH = `${failing.directory}:${previousPath ?? ''}`
    const failure = await checkPiRpcProducer({ bin: '/synthetic/pi', expectedVersion: '1.0.0' })
    assert.equal(failure.outcome, 'unverified')
    assert.equal(failure.stage, 'evidence')
    assert.ok(failure.detail.length <= 1100)
    process.env.PATH = `${hanging.directory}:${previousPath ?? ''}`
    const timeout = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 50,
    })
    assert.equal(timeout.outcome, 'unverified')
    assert.match(timeout.detail, /timed out/)
    assert.ok(timeout.detail.length <= 1100)
    process.env.PATH = `${flooding.directory}:${previousPath ?? ''}`
    const flood = await checkPiRpcProducer({
      bin: '/synthetic/pi',
      expectedVersion: '1.0.0',
      timeout: 5000,
    })
    assert.equal(flood.outcome, 'unverified')
    assert.match(flood.detail, /output exceeded bound/)
    assert.ok(flood.detail.length <= 1100)
  } finally {
    process.env.PATH = previousPath
    rmSync(failing.directory, { recursive: true, force: true })
    rmSync(hanging.directory, { recursive: true, force: true })
    rmSync(flooding.directory, { recursive: true, force: true })
  }
})
