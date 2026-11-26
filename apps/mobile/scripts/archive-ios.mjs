import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateSharedGraph } from './host-checks.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.artifacts/ios')
const archive = resolve(output, 'Holi.xcarchive')
await mkdir(output, { recursive: true })
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}: ${result.stderr ?? ''}`)
  return result.stdout ?? ''
}
function plist(path) {
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path]))
}
// NativeScript generates the project; always build the generated project, not an assumed scheme.
run('ns', ['prepare', 'ios', '--no-hmr', '--env.production', '--force', '--timeout', '600'])
const projects = (await readdir(resolve(root, 'platforms/ios'), { withFileTypes: true })).filter(
  (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'),
)
if (projects.length !== 1)
  throw new Error(`Expected one generated Xcode project, found ${projects.length}`)
const project = resolve(root, 'platforms/ios', projects[0].name)
const scheme = projects[0].name.replace(/\.xcodeproj$/, '')
await rm(archive, { recursive: true, force: true })
run('xcodebuild', [
  '-project',
  project,
  '-scheme',
  scheme,
  '-configuration',
  'Release',
  '-sdk',
  'iphoneos',
  '-destination',
  'generic/platform=iOS',
  '-archivePath',
  archive,
  'CODE_SIGNING_ALLOWED=NO',
  'archive',
])
const info = plist(join(archive, 'Info.plist'))
if (
  info.ApplicationProperties?.SigningIdentity ||
  info.ApplicationProperties?.ProvisioningProfile ||
  info.ApplicationProperties?.Team
)
  throw new Error('Archive unexpectedly contains signing metadata')
const applicationPath = info.ApplicationProperties?.ApplicationPath
if (!applicationPath?.startsWith('Products/Applications/') || !applicationPath.endsWith('.app'))
  throw new Error(`Unexpected archived application path: ${applicationPath}`)
const app = resolve(archive, applicationPath)
const appInfo = plist(join(app, 'Info.plist'))
if (!appInfo.CFBundleExecutable) throw new Error('Archive application has no executable')
const executable = resolve(app, appInfo.CFBundleExecutable)
const architecture = run('lipo', ['-archs', executable]).trim().split(/\s+/)
if (architecture.length !== 1 || architecture[0] !== 'arm64')
  throw new Error(`Expected device arm64 executable, got ${architecture.join(', ')}`)
const details = run('vtool', ['-show-build', executable])
if (!details.includes('platform IOS') || details.includes('platform IOSSIMULATOR'))
  throw new Error('Executable is not an iOS device binary')
const settings = run('xcodebuild', [
  '-project',
  project,
  '-scheme',
  scheme,
  '-configuration',
  'Release',
  '-sdk',
  'iphoneos',
  '-destination',
  'generic/platform=iOS',
  '-showBuildSettings',
])
for (const setting of [
  'CONFIGURATION = Release',
  'SDKROOT = iphoneos',
  'CODE_SIGNING_ALLOWED = NO',
])
  if (!settings.includes(setting)) throw new Error(`Missing expected archive setting: ${setting}`)
const graphPath = join(app, 'app/shared-bundle-graph.json')
const graph = JSON.parse(await readFile(graphPath, 'utf8'))
validateSharedGraph(graph)
const bytes = await readFile(executable)
const gitSha = run('git', ['rev-parse', 'HEAD']).trim()
const receipt = {
  archive: 'Holi.xcarchive',
  gitSha,
  executable: appInfo.CFBundleExecutable,
  executableSha256: createHash('sha256').update(bytes).digest('hex'),
  bundleGraphSha256: createHash('sha256')
    .update(await readFile(graphPath))
    .digest('hex'),
  architectures: architecture,
  platform: 'IOS',
  configuration: 'Release',
  deploymentTarget: appInfo.MinimumOSVersion,
  bundleIdentifier: appInfo.CFBundleIdentifier,
  verifiedAt: new Date().toISOString(),
}
if (!receipt.deploymentTarget || !receipt.bundleIdentifier || !(await stat(executable)).size)
  throw new Error('Archive metadata or executable is incomplete')
await writeFile(resolve(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`Verified unsigned device archive: ${archive}`)
