import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Script } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

const source = ts.createSourceFile(
  'windows-agent-smoke.ts',
  readFileSync(new URL('../scripts/windows-agent-smoke.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.ESNext,
  true,
)
const main = source.statements.find(
  (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'main',
)
const entry = source.statements.at(-1)
assert(main && entry && ts.isExpressionStatement(entry) && ts.isVoidExpression(entry.expression))
// Execute the real finalizer and error handler, without booting Electron or running the
// native probes. Unwrap the entrypoint's `void` so the test can await its completion.
const finalization = new Script(
  ts.transpileModule(`${main.getText(source)}\n${entry.expression.expression.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText,
  { filename: source.fileName },
)

async function finishSmoke(cleanupError?: Error) {
  const root = mkdtempSync(join(tmpdir(), 'holi-smoke-report-'))
  const reportPath = join(root, 'smoke-result.json')
  const steps: string[] = []
  const errors: unknown[] = []
  let quit: ReturnType<typeof setImmediate> | undefined
  let observedExit: { code: number; report: string | undefined } | undefined
  const exit = (code: number) => {
    if (observedExit) return
    clearImmediate(quit)
    steps.push(`exit ${code}`)
    observedExit = {
      code,
      report: existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : undefined,
    }
  }
  try {
    await finalization.runInNewContext({
      root,
      join,
      release,
      process: { platform: 'win32', versions: { electron: '43.0.0' } },
      checks: ['native fixture completed'],
      run: async () => {},
      cleanup: [
        async () => {
          await nextTurn()
          steps.push('cleanup')
          if (cleanupError) throw cleanupError
        },
      ],
      pendingPids: [[23, 42]],
      checkPidsGone: async () => {
        await nextTurn()
        steps.push('probe')
      },
      window: {
        destroy: () => {
          steps.push('destroy')
          quit = setImmediate(() => exit(0)) // Electron's implicit quit after the last window closes.
        },
      },
      writeFile: async (path: string, data: string, options: { flag: string }) => {
        // Opening the file can succeed before the event loop returns to complete the write.
        writeFileSync(path, '', options)
        await nextTurn()
        if (!observedExit) writeFileSync(path, data)
      },
      writeFileSync,
      app: { exit },
      console: { error: (error: unknown) => errors.push(error) },
    })
    return { observedExit, steps, errors }
  } finally {
    clearImmediate(quit)
    rmSync(root, { recursive: true, force: true })
  }
}

it('seals the dependency Electron smoke report before the first zero exit', async () => {
  const { observedExit, steps, errors } = await finishSmoke()
  expect(steps).toEqual(['cleanup', 'probe', 'destroy', 'exit 0'])
  expect(errors).toEqual([])
  expect(observedExit?.code).toBe(0)
  expect(JSON.parse(observedExit!.report!)).toEqual({
    ok: true,
    runtime: 'dependency-electron',
    platform: 'win32',
    platformVersion: release(),
    electron: '43.0.0',
    checks: ['native fixture completed'],
  })
})

it('probes and destroys the window but does not publish success when cleanup rejects', async () => {
  const failure = new Error('fixture cleanup failed')
  const { observedExit, steps, errors } = await finishSmoke(failure)
  expect(steps).toEqual(['cleanup', 'probe', 'destroy', 'exit 1'])
  expect(observedExit).toEqual({ code: 1, report: undefined })
  expect(errors).toEqual([expect.objectContaining({ errors: [failure] })])
})
