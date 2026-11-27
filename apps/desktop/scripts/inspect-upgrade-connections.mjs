#!/usr/bin/env node
import { dirname, join, resolve, sep, relative, isAbsolute } from 'node:path'
import { mkdir, realpath, lstat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { userInfo } from 'node:os'
import { createOwnedProcesses } from './owned-processes.mjs'
import { connectUpgradeInspector } from './upgrade-inspector.mjs'

const owned = createOwnedProcesses()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function command(cmd, args) {
  const result = await promisify(execFile)(cmd, args, {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  })
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

async function main() {
  assert(process.platform === 'darwin' && process.arch === 'arm64', 'requires darwin arm64')
  assert(
    process.argv.length === 4,
    'usage: node inspect-upgrade-connections.mjs <owned-extracted.app> <fresh-evidence-root>',
  )
  const app = resolve(process.argv[2])
  const evidence = resolve(process.argv[3])
  const home = resolve(userInfo().homedir)
  assert(
    app !== '/Applications' && !app.startsWith('/Applications/'),
    'refusing /Applications paths',
  )
  for (const path of [app, evidence])
    assert(path !== home && !path.startsWith(home + sep), 'refusing user-profile paths')
  assert((await realpath(app)) === app, 'app path must not be a symlink')
  const evidenceParent = await realpath(dirname(evidence))
  assert(evidenceParent === dirname(evidence), 'evidence parent must not traverse symlinks')
  assert(!(await lstat(evidence).catch(() => null)), 'evidence root must be fresh')
  const appParent = await realpath(dirname(app))
  assert(appParent === dirname(app), 'app parent must not traverse symlinks')
  const info = join(app, 'Contents', 'Info.plist')
  const bundleResult = await command('plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    info,
  ])
  const executableResult = await command('plutil', [
    '-extract',
    'CFBundleExecutable',
    'raw',
    '-o',
    '-',
    info,
  ])
  const bundleId = bundleResult.stdout
  const executable = executableResult.stdout
  assert(bundleId === 'ai.syv.holi', `unexpected app identity: ${bundleId}`)
  assert(
    executable &&
      !executable.includes('/') &&
      !executable.includes('\\') &&
      executable !== '.' &&
      executable !== '..',
    'unsafe bundle executable',
  )
  const executablePath = resolve(app, 'Contents', 'MacOS', executable)
  const executableRelative = relative(app, executablePath)
  assert(
    !isAbsolute(executableRelative) && !executableRelative.startsWith('..' + sep),
    'executable escapes app bundle',
  )
  const verify = await command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const signatureResult = await command('codesign', ['-dv', '--verbose=4', app]).catch((error) => ({
    stdout: error.stdout ?? '',
    stderr: error.stderr ?? '',
  }))
  const signingText = `${signatureResult.stdout}\n${signatureResult.stderr}`
  const team = signingText.match(/TeamIdentifier=([^\s]+)/)?.[1]
  const expectedTeam = process.env.HOLI_EXPECTED_TEAM_ID
  assert(
    expectedTeam && team === expectedTeam,
    'codesign TeamIdentifier does not match HOLI_EXPECTED_TEAM_ID',
  )
  const appStat = await lstat(app)
  assert(
    appStat.isDirectory() && !appStat.isSymbolicLink(),
    'artifact must be an extracted .app directory',
  )

  await mkdir(evidence, { recursive: false, mode: 0o700 })
  const isolated = join(evidence, 'profile')
  const paths = {
    appData: join(isolated, 'app-data'),
    userData: join(isolated, 'user-data'),
    sessionData: join(isolated, 'session-data'),
    home: isolated,
    vault: join(isolated, 'vault'),
  }
  for (const path of [isolated, paths.appData, paths.userData, paths.sessionData, paths.vault])
    await mkdir(path, { recursive: true, mode: 0o700 })
  const sandboxProfile = join(evidence, 'deny-personal-home.sb')
  await writeFile(
    sandboxProfile,
    `(version 1)\n(allow default)\n(deny file-read* (subpath ${JSON.stringify(home)}))\n(deny file-write* (subpath ${JSON.stringify(home)}))\n`,
    { mode: 0o600 },
  )
  const record = owned.start(
    '/usr/bin/sandbox-exec',
    [
      '-f',
      sandboxProfile,
      executablePath,
      '--inspect-brk=127.0.0.1:0',
      `--user-data-dir=${paths.userData}`,
    ],
    {
      cwd: evidence,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: isolated,
        HOLI_VAULT_ROOT: paths.vault,
      },
    },
  )
  let inspector
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    inspector = await connectUpgradeInspector(record, { signal: abort.signal })
    const frame = inspector.frame
    const expression = `(() => { const { app } = require('electron'); for (const [key, value] of Object.entries(${JSON.stringify(paths)})) if (['appData','userData','sessionData'].includes(key)) app.setPath(key, value); return { packaged: app.isPackaged, version: app.getVersion(), paths: Object.fromEntries(['appData','userData','sessionData'].map(key => [key, app.getPath(key)])), versions: process.versions }; })()`
    const value = await inspector.evaluate(expression)
    assert(value?.packaged === true, 'artifact is not packaged')
    assert(
      value.paths &&
        Object.entries(paths)
          .filter(([key]) => ['appData', 'userData', 'sessionData'].includes(key))
          .every(([key, path]) => value.paths[key] === path),
      'Electron paths did not match isolated root',
    )
    const metadata = {
      packagedApp: value.packaged,
      version: value.version,
      bundleId,
      executable,
      versions: value.versions,
      signing: { teamIdentifier: team, verification: verify.stderr || verify.stdout },
      debuggerPause: {
        reason: frame.reason,
        location: frame.url,
        lineNumber: frame.location.lineNumber,
      },
      personalProfileAccess: 'not accessed: paused before application entry execution',
      isolationPaths: paths,
    }
    await writeFile(join(evidence, 'evidence.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600,
    })
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await owned.stop(record)
    inspector?.close()
    assert(!abort.signal.aborted, 'interrupted; owned process stopped')
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
