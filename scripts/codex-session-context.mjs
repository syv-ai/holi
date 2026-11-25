#!/usr/bin/env node
import { mkdir, realpath, open } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { runNativeInitialFixture } from './codex-session-context-native.mjs'

const repositoryRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const schema = 'holi.codex-session-context.v1'
const roles = (request) =>
  Array.isArray(request?.input) &&
  request.input.some((item) => item.role === 'user') &&
  request.input.some((item) => item.role === 'developer')
const promptOf = (request) => {
  const user = request?.input?.filter((item) => item.role === 'user').at(-1)
  return typeof user?.content === 'string'
    ? user.content
    : user?.content?.map((part) => part.text ?? '').join('')
}

/** Validate retained observations before accepting a native feasibility classification. */
export function validateContextEvidence(value) {
  try {
    if (value?.schema !== schema || value.version !== '0.169.0') return false
    const native = value.native
    if (
      !native ||
      ![
        'incomplete-proof',
        'setup-unavailable',
        'demonstrated-unsupported-path',
        'supported',
      ].includes(value.outcome)
    )
      return false
    if (['incomplete-proof', 'setup-unavailable'].includes(value.outcome))
      return native.status !== 'demonstrated'
    if (
      native.status !== 'demonstrated' ||
      native.version !== 'codex-cli 0.169.0' ||
      native.package?.name !== '@openai/codex' ||
      native.package.version !== '0.169.0'
    )
      return false
    if (
      !native.source?.commit ||
      native.source.dirty !== false ||
      !native.containment?.loopback ||
      !['EPERM', 'EACCES'].includes(native.containment.external)
    )
      return false
    if (
      !native.drainage ||
      !native.rootRemoved ||
      native.cleanupError ||
      !native.receipts?.length ||
      !native.receipts.every((receipt) => receipt.drained)
    )
      return false
    if (
      native.initial?.status !== 'demonstrated' ||
      native.resume?.status !== 'demonstrated' ||
      !roles(native.initial.request) ||
      !roles(native.resume.request)
    )
      return false
    if (
      !native.hooks?.some(
        (event) => event.source === 'startup' && event.session_id === native.resume.session,
      ) ||
      !native.hooks.some(
        (event) => event.source === 'resume' && event.session_id === native.resume.session,
      )
    )
      return false
    if (
      promptOf(native.initial.request) !== 'HOLI764_UNCHANGED_USER_PROMPT' ||
      promptOf(native.resume.request) !== 'HOLI764_RESUME_PROMPT'
    )
      return false
    for (const [observation, marker] of [
      [native.initial, 'startup'],
      [native.resume, 'resume'],
    ]) {
      const body = JSON.stringify(observation.request)
      if (
        !body.includes(`HOLI764_ADDITIVE_CONTEXT:${marker}`) ||
        !body.includes('HOLI764_CONFIG_INSTRUCTIONS') ||
        !body.includes('HOLI764_PROFILE_INSTRUCTIONS')
      )
        return false
    }
    if (
      !native.consent?.some((input) => input.label === 'trust-exact-owned-hook') ||
      !native.trustChanges?.some(
        (change) =>
          !change.before.includes('trusted_hash') &&
          change.after.includes('trusted_hash = "sha256:'),
      )
    )
      return false
    if (!native.approvalTranscript?.includes('owned-context-hook.mjs')) return false
    if (
      native.negativeControls?.length !== 2 ||
      !native.negativeControls.every(
        (item, index) =>
          item.label === ['unrelated-hook', 'modified-hook'][index] &&
          item.status === 'demonstrated' &&
          item.deniedHookExecuted === false &&
          roles(item.request),
      )
    )
      return false
    const [unrelated, modified] = native.negativeControls
    if (
      !JSON.stringify(unrelated.request).includes('HOLI764_ADDITIVE_CONTEXT') ||
      JSON.stringify(modified.request).includes('HOLI764_ADDITIVE_CONTEXT') ||
      modified.afterEvents !== modified.beforeEvents
    )
      return false
    const restricted = native.restricted
    if (
      restricted?.launches?.length !== 2 ||
      restricted.requests?.length !== 2 ||
      !restricted.launches.every((item) => item.exit?.code === 0) ||
      !restricted.requests.every((item) => roles(item.body)) ||
      restricted.projectIntegrationExecuted !== false
    )
      return false
    if (value.outcome === 'demonstrated-unsupported-path')
      return (
        restricted.status === 'demonstrated-unsupported' &&
        typeof restricted.limitation === 'string' &&
        restricted.requests.every(
          (item) => !JSON.stringify(item.body).includes('HOLI764_ADDITIVE_CONTEXT'),
        )
      )
    return restricted.status === 'demonstrated'
  } catch {
    return false
  }
}

/** Run the isolated native matrix and retain its complete private evidence outside the checkout. */
export async function runContextHarness({
  output = process.env.HOLI_CODEX_CONTEXT_EVIDENCE ??
    join(tmpdir(), `holi764-evidence-${randomUUID()}.json`),
  nativeRunner = runNativeInitialFixture,
} = {}) {
  const path = resolve(output)
  await mkdir(dirname(path), { recursive: true })
  const parent = await realpath(dirname(path))
  const rel = relative(repositoryRoot, parent)
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)))
    throw Error('Evidence output must be outside the repository')
  const artifact = await open(path, 'wx', 0o600)
  try {
    let native
    try {
      native = await nativeRunner()
    } catch (error) {
      native = { status: 'incomplete', error: String(error) }
    }
    const evidence = {
      schema,
      version: '0.169.0',
      outcome:
        native.status === 'demonstrated' ? 'demonstrated-unsupported-path' : 'incomplete-proof',
      native,
    }
    if (!validateContextEvidence(evidence) && native.status === 'demonstrated') {
      evidence.outcome = 'incomplete-proof'
      evidence.validationError =
        'Required native observations or clean source provenance are missing'
      native.status = 'incomplete'
    }
    const bytes = JSON.stringify(evidence, null, 2)
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024)
      throw Error('Context evidence byte bound exceeded')
    await artifact.writeFile(`${bytes}\n`)
    return { evidence, output: path }
  } finally {
    await artifact.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runContextHarness()
  process.stdout.write(
    `${JSON.stringify({ outcome: result.evidence.outcome, output: result.output, error: result.evidence.native.error })}\n`,
  )
  if (!['supported', 'demonstrated-unsupported-path'].includes(result.evidence.outcome))
    process.exitCode = 1
}
