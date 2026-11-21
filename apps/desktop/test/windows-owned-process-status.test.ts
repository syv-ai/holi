import { describe, expect, it } from 'vitest'
import { spawnOwnedProgram } from '../src/main/owned-process'
import { joinOwnedProgram } from '../src/main/owned-program-lifetime'
import { fixtureResult, within } from './fixtures/fixture-deadline'
import { registrationEvidence } from './fixtures/windows-owned-process-registration'
import {
  registrationStopEvidence,
  statusCaseMs,
  statusWaitMs,
  withStatusProducer,
} from './fixtures/windows-owned-process-status'

function nativeExitCommand(code: number, nonce: string) {
  // Inline -Command, not a script file or a PowerShell/Node exit-code conversion.
  // The decimal uint literal is compiled by C#, then passed to the kernel directly.
  const source = `using System.Runtime.InteropServices; public static class HoliFixtureExit {
    [DllImport("kernel32.dll", ExactSpelling=true)] private static extern void ExitProcess(uint code);
    public static void Release() { ExitProcess(${code}u); }
  }`.replace(/\s+/g, ' ')
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition '${source}'`,
    `$nonce = '${nonce}'`,
    '$dir = (Get-Location).ProviderPath',
    "$tmp = [IO.Path]::Combine($dir, 'root.tmp')",
    `[IO.File]::WriteAllText($tmp, ('{"pid":'+$PID+',"nonce":"'+$nonce+'"}'))`,
    "[IO.File]::Move($tmp, [IO.Path]::Combine($dir, 'root.json'))",
    '$watch = [Diagnostics.Stopwatch]::StartNew()',
    "while (![IO.File]::Exists([IO.Path]::Combine($dir, 'release-status'))) { if ($watch.ElapsedMilliseconds -ge 45000 -or ![IO.Directory]::Exists($dir) -or [IO.File]::Exists([IO.Path]::Combine($dir, 'abort'))) { exit 2 }; Start-Sleep -Milliseconds 20 }",
    '[HoliFixtureExit]::Release()',
    'throw "ExitProcess returned"',
  ].join('; ')
}

const abortCase = 'preserves AbortError and authenticates EMPTY for a live native tree'
const exitCases = [
  { caseName: 'preserves native ExitProcess DWORD 259', code: 259 },
  { caseName: 'preserves native ExitProcess DWORD 0x80000017', code: 0x80000017 },
]

const registrationCases = [
  ['recovers one parent Job slot after the helper dies before SETUP', 'after-first-dup', false],
  ['recovers both parent Job slots after the helper dies before SETUP', 'after-both-dups', false],
  [
    'revokes adopted Job slots when REGISTERED is dropped before Root admission',
    'drop-registered',
    false,
  ],
  [
    'keeps a reused parent slot open after losing the adopted revoke receipt',
    'drop-registered',
    true,
  ],
] as const

describe.skipIf(process.platform !== 'win32')('native owned process status', () => {
  for (const [caseName, point, loseReceipt] of registrationCases) {
    it(
      caseName,
      async () => {
        const { proof, cleanup } = await registrationEvidence(point, loseReceipt)
        console.log(
          `HOLI_WINDOWS_OWNED_PRODUCER_PROOF ${JSON.stringify({ caseName, proof, cleanup })}`,
        )
      },
      statusCaseMs,
    )
  }

  for (const mode of ['ordinary', 'retained'] as const) {
    const caseName = `does not create the ${mode} Root when STOP is queued before AUTH`
    it(
      caseName,
      async () => {
        const { proof, cleanup } = await registrationStopEvidence(mode)
        console.log(
          `HOLI_WINDOWS_OWNED_PRODUCER_PROOF ${JSON.stringify({ caseName, proof, cleanup })}`,
        )
      },
      statusCaseMs,
    )
  }

  it(
    abortCase,
    async () => {
      const { proof, cleanup } = await withStatusProducer({ tree: true }, async (fixture) => {
        const controller = new AbortController()
        const { child, original } = fixture.start(() =>
          spawnOwnedProgram(fixture.nodeImage, fixture.treeArgs, {
            cwd: fixture.dir,
            signal: controller.signal,
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        )
        const errors = fixtureResult<Error>()
        child.on('error', (error) => errors.settle({ value: error }))
        const joined = joinOwnedProgram(child, 'win32')
        await fixture.holdRoot()
        const rootAliveBeforeAbort = !(await fixture.exited('root'))
        const grandchildAliveBeforeAbort = !(await fixture.exited('grandchild'))
        expect(rootAliveBeforeAbort && grandchildAliveBeforeAbort).toBe(true)
        const reason = new Error('native fixture cancelled')
        controller.abort(reason)
        const abortError = (await errors.wait(
          statusWaitMs,
          'original AbortError event',
        )) as NodeJS.ErrnoException
        const { name: errorName, code: errorCode } = abortError
        expect(errorName).toBe('AbortError')
        expect(errorCode).toBe('ABORT_ERR')
        const reasonPreserved = abortError.cause === reason && controller.signal.reason === reason
        expect(reasonPreserved).toBe(true)
        const result = await within(joined, statusWaitMs, 'aborted owned program join')
        const sameError = result.error === abortError
        expect(sameError).toBe(true)
        expect(result).toMatchObject({ code: 1, signal: null, ownership: 'empty' })
        const receipt = await within(original, statusWaitMs, 'original abort receipt')
        const sameReceipt = child.ownedCompletion === original
        expect(receipt).toBe('empty')
        expect(sameReceipt).toBe(true)
        // Child completion observes and records the operation error; the stable
        // helper status comes from joining actual close, not waiting on that error.
        const { helperExitCode } = await fixture.helperStatus()
        expect(helperExitCode).toBe(1)
        return {
          kind: 'abort',
          receipt,
          sameReceipt,
          errorName,
          errorCode,
          reasonPreserved,
          sameError,
          helperExitCode,
          rootAliveBeforeAbort,
          grandchildAliveBeforeAbort,
          joinOwnership: result.ownership,
        }
      })
      console.log(
        `HOLI_WINDOWS_OWNED_PRODUCER_PROOF ${JSON.stringify({ caseName: abortCase, proof, cleanup })}`,
      )
    },
    statusCaseMs,
  )

  for (const { caseName, code } of exitCases) {
    it(
      caseName,
      async () => {
        const { proof, cleanup } = await withStatusProducer({}, async (fixture) => {
          const { child, original } = fixture.start(() =>
            spawnOwnedProgram(
              fixture.powershell,
              [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                nativeExitCommand(code, fixture.nonce),
              ],
              { cwd: fixture.dir, stdio: ['ignore', 'pipe', 'pipe'] },
            ),
          )
          const joined = joinOwnedProgram(child, 'win32')
          await fixture.holdRoot(fixture.powershell)
          const rootAliveBeforeRelease = !(await fixture.exited('root'))
          expect(rootAliveBeforeRelease).toBe(true)
          await fixture.mark('release-status')
          const rootExitCode = await fixture.exitCode('root')
          expect(rootExitCode).toBe(code)
          const receipt = await within(original, statusWaitMs, 'original native status receipt')
          const sameReceipt = child.ownedCompletion === original
          expect(receipt).toBe('empty')
          expect(sameReceipt).toBe(true)
          const { helperExitCode, nodeExitCode } = await fixture.helperStatus()
          expect(helperExitCode).toBe(rootExitCode)
          expect(await within(joined, statusWaitMs, 'native status join')).toEqual({
            code: nodeExitCode,
            signal: null,
            error: null,
            ownership: receipt,
          })
          return {
            kind: 'exit-status',
            receipt,
            sameReceipt,
            rootAliveBeforeRelease,
            rootExitCode,
            helperExitCode,
            nodeExitCode,
          }
        })
        console.log(
          `HOLI_WINDOWS_OWNED_PRODUCER_PROOF ${JSON.stringify({ caseName, proof, cleanup })}`,
        )
      },
      statusCaseMs,
    )
  }
})
