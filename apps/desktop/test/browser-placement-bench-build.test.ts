import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareBenchmarkRuntime } from '../scripts/browser-placement-bench-build.mjs'
import { instrumentPlacement } from '../scripts/browser-placement-bench-instrumentation.mjs'

describe('browser placement benchmark preparation', () => {
  it('refuses source that has not been reviewed for instrumentation', () => {
    expect(() => instrumentPlacement('changed source', true)).toThrow()
    expect(() => instrumentPlacement('changed source', false)).toThrow()
  })

  it.skipIf(process.platform === 'win32')(
    'compiles an isolated instrumented Electron directory without launching it',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'h799-build-'))
      try {
        const result = await prepareBenchmarkRuntime({
          desktop: resolve(import.meta.dirname, '..'),
          root,
          countsOnly: true,
        })
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
        expect((await stat(join(root, manifest.main))).isFile()).toBe(true)
        expect((await stat(join(result.renderer, 'index.html'))).isFile()).toBe(true)
        expect(result.instrumentMatches).toBe(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    120000,
  )
})
