import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import https from 'node:https'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const generated = join(root, '.native-deps/libgit2-1.9.7')
const archive = join(generated, 'libgit2-1.9.7.tar.gz')
const source = join(generated, 'source')
const build = join(generated, 'build')
const prefix = join(generated, 'install')
const url = 'https://github.com/libgit2/libgit2/archive/refs/tags/v1.9.7.tar.gz'
const sha256 = '1a4fbe7589e814777ae76b64734ad80f4ecad22cd33a22682a2aaea4ae5375e7'

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}

async function download(target = url, redirects = 0, destination = archive) {
  if (redirects > 5) throw new Error('libgit2 archive download exceeded redirect limit')
  const response = await new Promise((resolve, reject) => {
    const request = https.get(target, { timeout: 30_000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        resolve({ redirect: new URL(res.headers.location, target).href })
      } else if (res.statusCode !== 200) {
        reject(new Error(`libgit2 download returned HTTP ${res.statusCode}`))
      } else resolve({ response: res })
    })
    request.setTimeout(30_000, () => request.destroy(new Error('libgit2 download timed out')))
    request.on('error', reject)
  })
  if (response.redirect) return download(response.redirect, redirects + 1, destination)
  await pipeline(response.response, createWriteStream(destination))
}

async function checksum(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

await mkdir(generated, { recursive: true })
if ((await checksum(archive).catch(() => null)) !== sha256) {
  await rm(archive, { force: true })
  const temporary = `${archive}.${process.pid}.${randomUUID()}.tmp`
  try {
    await download(url, 0, temporary)
    const digest = await checksum(temporary)
    if (digest !== sha256) throw new Error(`libgit2 archive SHA-256 mismatch: ${digest}`)
    await rename(temporary, archive)
  } finally {
    await rm(temporary, { force: true })
  }
}
await rm(source, { recursive: true, force: true })
await mkdir(source, { recursive: true })
run('tar', ['-xzf', archive, '--strip-components=1', '-C', source])
await rm(build, { recursive: true, force: true })
await rm(prefix, { recursive: true, force: true })
const sdk = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], {
  encoding: 'utf8',
})
if (sdk.status !== 0) throw new Error(`Xcode iOS Simulator SDK unavailable: ${sdk.stderr}`)
run('cmake', [
  '-S',
  source,
  '-B',
  build,
  '-G',
  'Unix Makefiles',
  '-DCMAKE_SYSTEM_NAME=iOS',
  '-DCMAKE_OSX_SYSROOT=iphonesimulator',
  '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64',
  `-DCMAKE_OSX_SYSROOT=${sdk.stdout.trim()}`,
  '-DCMAKE_OSX_DEPLOYMENT_TARGET=26.0',
  '-DCMAKE_INSTALL_PREFIX=' + prefix,
  '-DBUILD_SHARED_LIBS=OFF',
  '-DBUILD_TESTS=OFF',
  '-DBUILD_CLI=OFF',
  '-DBUILD_EXAMPLES=OFF',
  '-DUSE_HTTPS=SecureTransport',
  '-DUSE_SSH=OFF',
  '-DUSE_BUNDLED_ZLIB=ON',
  '-DUSE_HTTP_PARSER=builtin',
  '-DREGEX_BACKEND=builtin',
])
run('cmake', ['--build', build, '--config', 'Release', '--parallel'])
run('cmake', ['--install', build, '--config', 'Release'])
const destination = join(root, 'App_Resources/iOS/libgit2')
await mkdir(destination, { recursive: true })
await copyFile(join(prefix, 'lib/libgit2.a'), join(destination, 'libgit2.a'))
await cp(join(prefix, 'include'), join(destination, 'include'), { recursive: true })
await copyFile(join(source, 'COPYING'), join(destination, 'COPYING.txt'))
await writeFile(
  join(destination, 'SOURCE.txt'),
  `libgit2 1.9.7\nSource: ${url}\nSHA-256: ${sha256}\n`,
)
console.log(`Built pinned libgit2 ${sha256} for iOS Simulator`)
