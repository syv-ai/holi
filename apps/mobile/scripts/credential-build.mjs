import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { recordCredentialCommand } from './credential-log.mjs'

/** Build from the exact commit, with a fixture-local workspace, modules and Xcode output. */
export async function buildCredentialApp({ root, sourceHead, command, receipts, signal }) {
  const run = (stage, exe, args, options) =>
    recordCredentialCommand(
      receipts,
      stage,
      () => command(exe, args, { drainProcessGroup: true, ...options }),
      signal,
    )
  const store = await run('dependency-store', 'pnpm', ['store', 'path'])
  const archive = join(root, 'source.tar')
  const source = join(root, 'source')
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  for (const path of [source, home, tmp]) await mkdir(path)
  await run('snapshot', 'git', [
    'archive',
    `--output=${archive}`,
    sourceHead,
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'patches',
    'packages/shared/package.json',
    'packages/shared/src',
    'apps/mobile/package.json',
    'apps/mobile/tsconfig.json',
    'apps/mobile/nativescript.config.ts',
    'apps/mobile/webpack.config.js',
    'apps/mobile/app',
    'apps/mobile/App_Resources',
    'apps/mobile/scripts/build-libgit2-ios.mjs',
    'apps/mobile/scripts/shared-graph.cjs',
  ])
  await run('extract', 'tar', ['-xf', archive, '-C', source], { cwd: root })
  await unlink(archive)
  for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
    assert.ok(entry.isDirectory() || entry.isFile(), 'Build snapshot contains a nonregular file')
  }
  const lockfile = join(source, 'pnpm-lock.yaml')
  const lock = await readFile(lockfile)
  const { PATH, DEVELOPER_DIR, HOME, GEM_HOME, GEM_PATH, COREPACK_HOME, XDG_CACHE_HOME } =
    process.env
  // Read the installed xcodeproj gem, including a normal gem --user-install,
  // without passing the host home directory to the build tools.
  const gemPath = await run(
    'ruby-gem-path',
    'ruby',
    ['-rrubygems', '-e', 'print Gem.path.join(File::PATH_SEPARATOR)'],
    { env: { PATH, HOME, GEM_HOME, GEM_PATH } },
  )
  const env = {
    PATH,
    DEVELOPER_DIR,
    GEM_PATH: gemPath,
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: tmp,
    CI: '1',
    COREPACK_HOME:
      COREPACK_HOME ?? (HOME && join(XDG_CACHE_HOME ?? join(HOME, '.cache'), 'node/corepack')),
    COREPACK_ENABLE_NETWORK: '0',
  }
  const cwd = join(source, 'apps/mobile')
  const build = (stage, exe, args, options) =>
    run(stage, exe, args, { cwd, env, timeout: 600_000, ...options })
  await build(
    'dependencies',
    'pnpm',
    [
      '--filter',
      '@holi/mobile...',
      'install',
      '--frozen-lockfile',
      '--offline',
      '--ignore-scripts',
      '--package-import-method=copy',
      '--store-dir',
      store,
    ],
    { cwd: source },
  )
  assert.ok(lock.equals(await readFile(lockfile)), 'Fixture dependency lockfile changed')
  await build('xcode-project-tools', 'ruby', ['-e', "require 'xcodeproj'"])
  await build('libgit2', process.execPath, ['scripts/build-libgit2-ios.mjs'])
  // NativeScript 9.1.2 detaches its cleanup helper and some filesystem tools.
  // Keep that invocation's Node-spawned children in the owned process group;
  // normal NativeScript commands and installed packages are untouched.
  const preload = join(root, 'keep-build-children.cjs')
  await writeFile(
    preload,
    `const processes = require('node:child_process');
const { spawn } = processes;
processes.spawn = (command, args, options) => Array.isArray(args)
  ? spawn(command, args, { ...options, detached: false })
  : spawn(command, { ...(options ?? args), detached: false });
require('node:module').syncBuiltinESMExports();
`,
    { flag: 'wx' },
  )
  await build(
    'prepare',
    'pnpm',
    [
      'exec',
      'ns',
      'prepare',
      'ios',
      '--emulator',
      '--no-hmr',
      '--env.production',
      '--force',
      '--timeout',
      '600',
      '--disable-analytics',
      '--disable-npm-install',
    ],
    { env: { ...env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } },
  )
  assert.ok(
    lock.equals(await readFile(lockfile)),
    'Fixture dependency lockfile changed during prepare',
  )
  const xcodebuild = (stage, args) =>
    build(
      stage,
      'xcodebuild',
      [
        '-project',
        'platforms/ios/mobile.xcodeproj',
        '-scheme',
        'mobile',
        '-configuration',
        'Debug',
        '-sdk',
        'iphonesimulator',
        '-destination',
        'generic/platform=iOS Simulator',
        '-derivedDataPath',
        join(root, `${stage}-derived`),
        `CONFIGURATION_BUILD_DIR=${join(root, stage)}`,
        'ONLY_ACTIVE_ARCH=NO',
        ...args,
        'build',
      ],
      { killGrace: 10_000 },
    )
  await xcodebuild('unsigned-build', ['CODE_SIGNING_ALLOWED=NO', 'CODE_SIGN_IDENTITY='])
  await xcodebuild('simulator-signing', [
    'GCC_PREPROCESSOR_DEFINITIONS=$(inherited) HOLI_CREDENTIAL_ACCEPTANCE_BUILD=1',
    'CODE_SIGNING_ALLOWED=YES',
    'CODE_SIGNING_REQUIRED=YES',
    'CODE_SIGN_IDENTITY=-',
    'CODE_SIGN_STYLE=Manual',
    'DEVELOPMENT_TEAM=',
    'PROVISIONING_PROFILE=',
    'PROVISIONING_PROFILE_SPECIFIER=',
  ])
  return join(root, 'simulator-signing', 'mobile.app')
}
