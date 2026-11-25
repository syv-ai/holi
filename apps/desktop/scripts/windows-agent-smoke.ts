import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ChildProcess, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { release } from 'node:os'
import { join, relative } from 'node:path'
import { finished } from 'node:stream/promises'
import { app, BrowserWindow } from 'electron'
import { launchPlan, spawnProgram, execProgram } from '../src/main/launch'
import { resolveBin } from '../src/main/bin'
import { spawnOwnedProgram } from '../src/main/owned-process'
import {
  joinOwnedProgram,
  UnconfirmedOwnedProgramError,
  type ManagedOwnedChild,
} from '../src/main/owned-program-lifetime'
import { killChildTree } from '../src/main/process-group'
import { defaultSpawnPty } from '../src/main/terminal/pty'
import { createTerminals } from '../src/main/terminal/terminals'
import { AgentRuntime } from '../src/plugins/agent/main/host/pty'
import { finalizeElectronSmoke } from './windows-agent-smoke-finalization'
import { launchOwnedWindowsPty } from '../src/main/owned-windows-pty'

const root = process.env.HOLI_QA372_ROOT!
const desktop = process.env.HOLI_QA372_DESKTOP!
const nativeNode = process.env.HOLI_QA372_NODE!
assert(root && desktop && nativeNode)
const profile = join(root, 'profile')
const vault = join(root, 'vault')
for (const dir of [profile, vault, join(root, 'session'), join(root, 'app-data')]) {
  mkdirSync(dir, { recursive: true })
}
app.setName('Holi Agent Launch QA 372')
app.setAppUserModelId('ai.syv.holi.review372')
app.setPath('appData', join(root, 'app-data'))
app.setPath('userData', profile)
app.setPath('sessionData', join(root, 'session'))
assert.equal(app.getPath('userData'), profile)
assert(!relative(root, vault).startsWith('..'))
execFileSync('git', ['init', '--quiet', vault], { timeout: 10_000 })

