/* Temporary PR #369 Windows release lifecycle harness. Windows/Node 24 only. */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const http = require('node:http')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { WebSocket } = require('node:ws')
const run = promisify(execFile)

const root = path.resolve(__dirname, '../../..')
const app = path.join(root, 'apps/desktop')
const evidence = path.join(root, 'windows-release-qa-evidence')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holi-windows-qa-'))
const port = 18769
const cdpPort = 9333
const baseIdentity = 'ai.syv.holi.windowsqa'
const checks = []
const processes = new Set()
const log = (file, value) =>
  fs.appendFileSync(path.join(evidence, file), `${new Date().toISOString()} ${value}\n`)
function assert(ok, name, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) throw Error(`${name}: ${detail}`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, description, timeout = 120000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch {}
    await wait(1000)
  }
  throw Error(`Timed out waiting for ${description}; last=${JSON.stringify(last)}`)
}
async function ps(script, args = []) {
  return run(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script, ...args],
    { windowsHide: true, timeout: 120000 },
  )
}
function reqCdp(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    http
      .request(url, { method }, (r) => {
        let body = ''
        r.setEncoding('utf8')
        r.on('data', (x) => (body += x))
        r.on('end', () => resolve({ status: r.statusCode, body }))
      })
      .on('error', reject)
      .end()
  })
}
async function cdp(expression, timeout = 30000) {
  const target = await until(
    async () => {
      const { status, body } = await reqCdp(`http://127.0.0.1:${cdpPort}/json`)
      if (status !== 200) return
      const pages = JSON.parse(body)
      return pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)
    },
    'renderer CDP target',
    timeout,
  )
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const id = 1
    const timer = setTimeout(() => {
      ws.close()
      reject(Error(`CDP timeout: ${expression}`))
    }, timeout)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      ),
    )
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== id) return
      clearTimeout(timer)
      ws.close()
      if (msg.error || msg.result?.exceptionDetails) reject(Error(JSON.stringify(msg)))
      else resolve(msg.result?.result?.value)
    })
    ws.on('error', reject)
  })
}
async function trpc(route, type, input) {
  return cdp(
    `window.holi.trpc({path:${JSON.stringify(route)},type:${JSON.stringify(type)}${input === undefined ? '' : `,input:${JSON.stringify(input)}`}}).then(r=>r.data ?? r)`,
  )
}
function sha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512')
    fs.createReadStream(file)
      .on('data', (x) => h.update(x))
      .on('end', () => resolve(h.digest('base64')))
      .on('error', reject)
  })
}
function startServer(dir) {
  const requests = []
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname)
    const file = path.join(dir, name)
    requests.push({
      method: req.method,
      url: req.url,
      range: req.headers.range || null,
      at: new Date().toISOString(),
    })
    log('http.log', `${req.method} ${req.url} range=${req.headers.range || '-'}`)
    if (!fs.existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    const size = fs.statSync(file).size
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (range) {
      const start = Number(range[1] || 0),
        end = Math.min(Number(range[2] || size - 1), size - 1)
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      })
      if (req.method === 'HEAD') res.end()
      else fs.createReadStream(file, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    if (req.method === 'HEAD') res.end()
    else fs.createReadStream(file).pipe(res)
  })
  return new Promise((resolve, reject) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, requests })).on('error', reject),
  )
}
function writeQaEntry() {
  const file = path.join(app, 'out/main/qa-entry.cjs')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `const {app}=require('electron'); const path=require('node:path'); const root=process.env.HOLI_QA_PROFILE; app.setPath('userData',path.join(root,'userData')); app.setPath('sessionData',path.join(root,'sessionData')); app.commandLine.appendSwitch('remote-debugging-port','${cdpPort}'); app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1'); require('./index.js');`,
  )
}
async function packageVersion(version, dir) {
  fs.mkdirSync(dir, { recursive: true })
  const config = path.join(tmp, `builder-${version}.json`)
  const yml = fs.readFileSync(path.join(app, 'electron-builder.yml'), 'utf8')
  const publish = `publish:\n  provider: generic\n  url: http://127.0.0.1:${port}\n  channel: dev`
  const replaced = yml.replace(/publish:\n(?:  .*\n)+/, publish + '\n')
  if (replaced === yml) throw Error('Unable to replace electron-builder publish config')
  const y = require('yaml')
  const configObject = y.parse(replaced)
  Object.assign(configObject, {
    appId: baseIdentity,
    productName: 'Holi Windows QA',
    extraMetadata: {
      ...configObject.extraMetadata,
      version,
      productName: 'Holi Windows QA',
      name: 'holi-windows-qa',
      main: 'out/main/qa-entry.cjs',
    },
    directories: { ...configObject.directories, output: dir },
  })
  configObject.publish = [{ provider: 'generic', url: `http://127.0.0.1:${port}`, channel: 'dev' }]
  configObject.npmRebuild = false
  fs.writeFileSync(config, JSON.stringify(configObject, null, 2))
  await run(
    'pnpm',
    [
      'exec',
      'electron-builder',
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      '--config',
      config,
    ],
    {
      cwd: app,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20,
    },
  )
}
async function install(exe, args = []) {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$p=Start-Process -FilePath $args[0] -ArgumentList @('/S','--force-run', ...$args[1..($args.Count-1)]) -PassThru -Wait; if($p.ExitCode -ne 0){throw "installer exit $($p.ExitCode)"}`,
      exe,
      ...args,
    ],
    { windowsHide: true, timeout: 240000 },
  )
  return stdout
}
async function appMeta() {
  return cdp(
    `JSON.stringify({version:document.querySelector('[data-testid="onboarding"]')?.innerText || document.body.innerText.slice(0,500), title:document.title})`,
  )
}
async function screenshot(name) {
  const target = await reqCdp(`http://127.0.0.1:${cdpPort}/json`)
  const page = JSON.parse(target.body).find((x) => x.type === 'page')
  const result = await new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }),
      ),
    )
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id === 1) {
        ws.close()
        resolve(m.result.data)
      }
    })
    ws.on('error', reject)
  })
  fs.writeFileSync(path.join(evidence, name), Buffer.from(result, 'base64'))
}
async function lifecycle(pass, custom = false) {
  const profile = path.join(tmp, `profile-${pass}`)
  process.env.HOLI_QA_PROFILE = profile
  fs.mkdirSync(path.join(profile, 'sentinels'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'sentinels', 'profile.txt'), 'profile-preserved')
  const exeA = path.join(evidence, 'Holi Windows QA-0.7.1-dev.1-win-x64.exe')
  const exeB = path.join(evidence, 'Holi Windows QA-0.7.1-dev.2-win-x64.exe')
  const installDir = custom
    ? path.join(tmp, 'custom install location')
    : path.join(process.env.LOCALAPPDATA, 'Programs', 'Holi Windows QA')
  await install(exeA, custom ? ['/D=' + installDir] : [])
  assert(
    fs.existsSync(path.join(installDir, 'Holi Windows QA.exe')),
    'installed executable exists',
    installDir,
  )
  const appExe = path.join(installDir, 'Holi Windows QA.exe')
  const first = await until(async () => {
    try {
      return await cdp('JSON.stringify({pid:process.pid})', 3000)
    } catch {
      return null
    }
  }, 'A installer auto-start')
  assert(Boolean(first), 'A auto-start')
  const status = await trpc('updates.status', 'query')
  assert(status.supported === true, 'packaged updater supported')
  assert(status.version === '0.7.1-dev.1', 'A runtime version', JSON.stringify(status))
  assert(status.channel === 'dev', 'default dev channel')
  assert(status.account === undefined, 'no account leak')
  await screenshot(`pass-${pass}-A-onboarding.png`)
  fs.writeFileSync(path.join(profile, 'userData', 'QA-profile-sentinel.txt'), 'persisted')
  await trpc('updates.check', 'mutation')
  const ready = await until(
    async () => {
      const s = await trpc('updates.status', 'query')
      return s.state === 'ready' && s.availableVersion === '0.7.1-dev.2' ? s : null
    },
    'B update ready',
    600000,
  )
  assert(ready.availableVersion === '0.7.1-dev.2', 'B ready')
  await trpc('updates.install', 'mutation')
  const upgraded = await until(
    async () => {
      try {
        const s = await trpc('updates.status', 'query')
        return s.version === '0.7.1-dev.2' ? s : null
      } catch {
        return null
      }
    },
    'automatic updater relaunch B',
    300000,
  )
  assert(upgraded.version === '0.7.1-dev.2', 'B updater relaunch')
  assert(
    fs.existsSync(path.join(profile, 'userData', 'QA-profile-sentinel.txt')),
    'profile retained',
  )
  assert(
    fs.readFileSync(path.join(profile, 'sentinels', 'profile.txt'), 'utf8') === 'profile-preserved',
    'vault/profile data retained',
  )
  log('lifecycle.log', `${pass} B ready ${JSON.stringify(upgraded)}`)
}
async function main() {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24)
    throw Error('Requires Windows and Node 24')
  fs.mkdirSync(evidence, { recursive: true })
  fs.writeFileSync(path.join(evidence, 'runner.log'), '')
  const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  const sourceFiles = [
    'apps/desktop/electron-builder.yml',
    'apps/desktop/src/main/index.ts',
    'apps/desktop/src/main/updates/updater.ts',
    'apps/desktop/src/main/router.ts',
    'apps/desktop/src/preload/index.ts',
  ]
  const hashes = Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex'),
    ]),
  )
  fs.writeFileSync(
    path.join(evidence, 'source.json'),
    JSON.stringify(
      {
        gitSha: sha,
        node: process.version,
        platform: process.platform,
        createdAt: new Date().toISOString(),
        hashes,
      },
      null,
      2,
    ),
  )
  writeQaEntry()
  const one = path.join(tmp, 'build-a'),
    two = path.join(tmp, 'build-b')
  await packageVersion('0.7.1-dev.1', one)
  await packageVersion('0.7.1-dev.2', two)
  const files = fs.readdirSync(one).filter((f) => f.endsWith('.exe'))
  const filesB = fs.readdirSync(two).filter((f) => f.endsWith('.exe'))
  if (files.length !== 1 || filesB.length !== 1)
    throw Error('Expected one NSIS installer per build')
  fs.copyFileSync(
    path.join(one, files[0]),
    path.join(evidence, 'Holi Windows QA-0.7.1-dev.1-win-x64.exe'),
  )
  fs.copyFileSync(
    path.join(two, filesB[0]),
    path.join(evidence, 'Holi Windows QA-0.7.1-dev.2-win-x64.exe'),
  )
  for (const f of fs.readdirSync(two))
    if (/^(dev\.yml|Holi Windows QA-0\.7\.1-dev\.2-win-x64\.exe\.blockmap)$/.test(f))
      fs.copyFileSync(path.join(two, f), path.join(evidence, f))
  const update = fs.readFileSync(path.join(two, 'dev.yml'), 'utf8')
  fs.writeFileSync(path.join(evidence, 'dev.yml'), update)
  const server = await startServer(evidence)
  try {
    await lifecycle('default')
  } finally {
    server.server.close()
  }
  fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(checks, null, 2))
}
main()
  .catch((err) => {
    try {
      fs.mkdirSync(evidence, { recursive: true })
      fs.writeFileSync(path.join(evidence, 'failure.txt'), err.stack || String(err))
      fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(checks, null, 2))
    } catch {}
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })
