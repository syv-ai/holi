import { app, BrowserWindow, ipcMain, session } from 'electron'
import { spawn, type IPty } from 'node-pty'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.HOLI_518_ROOT!
const evidence = process.env.HOLI_518_EVIDENCE!
for (const dir of ['profile', 'session', 'home', 'zsh', 'vault'])
  mkdirSync(join(root, dir), { recursive: true })
app.setName('Holi Native Terminal Hints 518')
app.setPath('appData', join(root, 'app-data'))
app.setPath('userData', join(root, 'profile'))
app.setPath('sessionData', join(root, 'session'))
const live = new Set<BrowserWindow>()
const pty = new Map<string, IPty>()
const ptyInput: string[] = []
const outputs = new Map<string, string>()
const exits = new Map<string, number>()
const exitCodes: number[] = []
let fixtureProof = ''
let processExited = false
let terminalExitCode: number | null = null
let web: BrowserWindow | undefined
const send = (channel: string, value: unknown) => {
  for (const window of live) if (!window.isDestroyed()) window.webContents.send(channel, value)
}

async function run() {
  await app.whenReady()
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  )
  ses.on('will-download', (_event, item) => item.cancel())
  const window = new BrowserWindow({
    width: 640,
    height: 460,
    show: true,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  web = window
  live.add(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })
  window.webContents.on('console-message', (_event, level, message) => {
    console.log(`renderer[${level}] ${message}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`load failed ${code} ${description} ${url}`)
  })
  window.webContents.on('render-process-gone', (_event, detail) => {
    writeFileSync(join(evidence, 'renderer-gone.txt'), JSON.stringify(detail))
  })
  await window.loadFile(join(root, 'renderer', 'scripts', 'terminal-hints-native-smoke.html'))
  window.show()
  window.webContents.send('holi-smoke:start')
}

ipcMain.handle(
  'holi-smoke:trpc',
  (
    _event,
    op: { path: string; input?: { data?: string; cols?: number; rows?: number; remote?: string } },
  ) => {
    switch (op.path) {
      case 'terminal.list':
        return {
          ok: true,
          data:
            op.input?.remote === 'native-smoke'
              ? [...new Set([...pty.keys(), ...exits.keys()])].map((id) => ({
                  id,
                  title: id === 'native-shell' ? 'native smoke shell' : 'second live shell',
                  context: null,
                  exitCode: exits.get(id) ?? null,
                }))
              : [],
        }
      case 'terminal.create': {
        let id = 'native-shell'
        if (pty.has(id) || exits.has(id)) {
          let suffix = 2
          while (pty.has(`native-shell-${suffix}`) || exits.has(`native-shell-${suffix}`)) suffix++
          id = `native-shell-${suffix}`
        }
        spawnTerminal(id)
        return {
          ok: true,
          data: {
            ok: true,
            terminal: {
              id,
              title: id === 'native-shell' ? 'native smoke shell' : 'second live shell',
              context: null,
              exitCode: null,
            },
          },
        }
      }
      case 'terminal.kill': {
        const id = (op.input as { id?: string } | undefined)?.id
        const term = id ? pty.get(id) : undefined
        term?.kill()
        return { ok: true, data: null }
      }
      case 'terminal.replay':
        return {
          ok: true,
          data: outputs.get((op.input as { id?: string }).id ?? 'native-shell') ?? '',
        }
      case 'terminal.resize': {
        const input = op.input as { id?: string; cols?: number; rows?: number } | undefined
        const term = input?.id ? pty.get(input.id) : undefined
        if (term && input?.cols && input.rows) term.resize(input.cols, input.rows)
        return { ok: true, data: null }
      }
      case 'terminal.write': {
        const input = op.input as { id?: string; data?: string } | undefined
        if (typeof input?.data === 'string') {
          ptyInput.push(`${input.id}:${input.data}`)
          pty.get(input.id ?? 'native-shell')?.write(input.data)
        }
        return { ok: true, data: null }
      }
      case 'terminal.inputProof':
        return {
          ok: true,
          data: {
            input: ptyInput.map((data) => [...data].map((char) => char.codePointAt(0))),
            hasInterrupt: ptyInput.some((data) =>
              [...data].some((char) => char.charCodeAt(0) === 3),
            ),
            fixtureProof,
            outputs: Object.fromEntries(outputs),
            processExited,
            terminalExitCode,
            exits: [...exits],
            live: [...pty.keys()],
          },
        }
      case 'logs.entries':
        return { ok: true, data: [] }
      default:
        return { ok: false, message: `unsupported smoke operation ${op.path}` }
    }
  },
)
function spawnTerminal(id: string) {
  if (pty.has(id)) return
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
    USER: 'smoke',
    LOGNAME: 'smoke',
    HOST: 'holi-smoke',
    HOSTNAME: 'holi-smoke',
    PS1: 'HOLI_SHELL_READY> ',
    PROMPT: 'HOLI_SHELL_READY> ',
    HOME: join(root, 'home'),
    ZDOTDIR: join(root, 'zsh'),
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    HISTFILE: join(root, 'home', '.zsh_history'),
  }
  const term = spawn('/bin/zsh', ['-f'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd: join(root, 'vault'),
    env,
  })
  pty.set(id, term)
  outputs.set(id, '')
  term.onData((data) => {
    outputs.set(id, (outputs.get(id) ?? '') + data)
    if (data.includes('F_ENTER_PROOF')) fixtureProof += 'f-enter\n'
    if (data.includes('FIXTURE_OUTPUT_PROOF')) fixtureProof += 'output\n'
    if (data.includes('SIGINT_PROOF')) fixtureProof += 'sigint\n'
    send('holi-smoke:pty-data', { remote: 'native-smoke', id, data })
  })
  term.onExit(({ exitCode }) => {
    processExited = true
    terminalExitCode = exitCode
    exits.set(id, exitCode)
    exitCodes.push(exitCode)
    pty.delete(id)
    send('holi-smoke:pty-exit', { remote: 'native-smoke', id, exitCode })
  })
  const source = `let line='';const id=process.env.HOLI_TERMINAL_ID;process.stdout.write('NATIVE_HINT_FIXTURE\\n'+(id==='native-shell'?'https://example.com/holi-native-hint-proof\\n':'')+'SECOND_LIVE_FIXTURE https://example.com/'+id+'-proof\\n');process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{for(const c of chunk){if(c==='\\n'||c==='\\r'){const value=line;line='';if(value==='f')process.stdout.write('F_ENTER_PROOF\\n');else if(value==='fixture:output')process.stdout.write('FIXTURE_OUTPUT_PROOF\\n');else if(value==='fixture:control-only')process.stdout.write('\\u001b[3J\\u001b[2J\\u001b[HCONTROL_ONLY_PROOF\\n');else if(value==='fixture:long')process.stdout.write(('SCROLL_FIXTURE\\n').repeat(40)+'https://example.com/'+('wrapped-hint-'.repeat(70))+'end\\nLONG_FIXTURE_DONE\\n');else if(value==='fixture:quiesce'){process.stdout.write('SILENT_EXIT_READY\\n');process.exit(0)}else if(value==='exit')process.exit(0);else process.stdout.write('INPUT_PROOF:'+value+'\\n')}else line+=c}});process.stdin.resume();process.on('SIGINT',()=>{process.stdout.write('\\u001b[31mSIGINT_PROOF\\n\\u001b[0m')})`
  const fixtureScript = join(root, 'fixture.cjs')
  writeFileSync(fixtureScript, source)
  const command = `HOLI_TERMINAL_ID='${id}' node '${fixtureScript}'\n`
  setTimeout(() => term.write(command), 200)
}
ipcMain.on('holi-smoke:pty-stop', () => {
  for (const term of pty.values()) term.kill()
  pty.clear()
})
ipcMain.on('holi-smoke:quit', () => {
  const terms = [...pty.values()]
  if (terms.length === 0) {
    app.quit()
    return
  }
  let remaining = terms.length
  for (const term of terms) {
    term.onExit(() => {
      processExited = true
      if (--remaining === 0) {
        pty.clear()
        app.quit()
      }
    })
    term.kill()
  }
})
ipcMain.on('holi-smoke:theme', (_event, theme: 'light' | 'dark') => {
  web?.webContents.executeJavaScript(
    `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
  )
})
ipcMain.handle('holi:openExternal', (_event, value: string) => {
  // Harness-only allowlist; production main/ipc.ts validation is not exercised.
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'example.com')
    throw new Error('unexpected external URL')
  writeFileSync(join(evidence, 'external-url.txt'), value)
  void web?.webContents.executeJavaScript(
    `window.__holiNativeSmokeOpened=true;window.__holiNativeSmokeOpenedUrl=${JSON.stringify(value)}`,
  )
  return true
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})
app.on('before-quit', () => {
  writeFileSync(
    join(evidence, 'pty-proof.json'),
    JSON.stringify({
      outputBytes: [...outputs.values()].reduce((sum, value) => sum + value.length, 0),
      output: Object.fromEntries(outputs),
      exits: [...exits],
      exitCodes,
      input: ptyInput.map((data) => [...data].map((char) => char.codePointAt(0))),
      hasInterrupt: ptyInput.some((data) => [...data].some((char) => char.charCodeAt(0) === 3)),
      fixtureProof,
      processExited,
      terminalExitCode,
      processCount: pty.size,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    }),
  )
  for (const term of pty.values()) term.kill()
  pty.clear()
})
app.on('window-all-closed', () => app.quit())
void run()
