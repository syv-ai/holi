/* Temporary native Windows release lifecycle QA. Windows/Node 24 only. */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const http = require('node:http')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const { WebSocket } = globalThis
const run = promisify(execFile)

const root = path.resolve(__dirname, '../../..')
const app = path.join(root, 'apps/desktop')
const appRequire = createRequire(path.join(app, 'package.json'))
const yaml = appRequire('yaml')
const evidence = path.join(root, 'windows-release-qa-evidence')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'holi-windows-qa-'))
const port = 18769
const cdpPort = 9333
const identity = 'ai.syv.holi.windowsqa'
const checks = []
const timeout = {
  build: 900000,
  install: 240000,
  startup: 180000,
  update: 600000,
  quit: 90000,
  uninstall: 180000,
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function record(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(checks, null, 2))
  if (!ok) throw new Error(`${name}: ${detail}`)
}
function log(file, value) {
  fs.appendFileSync(path.join(evidence, file), `${new Date().toISOString()} ${value}\n`)
}
async function until(fn, description, ms = timeout.startup) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch (e) {
      last = String(e.message || e)
    }
    await wait(800)
  }
  throw new Error(`Timed out waiting for ${description}; last=${String(last).slice(0, 500)}`)
}
function ps(script, env = {}, ms = 120000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      env: { ...process.env, ...env },
      windowsHide: true,
      timeout: ms,
      maxBuffer: 8 * 1024 * 1024,
    },
  )
}
async function req(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    http
      .request(url, { method }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (part) => {
          body += part
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      .on('error', reject)
      .end()
  })
}
async function cdp(expression, ms = 30000) {
  if (typeof WebSocket !== 'function') throw new Error('Node 24 global WebSocket unavailable')
  const target = await until(
    async () => {
      const response = await req(`http://127.0.0.1:${cdpPort}/json`)
      if (response.status !== 200) return null
      return JSON.parse(response.body).find(
        (page) => page.type === 'page' && page.webSocketDebuggerUrl,
      )
    },
    'renderer CDP target',
    ms,
  )
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    const id = 1
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`CDP timeout: ${expression}`))
    }, ms)
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      ),
    )
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.close()
      if (message.error || message.result?.exceptionDetails)
        reject(new Error(JSON.stringify(message)))
      else resolve(message.result?.result?.value)
    })
    socket.addEventListener('error', (event) => {
      clearTimeout(timer)
      reject(new Error(`CDP websocket failure: ${event.message || 'unknown'}`))
    })
  })
}
async function screenshot(name) {
  const page = JSON.parse((await req(`http://127.0.0.1:${cdpPort}/json`)).body).find(
    (target) => target.type === 'page',
  )
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Screenshot timed out')), 30000)
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }),
      ),
    )
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id === 2) {
        clearTimeout(timer)
        socket.close()
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result.data)
      }
    })
    socket.addEventListener('error', reject)
  })
  fs.writeFileSync(path.join(evidence, name), Buffer.from(data, 'base64'))
}
async function trpc(route, type, input) {
  const operation = `{path:${JSON.stringify(route)},type:${JSON.stringify(type)}${input === undefined ? '' : `,input:${JSON.stringify(input)}`}}`
  const result = await cdp(`window.holi.trpc(${operation})`)
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean')
    throw new Error(`${route}: malformed IPC envelope`)
  if (!result.ok)
    throw new Error(`${route}: IPC ${result.code || 'error'}: ${result.message || 'unknown error'}`)
  return result.data
}
function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
      .on('error', reject)
  })
}
function writeQaEntry() {
  const output = path.join(app, 'out/main/qa-entry.cjs')
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(
    output,
    `
const fs=require('node:fs'); const path=require('node:path'); const {app}=require('electron');
const profile=process.env.HOLI_QA_PROFILE; if(!profile) throw Error('HOLI_QA_PROFILE required');
fs.mkdirSync(path.join(profile,'userData'),{recursive:true}); fs.mkdirSync(path.join(profile,'sessionData'),{recursive:true}); app.setPath('userData',path.join(profile,'userData')); app.setPath('sessionData',path.join(profile,'sessionData'));
app.commandLine.appendSwitch('remote-debugging-port',process.env.HOLI_QA_CDP_PORT);
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
const qaLog=process.env.HOLI_QA_EVIDENCE;
function emit(){ const entry={pid:process.pid,version:app.getVersion(),exe:process.execPath,userData:app.getPath('userData'),sessionData:app.getPath('sessionData'),profile}; fs.appendFileSync(path.join(qaLog,'startup.jsonl'),JSON.stringify(entry)+'\\n'); }
app.whenReady().then(()=>{emit(); setInterval(()=>{const quit=path.join(profile,'qa-quit'); if(fs.existsSync(quit)){fs.unlinkSync(quit); app.quit();}},250).unref();});
require('./index.js');\n`,
  )
}
async function packageVersion(version, output) {
  fs.mkdirSync(output, { recursive: true })
  const source = fs.readFileSync(path.join(app, 'electron-builder.yml'), 'utf8')
  const config = yaml.parse(source)
  config.appId = identity
  config.productName = 'Holi Windows QA'
  config.extraMetadata = {
    ...config.extraMetadata,
    version,
    productName: 'Holi Windows QA',
    name: 'holi-windows-qa',
    main: 'out/main/qa-entry.cjs',
  }
  config.directories = { ...config.directories, output }
  config.publish = [{ provider: 'generic', url: `http://127.0.0.1:${port}`, channel: 'dev' }]
  config.npmRebuild = false
  config.win = { ...config.win, target: [{ target: 'nsis', arch: ['x64'] }] }
  const configFile = path.join(tmp, `builder-${version}.json`)
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2))
  const pnpmCli = findPnpmCli()
  const result = await run(
    process.execPath,
    [
      pnpmCli,
      'exec',
      'electron-builder',
      '--win',
      'nsis',
      '--x64',
      '--publish',
      'never',
      '--config',
      configFile,
    ],
    {
      cwd: app,
      env: { ...process.env },
      windowsHide: true,
      timeout: timeout.build,
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  log('build.log', `${version} ${result.stdout.slice(-12000)} ${result.stderr.slice(-6000)}`)
  record(`${version} npmRebuild=false`, config.npmRebuild === false)
  record(
    `${version} provider generic loopback dev`,
    config.publish[0].provider === 'generic' &&
      config.publish[0].url === `http://127.0.0.1:${port}` &&
      config.publish[0].channel === 'dev',
  )
  const original = yaml.parse(source)
  const productionWin = { ...original.win }
  const qaWin = { ...config.win }
  delete productionWin.target
  delete qaWin.target
  record(
    `${version} preserve production signing policy`,
    JSON.stringify(qaWin) === JSON.stringify(productionWin),
    JSON.stringify(productionWin),
  )
  record(
    `${version} isolated QA app/cache identity`,
    config.appId === identity && config.productName === 'Holi Windows QA',
    `${config.appId}/${config.productName}`,
  )
}
function findPnpmCli() {
  const candidates = [process.env.npm_execpath]
  const stdout = require('node:child_process').execFileSync('where.exe', ['pnpm'], {
    encoding: 'utf8',
  })
  for (const shim of stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = shim.trim()
    candidates.push(path.join(path.dirname(normalized), '..', 'pnpm', 'bin', 'pnpm.cjs'))
    candidates.push(path.join(path.dirname(path.dirname(normalized)), 'pnpm', 'bin', 'pnpm.cjs'))
  }
  const cli = candidates
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(candidate) && candidate.toLowerCase().endsWith('.cjs'))
  if (!cli) throw new Error('Unable to resolve the installed pnpm JavaScript CLI')
  return cli
}
async function install(exe, extra = []) {
  await ps(
    '$ErrorActionPreference=\'Stop\'; $p=Start-Process -FilePath $env:HOLI_QA_INSTALLER -ArgumentList $env:HOLI_QA_INSTALL_ARGS -PassThru -Wait; if($p.ExitCode -ne 0){throw "installer exit $($p.ExitCode)"}',
    { HOLI_QA_INSTALLER: exe, HOLI_QA_INSTALL_ARGS: ['/S', '--force-run', ...extra].join(' ') },
    timeout.install,
  )
}
async function registryInfo() {
  const script =
    "$u=Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object {Get-ItemProperty $_.PSPath} | Where-Object {$_.DisplayName -eq 'Holi Windows QA'} | Select-Object -First 1; if($u){$u|ConvertTo-Json -Compress}"
  const { stdout } = await ps(script)
  return stdout.trim() ? JSON.parse(stdout.trim()) : null
}
async function assertInstalled(installedPath, version) {
  const exe = path.join(installedPath, 'Holi Windows QA.exe')
  record(`${version} default/custom install path`, fs.existsSync(exe), exe)
  const reg = await registryInfo()
  record(
    `${version} owned HKCU uninstall entry`,
    Boolean(
      reg &&
      reg.UninstallString &&
      reg.InstallLocation &&
      (version !== 'A' || reg.DisplayVersion === '0.7.1-dev.1'),
    ),
    JSON.stringify(
      reg && {
        DisplayName: reg.DisplayName,
        DisplayVersion: reg.DisplayVersion,
        InstallLocation: reg.InstallLocation,
      },
    ),
  )
  const shortcuts = await ps(
    "$paths=@([Environment]::GetFolderPath('Desktop'),(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')); Get-ChildItem $paths -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | Where-Object {$_.BaseName -eq 'Holi Windows QA'} | Select-Object -ExpandProperty FullName | ConvertTo-Json -Compress",
  )
  const links = shortcuts.stdout.trim() ? JSON.parse(shortcuts.stdout.trim()) : []
  const linkPaths = Array.isArray(links) ? links : links ? [links] : []
  const hasDesktop = linkPaths.some((item) => item.toLowerCase().includes('\\desktop\\'))
  const hasStartMenu = linkPaths.some((item) =>
    item.toLowerCase().includes('\\start menu\\programs\\'),
  )
  record(
    `${version} Desktop and Start Menu shortcuts`,
    hasDesktop && hasStartMenu,
    JSON.stringify(linkPaths),
  )
  const handler = await ps(
    "$key=Get-Item 'HKCU:\\Software\\Classes\\holi\\shell\\open\\command' -ErrorAction SilentlyContinue; if($key){$key.GetValue('')}",
  )
  record(
    `${version} holi protocol handler`,
    handler.stdout.includes('Holi Windows QA.exe'),
    handler.stdout.trim(),
  )
  return exe
}
function startServer(directory) {
  const requests = []
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, `http://127.0.0.1:${port}`).pathname
    const name = path.basename(decodeURIComponent(pathname))
    requests.push({
      method: request.method,
      url: request.url,
      range: request.headers.range || null,
      at: new Date().toISOString(),
    })
    log('http.log', `${request.method} ${request.url} range=${request.headers.range || '-'}`)
    const file = path.join(directory, name)
    if (!fs.existsSync(file)) {
      response.writeHead(404).end()
      return
    }
    const size = fs.statSync(file).size
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '')
    if (range) {
      const start = Number(range[1] || 0),
        end = Math.min(Number(range[2] || size - 1), size - 1)
      response.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      })
      if (request.method === 'HEAD') response.end()
      else fs.createReadStream(file, { start, end }).pipe(response)
      return
    }
    response.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' })
    if (request.method === 'HEAD') response.end()
    else fs.createReadStream(file).pipe(response)
  })
  return new Promise((resolve, reject) =>
    server.listen(port, '127.0.0.1', () => resolve({ server, requests })).on('error', reject),
  )
}
async function mainPid() {
  const entries = fs
    .readFileSync(path.join(evidence, 'startup.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line))
  return entries[entries.length - 1]
}
async function waitStartup(profile, version, exe) {
  return until(
    async () => {
      const entry = await mainPid()
      if (
        entry.profile !== profile ||
        entry.version !== version ||
        path.resolve(entry.exe).toLowerCase() !== path.resolve(exe).toLowerCase()
      )
        return null
      return entry
    },
    `main process ${version}`,
    timeout.startup,
  )
}
async function waitForExit(pid) {
  await until(
    async () => {
      const { stdout } = await ps(
        `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if(-not $p){'gone'}`,
      )
      return stdout.trim() === 'gone'
    },
    `process ${pid} quit`,
    timeout.quit,
  )
}
function makeVault(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'README.md'), 'Windows release QA disposable vault\n')
  fs.writeFileSync(path.join(rootDir, 'sentinel.txt'), 'vault-preserved')
  return run('git', ['init', '--quiet'], { cwd: rootDir })
    .then(() =>
      run('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'add', '.'], {
        cwd: rootDir,
      }),
    )
    .then(() =>
      run(
        'git',
        [
          '-c',
          'user.name=QA',
          '-c',
          'user.email=qa@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'fixture',
        ],
        { cwd: rootDir },
      ),
    )
}
async function nativePty(exe) {
  const dir = path.join(path.dirname(exe), 'resources/app.asar.unpacked/node_modules/node-pty')
  const moduleFile = path.join(dir, 'lib/index.js')
  record('packaged node-pty unpacked', fs.existsSync(moduleFile), moduleFile)
  const source =
    "const p=require(process.env.HOLI_QA_PTY);const x=p.spawn('cmd.exe',['/d','/s','/c','echo HOLI_QA_PTY_OK'],{name:'xterm-color',cols:80,rows:24,cwd:process.env.TEMP});let o='';x.onData(d=>o+=d);x.onExit(()=>{if(!o.includes('HOLI_QA_PTY_OK'))process.exit(2);console.log('PTY_OK')});setTimeout(()=>process.exit(3),15000).unref()"
  const { stdout } = await run(exe, ['-e', source], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOLI_QA_PTY: moduleFile },
    windowsHide: true,
    timeout: 60000,
  })
  record('installed Electron node-pty cmd echo', stdout.includes('PTY_OK'), stdout.trim())
}
async function unregisterForeignHandler() {
  const fake = path.join(tmp, 'foreign handler fixture.exe')
  fs.writeFileSync(fake, 'harmless test placeholder')
  await ps(
    "New-Item -Path 'HKCU:\\Software\\Classes\\holi\\shell\\open\\command' -Force | Out-Null; Set-Item -Path 'HKCU:\\Software\\Classes\\holi\\shell\\open\\command' -Value ('\"'+$env:HOLI_QA_FOREIGN+'\" \"%1\"'); Set-ItemProperty 'HKCU:\\Software\\Classes\\holi' -Name '(default)' -Value 'URL:Holi Protocol'; Set-ItemProperty 'HKCU:\\Software\\Classes\\holi' -Name 'URL Protocol' -Value ''",
    { HOLI_QA_FOREIGN: fake },
  )
  return fake
}
async function uninstall(exe, foreign = null) {
  const reg = await registryInfo()
  if (!reg || !reg.UninstallString) throw new Error('Cannot locate owned uninstall command')
  const uninstallPath = (reg.UninstallString.match(/^"([^"]+\.exe)"/) || [])[1]
  if (!uninstallPath || !fs.existsSync(uninstallPath))
    throw new Error(`Owned uninstaller missing: ${reg.UninstallString}`)
  const script =
    "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:HOLI_QA_UNINSTALLER -ArgumentList @('/S') -PassThru -Wait; if($p.ExitCode -ne 0){throw \"uninstaller exit $($p.ExitCode)\"}"
  await ps(script, { HOLI_QA_UNINSTALLER: uninstallPath }, timeout.uninstall)
  await until(
    async () => {
      const current = await registryInfo()
      const exists = fs.existsSync(exe)
      const command = await ps(
        "$key=Get-Item 'HKCU:\\Software\\Classes\\holi\\shell\\open\\command' -ErrorAction SilentlyContinue; if($key){$key.GetValue('')}",
      )
      const handler = command.stdout.trim()
      const shortcutCheck = await ps(
        "$paths=@([Environment]::GetFolderPath('Desktop'),(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs')); Get-ChildItem $paths -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | Where-Object {$_.BaseName -eq 'Holi Windows QA'} | Measure-Object | Select-Object -ExpandProperty Count",
      )
      const shortcutsRemain = Number(shortcutCheck.stdout.trim()) > 0
      const gone =
        !current &&
        !exists &&
        !shortcutsRemain &&
        (!handler || (foreign && handler.includes(foreign)))
      return gone
    },
    'uninstaller removes program/owned registrations but preserves foreign protocol',
    timeout.uninstall,
  )
  if (foreign) {
    const { stdout } = await ps(
      "$key=Get-Item 'HKCU:\\Software\\Classes\\holi\\shell\\open\\command' -ErrorAction SilentlyContinue; if($key){$key.GetValue('')}",
    )
    record('foreign holi handler preserved', stdout.includes(foreign), stdout.trim())
  }
}
async function lifecycle(pass, custom = false) {
  const profile = path.join(tmp, `profile-${pass}`)
  const vault = path.join(tmp, `vault-${pass}`)
  fs.mkdirSync(path.join(profile, 'sentinels'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'sentinels', 'profile.txt'), 'profile-preserved')
  await makeVault(vault)
  const exeA = path.join(evidence, 'Holi Windows QA-0.7.1-dev.1-win-x64.exe')
  const exeB = path.join(evidence, 'Holi Windows QA-0.7.1-dev.2-win-x64.exe')
  const installPath = custom
    ? path.join(tmp, 'custom install location with spaces')
    : path.join(process.env.LOCALAPPDATA, 'Programs', 'Holi Windows QA')
  const before = fs
    .readFileSync(path.join(evidence, 'startup.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean).length
  activeInstallPath = installPath
  process.env.HOLI_QA_PROFILE = profile
  process.env.HOLI_QA_EVIDENCE = evidence
  process.env.HOLI_QA_CDP_PORT = String(cdpPort)
  process.env.HOLI_VAULT_ROOT = vault
  await install(exeA, custom ? [`/D=${installPath}`] : [])
  const installedA = path.join(installPath, 'Holi Windows QA.exe')
  const startA = await until(
    async () => {
      const lines = fs.existsSync(path.join(evidence, 'startup.jsonl'))
        ? fs.readFileSync(path.join(evidence, 'startup.jsonl'), 'utf8').trim().split(/\r?\n/)
        : []
      if (lines.length <= before) return null
      const entry = JSON.parse(lines[lines.length - 1])
      return entry.version === '0.7.1-dev.1' && entry.profile === profile ? entry : null
    },
    'A install auto-start',
    timeout.startup,
  )
  record(
    'A launched naturally from installer',
    path.resolve(startA.exe).toLowerCase() === path.resolve(installedA).toLowerCase(),
    startA.exe,
  )
  record(
    'isolated userData/sessionData',
    startA.userData === path.join(profile, 'userData') &&
      startA.sessionData === path.join(profile, 'sessionData'),
    JSON.stringify({ userData: startA.userData, sessionData: startA.sessionData }),
  )
  const onboarding = await until(
    async () => {
      const value = await cdp(
        "JSON.stringify({text:document.body.innerText,dialog:!!document.querySelector('.onboarding-ritual,[data-testid=onboarding]')})",
      )
      const parsed = JSON.parse(value)
      return parsed.dialog ? parsed : null
    },
    'onboarding rendered with preload',
    timeout.startup,
  )
  record('onboarding visible', onboarding.dialog, onboarding.text.slice(0, 200))
  await assertInstalled(installPath, 'A')
  const auth = await trpc('auth.status', 'query')
  record('unauthenticated viewer null', auth.viewer === null, JSON.stringify(auth))
  const updateA = await trpc('updates.status', 'query')
  record(
    'A packaged updater supported/version/channel',
    updateA.supported === true && updateA.version === '0.7.1-dev.1' && updateA.channel === 'dev',
    JSON.stringify(updateA),
  )
  await screenshot(`pass-${pass}-A-onboarding.png`)
  fs.mkdirSync(path.join(profile, 'userData'), { recursive: true })
  fs.writeFileSync(path.join(profile, 'userData', 'QA-profile-sentinel.txt'), 'persisted')
  await nativePty(installedA)
  const updateYml = yaml.parse(fs.readFileSync(path.join(evidence, 'dev.yml'), 'utf8'))
  const feedSha = updateYml.files?.[0]?.sha512
  record(
    'B update feed generic local source and sha512',
    Boolean(feedSha) && updateYml.path === path.basename(exeB),
    JSON.stringify({ path: updateYml.path, sha512Present: Boolean(feedSha) }),
  )
  const installerSha = await sha512(exeB)
  record(
    'B installer SHA512 matches feed',
    installerSha === feedSha,
    `computed=${installerSha} feed=${feedSha}`,
  )
  const appUpdate = fs.readFileSync(path.join(installedA, 'resources/app-update.yml'), 'utf8')
  record(
    'installed app-update.yml generic feed and isolated cache identity',
    /provider:\s*generic/.test(appUpdate) &&
      appUpdate.includes(`http://127.0.0.1:${port}`) &&
      appUpdate.includes('dev') &&
      startA.userData === path.join(profile, 'userData') &&
      identity === 'ai.syv.holi.windowsqa',
    JSON.stringify({ appUpdate, appId: identity, userData: startA.userData }),
  )
  let updateState = await trpc('updates.check', 'mutation')
  if (updateState.state !== 'ready') {
    updateState = await until(
      async () => {
        const status = await trpc('updates.status', 'query')
        return ['available', 'ready'].includes(status.state) &&
          status.availableVersion === '0.7.1-dev.2'
          ? status
          : null
      },
      'B update discovered',
      timeout.update,
    )
  }
  const downloadResult =
    updateState.state === 'ready' ? updateState : await trpc('updates.download', 'mutation')
  const downloaded =
    downloadResult.state === 'ready'
      ? downloadResult
      : await until(
          async () => {
            const status = await trpc('updates.status', 'query')
            return status.state === 'ready' && status.availableVersion === '0.7.1-dev.2'
              ? status
              : null
          },
          'B downloaded and ready',
          timeout.update,
        )
  record(
    'B downloaded update ready',
    downloaded.availableVersion === '0.7.1-dev.2',
    JSON.stringify(downloaded),
  )
  record(
    'real HTTP update metadata and installer requests',
    requestsSeen.some((r) => r.url.includes('dev.yml')) &&
      requestsSeen.some((r) => decodeURIComponent(r.url).includes(path.basename(exeB))),
    JSON.stringify(requestsSeen.map((r) => r.url)),
  )
  const cache = yaml.parse(appUpdate).updaterCacheDirName
  record(
    'separate QA updater cache',
    typeof cache === 'string' && cache.includes('holi-windows-qa'),
    String(cache),
  )
  const pending = path.join(process.env.LOCALAPPDATA, cache, 'pending')
  const downloadedInstallers = fs.readdirSync(pending).filter((name) => name.endsWith('.exe'))
  record(
    'downloaded installer present',
    downloadedInstallers.length === 1,
    JSON.stringify(downloadedInstallers),
  )
  record(
    'downloaded installer SHA512 matches feed',
    (await sha512(path.join(pending, downloadedInstallers[0]))) === feedSha,
  )
  const previousPid = startA.pid
  const installStarted = Date.now()
  try {
    await trpc('updates.install', 'mutation')
  } catch (error) {
    log('lifecycle.log', `install RPC disconnected as expected: ${error.message}`)
  }
  const startB = await until(
    async () => {
      const entries = fs
        .readFileSync(path.join(evidence, 'startup.jsonl'), 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      return entries
        .reverse()
        .find(
          (entry) =>
            entry.version === '0.7.1-dev.2' &&
            entry.profile === profile &&
            entry.pid !== previousPid,
        )
    },
    'automatic native updater restart B process',
    timeout.update,
  )
  await waitForExit(previousPid)
  record(
    'B updater relaunch same executable and profile',
    path.resolve(startB.exe).toLowerCase() === path.resolve(installedA).toLowerCase() &&
      startB.userData === path.join(profile, 'userData'),
    JSON.stringify(startB),
  )
  const statusB = await until(
    async () => {
      const result = await trpc('updates.status', 'query')
      return result.version === '0.7.1-dev.2' ? result : null
    },
    'B update state after CDP reconnect',
    timeout.startup,
  )
  record(
    'B version and channel after relaunch',
    statusB.version === '0.7.1-dev.2' && statusB.channel === 'dev',
    JSON.stringify(statusB),
  )
  const onboardingB = await cdp(
    "!!document.querySelector('.onboarding-ritual,[data-testid=onboarding]')",
  )
  record('B onboarding rendered after reconnect', onboardingB === true)
  await screenshot(`pass-${pass}-B-onboarding.png`)
  record(
    'profile and vault sentinels survive update',
    fs.readFileSync(path.join(profile, 'userData', 'QA-profile-sentinel.txt'), 'utf8') ===
      'persisted' &&
      fs.readFileSync(path.join(profile, 'sentinels', 'profile.txt'), 'utf8') ===
        'profile-preserved' &&
      fs.readFileSync(path.join(vault, 'sentinel.txt'), 'utf8') === 'vault-preserved',
    `${Date.now() - installStarted}ms`,
  )
  const registryB = await registryInfo()
  record(
    'registry DisplayVersion is B',
    registryB?.DisplayVersion === '0.7.1-dev.2',
    JSON.stringify(
      registryB && {
        DisplayVersion: registryB.DisplayVersion,
        InstallLocation: registryB.InstallLocation,
      },
    ),
  )
  const foreign = custom ? await unregisterForeignHandler() : null
  const quitFile = path.join(profile, 'qa-quit')
  fs.writeFileSync(quitFile, 'quit')
  await waitForExit(startB.pid)
  record(
    'normal app quit completed before uninstall',
    true,
    'test-only sentinel invoked app.quit; PID exited',
  )
  await uninstall(installedA, foreign)
  record(
    'profile and vault remain after uninstall',
    fs.readFileSync(path.join(profile, 'userData', 'QA-profile-sentinel.txt'), 'utf8') ===
      'persisted' &&
      fs.readFileSync(path.join(profile, 'sentinels', 'profile.txt'), 'utf8') ===
        'profile-preserved' &&
      fs.readFileSync(path.join(vault, 'sentinel.txt'), 'utf8') === 'vault-preserved',
    `${profile}; ${vault}`,
  )
}
let requestsSeen = []
let activeInstallPath = null
async function main() {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Requires Windows and Node 24')
  if (typeof WebSocket !== 'function') throw new Error('Requires Node 24 global WebSocket')
  fs.mkdirSync(evidence, { recursive: true })
  for (const file of fs.readdirSync(evidence))
    fs.rmSync(path.join(evidence, file), { recursive: true, force: true })
  fs.writeFileSync(path.join(evidence, 'runner.log'), '')
  fs.writeFileSync(path.join(evidence, 'startup.jsonl'), '')
  const git = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
  writeQaEntry()
  const hashes = {}
  for (const file of [
    'apps/desktop/electron-builder.yml',
    'apps/desktop/build/installer.nsh',
    'apps/desktop/src/main/updates/state.ts',
    'apps/desktop/src/main/index.ts',
    'apps/desktop/src/main/updates/updater.ts',
    'apps/desktop/src/main/router.ts',
    'apps/desktop/src/preload/index.ts',
    'apps/desktop/scripts/windows-release-qa.cjs',
    '.github/workflows/preview.yml',
    'apps/desktop/out/main/qa-entry.cjs',
  ])
    hashes[file] = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(root, file)))
      .digest('hex')
  fs.writeFileSync(
    path.join(evidence, 'source.json'),
    JSON.stringify(
      {
        gitSha: git,
        node: process.version,
        platform: process.platform,
        createdAt: new Date().toISOString(),
        appId: identity,
        hashes,
      },
      null,
      2,
    ),
  )
  const one = path.join(tmp, 'build-a'),
    two = path.join(tmp, 'build-b')
  await packageVersion('0.7.1-dev.1', one)
  await packageVersion('0.7.1-dev.2', two)
  const installersA = fs.readdirSync(one).filter((file) => file.endsWith('.exe'))
  const installersB = fs.readdirSync(two).filter((file) => file.endsWith('.exe'))
  record(
    'two distinct NSIS installer artifacts',
    installersA.length === 1 &&
      installersB.length === 1 &&
      fs.statSync(path.join(one, installersA[0])).size !== 0 &&
      fs.statSync(path.join(two, installersB[0])).size !== 0,
    JSON.stringify({ installersA, installersB, identity }),
  )
  const nameA = 'Holi Windows QA-0.7.1-dev.1-win-x64.exe',
    nameB = 'Holi Windows QA-0.7.1-dev.2-win-x64.exe'
  fs.copyFileSync(path.join(one, installersA[0]), path.join(evidence, nameA))
  fs.copyFileSync(path.join(two, installersB[0]), path.join(evidence, nameB))
  for (const file of fs.readdirSync(two))
    if (/^(dev\.yml|Holi Windows QA-0\.7\.1-dev\.2-win-x64\.exe\.blockmap)$/.test(file))
      fs.copyFileSync(path.join(two, file), path.join(evidence, file))
  if (!fs.existsSync(path.join(evidence, 'dev.yml')))
    throw new Error('B generic provider metadata dev.yml missing')
  const { server, requests } = await startServer(evidence)
  requestsSeen = requests
  try {
    await lifecycle('default')
    await lifecycle('custom', true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  fs.writeFileSync(path.join(evidence, 'http-requests.json'), JSON.stringify(requests, null, 2))
  fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(checks, null, 2))
  fs.writeFileSync(
    path.join(evidence, 'result.json'),
    JSON.stringify({ success: true, assertions: checks.length }),
  )
  await ps(
    "Remove-Item 'HKCU:\\Software\\Classes\\holi' -Recurse -Force -ErrorAction SilentlyContinue",
  )
}
main()
  .catch((error) => {
    try {
      fs.mkdirSync(evidence, { recursive: true })
      fs.writeFileSync(path.join(evidence, 'failure.txt'), `${error.stack || error}\n`)
      fs.writeFileSync(path.join(evidence, 'assertions.json'), JSON.stringify(checks, null, 2))
    } catch {}
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    // Failure-only cleanup is allowed to force-kill QA-owned processes. A normal pass must exit naturally.
    if (process.exitCode) {
      try {
        await ps(
          "Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'Holi Windows QA.exe'} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}; $u=Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object {Get-ItemProperty $_.PSPath} | Where-Object {$_.DisplayName -eq 'Holi Windows QA'} | Select-Object -First 1; if($u -and $u.UninstallString -match '^\"([^\"]+\\.exe)\"'){if(Test-Path $Matches[1]){Start-Process -FilePath $Matches[1] -ArgumentList @('/S') -Wait}}; if($env:HOLI_QA_INSTALL_DIR -and (Test-Path $env:HOLI_QA_INSTALL_DIR)){Remove-Item -LiteralPath $env:HOLI_QA_INSTALL_DIR -Recurse -Force -ErrorAction SilentlyContinue}",
          { HOLI_QA_INSTALL_DIR: activeInstallPath || '' },
          60000,
        )
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })
