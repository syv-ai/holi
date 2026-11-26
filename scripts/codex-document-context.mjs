#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const schema = 'holi.codex-document-context.v1'

export function validateDocumentContextProof(proof) {
  const errors = []
  const fail = (message) => errors.push(message)
  if (!proof || proof.schema !== schema) fail('unsupported proof schema')
  const initial = proof?.initial
  const resumed = proof?.resumed
  for (const [name, capture] of [['initial', initial], ['resumed', resumed]]) {
    if (!capture || !Array.isArray(capture.messages)) { fail(`${name} capture is missing`); continue }
    if (!capture.messages.some((m) => m.role === 'developer' && m.content?.includes(capture.marker))) fail(`${name} document context was not captured as developer content`)
    if (!capture.messages.some((m) => m.role === 'user' && m.content?.includes(proof.prompt))) fail(`${name} user prompt is missing`)
    for (const instruction of proof.instructions ?? []) if (!capture.messages.some((m) => m.role === 'developer' && m.content?.includes(instruction))) fail(`${name} developer instruction is missing`)
  }
  if (initial && resumed && initial.conversationId !== resumed.conversationId) fail('resume did not use the same conversation')
  if (initial && resumed && initial.marker === resumed.marker) fail('resume did not prove fresh document context')
  if (!proof?.consent?.normalNativeFlow) fail('native consent evidence is missing')
  if (!proof?.cleanup?.verified) fail('owned resource cleanup is unverified')
  if (!proof?.provenance?.binary || !proof.provenance.argv || !proof.provenance.environment || !proof.provenance.config) fail('native provenance is incomplete')
  return { valid: errors.length === 0, errors }
}

export async function validateProofFile(path) {
  return validateDocumentContextProof(JSON.parse(await readFile(path, 'utf8')))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? 'codex-document-context-proof.json')
  try {
    const result = await validateProofFile(path)
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.valid ? 0 : 1
  } catch (error) {
    console.error(`Unable to read proof: ${error.message}`)
    process.exitCode = 1
  }
}
