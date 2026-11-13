import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCompatibility } from './codex-compatibility.mjs'
import { checkProbe, exactVersion, isolatedEnvironment } from './codex-compatibility-checks.mjs'

test('drops inherited credentials and config variables', () => {
  const inherited = {
    ...process.env,
    GH_TOKEN: 'must-not-exist',
    OPENAI_API_KEY: 'must-not-exist',
    npm_config_userconfig: '/real/config',
  }
  const clean = isolatedEnvironment('/scratch', inherited.PATH)
  assert.equal('GH_TOKEN' in clean, false)
  assert.equal('OPENAI_API_KEY' in clean, false)
  assert.equal(clean.HOME, '/scratch/home')
  assert.equal(clean.CODEX_HOME, '/scratch/home/.codex')
  assert.equal(clean.npm_config_userconfig, '/scratch/npmrc')
  assert.deepEqual(Object.keys(clean).sort(), [
    'CI',
    'CODEX_HOME',
    'HOME',
    'PATH',
    'npm_config_cache',
    'npm_config_globalconfig',
    'npm_config_userconfig',
  ])
  assert.notEqual(clean.npm_config_userconfig, inherited.npm_config_userconfig)
})

test('matches only the exact CLI version', () => {
  assert.equal(exactVersion('codex-cli 0.169.0', '0.169.0'), true)
  assert.equal(exactVersion('codex-cli 10.169.0', '0.169.0'), false)
})

test('classifies missing options, timeouts and nonzero probes', () => {
  assert.match(
    checkProbe({ status: 0 }, ['--json'], 'Usage: codex exec'),
    /missing consumed options/,
  )
  assert.equal(checkProbe({ status: null, error: { code: 'ETIMEDOUT' } }, [], ''), 'timed out')
  assert.equal(checkProbe({ status: 2 }, [], ''), 'exit 2')
  assert.equal(checkProbe({ status: 0 }, ['--json'], ' --json'), null)
})

test('runs isolated install and CLI probes without leaking install output into JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-codex-runner-test-'))
  const npm = join(root, 'npm')
  const body = `#!/bin/sh
case "$*" in *install*) ;; *) exit 41 ;; esac
[ -z "\${GH_TOKEN:-}" ] && [ -z "\${OPENAI_API_KEY:-}" ] || exit 42
case "$HOME" in *holi-codex-check-*/home) ;; *) exit 43 ;; esac
printf '%s\\n' 'install banner that is not JSON'
install_dir=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then shift; install_dir=$1; fi
  shift
done
mkdir -p "$install_dir/node_modules/.bin"
cat > "$install_dir/node_modules/.bin/codex" <<'CODEX'
#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli 0.169.0'; exit 0; fi
# Resume help omits the parent exec options even when they were accepted.
case " $* " in
  *' resume '*) echo 'Usage: codex resume --json --skip-git-repo-check -c -m';;
  *) echo 'Usage: codex exec --json --skip-git-repo-check -C --sandbox -c -m';;
esac
CODEX
chmod +x "$install_dir/node_modules/.bin/codex"
`
  try {
    await writeFile(npm, body)
    await chmod(npm, 0o755)
    const runner = new URL('./codex-compatibility.mjs', import.meta.url).href
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { runCompatibility } from ${JSON.stringify(runner)};
         const result = await runCompatibility('0.169.0', { npm: ${JSON.stringify(npm)}, timeout: 5000 });
         process.stdout.write(JSON.stringify({ checks: result.checks }));
         process.exitCode = result.failed ? 1 : 0;`,
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          GH_TOKEN: 'must-not-reach-child',
          OPENAI_API_KEY: 'must-not-reach-child',
        },
      },
    )
    assert.equal(child.status, 0, child.stderr || child.stdout)
    const result = JSON.parse(child.stdout)
    assert.equal(result.checks[0].outcome, 'pass')
    assert.equal(child.stdout.includes('install banner'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('classifies wrong versions, removed options and nonzero probes through the runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-codex-classify-test-'))
  const npm = join(root, 'npm')
  try {
    const scenarios = [
      ['wrong version', "echo 'codex-cli 9.9.9'", /expected 0.169.0/],
      [
        'removed option',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.169.0"; else echo exec; fi',
        /missing consumed options/,
      ],
      [
        'nonzero',
        'if [ "$1" = "--version" ]; then echo "codex-cli 0.169.0"; else exit 7; fi',
        /exit 7/,
      ],
    ]
    for (const [name, behavior, expected] of scenarios) {
      await writeFile(
        npm,
        `#!/bin/sh\ninstall_dir=\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--prefix" ]; then shift; install_dir=$1; fi; shift; done\nmkdir -p "$install_dir/node_modules/.bin"\ncat > "$install_dir/node_modules/.bin/codex" <<'CODEX'\n#!/bin/sh\n${behavior}\nCODEX\nchmod +x "$install_dir/node_modules/.bin/codex"\n`,
      )
      await chmod(npm, 0o755)
      const result = await runCompatibility('0.169.0', { npm, timeout: 1_000 })
      assert.equal(result.failed, true, name)
      assert.match(result.checks[0].detail, expected, name)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('classifies a timed-out installed CLI through the runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-codex-timeout-test-'))
  const npm = join(root, 'npm')
  try {
    await writeFile(
      npm,
      `#!/bin/sh\ninstall_dir=\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--prefix" ]; then shift; install_dir=$1; fi; shift; done\nmkdir -p "$install_dir/node_modules/.bin"\nprintf '#!/bin/sh\\nsleep 2\\n' > "$install_dir/node_modules/.bin/codex"\nchmod +x "$install_dir/node_modules/.bin/codex"\n`,
    )
    await chmod(npm, 0o755)
    const result = await runCompatibility('0.169.0', { npm, timeout: 30 })
    assert.equal(result.failed, true)
    assert.match(result.checks[0].detail, /timed out/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
