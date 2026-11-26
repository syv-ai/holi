import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.artifacts/ios')
const archive = resolve(output, 'Holi.xcarchive')
await mkdir(output, { recursive: true })
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr ?? ''}`)
  return result.stdout ?? ''
}
function plist(path) {
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', path]))
}
// NativeScript prepares the Xcode project/resources; xcodebuild owns the unsigned archive.
run('ns', ['prepare', 'ios', '--no-hmr', '--env.production', '--force', '--timeout', '600'])
run('xcodebuild', ['-scheme', 'Holi', '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-archivePath', archive, 'CODE_SIGNING_ALLOWED=NO', 'archive'])
const info = plist(resolve(archive, 'Info.plist'))
if (info.ApplicationProperties?.SigningIdentity || info.ApplicationProperties?.ProvisioningProfile || info.ApplicationProperties?.Team) throw new Error('Archive unexpectedly contains signing metadata')
if (info.ApplicationProperties?.ApplicationPath !== 'Applications/Holi.app') throw new Error('Unexpected archived application path')
const app = resolve(archive, info.ApplicationProperties.ApplicationPath)
const appInfo = plist(resolve(app, 'Info.plist'))
if (!appInfo.CFBundleExecutable) throw new Error('Archive application has no executable')
const executable = resolve(app, appInfo.CFBundleExecutable)
const architecture = run('lipo', ['-archs', executable]).trim().split(/\s+/)
if (architecture.length !== 1 || architecture[0] !== 'arm64') throw new Error(`Expected device arm64 executable, got ${architecture.join(', ')}`)
const details = run('vtool', ['-show-build', executable])
if (!details.includes('platform IOS')) throw new Error('Executable is not built for IOS device platform')
if (details.includes('platform IOSSIMULATOR')) throw new Error('Simulator executable found in device archive')
const settings = run('xcodebuild', ['-showBuildSettings', '-scheme', 'Holi', '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS'])
for (const setting of ['CONFIGURATION = Release', 'SDKROOT = iphoneos', 'CODE_SIGNING_ALLOWED = NO']) if (!settings.includes(setting)) throw new Error(`Missing expected archive setting: ${setting}`)
const bytes = await readFile(executable)
const receipt = { archive: 'Holi.xcarchive', sha256: createHash('sha256').update(bytes).digest('hex'), executable: appInfo.CFBundleExecutable, architectures: architecture, platform: 'IOS', configuration: 'Release', deploymentTarget: appInfo.MinimumOSVersion, bundleIdentifier: appInfo.CFBundleIdentifier, verifiedAt: new Date().toISOString() }
if (!receipt.deploymentTarget || !receipt.bundleIdentifier || !(await stat(executable)).size) throw new Error('Archive metadata or executable is incomplete')
await writeFile(resolve(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`Verified unsigned device archive: ${archive}`)
