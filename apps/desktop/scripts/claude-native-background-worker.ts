import { writeFile } from 'node:fs/promises'
import { createClaudeCli } from '../src/plugins/agent/main/claude/cli'

const cli = createClaudeCli({
  resolveBin: () => process.env.HOLI_NATIVE_WRAPPER!,
  log: console.error,
})
const target = { root: process.cwd(), configDir: process.env.CLAUDE_CONFIG_DIR!, binDir: null }
const evidence: Record<string, unknown> = {}
let start: Awaited<ReturnType<typeof cli.startBg>> | undefined
try {
  start = await cli.startBg(target, { name: 'Holi fixture', prompt: 'Reply with fixture response' })
  evidence.start = start.ok ? { ok: true, id: start.id } : { ok: false, message: start.message }
  if (!start.ok) throw new Error(start.message)
  const id = start.id
  const listing = await cli.list(target)    evidence.list = JSON.parse(listing)
if (
    !Array.isArray(evidence.list) ||
    !evidence.list.some(
      (row) => row.id === id && row.cwd === target.root && row.kind === 'background',
    )
  )
    throw new Error('Native listing did not preserve session and vault')
  const observation = await cli.run(target, ['--print', '--resume', id, 'Reply with the exact marker HOLI_NATIVE_STREAM_MARKER_7f3c'])
  evidence.nativeObservation = observation.output
  if (!observation.output.includes('HOLI_NATIVE_STREAM_MARKER_7f3c'))
    throw new Error('Native CLI did not observe the completed streamed response marker')
} catch (error) {
  evidence.error = String(error)
  process.exitCode = 1
} finally {
  if (start?.ok) {
    for (const action of ['stop', 'rm'] as const) {
      try {
        const result = await cli[action](target, start.id)
        evidence[action] = result.ok ? { ok: true } : { ok: false, message: result.message }
        if (!result.ok) process.exitCode = 1
      } catch (error) {
        evidence[action] = { ok: false, error: String(error) }
        process.exitCode = 1
      }
    }
  }
  const lease =
    start &&
    ('lease' in start
      ? start.lease
      : 'error' in start
        ? (start.error as { lease?: { revoke(): Promise<void> } } | undefined)?.lease
        : undefined)
  if (lease) {
    try {
      await lease.revoke()
      evidence.leaseRevoked = true
    } catch (error) {
      evidence.leaseError = String(error)
      process.exitCode = 1
    }
  }
  await writeFile(process.env.HOLI_NATIVE_WORKER_RESULT!, JSON.stringify(evidence))
}
