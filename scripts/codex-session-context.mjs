#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.169.0'
const SCHEMA = 'holi.codex-session-context.v1'
const OUTCOMES = new Set(['supported', 'demonstrated-unsupported-path', 'setup-unavailable', 'incomplete-proof'])
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Validate bounded evidence without promoting missing or partial observations to a verdict. */
export function validateContextEvidence(value) {
  if (!value || value.schema !== SCHEMA || value.version !== VERSION || !OUTCOMES.has(value.outcome)) return false
  if (!Array.isArray(value.scenarios) || value.scenarios.length > 12) return false
  if (!value.provenance || !Array.isArray(value.modelRequests) || value.modelRequests.length > 20) return false
  if (!value.cleanup || typeof value.cleanup.verified !== 'boolean') return false
  if (value.outcome === 'supported' && (!value.cleanup.verified || value.scenarios.some((s) => s.status !== 'demonstrated'))) return false
  if (value.outcome === 'demonstrated-unsupported-path' && !value.scenarios.some((s) => s.status === 'demonstrated-unsupported')) return false
  return true
}

export async function runContextHarness({ output = process.env.HOLI_CODEX_CONTEXT_EVIDENCE } = {}) {
  const evidence = {
    schema: SCHEMA,
    version: VERSION,
    source: { commit: 'unrecorded', dirty: true },
    outcome: 'incomplete-proof',
    limitation: 'Native scenario runner is not implemented; no native execution or model request was attempted.',
    scenarios: ['initialTUI', 'exact-conversation-resume', 'restrictedexec-follow-up'].map((name) => ({ name, status: 'not-run' })),
    provenance: null,
    consent: [],
    trustChanges: [],
    hookEvents: [],
    modelRequests: [],
    isolation: [],
    cleanup: { verified: false },
  }
  if (output) {
    const path = resolve(output)
    if (!path.startsWith(`${repositoryRoot}/`)) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    } else throw new Error('Evidence output must be outside the repository')
  }
  return evidence
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await runContextHarness()
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
}
