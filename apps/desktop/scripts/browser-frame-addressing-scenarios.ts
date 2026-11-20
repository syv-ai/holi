import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import type { Check, PhaseInput } from './browser-frame-addressing-phase-fixture'
import { runBoundedCaptureChurn } from './browser-frame-addressing-churn'
import { runStaticIdentityAndOwnerOracle } from './browser-frame-addressing-identity'
import { runMutationOwnerMatrices } from './browser-frame-addressing-mutations'
import { runPreDispatchCrossProcessNavigation } from './browser-frame-addressing-pre-dispatch'
import { runPendingResolutionNavigation } from './browser-frame-addressing-pending-resolution'
import { runPendingEvaluationAndCrossProcessNavigation } from './browser-frame-addressing-pending-evaluation'
import { runDetachAndReplacement } from './browser-frame-addressing-detach-replacement'
import { runPresentationAbaAndNativeInput } from './browser-frame-addressing-presentation'

export async function runFrameAddressingScenarios(input: {
  contents: WebContents
  window: BrowserWindow
  port: number
  evidence: string
  checks: string[]
  check: Check
}): Promise<void> {
  const phase: PhaseInput = { contents: input.contents, port: input.port, check: input.check }
  const frameProcessIds = await runStaticIdentityAndOwnerOracle(phase)
  await runMutationOwnerMatrices(phase)
  await runPreDispatchCrossProcessNavigation(phase)
  await runPendingResolutionNavigation(phase)
  await runPendingEvaluationAndCrossProcessNavigation(phase)
  await runDetachAndReplacement(phase)
  await runPresentationAbaAndNativeInput({ ...phase, window: input.window })
  await runBoundedCaptureChurn(phase)
  writeFileSync(
    join(input.evidence, 'proof.json'),
    JSON.stringify(
      {
        ok: true,
        checks: input.checks,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        frameProcessIds,
      },
      null,
      2,
    ),
  )
}
