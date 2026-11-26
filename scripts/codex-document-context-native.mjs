#!/usr/bin/env node
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { schema } from './codex-document-context.mjs'

const version = '0.169.0'
export async function runNativeDocumentContext({ output = resolve('codex-document-context-proof.json') } = {}) {
  const binary = process.env.CODEX_BIN
  if (!binary) throw new Error('Set CODEX_BIN to the already-installed Codex 0.169.0 binary; this runner never downloads it.')
  await access(binary)
  const versionResult = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (versionResult.status !== 0 || !versionResult.stdout.includes(version)) throw new Error(`Expected native Codex ${version}`)
  const root = await mkdtemp(join(tmpdir(), 'holi-codex-document-context-'))
  const home = join(root, 'home'), project = join(root, 'project'), codexHome = join(root, 'codex')
  await Promise.all([mkdir(home), mkdir(project), mkdir(codexHome)])
  const marker1 = `HOLI_DOC_${randomUUID()}`, marker2 = `HOLI_DOC_${randomUUID()}`
  await writeFile(join(project, 'document.md'), marker1)
  const provenance = { binary: resolve(binary), version: versionResult.stdout.trim(), argv: null, environment: { HOME: home, CODEX_HOME: codexHome }, config: join(codexHome, 'config.toml') }
  try {
    throw new Error('Native Responses capture and consent recording are not implemented; refusing to launch Codex without the loopback capture fixture.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) runNativeDocumentContext().catch((e) => { console.error(e.message); process.exitCode = 1 })
