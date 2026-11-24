import { lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadConfigFromFile, mergeConfig } from 'vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2]
if (!out || !isAbsolute(out))
  throw new Error('Usage: node scripts/build-agent-inbox-550.mjs /absolute/new-build-directory')
const target = resolve(out)
try {
  await lstat(target)
  throw new Error(`Build directory already exists: ${target}`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
await mkdir(target, { recursive: false })
const outRoot = join(target, 'out')
const configResult = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  join(desktop, 'electron.vite.config.ts'),
)
if (!configResult) throw new Error('Could not load electron-vite.config.ts')
const replacement = resolve(desktop, 'src/main/github/electron.ts')
const fixture = resolve(desktop, 'scripts/agent-inbox-550-github.ts')
const replaceGitHub = {
  name: 'agent-inbox-550-github-composition',
  enforce: 'pre',
  resolveId(id, importer) {
    if (!importer || !id.startsWith('.')) return null
    const resolved = resolve(dirname(importer), id)
    if (resolved === replacement || resolved === `${replacement}.ts`) return fixture
    return null
  },
}
const config = mergeConfig(configResult.config, {
  root: desktop,
  configFile: false,
  build: { outDir: outRoot, emptyOutDir: false },
  main: {
    entry: resolve(desktop, 'src/main/agent-inbox-550-main.ts'),
    outDir: join(outRoot, 'main'),
    plugins: [replaceGitHub],
  },
  preload: { outDir: join(outRoot, 'preload') },
  renderer: { root: resolve(desktop, 'src/renderer'), outDir: join(outRoot, 'renderer') },
})
await build(config)
console.log(`Built production composition under ${outRoot}`)
