import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { waitForBeforePanel } from '../scripts/upgrade-before-panel.mjs'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
)

type Scenario =
  | 'ready'
  | 'ambiguous'
  | 'loading'
  | 'window-too-large'
  | 'image-too-large'
  | 'window-changed'
  | 'capture-failed'
  | 'transport-too-large'
  | 'existing-output'

async function fixture(scenario: Scenario = 'ready') {
  const directory = await mkdtemp(join(tmpdir(), 'holi-before-panel-'))
  const failure = new Error('panel deadline reached')
  const receipt: { before: Record<string, unknown>; timedOut?: { phase: string } } = { before: {} }
  let captures = 0
  let encodes = 0
  let changed = false
  const window = {
    id: 7,
    isDestroyed: () => false,
    webContents: { isLoading: () => scenario === 'loading' },
    getContentBounds: () => ({ width: scenario === 'window-too-large' ? 50_000 : 1, height: 1 }),
    capturePage: async () => {
      captures++
      if (scenario === 'capture-failed') throw new Error('capture unavailable')
      changed = scenario === 'window-changed'
      return {
        getSize: () => ({ width: scenario === 'image-too-large' ? 50_000 : 1, height: 1 }),
        toPNG: () => {
          encodes++
          return png
        },
      }
    },
  }
  const other = { ...window, id: 8 }
  const electron = {
    BrowserWindow: {
      getAllWindows: () => (scenario === 'ambiguous' || changed ? [window, other] : [window]),
    },
    screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) },
  }
  const output = join(directory, 'before-panel-unasserted.png')
  if (scenario === 'existing-output') await writeFile(output, 'retained evidence')
  return {
    directory,
    failure,
    receipt,
    output,
    captures: () => captures,
    encodes: () => encodes,
    observe: (connected: unknown) =>
      waitForBeforePanel({
        probe: async () => ({
          connected,
          headingVisible: true,
          unsafe: 'untrusted payload',
          unknownFlag: true,
        }),
        wait: async (_name: string, condition: () => Promise<unknown>) => {
          if (await condition()) return
          receipt.timedOut = { phase: 'visible-google-connections' }
          throw failure
        },
        execute: async (expression: string) => {
          const result = await vm.runInNewContext(expression, {
            require: (name: string) => {
              if (name !== 'electron') throw new Error('unexpected module')
              return electron
            },
          })
          // Model an oversized transport response separately from the Electron capture contract.
          return scenario === 'transport-too-large' && result
            ? { ...result, png: 'A'.repeat(24 * 1024 * 1024) }
            : result
        },
        evidenceDirectory: directory,
        receipt,
      }),
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

describe('before-panel observation', () => {
  it('accepts explicit connection evidence without creating a failure image', async () => {
    const app = await fixture()
    try {
      await app.observe(true)
      expect(app.receipt.before.uiProbe).toMatchObject({ connected: true })
      expect(await readdir(app.directory)).toEqual([])
      expect(app.captures()).toBe(0)
    } finally {
      await app.close()
    }
  })

  it.each([false, 'true', { value: true }])(
    'does not accept a truthy probe object with connected=%j',
    async (connected) => {
      const app = await fixture()
      try {
        await expect(app.observe(connected)).rejects.toBe(app.failure)
        expect(app.receipt.before.uiProbe).not.toMatchObject({ connected: true })
        expect(app.receipt.before.uiProbe).not.toHaveProperty('unknownFlag')
        expect(JSON.stringify(app.receipt)).not.toContain('untrusted payload')
        expect(app.receipt.before.failureImage).toMatchObject({
          googleConnectionsPanelAsserted: false,
        })
        expect(await readFile(app.output)).toEqual(png)
        if (process.platform !== 'win32') expect((await stat(app.output)).mode & 0o077).toBe(0)
      } finally {
        await app.close()
      }
    },
  )

  it.each([
    'ambiguous',
    'loading',
    'window-too-large',
    'image-too-large',
    'window-changed',
    'capture-failed',
    'transport-too-large',
    'existing-output',
  ] as const)(
    'retains the original failure and refuses unsafe/unavailable evidence: %s',
    async (scenario) => {
      const app = await fixture(scenario)
      try {
        await expect(app.observe(false)).rejects.toBe(app.failure)
        expect(app.receipt.before.failureImage).toMatchObject({ outcome: 'unavailable' })
        if (scenario === 'existing-output')
          expect(await readFile(app.output, 'utf8')).toBe('retained evidence')
        else await expect(stat(app.output)).rejects.toMatchObject({ code: 'ENOENT' })
        if (['ambiguous', 'loading', 'window-too-large'].includes(scenario))
          expect(app.captures()).toBe(0)
        if (scenario === 'image-too-large') expect(app.encodes()).toBe(0)
      } finally {
        await app.close()
      }
    },
  )
})
