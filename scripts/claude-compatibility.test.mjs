import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { nativePlatform, runCompatibility } from './claude-compatibility.mjs'

async function fakeInstall(t, mode = 'good') {
  const temp = await mkdtemp(join(tmpdir(), 'holi-claude-runner-test-'))
  const npm = join(temp, 'npm-fake.mjs')
  const log = join(temp, 'argv.jsonl')
  await writeFile(
    npm,
    `#!/usr/bin/env node\nimport { mkdir, writeFile, chmod } from 'node:fs/promises'; import { join } from 'node:path';
const args=process.argv.slice(2); const prefix=args[args.indexOf('--prefix')+1]; const root=join(prefix,'node_modules','@anthropic-ai');
if (!args.includes('--ignore-scripts') || args.some(a=>a.includes('wrong-name'))) process.exit(3);
await writeFile(${JSON.stringify(log)},JSON.stringify(['install',...args])+'\\n',{flag:'a'}); await writeFile(${JSON.stringify(join(temp, 'env.json'))},JSON.stringify(Object.keys(process.env).sort()));
const version=args.at(-1).split('@').at(-1); const wrapper=join(root,'claude-code'); await mkdir(join(wrapper,'bin'),{recursive:true});
await writeFile(join(wrapper,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-code',version,bin:{claude:'bin/claude.exe'}}));
await writeFile(join(wrapper,'bin','claude.exe'),'#!/usr/bin/env node\\nprocess.stdout.write("2.1.319 (Claude Code)")'); await chmod(join(wrapper,'bin','claude.exe'),0o755);
const key=process.platform+'-'+process.arch; const native=join(root,'claude-code-'+key); await mkdir(native,{recursive:true});
if (${JSON.stringify(mode)} !== 'missing-native') {
 await writeFile(join(native,'package.json'),JSON.stringify({name:'@anthropic-ai/claude-code-'+key,version:${JSON.stringify(mode === 'wrong-native-version' ? '2.1.320' : '2.1.319')},os:[process.platform],cpu:[process.arch]}));
 await writeFile(join(native,'claude'+(process.platform==='win32'?'.exe':'')),${JSON.stringify(`#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
const args=process.argv.slice(2)
await writeFile(${JSON.stringify(log)}, JSON.stringify(args)+String.fromCharCode(10), {flag:'a'})
if(args[0]==='--version') process.stdout.write(${JSON.stringify(mode === 'wrong-version' ? '2.1.320 (Claude Code)' : '2.1.319 (Claude Code)')})
else if(args.at(-1)==='--help') process.stdout.write(${JSON.stringify(mode === 'empty-help' ? '' : mode === 'removed' ? 'Usage: claude' : mode === 'huge-output' ? 'x'.repeat(100000) : 'Usage: claude agents --json --all attach stop respawn rm --bg --name --resume --fork-session --model --append-system-prompt --mcp-config --allowedTools --disallowedTools')})
if (${JSON.stringify(mode)} === 'nonzero' && args[0] === 'agents') process.exit(7)
if (${JSON.stringify(mode)} === 'timeout' && args[0] === 'agents') await new Promise(r=>setTimeout(r,1000))
`)});
 await chmod(join(native,'claude'+(process.platform==='win32'?'.exe':'')),0o755);
}
const bin=join(prefix,'node_modules','.bin'); await mkdir(bin,{recursive:true}); await writeFile(join(bin,'claude'),'#!/usr/bin/env node\\nprocess.stdout.write("2.1.319 (Claude Code)")'); await chmod(join(bin,'claude'),0o755);
`,
  )
  await chmod(npm, 0o755)
  t.after(async () => rm(temp, { recursive: true, force: true }))
  return { temp, npm, log }
}

test('workflow records fixture evidence without claiming producer coverage', async (t) => {
  const workflow = await readFile(
    new URL('../.github/workflows/harness-monitor.yml', import.meta.url),
    'utf8',
  )
  assert.match(
    workflow,
    /src\/plugins\/agent\/test\/claude-sessions\.test\.ts test\/bridge-env\.test\.ts/,
  )
  const claudeJob = workflow.split('  claude-check:')[1]?.split('  report:')[0] ?? ''
  const mergeLine = claudeJob.split('\n').find((line) => line.includes('/claude/checks.json'))
  const mergeSource = mergeLine?.trim().match(/^node -e "(.+)"$/)?.[1]
  assert.ok(mergeSource, 'workflow must merge its fixture result')
  const temp = await mkdtemp(join(tmpdir(), 'holi-claude-artifact-test-'))
  t.after(async () => rm(temp, { recursive: true, force: true }))
  await mkdir(join(temp, 'claude'))
  const producerChecks = [
    'historical-session inclusion',
    'actual hook emission',
    'permissions',
    'messaging',
  ].map((name) => ({ name, outcome: 'unverified', detail: 'Not exercised by fixture replay.' }))
  await writeFile(
    join(temp, 'claude', 'cli.json'),
    JSON.stringify({
      checks: [
        { name: 'CLI surface', outcome: 'pass' },
        { name: 'fixture consumers', outcome: 'unverified' },
        ...producerChecks,
      ],
    }),
  )
  for (const outcome of ['pass', 'mismatch']) {
    const fixture = { name: 'fixture consumers', outcome, detail: 'Constructed 2.1.319 fixture.' }
    await writeFile(join(temp, 'claude', 'fixtures.json'), JSON.stringify(fixture))
    const result = spawnSync(process.execPath, ['-e', mergeSource], {
      env: { RUNNER_TEMP: temp },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const checks = JSON.parse(await readFile(join(temp, 'claude', 'checks.json'), 'utf8'))
    assert.deepEqual(
      checks.filter((check) => check.name === 'fixture consumers'),
      [fixture],
    )
    assert.deepEqual(
      checks.filter((check) => producerChecks.some((p) => p.name === check.name)),
      producerChecks,
    )
  }
})

test('probes exact isolated help/version without requiring an advertised prompt separator', async (t) => {
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

test('never probes the npm wrapper placeholder when the exact native binary is missing or mismatched', async (t) => {
  for (const [mode, expected] of [
    ['missing-native', /ENOENT|no such file/i],
    ['wrong-native-version', /does not match 2.1.319/],
  ]) {
    const fake = await fakeInstall(t, mode)
    const result = await runCompatibility('2.1.319', { npm: fake.npm, timeout: 3000 })
    assert.equal(result.failed, true)
    assert.match(result.checks[0].detail, expected)
    const calls = (await readFile(fake.log, 'utf8')).trim().split('\\n').map(JSON.parse)
    assert.deepEqual(calls, [calls[0]])
  }
})

test('maps supported operating systems and architectures without falling back', () => {
  assert.equal(nativePlatform('darwin', 'arm64', false), 'darwin-arm64')
  assert.equal(nativePlatform('darwin', 'x64', false), 'darwin-x64')
  assert.equal(nativePlatform('linux', 'x64', false), 'linux-x64')
  assert.equal(nativePlatform('linux', 'arm64', true), 'linux-arm64-musl')
  assert.equal(nativePlatform('win32', 'x64', false), 'win32-x64')
  assert.equal(nativePlatform('win32', 'arm64', false), 'win32-arm64')
  assert.equal(nativePlatform('freebsd', 'x64', false), null)
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
