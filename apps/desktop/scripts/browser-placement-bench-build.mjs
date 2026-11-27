import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { externalizeDepsPlugin } from 'electron-vite'
import { instrumentPlacement } from './browser-placement-bench-instrumentation.mjs'
export async function prepareBenchmarkRuntime({ desktop, root, countsOnly }) {
  const sourcePath = join(desktop, 'src/plugins/browser/renderer/browser-surface.tsx')
  const fixture = join(desktop, 'scripts/browser-placement-fixture')
  const renderer = join(root, 'renderer')
  const reactPlugin = react()
  const tailwind = (
    await import(
      pathToFileURL(createRequire(join(desktop, 'package.json')).resolve('@tailwindcss/vite'))
    )
  ).default
  let instrumentMatches = 0
  const source = await readFile(sourcePath, 'utf8')
  const sourceHash = instrumentPlacement(source).hash
  const instrumentationPlugin = {
    name: 'placement-benchmark-instrumentation',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== sourcePath) return null
      const result = instrumentPlacement(code, countsOnly)
      if (result.instrumented) instrumentMatches++
      return result.instrumented ? result.code : null
    },
  }
  await build({
    configFile: false,
    base: './',
    root: fixture,
    resolve: {
      alias: [{ find: '@', replacement: join(desktop, 'src/renderer/src') }],
      dedupe: ['react', 'react-dom', 'jotai'],
    },
    esbuild: { jsx: 'automatic' },
    plugins: [instrumentationPlugin, reactPlugin, tailwind()],
    build: { outDir: renderer, emptyOutDir: true, minify: false },
  })
  const mainSource = join(desktop, 'scripts/browser-placement-bench-main.ts')
  await build({
    configFile: false,
    root: desktop,
    plugins: [externalizeDepsPlugin({ exclude: ['@holi/shared'] })],
    build: {
      ssr: true,
      target: 'node24',
      outDir: root,
      emptyOutDir: false,
      rollupOptions: {
        input: mainSource,
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'main.cjs',
          banner: `module.paths.unshift(${JSON.stringify(join(desktop, 'node_modules'))});`,
        },
      },
    },
  })
  assert.equal(
    instrumentMatches,
    countsOnly ? 1 : 0,
    'instrumentation match count differs from requested run mode',
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'holi-browser-placement-bench', main: 'main.cjs' }),
  )

  return { sourceHash, renderer, instrumentMatches }
}
