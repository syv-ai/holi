import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runCompatibility } from './claude-compatibility.mjs'

async function fakeInstall(t, mode = 'good') {
  const temp = await mkdtemp(join(tmpdir(), 'holi-claude-runner-test-'))
  const npm = join(temp, 'npm-fake.mjs')
  const log = join(temp, 'argv.jsonl')
  await writeFile(
    npm,
    `#!/usr/bin/env node\nimport { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path';\nconst args=process.argv.slice(2); const prefix=args[args.indexOf('--prefix')+1];\nif (!args.includes('--ignore-scripts') || args.some(a=>a.includes('wrong-name'))) process.exit(3);\nconst bin=join(prefix,'node_modules','.bin'); await mkdir(bin,{recursive:true});\nawait writeFile(${JSON.stringify(log)},JSON.stringify(['install',...args])+'\\n',{flag:'a'}); await writeFile(${JSON.stringify(join(temp, 'env.json'))},JSON.stringify(Object.keys(process.env).sort()));\nawait writeFile(join(bin,'claude'), ${JSON.stringify(`#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
const args=process.argv.slice(2)
await writeFile(${JSON.stringify(log)}, JSON.stringify(args)+'\\n', {flag:'a'})
if(args[0]==='--version') process.stdout.write(${JSON.stringify(mode === 'wrong-version' ? '2.1.320 (Claude Code)' : '2.1.319 (Claude Code)')})
else if(args.at(-1)==='--help') process.stdout.write(${JSON.stringify(mode === 'empty-help' ? '' : mode === 'removed' ? 'Usage: claude' : mode === 'huge-output' ? 'x'.repeat(100000) : 'Usage: claude agents --json --all attach stop respawn rm --bg --name --resume --fork-session --model --append-system-prompt --mcp-config --allowedTools --disallowedTools --')})
if (${JSON.stringify(mode)} === 'nonzero' && args[0] === 'agents') process.exit(7)
if (${JSON.stringify(mode)} === 'timeout' && args[0] === 'agents') await new Promise(r=>setTimeout(r,1000))
`)});\nawait import('node:fs/promises').then(fs=>fs.chmod(join(bin,'claude'),0o755));\n`,
  )
  await chmod(npm, 0o755)
  t.after(async () => rm(temp, { recursive: true, force: true }))
  return { temp, npm, log }
}

test('runs the exact isolated install and probes only bounded help/version argv', async (t) => {
  const fake = await fakeInstall(t)
  const result = await runCompatibility('2.1.319', { npm: fake.npm, timeout: 3000 })
  assert.equal(result.failed, false, JSON.stringify(result.checks))
  assert.equal(result.checks[0].outcome, 'pass')
  const calls = (await readFile(fake.log, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(calls[0], [
    'install',
    'install',
    '--prefix',
    calls[0][3],
    '--no-save',
    '--ignore-scripts',
    '@anthropic-ai/claude-code@2.1.319',
  ])
  assert.deepEqual(
    (await readFile(join(fake.temp, 'env.json'), 'utf8').then(JSON.parse)).filter(
      (key) => key !== '__CF_USER_TEXT_ENCODING',
    ),
    [
      'CI',
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'PATH',
      'npm_config_cache',
      'npm_config_globalconfig',
      'npm_config_userconfig',
    ],
  )
  assert.deepEqual(calls.slice(1), [
    ['--version'],
    ['agents', '--help'],
    ['attach', '--help'],
    ['stop', '--help'],
    ['respawn', '--help'],
    ['rm', '--help'],
    ['--help'],
  ])
  assert.ok(
    calls
      .slice(1)
      .every((argv) => argv.length <= 2 && (argv[0] === '--version' || argv.at(-1) === '--help')),
  )
})

test('command-line runner writes only valid JSON to stdout', async (t) => {
  const fake = await fakeInstall(t)
  const npmShim = join(fake.temp, 'npm')
  await copyFile(fake.npm, npmShim)
  await chmod(npmShim, 0o755)
  const result = spawnSync(process.execPath, ['scripts/claude-compatibility.mjs', '2.1.319'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: `${fake.temp}:${process.env.PATH ?? '/usr/bin:/bin'}` },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout).checks[0].outcome, 'pass')
})

test('reports wrong versions, removed options, empty help, and probe failures', async (t) => {
  for (const [mode, expected] of [
    ['wrong-version', /version: expected 2.1.319/],
    ['removed', /missing consumed commands\/options/],
    ['empty-help', /missing consumed commands\/options/],
    ['nonzero', /agents: exit 7/],
    ['huge-output', /agents: stdout maxBuffer length exceeded|agents: spawnSync/],
  ]) {
    const fake = await fakeInstall(t, mode)
    const result = await runCompatibility('2.1.319', { npm: fake.npm, timeout: 3000 })
    assert.equal(result.failed, true)
    assert.match(result.checks[0].detail, expected)
  }
})

test('removes install directory after success and failure', async (t) => {
  for (const mode of ['good', 'nonzero']) {
    const fake = await fakeInstall(t, mode)
    await runCompatibility('2.1.319', { npm: fake.npm, timeout: 3000 })
    const installArgs = (await readFile(fake.log, 'utf8'))
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .find((item) => Array.isArray(item) && item[0] === 'install')
    await assert.rejects(access(installArgs[3]))
  }
})

test('reports probe timeout with its probe name', async (t) => {
  const fake = await fakeInstall(t, 'timeout')
  const result = await runCompatibility('2.1.319', { npm: fake.npm, timeout: 40 })
  assert.equal(result.failed, true)
  assert.match(result.checks[0].detail, /agents: timed out/)
})

test('rejects malformed version requests before invoking npm', async () => {
  await assert.rejects(runCompatibility('2.1.junk'), /exact Claude Code npm version/)
})
