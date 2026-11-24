import { lstat, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, loadConfigFromFile } from 'electron-vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = process.argv[2]
if (!destination || !isAbsolute(destination))
  throw new Error('Usage: node scripts/build-agent-inbox-550.mjs /absolute/new-build-directory')
try {
  if ((await lstat(join(desktop, 'out'))).isSymbolicLink())
    throw new Error('Checkout out is a symlink; use a checkout-local output directory first')
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
// Caller must provide a freshly-created parent; mkdir without recursive deliberately
// rejects reused build destinations rather than overwriting prior evidence.
const target = await realpath(resolve(destination))
const out = join(target, 'out')
const configFile = join(desktop, 'scripts/agent-inbox-550.vite.config.ts')
try {
  process.chdir(desktop)
  process.env.HOLI_550_BUILD_DIRECTORY = target
  await mkdir(join(target, 'runtime'), { mode: 0o700 })
  await symlink(join(desktop, 'node_modules'), join(target, 'node_modules'), 'dir')
  const { config } = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    configFile,
    desktop,
  )
  for (const name of ['main', 'preload', 'renderer'])
    if (config[name]?.build?.outDir !== join(out, name))
      throw new Error(`Build output is not isolated: ${name}`)
  await build({ configFile })
  for (const entry of [
    'main/seed.js',
    'main/bootstrap.js',
    'main/index.js',
    'preload/index.js',
    'renderer/index.html',
  ])
    if (!(await lstat(join(out, entry))).isFile())
      throw new Error(`Missing production output: ${entry}`)
  await writeFile(
    join(target, 'build.json'),
    JSON.stringify({
      entry: join(out, 'main/bootstrap.js'),
      runtimeRoot: join(target, 'runtime'),
      vaultRoot: join(target, 'runtime/vaults'),
    }),
  )
  console.log(`Production composition built at ${target}`)
} catch (error) {
  await rm(target, { recursive: true, force: true })
  throw error
}
