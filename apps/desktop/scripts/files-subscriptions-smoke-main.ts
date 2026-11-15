import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import { initTRPC } from '@trpc/server'
import { createSubscriptions } from '../src/main/vault/subscriptions'
import { scanVault } from '../src/main/vault/vault-store'
import { callProcedure, toEnvelope, type TrpcOp } from '../src/main/trpc-call'

const root = process.env.HOLI_566_ROOT!
const evidence = process.env.HOLI_566_EVIDENCE!
const vaultRoot = join(root, 'vault')
const remote = 'smoke/files-subscriptions'
const checks: string[] = []
const errors: string[] = []
const denied: string[] = []
const captures: string[] = []
let windowRef: BrowserWindow | null = null
let recorder: ReturnType<typeof setInterval> | undefined
let frame = 0
let capturing: Promise<void> | null = null

function check(condition: unknown, name: string): asserts condition {
  assert(condition, name)
  checks.push(name)
}

async function waitFor(expression: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (windowRef && !windowRef.isDestroyed()) {
      const ready = await windowRef.webContents.executeJavaScript(`Boolean(${expression})`)
      if (ready) return
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out waiting for renderer: ${expression}`)
}

async function evaluate<T>(expression: string): Promise<T> {
  assert(windowRef && !windowRef.isDestroyed())
  return windowRef.webContents.executeJavaScript(expression) as Promise<T>
}

async function capture(name: string): Promise<void> {
  assert(windowRef && !windowRef.isDestroyed())
  await new Promise((resolve) => setTimeout(resolve, 180))
  await import('node:fs/promises').then(({ writeFile: save }) =>
    windowRef!.capturePage().then((image) => save(join(evidence, name), image.toPNG())),
  )
  captures.push(name)
}

async function nativeSpace(label: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400))
  await evaluate(
    `(()=>{const n=document.querySelector('[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');if(!n)throw Error('Missing keyboard target: '+${JSON.stringify(label)});n.focus()})()`,
  )
  windowRef!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  windowRef!.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
  windowRef!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await new Promise((resolve) => setTimeout(resolve, 400))
}

async function run(): Promise<void> {
  await Promise.all(
    [
      join(root, 'user-data'),
      join(root, 'app-data'),
      join(root, 'session-data'),
      vaultRoot,
      evidence,
    ].map((path) => mkdir(path, { recursive: true })),
  )
  await mkdir(join(vaultRoot, 'Projects'), { recursive: true })
  await Promise.all([
    writeFile(join(vaultRoot, 'README.md'), '# Production file row\n'),
    writeFile(join(vaultRoot, 'sibling.md'), '# Sibling row\n'),
    writeFile(join(vaultRoot, '.env'), 'SYNTHETIC=not-a-secret\n'),
    writeFile(join(vaultRoot, 'Projects', 'plan.md'), '# Folder child\n'),
  ])

  app.setName('Holi files subscriptions native smoke 566')
  app.setPath('appData', join(root, 'app-data'))
  app.setPath('userData', join(root, 'user-data'))
  app.setPath('sessionData', join(root, 'session-data'))
  assert.equal(app.getPath('userData'), join(root, 'user-data'))
  await app.whenReady()
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^(file|data|devtools):/.test(details.url)) return callback({})
    denied.push(details.url)
    callback({ cancel: true })
  })

  const subscriptions = createSubscriptions(join(app.getPath('userData'), 'subscriptions.json'))
  const t = initTRPC.create()
  const router = t.router({
    subscriptions: t.router({
      list: t.procedure
        .input((value) => value as { remote: string; paths: string })
        .query(async ({ input }) =>
          subscriptions.list(input.remote, vaultRoot, JSON.parse(input.paths)),
        ),
      set: t.procedure
        .input((value) => value as { remote: string; path: string; enabled: boolean })
        .mutation(async ({ input }) =>
          subscriptions.set(input.remote, vaultRoot, input.path, input.enabled, async () =>
            'a'.repeat(40),
          ),
        ),
    }),
  })
  ipcMain.handle('holi:trpc', async (event, op: TrpcOp) => {
    if (windowRef?.isDestroyed() || event.sender !== windowRef?.webContents) {
      return { ok: false, message: 'Unauthorized smoke sender' }
    }
    return toEnvelope(callProcedure(router, op))
  })
  ipcMain.handle('holi:files-smoke-snapshot', async (event) => {
    if (windowRef?.isDestroyed() || event.sender !== windowRef?.webContents)
      throw new Error('Unauthorized smoke sender')
    return scanVault(vaultRoot, [])
  })

  windowRef = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  windowRef.webContents.on('will-navigate', (event) => event.preventDefault())
  windowRef.webContents.on('console-message', (event) => {
    console.log(`RENDERER ${event.level}: ${event.message}`)
    if (event.level === 'error') errors.push(event.message)
  })
  windowRef.webContents.on('render-process-gone', (_event, details) =>
    errors.push(`renderer gone: ${details.reason}`),
  )
  windowRef.webContents.on('did-fail-load', (_event, code, description) =>
    errors.push(`load failed ${code}: ${description}`),
  )
  windowRef.on('unresponsive', () => errors.push('window unresponsive'))
  await windowRef.loadFile(join(root, 'renderer.html'))
  await waitFor(
    `document.querySelector('[aria-label="Subscribe README.md"]') && document.body.textContent.includes('.env')`,
  )

  await mkdir(join(evidence, 'frames'), { recursive: true })
  recorder = setInterval(() => {
    if (capturing !== null || !windowRef || windowRef.isDestroyed()) return
    capturing = windowRef
      .capturePage()
      .then((image) =>
        writeFile(
          join(evidence, 'frames', `frame-${String(frame++).padStart(4, '0')}.png`),
          image.toPNG(),
        ),
      )
      .catch((error: unknown) => errors.push(`Recording failed: ${String(error)}`))
      .then(() => {
        capturing = null
      })
  }, 100)

  const initial = await evaluate<{ labels: string[]; text: string }>(
    `({labels:[...document.querySelectorAll('[aria-label]')].map(n=>n.getAttribute('aria-label')||''),text:document.body.innerText})`,
  )
  check(
    initial.text.includes('README') &&
      initial.text.includes('sibling') &&
      initial.text.includes('.env'),
    `production scan renders regular siblings and visible hidden file: ${initial.text}`,
  )
  check(
    !initial.labels.some((label) => label?.startsWith('Subscribe ') && label.includes('.env')),
    `secret .env row has no subscription bell: ${JSON.stringify(initial.labels)}`,
  )
  check(
    initial.labels.includes('Subscribe this vault'),
    'real SidebarProvider renders root subscription control',
  )
  check(initial.labels.includes('Subscribe Projects'), 'folder row renders subscription control')
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`)
  const lightBackground = await evaluate<string>(
    `getComputedStyle(document.querySelector('main')).backgroundColor`,
  )
  await capture('files-initial-light.png')
  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
  check(
    (await evaluate<string>(`getComputedStyle(document.querySelector('main')).backgroundColor`)) !==
      lightBackground,
    'dark theme changes the computed production surface color',
  )
  await capture('files-initial-dark.png')
  await evaluate(`document.documentElement.setAttribute('data-theme', 'light')`)

  await nativeSpace('Subscribe README.md')
  await waitFor(`document.querySelector('[aria-label="Unsubscribe README.md"]')`)
  const firstStored = await subscriptions.list(remote, vaultRoot, [
    '',
    'README.md',
    'sibling.md',
    'Projects',
  ])
  check(
    firstStored.find((scope) => scope.path === 'README.md')?.explicit === true,
    'native keyboard input subscribes exactly one production file',
  )
  check(
    firstStored.every((scope) => scope.path === 'README.md' || !scope.explicit),
    'file subscription does not include root, folder, or sibling',
  )
  await capture('file-subscribed.png')

  await windowRef.webContents.reload()
  await waitFor(`document.querySelector('[aria-label="Unsubscribe README.md"]')`)
  const afterReload = await subscriptions.list(remote, vaultRoot, [
    '',
    'README.md',
    'sibling.md',
    'Projects',
  ])
  check(
    afterReload.find((scope) => scope.path === 'README.md')?.explicit === true,
    'file subscription remains after renderer reload',
  )

  await nativeSpace('Subscribe Projects')
  await waitFor(`document.querySelector('[aria-label="Unsubscribe Projects"]')`)
  const underFolder = await subscriptions.list(remote, vaultRoot, [
    '',
    'README.md',
    'sibling.md',
    'Projects',
    'Projects/plan.md',
  ])
  check(
    underFolder.find((scope) => scope.path === 'Projects/plan.md')?.coveredBy === 'Projects',
    'folder subscription is inherited by its child',
  )
  check(
    underFolder.find((scope) => scope.path === 'README.md')?.coveredBy === null,
    'folder subscription does not cover unrelated sibling',
  )
  await capture('folder-inheritance.png')
  await nativeSpace('Subscribe this vault')
  await waitFor(`document.querySelector('[aria-label*="Unsubscribe this vault"]')`)
  await nativeSpace('Remove explicit subscription for README.md (still covered by the vault)')
  await waitFor(
    `document.querySelector('[aria-label="Subscribe README.md explicitly (already covered by the vault)"]')`,
  )
  const removedFile = await subscriptions.list(remote, vaultRoot, ['README.md'])
  check(
    !removedFile[0]?.explicit && removedFile[0]?.coveredBy === '',
    'removing explicit file subscription preserves root coverage',
  )
  const underRoot = await subscriptions.list(remote, vaultRoot, [
    '',
    'README.md',
    'sibling.md',
    'Projects/plan.md',
  ])
  check(
    underRoot.find((scope) => scope.path === 'sibling.md')?.coveredBy === '',
    'root subscription is inherited by unrelated files',
  )
  check(
    underRoot.find((scope) => scope.path === 'Projects/plan.md')?.coveredBy === 'Projects',
    'nearest folder subscription remains the child coverage',
  )
  await nativeSpace('Unsubscribe this vault')
  await waitFor(`document.querySelector('[aria-label="Subscribe this vault"]')`)
  const rootRemoved = await subscriptions.list(remote, vaultRoot, [
    '',
    'sibling.md',
    'Projects/plan.md',
  ])
  check(
    !rootRemoved[0]?.explicit &&
      rootRemoved.find((scope) => scope.path === 'Projects/plan.md')?.coveredBy === 'Projects',
    'removing root subscription retains explicit folder coverage',
  )

  await evaluate(`document.documentElement.setAttribute('data-theme', 'dark')`)
  await capture('files-final-dark.png')
  clearInterval(recorder)
  await capturing
  assert(frame > 10, 'continuous recording must include interaction frames')
  assert.deepEqual(errors, [], 'renderer errors must remain empty')
  assert.deepEqual(denied, [], 'external network requests must be blocked without attempts')
  const persisted = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(join(app.getPath('userData'), 'subscriptions.json'), 'utf8'),
  ) as { remotes: Record<string, { path: string; baseline: string | null }[]> }
  assert.deepEqual(persisted.remotes[remote], [{ path: 'Projects', baseline: 'a'.repeat(40) }])
  checks.push('production-subscriptions-json-contains-only-surviving-explicit-folder-scope')
  await (
    await import('node:fs/promises')
  ).writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        captures,
        recordingFrames: frame,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        roots: { userData: app.getPath('userData'), vault: vaultRoot },
        networkDenied: denied,
        rendererErrors: errors,
        persisted,
      },
      null,
      2,
    ),
  )
  await app.quit()
}

void run().catch(async (error: unknown) => {
  clearInterval(recorder)
  await capturing
  console.error(error)
  errors.push(error instanceof Error ? (error.stack ?? error.message) : String(error))
  try {
    const saved = await (
      await import('node:fs/promises')
    )
      .readFile(join(app.getPath('userData'), 'subscriptions.json'), 'utf8')
      .catch(() => null)
    await (
      await import('node:fs/promises')
    ).writeFile(
      join(evidence, 'result.json'),
      JSON.stringify({ ok: false, checks, rendererErrors: errors, persistedText: saved }, null, 2),
    )
  } catch {}
  app.exit(1)
})
