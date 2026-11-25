#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { mkdtemp, realpath } from 'node:fs/promises'
import { runProducerProof } from './codex-exec-producer.mjs'

const VERSION = '0.169.0'
const SCHEMA = 'holi.codex-session-context.v1'
const SCENARIOS = ['initialTUI', 'exact-conversation-resume', 'restrictedexec-follow-up']
const OUTCOMES = new Set([
  'supported',
  'demonstrated-unsupported-path',
  'setup-unavailable',
  'incomplete-proof',
])
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Accept only complete observations tied to the pinned package and an owned cleanup receipt. */
export function validateContextEvidence(value) {
  if (
    !value ||
    value.schema !== SCHEMA ||
    value.version !== VERSION ||
    !OUTCOMES.has(value.outcome)
  )
    return false
  if (
    !value.provenance ||
    value.provenance.package !== '@openai/codex' ||
    value.provenance.version !== VERSION ||
    !value.provenance.source ||
    !Array.isArray(value.provenance.argv)
  )
    return false
  if (
    !Array.isArray(value.scenarios) ||
    value.scenarios.length !== SCENARIOS.length ||
    value.scenarios.some((s, i) => s?.name !== SCENARIOS[i])
  )
    return false
  if (
    !Array.isArray(value.modelRequests) ||
    !value.modelRequests.length ||
    value.modelRequests.some((r) => !r?.url || !Array.isArray(r.roles) || !r.roles.includes('user'))
  )
    return false
  if (
    !Array.isArray(value.consent) ||
    !Array.isArray(value.trustChanges) ||
    !Array.isArray(value.hookEvents) ||
    !Array.isArray(value.isolation)
  )
    return false
  if (
    !value.cleanup ||
    value.cleanup.verified !== true ||
    value.cleanup.ownedRootRemoved !== true ||
    value.cleanup.processesDrained !== true
  )
    return false
  if (
    value.outcome === 'supported' &&
    value.scenarios.some((s) => s.status !== 'demonstrated' || !s.evidence)
  )
    return false
  if (
    value.outcome === 'demonstrated-unsupported-path' &&
    !value.scenarios.some((s) => s.status === 'demonstrated-unsupported' && s.evidence)
  )
    return false
  if (
    ['setup-unavailable', 'incomplete-proof'].includes(value.outcome) &&
    value.scenarios.some((s) => s.status === 'demonstrated-unsupported')
  )
    return false
  return true
}

export async function runContextHarness({
  output = process.env.HOLI_CODEX_CONTEXT_EVIDENCE,
  proofRunner = runProducerProof,
} = {}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), `holi764-${randomUUID()}-`)))
  const evidence = {
    schema: SCHEMA,
    version: VERSION,
    outcome: 'incomplete-proof',
    provenance: {
      package: '@openai/codex',
      version: VERSION,
      source: 'npm registry package; exact source not yet established',
      argv: [],
    },
    scenarios: SCENARIOS.map((name) => ({ name, status: 'not-run' })),
    consent: [],
    trustChanges: [],
    hookEvents: [],
    modelRequests: [],
    isolation: [],
    cleanup: { verified: false, ownedRoot: root, ownedRootRemoved: false, processesDrained: false },
  }
  try {
    // The existing executable producer proves the isolated package install/version and
    // synthetic loopback transport. It is not evidence for native TUI or hook semantics.
    const producer = await proofRunner()
    evidence.provenance = {
      package: '@openai/codex',
      version: VERSION,
      source: producer.evidence?.native?.bin ?? 'pinned-package-install',
      argv:
        producer.evidence?.native?.scenarios?.flatMap(
          (s) => s.processes?.flatMap((p) => p.args) ?? [],
        ) ?? [],
    }
    evidence.producer = producer.evidence
    evidence.outcome =
      producer.evidence?.classification === 'setup-unavailable'
        ? 'setup-unavailable'
        : 'incomplete-proof'
  } catch (error) {
    evidence.error = String(error)
  } finally {
    // Keep the uniquely-owned root and bounded evidence for inspection; only remove
    // after verified drainage. This runner currently launches no child processes itself.
    evidence.cleanup.processesDrained = true
    evidence.cleanup.ownedRootRemoved = false
    evidence.cleanup.verified = false
  }
  if (output) {
    const path = resolve(output)
    if (path.startsWith(`${repositoryRoot}/`))
      throw new Error('Evidence output must be outside the repository')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  }
  return evidence
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await runContextHarness()
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  process.exitCode = evidence.outcome === 'incomplete-proof' ? 2 : 1
}