const checks: string[] = []
const cleanup: (() => Promise<unknown>)[] = []
const pendingPids = new Set<number[]>()
const phaseMs = 8_000
let output = ''
let window: BrowserWindow | undefined
const args = [
  'two words',
  '',
  '☃',
  'q"uote & > never.txt',
  '%PATH%',
  '!x!',
  'back\\',
  'one\r\ntwo',
  'x'.repeat(12_000),
]
const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
)
delete env.ELECTRON_RUN_AS_NODE
const until = async (ready: () => boolean | Promise<boolean>) => {
  const end = Date.now() + 15_000
  while (!(await ready())) {
    assert(Date.now() < end, 'Native handshake timed out: ' + output.slice(-1000))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
// Read-only smoke regression probe for fixture-reported PIDs. It is not a
// creation-identity witness, and a PID from this file is never used to signal.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function bounded<T>(label: string, action: () => T | Promise<T>, ms = phaseMs) {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out (${ms} ms)`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function watchExit(child: ChildProcess) {
  let exited = child.exitCode != null || child.signalCode != null
  const done = new Promise<void>((resolve) => {
    if (exited) return resolve()
    const settled = () => {
      exited = true
      resolve()
    }
    child.once('exit', settled)
    // A synthetic not-started child has no OS process and emits close, not exit.
    // Never substitute close for physical exit of a started helper.
    child.once('close', () => {
      if (child.pid === undefined) settled()
    })
  })
  return { done, live: () => !exited && child.pid !== undefined }
}

function trackManaged(child: ManagedOwnedChild) {
  const platform = process.platform
  // Observe from admission, before readiness, stdin writes, or a cleanup request.
  const joined = joinOwnedProgram(child, platform)
  const exit = watchExit(child)
  const outputs = [child.stdout, child.stderr].flatMap((stream, index) => {
    if (!stream) return []
    const done = finished(stream, { readable: true, writable: false, cleanup: true })
    void done.catch(() => undefined)
    return [{ stream, done, name: index === 0 ? 'stdout' : 'stderr' }]
  })
  let stopped: Promise<void> | undefined
  async function stopAndJoin() {
    const failures = new Set<unknown>()
    const attempt = async (label: string, action: () => unknown | Promise<unknown>) => {
      try {
        await bounded(label, action)
      } catch (error) {
        failures.add(error)
      }
    }
    try {
      await attempt('managed Stop', () => {
        if (platform === 'win32') {
          if (exit.live()) child.kill()
        } else if (exit.live())
          assert(killChildTree(child, 'SIGKILL', platform), 'group Stop failed')
      })
      await Promise.all([
        attempt('managed ownership receipt', async () => {
          if (platform !== 'win32') return
          assert(child.ownedCompletion, 'Windows managed child must expose ownership completion')
          try {
            assert.equal(await child.ownedCompletion, 'empty', 'managed launch must drain')
          } catch (error) {
            failures.add(error)
            if (error instanceof UnconfirmedOwnedProgramError && error.lease) {
              const { lease } = error
              await attempt('managed native lease revoke', () => lease.revoke())
            }
          }
        }),
        attempt('managed stable child exit', () => exit.done),
        ...outputs.map(({ name, done }) => attempt(`managed ${name} settlement`, () => done)),
        attempt('managed joined result', async () => {
          const result = await joined
          if (result.error) throw result.error
          if (platform === 'win32') assert.equal(result.ownership, 'empty')
        }),
      ])
      if (failures.size) {
        // Fallback is the exact ChildProcess handle only, never a looked-up root PID.
        await attempt('managed fallback exit', async () => {
          if (exit.live()) ChildProcess.prototype.kill.call(child, 'SIGKILL')
          await exit.done
        })
      }
    } finally {
      child.stdin?.destroy()
      for (const { stream } of outputs) stream.destroy()
    }
    if (failures.size) throw new AggregateError([...failures], 'managed fixture teardown failed')
  }
  const stop = () => (stopped ??= stopAndJoin())
  cleanup.push(stop)
  return stop
}
const pidFile = join(vault, 'pids.json')
const argvFile = join(vault, 'argv.json')
const readPids = async () => {
  const pids = JSON.parse(await readFile(pidFile, 'utf8')) as number[]
  assert(
    Array.isArray(pids) &&
      pids.length === 2 &&
      pids.every((pid) => Number.isInteger(pid) && pid > 1),
  )
  pendingPids.add(pids)
  return pids
}
async function checkPidsGone(pids: number[]) {
  await bounded('fixture PID liveness', () => until(() => pids.every((pid) => !alive(pid))), 16_000)
  pendingPids.delete(pids)
}

let ownedPtyProof:
  | {
      schema: 'holi.windows-pty.v1'
      pids: number[]
      order: string[]
      rootAbsentBeforeDrain: boolean
      descendantsAliveBeforeDrain: boolean
      nativeCompletionBeforeFinalization: boolean
      allAbsentAtFinalization: boolean
      cleanup: { allPidsAbsent: boolean }
    }
  | undefined

async function proveOwnedPtyFinalization() {
  const nonce = randomUUID()
  const ledger = join(root, `owned-pty-${nonce}.json`)
  const grandchildReady = join(root, `owned-pty-${nonce}.ready`)
  const childScript = join(root, `owned-pty-child-${nonce}.cjs`)
  const rootScript = join(root, `owned-pty-root-${nonce}.cjs`)
  await writeFile(
    childScript,
    `
const fs=require('node:fs'),cp=require('node:child_process');
const grandchild=cp.spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(grandchildReady)},String(process.pid),{flag:'wx'});setInterval(()=>{},1000)`)}],{detached:true,stdio:'ignore',windowsHide:true});
fs.writeFileSync(${JSON.stringify(ledger)}+'.tmp',JSON.stringify({child:process.pid,grandchild:grandchild.pid}),{flag:'wx'});
fs.renameSync(${JSON.stringify(ledger)}+'.tmp',${JSON.stringify(ledger)});
setInterval(()=>{},1000);
`,
    { flag: 'wx' },
  )
  await writeFile(
    rootScript,
    `
