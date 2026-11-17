import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build as electronBuild } from 'electron-vite'

// Owns the disposable install/build inputs and returns their paths to the runner.
export async function prepareCommunityHintsNativeFixture({ desktop, root, pluginPort }) {
  const mainBuildConfig = join(root, 'community-hints-native-smoke.electron.config.mjs')
  const plugin = join(root, 'plugin')
  await mkdir(plugin)
  await copyFile(
    join(desktop, 'scripts/community-hints-native-smoke-serve.cjs'),
    join(plugin, 'serve.cjs'),
  )
  await writeFile(
    join(plugin, 'holi-plugin.json'),
    JSON.stringify({
      id: 'smoke-plugin',
      name: 'Community hint fixture',
      version: '0.1.0',
      opens: ['slides.md'],
      setup: [
        process.execPath,
        '-e',
        "require('node:fs').writeFileSync('.hint-smoke-setup', 'setup-complete')",
      ],
      serve: [process.execPath, 'serve.cjs', '{file}', '--port', '{port}'],
    }),
  )
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: plugin,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  )
  git('tag', 'v0.1.0')
  await build({
    configFile: false,
    root: desktop,
    base: './',
    resolve: { alias: { '@': join(desktop, 'src/renderer/src') } },
    plugins: [react(), tailwindcss()],
    build: {
      target: 'chrome140',
      outDir: join(root, 'renderer'),
      emptyOutDir: true,
      rollupOptions: { input: join(desktop, 'scripts/community-hints-native-smoke.html') },
    },
  })
  await writeFile(
    mainBuildConfig,
    `import { defineConfig, externalizeDepsPlugin } from ${JSON.stringify(pathToFileURL(join(desktop, 'node_modules/electron-vite/dist/index.js')).href)}\nexport default defineConfig({main:{plugins:[externalizeDepsPlugin({exclude:['@holi/shared']})],build:{outDir:${JSON.stringify(root)},emptyOutDir:false,rollupOptions:{input:${JSON.stringify(join(desktop, 'scripts/community-hints-native-smoke-main.ts'))},external:['electron'],output:{format:'cjs',entryFileNames:'main.cjs',banner:${JSON.stringify(`module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`)}}}}}})\n`,
  )
  await electronBuild({ configFile: mainBuildConfig })
  assert((await readFile(join(root, 'main.cjs'), 'utf8')).includes('app.asar.unpacked'))
  const emittedBridge = (await readdir(join(root, 'chunks'))).find((name) =>
    name.startsWith('hint-bridge-'),
  )
  assert(emittedBridge, 'electron-vite did not emit the bridge asset')
  await readFile(join(root, 'chunks', emittedBridge), 'utf8')
  assert(
    (await readFile(join(desktop, 'electron-builder.yml'), 'utf8')).includes(
      "'out/main/chunks/**'",
    ),
    'electron-builder does not unpack the emitted bridge asset directory',
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-community-hints-native-510', main: 'main.cjs' }),
  )
  await writeFile(
    join(root, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('holiSmoke',{call:(name,params)=>ipcRenderer.invoke('community:call',name,params),quit:()=>ipcRenderer.send('smoke:quit')});contextBridge.exposeInMainWorld('holi',{trpc:op=>ipcRenderer.invoke('community:trpc',op),logs:{onEntry:()=>()=>{}}});`,
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/.test(key) && !key.startsWith('GIT_'),
    ),
  )
  Object.assign(env, {
    HOME: join(root, 'home'),
    HOLI_510_ROOT: root,
    HOLI_510_SERVER_PORT: String(pluginPort),
  })
  delete env.ELECTRON_RUN_AS_NODE
  return { electron, env, ownedPaths: { root, plugin, mainBuildConfig } }
}
