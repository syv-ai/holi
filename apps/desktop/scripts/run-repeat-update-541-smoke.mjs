import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createOwnedProcesses } from './owned-processes.mjs'

assert.equal(process.platform, 'darwin', 'This fixture exercises the macOS updater')
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-541-smoke-')))
const evidence = await mkdtemp(join(tmpdir(), 'holi-541-evidence-'))
const processes = createOwnedProcesses()
const results = []
let candidate = '0.7.1-dev.194'
const requests = []
const server = createServer((request, response) => {
  requests.push({ url: request.url, candidate, at: new Date().toISOString() })
  response.writeHead(200, { 'content-type': 'application/yaml' })
  response.end(
    JSON.stringify({
      version: candidate,
      releaseDate: candidate.endsWith('195') ? '2026-11-24T12:00:00Z' : '2026-11-24T11:00:00Z',
      files: [{ url: 'synthetic.zip', sha512: Buffer.alloc(64).toString('base64'), size: 0 }],
      path: 'synthetic.zip',
      sha512: Buffer.alloc(64).toString('base64'),
    }),
  )
})
console.log(`Evidence: ${evidence}`)
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  const output = join(root, 'bundle')
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: output,
      emptyOutDir: true,
      rollupOptions: {
        input: join(desktop, 'scripts/repeat-update-541-smoke-main.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          inlineDynamicImports: true,
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin()],
    build: {
      ssr: true,
      outDir: output,
      emptyOutDir: false,
      rollupOptions: {
        input: join(desktop, 'src/preload/index.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'preload.cjs' },
      },
    },
  })
  const html = join(root, 'index.html')
  await writeFile(
    html,
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"></head><body><div id="root"></div><script type="module" src="${join(desktop, 'scripts/repeat-update-541-smoke-renderer.tsx')}"></script></body></html>`,
  )
  await symlink(join(desktop, 'node_modules'), join(root, 'node_modules'), 'dir')
  await build({
    configFile: false,
    root,
    base: './',
    resolve: {
      alias: { '@': join(desktop, 'src/renderer/src') },
      dedupe: ['react', 'react-dom', 'jotai'],
    },
    plugins: [react(), tailwindcss()],
    build: { outDir: join(output, 'renderer'), rollupOptions: { input: html } },
  })
  const electron = createRequire(import.meta.url)('electron')
  for (const scenario of [
    {
      name: 'before-restart',
      version: '0.7.1-dev.193',
      offer: '0.7.1-dev.194',
      consent: true,
      install: true,
      expected: '0.7.1-dev.194',
    },
    {
      name: 'after-simulated-upgrade',
      version: process.argv.includes('--failed-install') ? '0.7.1-dev.193' : '0.7.1-dev.194',
      offer: '0.7.1-dev.194',
      consent: true,
      install: false,
      expected: null,
    },
    {
      name: 'failed-install-control',
      version: '0.7.1-dev.193',
      offer: '0.7.1-dev.194',
      consent: true,
      install: false,
      expected: '0.7.1-dev.194',
    },
    {
      name: 'new-release-control',
      version: '0.7.1-dev.194',
      offer: '0.7.1-dev.195',
      consent: true,
      install: false,
      expected: '0.7.1-dev.195',
    },
    {
      name: 'older-release-control',
      version: '0.7.1-dev.194',
      offer: '0.7.1-dev.193',
      consent: true,
      install: false,
      expected: '0.7.1-dev.193',
    },
    {
      name: 'declined-guard-control',
      version: '0.7.1-dev.194',
      offer: '0.7.1-dev.195',
      consent: false,
      install: true,
      expected: '0.7.1-dev.195',
    },
  ]) {
    candidate = scenario.offer
    const result = join(evidence, `${scenario.name}.json`)
    await writeFile(
      join(output, 'package.json'),
      JSON.stringify({
        name: 'holi-541-smoke',
        version: scenario.version,
        main: 'main.cjs',
      }),
    )
    const config = join(root, 'scenario.json')
    await writeFile(
      config,
      JSON.stringify({
        root,
        feed: `http://127.0.0.1:${address.port}/`,
        expected: scenario.expected,
        consent: scenario.consent,
        install: scenario.install,
        prompt: scenario.name !== 'failed-install-control',
        result,
      }),
    )
    const home = join(root, 'home')
    await mkdir(home, { recursive: true })
    const env = { ...process.env, HOME: home, USERPROFILE: home }
    delete env.ELECTRON_RUN_AS_NODE
    const before = requests.length
    const run = await processes.run(electron, [output, config], {
      env,
      timeoutMs: 30_000,
      label: scenario.name,
    })
    await writeFile(join(evidence, `${scenario.name}.log`), run.output)
    assert(requests.length > before, 'A real feed check must complete in each fresh process')
    const receipt = JSON.parse(await readFile(result, 'utf8'))
    assert.equal(receipt.running, scenario.version)
    assert.equal(receipt.ok, true)
    results.push({ name: scenario.name, ...receipt })
  }
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify({ ok: true, results, requests }, null, 2),
  )
  console.log(`Updater fresh-process smoke: ${results.length} scenarios passed`)
} catch (error) {
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        ok: false,
        results,
        requests,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  try {
    await processes.stopAll()
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}
