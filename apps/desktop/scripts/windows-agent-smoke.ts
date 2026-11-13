import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { launchPlan, spawnProgram, execProgram } from '../src/main/launch'
import { resolveBin } from '../src/main/bin'
import { spawnOwnedProgram } from '../src/main/owned-process'
import { defaultSpawnPty } from '../src/main/terminal/pty'
import { createTerminals } from '../src/main/terminal/terminals'
import { AgentRuntime } from '../src/plugins/agent/main/host/pty'

const root = process.env.HOLI_QA372_ROOT!
const evidence = process.env.HOLI_QA372_EVIDENCE!
const desktop = process.env.HOLI_QA372_DESKTOP!
assert(root && evidence && desktop)
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
execFileSync('git', ['init', '--quiet', vault])

const checks: string[] = []
const active: AgentRuntime[] = []
let terminals: ReturnType<typeof createTerminals> | undefined
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
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const pidFile = join(vault, 'pids.json')
const argvFile = join(vault, 'argv.json')
const readPids = async () => JSON.parse(await readFile(pidFile, 'utf8')) as number[]

async function run() {
  await app.whenReady()
  window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  await window.loadURL('data:text/html,<h1>Holi native agent launch checks</h1>')
  const bin = join(root, 'Ada Lovelace ! percent %', 'bin')
  const packageDir = join(bin, 'node_modules', 'fixture')
  await mkdir(packageDir, { recursive: true })
  const script = join(packageDir, 'cli.js')
  await writeFile(
    script,
    `
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='--pty') {
 fs.writeFileSync(${JSON.stringify(argvFile)},JSON.stringify(args.slice(1)));
 const c=cp.spawn(process.execPath,['-e','setInterval(()=>0,1000)'],{stdio:'ignore',windowsHide:true,env:process.env});
 fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));
 process.stdout.write('READY\\n');
 let input=''; process.stdin.on('data',d=>{input+=d;let n;while((n=input.indexOf('\\n'))>=0){const line=input.slice(0,n).replace(/\\r/g,'');input=input.slice(n+1);process.stdout.write(line==='size'?'SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\n':'INPUT:'+line+'\\n')}});
} else { console.log(JSON.stringify(args)); }
`,
  )
  const shim = join(bin, 'claude.cmd')
  await writeFile(shim, await readFile(join(desktop, 'test/fixtures/npm-node-shim.cmd'), 'utf8'))
  const lookupEnv = { ...env, Path: bin, PATH: undefined }
  if (process.platform === 'win32') {
    assert.equal(resolveBin('claude', lookupEnv), shim)
    checks.push('Explorer Path/PATHEXT discovers actual npm shim')
  }
  // Force the same fallback inside a genuine Electron GUI parent, not Node masquerading as it.
  const launch = { platform: 'win32' as const, resolve: () => null }
  const plan = launchPlan(shim, args, { ...launch, env })
  assert.equal(plan.file, process.execPath)
  assert.equal(plan.env?.ELECTRON_RUN_AS_NODE, '1')
  const child = spawnProgram(
    shim,
    args,
    { cwd: vault, env, stdio: ['ignore', 'pipe', 'pipe'] },
    launch,
  )
  let stdout = '',
    stderr = ''
  child.stdout!.on('data', (d) => {
    stdout += d
  })
  child.stderr!.on('data', (d) => {
    stderr += d
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 0, stderr)
  assert.deepEqual(JSON.parse(stdout), args)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined)
  checks.push('GUI Electron parent launches npm JS with exact argv and child-only runtime flag')
  const result = await new Promise<string>((resolve, reject) =>
    execProgram(
      shim,
      args,
      { cwd: vault, env, timeoutMs: 10_000, maxBuffer: 100_000, encoding: 'utf8' },
      (err, out) => (err ? reject(err) : resolve(out)),
      launch,
    ),
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
  active.push(runtime)
  runtime.onData((data) => {
    output += data
  })
  runtime.start({ bin: shim, args: ['--pty', ...args], cwd: vault, env, cols: 100, rows: 30 })
  await until(() => output.includes('READY'))
  const pids = await readPids()
  assert.deepEqual(JSON.parse(await readFile(argvFile, 'utf8')), args)
  runtime.write('ping\r')
  await until(() => output.includes('INPUT:ping'))
  runtime.resize(113, 37)
  runtime.write('size\r')
  await until(() => output.includes('SIZE:113x37'))
  await runtime.kill()
  await until(() => pids.every((pid) => !alive(pid)))
  checks.push(
    `real ${process.platform === 'win32' ? 'ConPTY' : 'PTY'} exact argv, stdin/output, resize and AgentRuntime Stop terminate root and descendant`,
  )

  const managed = spawnOwnedProgram(plan.file, [script, '--pty'], {
    cwd: vault,
    env: { ...env, ...plan.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let managedOutput = ''
  managed.stdout!.on('data', (d) => {
    managedOutput += d
  })
  managed.stderr!.on('data', (d) => {
    output += d
  })
  const managedDone = new Promise((resolve, reject) => {
    managed.once('error', reject)
    managed.once('close', resolve)
  })
  managed.stdin!.write('ping\n')
  await until(() => managedOutput.includes('READY'))
  await until(() => managedOutput.includes('INPUT:ping'))
  const managedPids = await readPids()
  if (process.platform === 'win32') managed.kill()
  else process.kill(-managed.pid!, 'SIGKILL')
  await managedDone
  await until(() => managedPids.every((pid) => !alive(pid)))
  checks.push('managed process ownership stops its real descendant before completion')

  terminals = createTerminals({
    send() {},
    shell: () => process.execPath,
    baseEnv: () => env,
    integrationDir: () => null,
    gitSummary: async () => null,
    processCwd: async () => null,
    spawnPty: (_file, _args, opts) => ptySpawn(shim, ['--pty', ...args], opts),
  })
  const opened = terminals.create({ remote: 'qa/disposable', root: vault, cols: 100, rows: 30 })
  assert(opened.ok)
  await until(() => terminals!.replay('qa/disposable', opened.terminal.id).includes('READY'))
  const leavePids = await readPids()
  await terminals.closeRemote('qa/disposable')
  await until(() => leavePids.every((pid) => !alive(pid)))
  checks.push('vault leave closes real panel terminal and descendant')
  const quitting = terminals.create({ remote: 'qa/disposable', root: vault, cols: 100, rows: 30 })
  assert(quitting.ok)
  await until(() => terminals!.replay('qa/disposable', quitting.terminal.id).includes('READY'))
  const quitPids = await readPids()
  app.once('before-quit', (event) => {
    event.preventDefault()
    void (async () => {
      await terminals!.closeAll()
      await until(() => quitPids.every((pid) => !alive(pid)))
      checks.push('application quit closes real terminal tree')
      await writeFile(
        join(evidence, 'native-electron-results.json'),
        JSON.stringify(
          { ok: true, platform: process.platform, electron: process.versions.electron, checks },
          null,
          2,
        ),
      )
      console.log(JSON.stringify({ ok: true, checks }))
      app.exit(0)
    })().catch(fail)
  })
  app.quit()
}

async function fail(error: unknown) {
  console.error(error)
  await Promise.allSettled(active.map((runtime) => runtime.kill()))
  await terminals?.closeAll()
  await writeFile(
    join(evidence, 'native-electron-results.json'),
    JSON.stringify(
      { ok: false, checks, error: String(error), output: output.slice(-4000) },
      null,
      2,
    ),
  )
  app.exit(1)
}
void run().catch(fail)
