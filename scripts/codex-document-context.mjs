#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const schema = 'holi.codex-document-context.v1'
const text = (item) =>
  typeof item?.content === 'string'
    ? item.content
    : (Array.isArray(item?.content) ? item.content : []).map((part) => part.text ?? '').join('')
const contains = (request, role, marker) =>
  typeof marker === 'string' &&
  marker.length > 0 &&
  request?.input?.some((item) => item.role === role && text(item).includes(marker))

/** Verify captured native requests and lifecycle observations, not serialized marker presence. */
export function validateDocumentContextProof(proof) {
  const errors = []
  const fail = (condition, message) => {
    if (!condition) errors.push(message)
  }
  fail(proof?.schema === schema, 'unsupported proof schema')
  fail(!proof?.error, 'native producer recorded an error')
  fail(!proof?.transcripts?.some((entry) => entry.failure), 'native process recorded a failure')
  fail(
    !proof?.cleanup?.receipts?.some((entry) => entry.error || entry.failure),
    'native cleanup receipt recorded a failure',
  )
  const expected = proof?.expected
  const initial = proof?.initial
  const resumed = proof?.resumed
  for (const [name, capture] of [
    ['baseline', proof?.baseline],
    ['initial', initial],
    ['resumed', resumed],
  ]) {
    const request = capture?.request
    fail(Array.isArray(request?.input), `${name} request missing`)
    fail(
      contains(request, 'developer', expected?.developer),
      `${name} effective developer instructions missing`,
    )
    fail(
      typeof expected?.excluded === 'string' &&
        !JSON.stringify(request ?? {}).includes(expected.excluded),
      `${name} profile precedence missing`,
    )
    fail(contains(request, 'developer', expected?.model), `${name} model instructions missing`)
    fail(
      contains(request, 'user', expected?.project),
      `${name} native project instructions missing`,
    )
    const user = request?.input?.filter((item) => item.role === 'user').at(-1)
    fail(
      typeof proof?.prompt === 'string' && proof.prompt.length > 0 && text(user) === proof.prompt,
      `${name} user prompt changed`,
    )
    if (name !== 'baseline')
      fail(
        contains(request, 'developer', capture?.marker),
        `${name} fresh document context missing from developer role`,
      )
  }
  fail(
    typeof initial?.conversationId === 'string' &&
      /^[0-9a-f-]{36}$/.test(initial.conversationId) &&
      initial.conversationId === resumed?.conversationId,
    'same native conversation was not resumed',
  )
  fail(
    typeof initial?.marker === 'string' &&
      typeof resumed?.marker === 'string' &&
      initial.marker !== resumed.marker,
    'resume document marker did not change',
  )
  const input = resumed?.request?.input ?? []
  const priorUser = input
    .map((item, i) => (item.role === 'user' && text(item) === proof?.prompt ? i : -1))
    .filter((i) => i >= 0)
  const fresh = input.findIndex(
    (item) =>
      item.role === 'developer' &&
      typeof resumed?.marker === 'string' &&
      text(item).includes(resumed.marker),
  )
  fail(
    priorUser.length >= 2 && fresh > priorUser.at(-2) && fresh < priorUser.at(-1),
    'resumed context is not fresh current-turn input',
  )
  const consent = proof?.consent
  fail(
    typeof consent?.before === 'string' &&
      !consent.before.includes('trusted_hash') &&
      consent?.after?.includes('trusted_hash = "sha256:') &&
      consent?.transcript?.includes('Trusted') &&
      consent.transcript.includes(consent.hook),
    'normal native consent observations missing',
  )
  fail(
    proof?.containment?.loopback === true &&
      ['EPERM', 'EACCES'].includes(proof?.containment?.external),
    'network containment unproven',
  )
  fail(proof?.sourcesUnchanged === true, 'synthetic instruction sources changed')
  fail(
    proof?.provenance?.version === 'codex-cli 0.169.0' &&
      /^[0-9a-f]{64}$/.test(proof?.provenance?.binaryHash ?? '') &&
      proof.provenance.launches?.length > 0 &&
      proof.provenance.config?.profile,
    'native provenance incomplete',
  )
  const cleanup = proof?.cleanup
  fail(
    cleanup?.rootRemoved === true &&
      cleanup?.serverClosed === true &&
      !cleanup.error &&
      cleanup.receipts?.length === proof?.provenance?.launches?.length &&
      cleanup.receipts?.length > 0 &&
      cleanup.receipts.every((receipt) => receipt.drained),
    'owned resources not demonstrably cleaned',
  )
  return { valid: errors.length === 0, errors }
}

export async function validateProofFile(path) {
  return validateDocumentContextProof(JSON.parse(await readFile(path, 'utf8')))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await validateProofFile(
      resolve(process.argv[2] ?? 'codex-document-context-proof.json'),
    )
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.valid ? 0 : 1
  } catch (error) {
    console.error(`Unable to read proof: ${error.message}`)
    process.exitCode = 1
  }
}
