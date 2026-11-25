import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { verifyCodexTuiProvenance } from './codex-tui-provenance.mjs'

async function installation(t) {
  const root = await mkdtemp(join(tmpdir(), 'holi-tui-package-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'node_modules/@openai/codex')
  const nativeRoot = join(root, 'node_modules/@openai/codex-darwin-arm64')
  const executable = join(nativeRoot, 'vendor/aarch64-apple-darwin/bin/codex')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      version: '0.166.0',
      optionalDependencies: {
        '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.166.0-darwin-arm64',
      },
    }),
  )
  await writeFile(join(packageRoot, 'bin/codex.js'), '// synthetic package launcher')
  await writeFile(
    join(nativeRoot, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.166.0-darwin-arm64' }),
  )
  const bytes = Buffer.concat([
    Buffer.from('cffaedfe', 'hex'),
    Buffer.from('synthetic package bytes'),
  ])
  await writeFile(executable, bytes)
  await chmod(executable, 0o700)
  return { root, packageRoot, executable, bytes }
}

test('synthetic package layout binds the native payload, not its launcher', async (t) => {
  const fixture = await installation(t)
  const result = verifyCodexTuiProvenance(fixture.root, { platform: 'darwin', arch: 'arm64' })
  assert.equal(result.executable, fixture.executable)
  assert.equal(result.executableSha256, createHash('sha256').update(fixture.bytes).digest('hex'))
  assert.notEqual(result.executableSha256, result.launcherSha256)
})

test('wrong pinned package and wrapper-only payloads are rejected', async (t) => {
  const fixture = await installation(t)
  await writeFile(fixture.executable, '#!/usr/bin/env node\n')
  assert.throws(() => verifyCodexTuiProvenance(fixture.root, { platform: 'darwin', arch: 'arm64' }))
  await writeFile(fixture.executable, fixture.bytes)
  await writeFile(
    join(fixture.packageRoot, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.169.0' }),
  )
  assert.throws(() => verifyCodexTuiProvenance(fixture.root, { platform: 'darwin', arch: 'arm64' }))
})

test('a platform executable symlink cannot escape the owned installation', async (t) => {
  const fixture = await installation(t)
  const other = await mkdtemp(join(tmpdir(), 'holi-tui-foreign-test-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  const foreign = join(other, 'payload')
  await writeFile(foreign, fixture.bytes)
  await chmod(foreign, 0o700)
  await rm(fixture.executable)
  await symlink(foreign, fixture.executable)
  assert.throws(() => verifyCodexTuiProvenance(fixture.root, { platform: 'darwin', arch: 'arm64' }))
})