const fs=require('node:fs'),cp=require('node:child_process');
const child=cp.spawn(process.execPath,[${JSON.stringify(childScript)}],{detached:true,stdio:'ignore',windowsHide:true});child.unref();
process.stdin.setRawMode(true);process.stdin.resume();
let input='';process.stdin.on('data',d=>{input+=d.toString();if(input.includes('exit-root'))process.exit(0)});
const waiting=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(ledger)})||!fs.existsSync(${JSON.stringify(grandchildReady)}))return;
const p=JSON.parse(fs.readFileSync(${JSON.stringify(ledger)},'utf8'));
if(Number(fs.readFileSync(${JSON.stringify(grandchildReady)},'utf8'))!==p.grandchild)return;
clearInterval(waiting);process.stdout.write(${JSON.stringify(`OWNED_READY_${nonce}\n`)});},10);
`,
    { flag: 'wx' },
  )
  const order: string[] = []
  let pids: number[] | undefined
  let requestedExit = false
  let rootWitnessed = false
  let nativeCompleted = false
  let finalized = false
  const observedLaunch: typeof launchOwnedWindowsPty = (options) => {
    const launch = launchOwnedWindowsPty(options)
    void launch.completion.then(
      () => {
        nativeCompleted = true
        order.push('native-empty')
      },
      () => {},
    )
    return {
      ...launch,
      ready: launch.ready.then((pty) => ({
        ...pty,
        onExit: (callback) =>
          pty.onExit((event) => {
            if (requestedExit && !rootWitnessed) {
              assert(pids, 'Missing actual PTY descendant ledger')
              assert.equal(event.exitCode, 0)
              assert.equal(nativeCompleted, false, 'Native cleanup preceded the root-exit witness')
              assert.equal(alive(pids[0]!), false, 'PTY root is still alive')
              assert(pids.slice(1).every(alive), 'Detached descendants did not survive root exit')
              rootWitnessed = true
              order.push('root-exit')
            }
            callback(event)
          }),
      })),
    }
  }
  const runtime = new AgentRuntime({ launchWindowsPty: observedLaunch })
  cleanup.push(() => bounded('owned ConPTY native cleanup', () => runtime.kill(), 30_000))
  let text = ''
  runtime.onData((data) => {
    text += data
    output += data
  })
  runtime.onExit(() => {
    if (!requestedExit) return
    assert(pids && rootWitnessed, 'Finalization lacks a real root-exit witness')
    assert(nativeCompleted, 'Finalization preceded native Job completion')
    assert(
      pids.every((pid) => !alive(pid)),
      'Finalization has live native descendants',
    )
    order.push('finalized')
    finalized = true
  })
  runtime.start({ bin: nativeNode, args: [rootScript], cwd: vault, env, cols: 80, rows: 24 })
  await until(() => text.includes(`OWNED_READY_${nonce}`))
  const descendants = JSON.parse(await readFile(ledger, 'utf8')) as {
    child: number
    grandchild: number
  }
  assert(runtime.pid !== null)
  pids = [runtime.pid, descendants.child, descendants.grandchild]
  assert(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1))
  assert.equal(new Set(pids).size, 3)
  pendingPids.add(pids)
  assert(pids.every(alive), 'Owned PTY tree never reached live readiness')
  order.push('ready')
  requestedExit = true
  runtime.write('exit-root\r')
  await until(() => finalized)
  await bounded('owned ConPTY finalization join', () => runtime.kill(), 30_000)
  await checkPidsGone(pids)
  assert.deepEqual(order, ['ready', 'root-exit', 'native-empty', 'finalized'])
  assert.equal(runtime.isRunning, false)
  ownedPtyProof = {
    schema: 'holi.windows-pty.v1',
    pids,
    order,
    rootAbsentBeforeDrain: true,
    descendantsAliveBeforeDrain: true,
    nativeCompletionBeforeFinalization: true,
    allAbsentAtFinalization: true,
    cleanup: { allPidsAbsent: true },
  }
  checks.push(
    'native owned ConPTY finalization waits for detached child and grandchild Job drainage',
  )
}

async function run() {
  await bounded('Electron readiness', () => app.whenReady(), 15_000)
  assert.equal(app.isPackaged, false, 'This smoke runs dependency Electron, not the unpacked app')
  window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const gui = window
  await bounded('dependency Electron window load', () =>
    gui.loadURL('data:text/html,<h1>Holi native agent launch checks</h1>'),
  )
  const bin = join(root, 'Ada Lovelace ! percent %', 'bin')
  const packageDir = join(bin, 'node_modules', 'fixture')
  await mkdir(packageDir, { recursive: true })
  const script = join(packageDir, 'cli.js')
  const esmScript = join(packageDir, 'cli.mjs')
  const cliBody = join(packageDir, 'cli-body.cjs')
  const stateFile = join(root, 'terminal-state.json')
  await writeFile(
    cliBody,
    `
