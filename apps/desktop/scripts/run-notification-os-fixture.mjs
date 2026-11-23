import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { createOwnedProcesses } from './owned-processes.mjs'
import { clickNativeBanner } from './notification-os.mjs'

if (process.platform !== 'darwin') throw new Error('notification readiness requires macOS')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(desktop, 'package.json'))
const evidence = resolve(process.argv[2] ?? '/tmp/holi-notification-readiness')
const root = await mkdtemp(join(tmpdir(), 'holi-notification-fixture-'))
const profile = join(root, 'profile')
const result = join(root, 'result')
const title = `Holi readiness ${randomUUID()}`
const owned = createOwnedProcesses()
let log = ''
try {
  await mkdir(join(profile, 'home'), { recursive: true })
  await mkdir(join(profile, 'tmp'), { recursive: true })
  await mkdir(evidence, { recursive: true })
  await build({
    configFile: false,
    root: desktop,
    logLevel: 'error',
    build: {
      ssr: join(desktop, 'scripts/notification-os-fixture-main.ts'),
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'main.cjs' },
      },
    },
  })
  const electron = require('electron')
  const child = owned.start(electron, [join(root, 'main.cjs')], {
    env: {
      PATH: process.env.PATH,
      HOME: join(profile, 'home'),
      TMPDIR: join(profile, 'tmp'),
      HOLI_NOTIFICATION_TITLE: title,
      HOLI_NOTIFICATION_RESULT: result,
      HOLI_NOTIFICATION_USER_DATA: join(profile, 'user'),
      HOLI_NOTIFICATION_SESSION_DATA: join(profile, 'session'),
    },
  })
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      if ((await readFile(result, 'utf8')) === 'shown') break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (Date.now() >= deadline) throw new Error(`fixture did not become ready: ${child.output}`)
  const click = await clickNativeBanner({
    appName: 'Holi notification readiness',
    title,
    timeoutMs: 12_000,
  })
  const clickDeadline = Date.now() + 5_000
  let outcome = ''
  while (Date.now() < clickDeadline) {
    try {
      outcome = await readFile(result, 'utf8')
      if (outcome === 'clicked-and-window-activated') break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (outcome !== 'clicked-and-window-activated')
    throw new Error(`native click did not activate fixture window (state=${outcome})`)
  log = JSON.stringify({ title, click, outcome, userDataOwned: true, sessionDataOwned: true })
  await writeFile(join(evidence, 'result.json'), `${log}\n`)
  console.log(log)
} catch (error) {
  const failure = JSON.stringify({ title, error: String(error), output: owned.output })
  try {
    await mkdir(evidence, { recursive: true })
    await writeFile(join(evidence, 'result.json'), `${failure}\n`)
  } catch {}
  throw error
} finally {
  await owned.stopAll()
  await rm(root, { recursive: true, force: true })
}
