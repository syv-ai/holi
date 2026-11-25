import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { finalizeElectronSmoke } from '../scripts/windows-agent-smoke-finalization'

async function finishSmoke(failureAt?: 'run' | 'cleanup') {
  const root = mkdtempSync(join(tmpdir(), 'holi-smoke-report-'))
  const reportPath = join(root, 'smoke-result.json')
  const resource = join(root, 'fixture-resource')
  writeFileSync(resource, 'retained until cleanup')
  const failure = new Error('fixture failed')
  let quit: ReturnType<typeof setImmediate> | undefined
  let observedExit:
    | { code: number; report: string | undefined; resourcePresent: boolean; windowClosed: boolean }
    | undefined
  let cleaned = false
  let closed = false
  const exit = (code: number) => {
    if (observedExit) return
    clearImmediate(quit)
    observedExit = {
      code,
      resourcePresent: existsSync(resource),
      windowClosed: closed,
      report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined,
    }
  }
  const record = {
    ok: true,
    runtime: 'dependency-electron',
    checks: ['fixture stage'],
    ownedPty: { schema: 'fixture-payload' },
  }
  try {
    await finalizeElectronSmoke({
      reportPath,
      run: async () => {
        if (failureAt === 'run') throw failure
        return record
      },
      cleanup: async () => {
        await nextTurn()
        cleaned = true
        if (failureAt === 'cleanup') throw failure
        rmSync(resource)
      },
      closeWindow: () => {
        closed = true
        // Model Electron's implicit quit after the last window closes.
        quit = setImmediate(() => exit(0))
      },
      exit,
    }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toContain(failure)
      exit(1)
    })
    return { observedExit, cleaned, closed, record }
  } finally {
    clearImmediate(quit)
    rmSync(root, { recursive: true, force: true })
  }
}

it('seals the complete smoke report before the first zero exit', async () => {
  const { observedExit, cleaned, closed, record } = await finishSmoke()
  expect(cleaned && closed).toBe(true)
  expect(observedExit).toMatchObject({ code: 0, resourcePresent: false, windowClosed: true })
  expect(JSON.parse(observedExit!.report!)).toEqual(record)
})

it.each(['run', 'cleanup'] as const)(
  'still cleans and closes but never publishes success after %s failure',
  async (phase) => {
    const { observedExit, cleaned, closed } = await finishSmoke(phase)
    expect(cleaned && closed).toBe(true)
    expect(observedExit).toEqual({
      code: 1,
      report: undefined,
      resourcePresent: phase === 'cleanup',
      windowClosed: true,
    })
  },
)