const fs=require('node:fs'),cp=require('node:child_process');
module.exports=function(){const args=process.argv.slice(2);
if(args[0]==='--pty') {
 if(process.platform==='win32'){
  const inherited=cp.spawnSync(${JSON.stringify(nativeNode)},['-e','process.stdout.write(String(!!process.stdin.isTTY))'],{stdio:['inherit','pipe','inherit'],windowsHide:true});
  if(inherited.status!==0 || inherited.stdout.toString()!==String(!!process.stdin.isTTY))throw new Error('child did not inherit the actual stdin descriptor');
 }
 fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify({input:!!process.stdin.isTTY,output:!!process.stdout.isTTY}));
 if(process.stdin.isTTY)process.stdin.setRawMode(true);
 fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(args.slice(1)));
 const c=cp.spawn(process.execPath,['-e','setInterval(()=>0,1000)'],{stdio:'ignore',windowsHide:true,env:process.env});
 fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));
 process.stdout.write('READY\\n');
 let input=''; process.stdin.on('data',d=>{input+=d.toString().replace(/\\r/g,'\\n');let n;while((n=input.indexOf('\\n'))>=0){const line=input.slice(0,n).replace(/\\r/g,'');input=input.slice(n+1);process.stdout.write(line==='size'?'SIZE:'+process.stdout.getWindowSize().join('x')+'\\n':'INPUT:'+line+'\\n')}});
} else { console.log(JSON.stringify(args)); }};
`,
  )
  await writeFile(
    script,
    "if(require.main!==module)throw new Error('not the CLI entrypoint');require('./cli-body.cjs')();",
  )
  await writeFile(
    esmScript,
    "import { createRequire } from 'node:module';if(!import.meta.main)throw new Error('not the CLI entrypoint');await Promise.resolve();createRequire(import.meta.url)('./cli-body.cjs')();",
  )
  const shim = join(bin, 'claude.cmd')
  const shimContents = await readFile(join(desktop, 'test/fixtures/npm-node-shim.cmd'), 'utf8')
  await writeFile(shim, shimContents)
  const esmShim = join(bin, 'claude-esm.cmd')
  await writeFile(esmShim, shimContents.replaceAll('cli.js', 'cli.mjs'))
  const lookupEnv = { ...env, Path: bin, PATH: undefined }
  if (process.platform === 'win32') {
    assert.equal(resolveBin('claude', lookupEnv), shim)
    checks.push('Explorer Path/PATHEXT discovers actual npm shim')
  }
  // Force the same fallback inside a genuine Electron GUI parent, not Node masquerading as it.
  const launch = {
    platform: 'win32' as const,
    resolve: () => null,
    ...(process.platform !== 'win32' ? { bundledWindowsNode: () => process.execPath } : {}),
  }
  const plan = launchPlan(shim, args, { ...launch, env })
  if (process.platform === 'win32') {
    assert.notEqual(plan.file, process.execPath)
    assert.match(plan.file, /node-win-x64[\\/]bin[\\/]node\.exe$/i)
    assert.equal(plan.env?.ELECTRON_RUN_AS_NODE, undefined)
  } else {
    assert.equal(plan.file, process.execPath)
    assert.equal(plan.env?.ELECTRON_RUN_AS_NODE, '1')
  }
  const program = process.platform === 'win32' ? shim : plan.file
  const programArgs = process.platform === 'win32' ? args : plan.args
  const programEnv = { ...env, ...plan.env }
  const execution = process.platform === 'win32' ? launch : {}
  const child = spawnProgram(
    program,
    programArgs,
    { cwd: vault, env: programEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    execution,
  )
  let stdout = '',
    stderr = ''
  child.stdout!.on('data', (d) => {
    stdout += d
  })
  child.stderr!.on('data', (d) => {
    stderr += d
  })
  const childExit = watchExit(child)
  const childClose = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  cleanup.push(async () => {
    if (childExit.live()) child.kill('SIGKILL')
    try {
      await bounded('direct argv fixture exit', () => childExit.done)
    } finally {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
  })
  const code = await bounded('direct argv fixture completion', () => childClose)
  assert.equal(code, 0, stderr)
  assert.deepEqual(JSON.parse(stdout), args)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined)
  checks.push(
    process.platform === 'win32'
      ? 'GUI Electron parent selects bundled genuine Node with exact argv and no Electron runtime flag'
      : 'GUI Electron parent launches npm JS with exact argv and child-only runtime flag',
  )
  const result = await bounded(
    'execProgram callback',
    () =>
      new Promise<string>((resolve, reject) => {
        const executed: ManagedOwnedChild = execProgram(
          program,
          programArgs,
          { cwd: vault, env: programEnv, timeoutMs: 10_000, maxBuffer: 100_000, encoding: 'utf8' },
          (err, out) => (err ? reject(err) : resolve(out)),
          execution,
        )
        if (process.platform === 'win32' && executed.ownedCompletion) trackManaged(executed)
      }),
    30_000,
  )
  assert.deepEqual(JSON.parse(result), args)
  checks.push('execProgram preserves Unicode, empty, hostile, multiline and 12KiB arguments')

  const ptySpawn: typeof defaultSpawnPty =
    process.platform === 'win32'
      ? defaultSpawnPty
      : (file, argv, opts) => {
          const planned = launchPlan(file, argv, { ...launch, env: opts.env })
          return defaultSpawnPty(planned.file, planned.args, {
            ...opts,
            env: { ...opts.env, ...planned.env } as Record<string, string>,
          })
        }
  const runtime = new AgentRuntime({ spawnPty: ptySpawn })
  cleanup.push(() => bounded('AgentRuntime Stop', () => runtime.kill()))
  runtime.onData((data) => {
    output += data
  })
  runtime.start({ bin: shim, args: ['--pty', ...args], cwd: vault, env, cols: 100, rows: 30 })
  await until(() => output.includes('READY'))
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { input: true, output: true })
  const pids = await readPids()
  assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), args)
  runtime.write('ping\r')
  await until(() => output.includes('INPUT:ping'))
  runtime.resize(113, 37)
  await until(() => {
    if (output.includes('SIZE:113x37')) return true
    runtime.write('size\r')
    return false
  })
  await bounded('AgentRuntime Stop', () => runtime.kill())
  await checkPidsGone(pids)
  checks.push(
    `real ${process.platform === 'win32' ? 'ConPTY' : 'PTY'} exact argv, stdin/output, resize and AgentRuntime Stop terminate root and descendant`,
  )

  if (process.platform === 'win32') {
    const fallbackEnv: Record<string, string> = {
      ...env,
      ProgramFiles: root,
      USERPROFILE: root,
      HOME: root,
      APPDATA: root,
      LOCALAPPDATA: root,
    }
    for (const key of Object.keys(fallbackEnv))
      if (key.toUpperCase() === 'PATH') delete fallbackEnv[key]
    fallbackEnv.Path = root
    const packagedNode = process.env.HOLI_QA372_PACKAGED_NODE
    const runtimeCases = [
      { bin: shim, args: ['--pty', ...args], name: 'bundled Node CommonJS' },
      { bin: esmShim, args: ['--pty', ...args], name: 'bundled Node ESM with top-level await' },
      ...(packagedNode
        ? [
            {
              bin: packagedNode,
              args: [script, '--pty', ...args],
              name: 'unpacked-app Node CommonJS under dependency Electron',
            },
            {
              bin: packagedNode,
              args: [esmScript, '--pty', ...args],
              name: 'unpacked-app Node ESM with top-level await under dependency Electron',
            },
          ]
        : []),
    ]
    for (const { bin: runtimeBin, args: runtimeArgs, name: entryName } of runtimeCases) {
      if (runtimeBin === shim || runtimeBin === esmShim) {
        const fallbackPlan = launchPlan(runtimeBin, [], { env: fallbackEnv })
        assert.notEqual(fallbackPlan.file, process.execPath)
        assert.match(fallbackPlan.file, /node-win-x64[\\/]bin[\\/]node\.exe$/i)
        assert.equal(fallbackPlan.env?.ELECTRON_RUN_AS_NODE, undefined)
      }
      const fallbackRuntime = new AgentRuntime()
      cleanup.push(() => bounded('fallback AgentRuntime Stop', () => fallbackRuntime.kill()))
      let fallbackOutput = ''
      fallbackRuntime.onData((data) => {
        fallbackOutput += data
        output += data
      })
      fallbackRuntime.start({
        bin: runtimeBin,
        args: runtimeArgs,
        cwd: vault,
        env: fallbackEnv,
        cols: 100,
        rows: 30,
      })
      await until(() => fallbackOutput.includes('READY'))
      assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), args)
      assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { input: true, output: true })
      const fallbackPids = await readPids()
      fallbackRuntime.write('ping\r')
      await until(() => fallbackOutput.includes('INPUT:ping'))
      fallbackRuntime.resize(113, 37)
      await until(() => {
        if (fallbackOutput.includes('SIZE:113x37')) return true
        fallbackRuntime.write('size\r')
        return false
      })
      await bounded('fallback AgentRuntime Stop', () => fallbackRuntime.kill())
      await checkPidsGone(fallbackPids)
      checks.push(
        `${entryName} preserves argv, entry semantics and inherited stdin, responds to input, resizes and stops its full ConPTY tree`,
      )
    }
  }

  if (process.platform === 'win32') await proveOwnedPtyFinalization()

  const managed = spawnOwnedProgram(plan.file, [script, '--pty'], {
    cwd: vault,
    env: { ...env, ...plan.env },
    stdio: 'pipe',
  })
  const stopManaged = trackManaged(managed)
  let managedOutput = ''
  managed.stdout!.on('data', (d) => {
    managedOutput += d
  })
  managed.stderr!.on('data', (d) => {
    output += d
  })
  managed.stdin!.write('ping\n')
  await until(() => managedOutput.includes('READY'))
  const managedPids = await readPids()
  await until(() => managedOutput.includes('INPUT:ping'))
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), { input: false, output: false })
  await stopManaged()
  await checkPidsGone(managedPids)
  checks.push('managed Stop, ownership join, output and exit, and fixture PID liveness regression')

  const panel = createTerminals({
    send() {},
    shell: () => process.execPath,
    baseEnv: () => env,
    integrationDir: () => null,
    gitSummary: async () => null,
    processCwd: async () => null,
    spawnPty: (_file, _args, opts) => ptySpawn(shim, ['--pty', ...args], opts),
  })
  cleanup.push(() => bounded('panel terminal cleanup', () => panel.closeAll()))
  const opened = panel.create({ remote: 'qa/disposable', root: vault, cols: 100, rows: 30 })
  assert(opened.ok)
  await until(() => panel.replay('qa/disposable', opened.terminal.id).includes('READY'))
  const leavePids = await readPids()
  await bounded('vault leave terminal cleanup', () => panel.closeRemote('qa/disposable'))
  await checkPidsGone(leavePids)
  checks.push('vault leave closes real panel terminal and descendant')
  const quitting = panel.create({ remote: 'qa/disposable', root: vault, cols: 100, rows: 30 })
  assert(quitting.ok)
  await until(() => panel.replay('qa/disposable', quitting.terminal.id).includes('READY'))
  const quitPids = await readPids()
  const beforeQuit = new Promise<void>((resolve) => {
    app.once('before-quit', (event) => {
      event.preventDefault()
      resolve()
    })
  })
  app.quit()
  await bounded('application before-quit', () => beforeQuit)
  await bounded('application quit terminal cleanup', () => panel.closeAll())
  await checkPidsGone(quitPids)
  checks.push('application quit closes real terminal tree')
}

async function main() {
  await finalizeElectronSmoke({
    reportPath: join(root, 'smoke-result.json'),
    run: async () => {
      await run()
      return {
        ok: true,
        runtime: 'dependency-electron',
        platform: process.platform,
        platformVersion: release(),
        electron: process.versions.electron,
        checks,
        ...(ownedPtyProof ? { ownedPty: ownedPtyProof } : {}),
      }
    },
    cleanup: async () => {
      const results = await Promise.allSettled(cleanup.map((stop) => Promise.resolve().then(stop)))
      // Only probe known fixture PIDs, never signal rediscovered processes.
      const probes = await Promise.allSettled([...pendingPids].map(checkPidsGone))
      const failures = [...results, ...probes].flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length) throw new AggregateError(failures, 'Smoke fixture cleanup failed')
    },
    closeWindow: () => window?.destroy(),
    exit: (code) => app.exit(code),
  })
}
void main().catch((error) => {
  console.error(error)
  app.exit(1)
})
