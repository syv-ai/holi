import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import { mergeConfig } from 'vite'
import production from '../electron.vite.config'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.env.HOLI_550_BUILD_DIRECTORY
if (!target || !isAbsolute(target)) throw new Error('An owned build directory is required')
const composition = join(desktop, 'src/main/github/electron')
const fixture = join(desktop, 'scripts/agent-inbox-550-github.ts')
export default defineConfig({
  main: mergeConfig(production.main ?? {}, {
    root: desktop,
    plugins: [
      {
        name: 'owned-github-composition',
        enforce: 'pre',
        resolveId(id: string, importer?: string) {
          if (!importer || !id.startsWith('.')) return null
          const candidate = resolve(dirname(importer), id)
          return candidate === composition || candidate === `${composition}.ts` ? fixture : null
        },
      },
    ],
    build: {
      outDir: join(target, 'out/main'),
      lib: {
        entry: {
          index: join(desktop, 'src/main/index.ts'),
          bootstrap: join(desktop, 'scripts/agent-inbox-550-main.ts'),
          seed: join(desktop, 'scripts/seed-agent-inbox-550.ts'),
        },
      },
      rollupOptions: { output: { entryFileNames: '[name].js' } },
    },
  }),
  preload: mergeConfig(production.preload ?? {}, {
    root: desktop,
    build: { outDir: join(target, 'out/preload') },
  }),
  renderer: mergeConfig(production.renderer ?? {}, {
    root: join(desktop, 'src/renderer'),
    build: { outDir: join(target, 'out/renderer') },
  }),
})
