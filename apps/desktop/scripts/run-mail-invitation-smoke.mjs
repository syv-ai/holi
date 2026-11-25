// Native evidence (macOS or a Linux display):
// node apps/desktop/scripts/run-mail-invitation-smoke.mjs --evidence-dir=/absolute/new-directory
// Compile without launching Electron: add --build-only (no evidence directory needed).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOwnedProcesses } from './owned-processes.mjs'

const script = fileURLToPath(import.meta.url)
const desktop = resolve(dirname(script), '..')
const rendererEntry = fileURLToPath(
  new URL('./mail-invitation-smoke-renderer.tsx', import.meta.url),
)
const mainEntry = fileURLToPath(new URL('./mail-invitation-smoke-main.ts', import.meta.url))
const ipc = 'holi-invitation-fixture'
const require = createRequire(import.meta.url)

async function buildFixture(root) {
  // We never build the primary app's `out`. A worktree may link it to a live app.
  for (const path of [join(desktop, 'out'), join(desktop, '../../out')]) {
    const output = await lstat(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (output?.isSymbolicLink()) console.log(`Leaving existing output symlink untouched: ${path}`)
  }
  const { build } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const { default: tailwindcss } = await import('@tailwindcss/vite')
  await build({
    configFile: false,
    envFile: false,
    root: desktop,
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    build: {
      outDir: join(root, 'renderer'),
      emptyOutDir: false,
      rollupOptions: {
        input: rendererEntry,
        output: { entryFileNames: 'renderer.js', assetFileNames: '[name]-[hash][extname]' },
      },
    },
  })
  await build({
    configFile: false,
    envFile: false,
    root: desktop,
    ssr: { noExternal: ['@holi/shared'] },
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: mainEntry,
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  const css = (await readdir(join(root, 'renderer'))).filter((file) => /^[-\w]+\.css$/.test(file))
  assert.equal(css.length, 1, 'expected one bundled renderer stylesheet')
  const csp =
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; connect-src 'none'; frame-src about:; base-uri 'none'; form-action 'none'"
  await writeFile(
    join(root, 'renderer.html'),
    `<!doctype html><html lang="en-US" data-theme="light"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Holi — synthetic mail invitation evidence</title><link rel="stylesheet" href="renderer/${css[0]}"></head><body><div id="root"></div><script type="module" src="renderer/renderer.js"></script></body></html>`,
    { flag: 'wx' },
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('holi', {
  trpc: (op) => ipcRenderer.invoke(${JSON.stringify(ipc)}, op),
  openExternal: (url) => ipcRenderer.invoke(${JSON.stringify(`${ipc}-external`)}, url),
});\n`,
    { flag: 'wx' },
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-mail-invitation-fixture', main: 'main.cjs' }),
    { flag: 'wx' },
  )
}

async function verifyScratch(root, nonce) {
  const directory = await lstat(root)
  assert(directory.isDirectory() && directory.uid === process.getuid())
  assert.equal(directory.mode & 0o077, 0)
  assert.match(basename(root), /^holi-mail-invitation-/)
  assert.equal(dirname(root), await realpath(tmpdir()))
  assert.equal(await realpath(root), root)
  assert.match(nonce, /^[a-f0-9-]{36}$/)
  assert.equal(await readFile(join(root, 'owner'), 'utf8'), nonce)
  return directory
}

async function installedElectron() {
  // `require('electron')` can start an unbounded implicit download on a fresh
  // worktree. Require a local install before starting the offline run instead.
  const packageRoot = dirname(require.resolve('electron'))
  const binary = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
  const path = join(packageRoot, 'dist', binary)
  await access(path, constants.X_OK).catch(() => {
    throw new Error(
      'Install the pinned Electron binary first: node apps/desktop/node_modules/electron/install.js',
    )
  })
  return path
}

async function runFixture() {
  assert(
    ['darwin', 'linux'].includes(process.platform),
    'requires POSIX process-group cleanup (macOS or Linux)',
  )
  const args = process.argv.slice(2)
  const buildOnly = args.includes('--build-only')
  const outputArg = args
    .find((arg) => arg.startsWith('--evidence-dir='))
    ?.slice('--evidence-dir='.length)
  assert(
    args.every((arg) => arg === '--build-only' || arg === `--evidence-dir=${outputArg}`),
    'unknown harness option',
  )
  assert(
    buildOnly || (outputArg && isAbsolute(outputArg)),
    'pass --evidence-dir=/absolute/new-directory',
  )
  const electron = buildOnly ? null : await installedElectron()
  const parent = await realpath(tmpdir())
  const root = await mkdtemp(join(parent, 'holi-mail-invitation-'))
  const identity = await lstat(root)
  const nonce = randomUUID()
  const abort = new AbortController()
  const owned = createOwnedProcesses({ signal: abort.signal })
  const interrupt = () => {
    process.exitCode = 130
    abort.abort()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  let evidence
  let native
  let source
  let video
  let failure
  let removed = false
  let marked = false
  try {
    await writeFile(join(root, 'owner'), nonce, { flag: 'wx', mode: 0o600 })
    marked = true
    await verifyScratch(root, nonce)
    if (!buildOnly) {
      const output = resolve(outputArg)
      assert(output !== root && !output.startsWith(`${root}${sep}`))
      const realParent = await realpath(dirname(output))
      // Require a new destination; never clear or overwrite a prior run.
      const destination = join(realParent, basename(output))
      await mkdir(destination, { mode: 0o700 })
      evidence = destination
    }
    const env = Object.fromEntries(
      ['PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY'].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    )
    Object.assign(env, {
      TMPDIR: parent,
      HOME: root,
      CFFIXED_USER_HOME: root,
      XDG_CONFIG_HOME: root,
      XDG_CACHE_HOME: root,
      XDG_DATA_HOME: root,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TZ: 'UTC',
      HOLI_INVITATION_ROOT: root,
      HOLI_INVITATION_NONCE: nonce,
    })
    if (electron) {
      const gitOptions = { env, cwd: desktop, timeoutMs: 5_000 }
      const head = await owned.run('git', ['rev-parse', 'HEAD'], gitOptions)
      const status = await owned.run(
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        gitOptions,
      )
      source = { head: head.output.trim(), trackedTreeClean: status.output.trim() === '' }
    }
    const build = await owned.run(process.execPath, [script, '--compile-owned-fixture'], {
      env,
      cwd: root,
      timeoutMs: 120_000,
      label: 'isolated invitation bundle',
    })
    process.stdout.write(build.output)
    if (electron) {
      const run = await owned.run(electron, ['--lang=en-US', '--disable-breakpad', root], {
        env,
        cwd: root,
        timeoutMs: 110_000,
        label: 'isolated invitation Electron',
      })
      process.stdout.write(run.output)
      native = JSON.parse(await readFile(join(root, 'native.json'), 'utf8'))
      assert.equal(native.ok, true)
      assert.equal(native.electron.split('.')[0], '43')
      const file = 'invitation-rsvp.mp4'
      await owned.run(
        'ffmpeg',
        [
          '-n',
          '-framerate',
          '5',
          '-i',
          join(root, 'frames/frame-%04d.png'),
          '-an',
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-pix_fmt',
          'yuv420p',
          join(root, file),
        ],
        { env, cwd: root, timeoutMs: 30_000 },
      )
      const probe = await owned.run(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          join(root, file),
        ],
        { env, cwd: root, timeoutMs: 5_000 },
      )
      const durationSeconds = Number(probe.output.trim())
      assert(durationSeconds >= 2.5 && (await stat(join(root, file))).size > 0)
      await copyFile(join(root, file), join(evidence, file), constants.COPYFILE_EXCL)
      video = { file, durationSeconds }
    }
  } catch (error) {
    failure = error
  } finally {
    const cleanupErrors = []
    try {
      await owned.stopAll()
    } catch (error) {
      cleanupErrors.push(String(error))
    }
    try {
      if (evidence) {
        native ??= await readFile(join(root, 'native.json'), 'utf8').then(JSON.parse, (error) => {
          if (error.code !== 'ENOENT') throw error
        })
        for (const { file } of native?.captures ?? []) {
          assert.match(file, /^\d\d-[a-z-]+\.png$/)
          assert((await stat(join(root, 'evidence', file))).size > 0)
          await copyFile(
            join(root, 'evidence', file),
            join(evidence, file),
            constants.COPYFILE_EXCL,
          )
        }
      }
    } catch (error) {
      failure ??= error
    }
    try {
      assert.equal(owned.size, 0, 'refusing to unlink a profile while owned processes remain')
      const candidate = marked ? await verifyScratch(root, nonce) : await lstat(root)
      assert(
        candidate.isDirectory() && candidate.dev === identity.dev && candidate.ino === identity.ino,
      )
      await rm(root, { recursive: true })
      removed = true
    } catch (error) {
      cleanupErrors.push(String(error))
    }
    if (cleanupErrors.length)
      failure = new AggregateError(
        [failure, ...cleanupErrors].filter(Boolean),
        'Invitation fixture cleanup failed',
      )
    if (abort.signal.aborted) failure ??= new Error('Invitation fixture interrupted')
    if (evidence) {
      await writeFile(
        join(evidence, 'result.json'),
        JSON.stringify(
          {
            ok: failure === undefined && native?.ok === true,
            source,
            native,
            video,
            failure: failure instanceof Error ? failure.message : failure,
            cleanup: { removed, remainingOwnedPids: owned.remainingPids, errors: cleanupErrors },
          },
          null,
          2,
        ),
        { flag: 'wx' },
      )
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  if (failure) throw failure
  console.log(
    buildOnly
      ? 'Fixture compiled without launching Electron.'
      : `Synthetic invitation evidence: ${evidence}`,
  )
}

if (process.argv[2] === '--compile-owned-fixture') {
  const { HOLI_INVITATION_ROOT: root, HOLI_INVITATION_NONCE: nonce } = process.env
  await verifyScratch(root, nonce)
  await buildFixture(root)
} else {
  await runFixture()
}
