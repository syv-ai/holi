import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
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
  const listing = await cli.list(target)
  if (listing === null) throw new Error('Native session listing unavailable')
  evidence.list = JSON.parse(listing)
  if (
    !Array.isArray(evidence.list) ||
    !evidence.list.some(
      (row) => row.id === id && row.cwd === target.root && row.kind === 'background',
    )
  )
    throw new Error('Native listing did not preserve session and vault')
  const row = evidence.list.find((entry) => entry.id === id)
  if (!/^[0-9a-f-]{36}$/.test(row.sessionId)) throw new Error('Native conversation id missing')
  const projects = join(target.configDir, 'projects')
  const deadline = Date.now() + 15_000
  let completion
  while (Date.now() < deadline && !completion) {
    const dirs = await readdir(projects, { withFileTypes: true }).catch(() => [])
    for (const dir of dirs.slice(0, 16)) {
      if (!dir.isDirectory()) continue
      const text = await readFile(join(projects, dir.name, `${row.sessionId}.jsonl`), 'utf8').catch(
        () => '',
      )
      for (const line of text.split('\n')) {
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (
          record.sessionId === row.sessionId &&
          record.type === 'assistant' &&
          record.message?.role === 'assistant' &&
          record.message.stop_reason === 'end_turn' &&
          record.message.content?.some(
            (part: { type?: string; text?: string }) =>
              part.type === 'text' && part.text === process.env.HOLI_NATIVE_EXPECTED_REPLY,
          )
        ) {
          completion = {
            sessionId: row.sessionId,
            messageId: record.message.id,
            stopReason: record.message.stop_reason,
            text: process.env.HOLI_NATIVE_EXPECTED_REPLY,
          }
        }
      }
    }
    if (!completion) await delay(100)
  }
  if (!completion) throw new Error('Completed native background assistant response not observed')
  evidence.nativeModelCompletion = completion
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
