import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.artifacts/ios')
await mkdir(output, { recursive: true })
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}
// NativeScript prepares the Xcode project/resources; xcodebuild owns the unsigned archive.
run('ns', ['prepare', 'ios', '--no-hmr', '--env.production', '--force', '--timeout', '600'])
run('xcodebuild', ['-version'])
run('xcodebuild', ['-scheme', 'Holi', '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS', '-archivePath', `${output}/Holi.xcarchive`, 'CODE_SIGNING_ALLOWED=NO', 'archive'])
