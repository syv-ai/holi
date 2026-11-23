import { createClaudeCli } from '../src/plugins/agent/main/claude/cli'

const [bin, root, configDir, evidenceFile] = process.argv.slice(2)
if (!bin || !root || !configDir || !evidenceFile) {
  throw new Error('Usage: worker <claude-bin> <owned-root> <config-dir> <evidence-file>')
}

const cli = createClaudeCli({ resolveBin: () => bin, log: (line) => console.error(line) })
const target = { root, configDir, binDir: null }
const evidence: Record<string, unknown> = {
  scope: 'native background lifecycle only; model turn and notification unverified',
}
let start: Awaited<ReturnType<typeof cli.startBg>> | undefined
try {
  start = await cli.startBg(target, {
    name: 'Holi native background fixture',
    prompt: 'Lifecycle probe only',
  })
  evidence.start = start.ok ? { ok: true, id: start.id } : { ok: false, message: start.message }
  if (start.ok) evidence.agents = await cli.list(target)
} catch (error) {
  evidence.error = String(error)
} finally {
  if (start?.ok) {
    try {
      evidence.stop = await cli.stop(target, start.id)
    } catch (error) {
      evidence.stopError = String(error)
    }
    try {
      evidence.remove = await cli.rm(target, start.id)
    } catch (error) {
      evidence.removeError = String(error)
    }
  }
  const lease = start && 'lease' in start ? start.lease : undefined
  if (lease) {
    try {
      await lease.revoke()
      evidence.leaseRevoked = true
    } catch (error) {
      evidence.leaseError = String(error)
    }
  }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(evidenceFile, JSON.stringify(evidence, null, 2))
}
console.log(JSON.stringify(evidence))
