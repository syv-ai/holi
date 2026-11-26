import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateSharedGraph } from './host-checks.mjs'
import { validateArchiveEvidence } from './archive-checks.mjs'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.artifacts/ios')
const archive = join(output, 'Holi.xcarchive')
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}: ${result.stderr ?? ''}`)
  return result.stdout ?? ''
}
function plist(path) {
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path], true))
}
async function bundleFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory())
      files.push(...(await bundleFiles(join(directory, entry.name), `${name}/`)))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Unsupported archived bundle entry: ${name}`)
  }
  return files.sort()
}
await mkdir(output, { recursive: true })
await rm(join(output, 'receipt.json'), { force: true })
await rm(archive, { recursive: true, force: true })
run('ns', [
  'prepare',
  'ios',
  '--release',
  '--no-hmr',
  '--env.production',
  '--force',
  '--timeout',
  '600',
])
const projects = (await readdir(join(root, 'platforms/ios'), { withFileTypes: true })).filter(
  (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'),
)
if (projects.length !== 1)
  throw new Error(`Expected one generated Xcode project, found ${projects.length}`)
const scheme = projects[0].name.replace(/\.xcodeproj$/, '')
const args = [
  '-project',
  join(root, 'platforms/ios', projects[0].name),
  '-scheme',
  scheme,
  '-configuration',
  'Release',
  '-sdk',
  'iphoneos',
  '-destination',
  'generic/platform=iOS',
  '-derivedDataPath',
  join(root, '.native-deps/archive-derived'),
  'CODE_SIGNING_ALLOWED=NO',
  'CODE_SIGNING_REQUIRED=NO',
  'CODE_SIGN_IDENTITY=',
  'DEVELOPMENT_TEAM=',
]
const settingsReport = JSON.parse(run('xcodebuild', [...args, '-showBuildSettings', '-json'], true))
const settings = settingsReport.find((entry) => entry.target === scheme)?.buildSettings
if (!settings) throw new Error('Missing application target build settings')
await writeFile(join(output, 'build-settings.json'), JSON.stringify(settingsReport, null, 2))
run('xcodebuild', [...args, '-archivePath', archive, 'archive'])
const archiveInfo = plist(join(archive, 'Info.plist'))
const applicationPath = archiveInfo.ApplicationProperties?.ApplicationPath
if (!/^Applications\/[^/]+\.app$/.test(applicationPath ?? ''))
  throw new Error('Invalid archive application path')
const app = join(archive, 'Products', applicationPath)
const appInfo = plist(join(app, 'Info.plist'))
if (!/^[^/.][^/]*$/.test(appInfo.CFBundleExecutable ?? ''))
  throw new Error('Invalid executable name')
const executable = join(app, appInfo.CFBundleExecutable)
const architectures = run('lipo', ['-archs', executable], true).trim().split(/\s+/)
const buildVersion = run('vtool', ['-show-build', executable], true)
const signature = spawnSync('codesign', ['-d', executable], { encoding: 'utf8' })
if (signature.error) throw signature.error
if (signature.status !== 0 && !signature.stderr.includes('code object is not signed at all'))
  throw new Error(`Cannot inspect archive signing state: ${signature.stderr}`)
const files = await bundleFiles(app)
const gitSha = run('git', ['rev-parse', 'HEAD'], true).trim()
validateArchiveEvidence({
  archiveInfo,
  appInfo,
  settings,
  architectures,
  buildVersion,
  signed: signature.status === 0,
  bundleFiles: files,
  gitSha,
})
const graphBytes = await readFile(join(app, 'app/shared-bundle-graph.json'))
validateSharedGraph(JSON.parse(graphBytes))
const bundleHash = createHash('sha256')
for (const name of files) {
  const bytes = await readFile(join(app, name))
  bundleHash.update(`${name}\0${bytes.length}\0`).update(bytes)
}
const executableBytes = await readFile(executable)
if (!executableBytes.length) throw new Error('Empty archive executable')
const receipt = {
  archive: 'Holi.xcarchive',
  gitSha,
  executable: appInfo.CFBundleExecutable,
  executableSha256: createHash('sha256').update(executableBytes).digest('hex'),
  bundleSha256: bundleHash.digest('hex'),
  bundleGraphSha256: createHash('sha256').update(graphBytes).digest('hex'),
  architectures,
  platform: 'IOS',
  configuration: settings.CONFIGURATION,
  deploymentTarget: appInfo.MinimumOSVersion,
  bundleIdentifier: appInfo.CFBundleIdentifier,
  signed: false,
  xcode: run('xcodebuild', ['-version'], true).trim(),
  verifiedAt: new Date().toISOString(),
}
await writeFile(join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`Verified unsigned device archive: ${archive}`)
