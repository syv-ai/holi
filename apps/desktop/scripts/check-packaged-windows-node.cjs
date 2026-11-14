const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const [packageOutput, evidencePath] = process.argv.slice(2)
if (!packageOutput || !evidencePath) {
  throw new Error('Usage: node check-packaged-windows-node.cjs <package-output> <evidence.json>')
}

const desktopRoot = path.resolve(__dirname, '..')
const desktopPackage = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
const dependencyRoot = path.join(desktopRoot, 'node_modules', 'node-win-x64')
const dependencyPackage = JSON.parse(
  readFileSync(path.join(dependencyRoot, 'package.json'), 'utf8'),
)
const pinnedVersion = desktopPackage.optionalDependencies?.['node-win-x64']
if (!pinnedVersion || dependencyPackage.version !== pinnedVersion) {
  throw new Error(
    `Installed node-win-x64 version ${dependencyPackage.version} does not match optionalDependency ${pinnedVersion}`,
  )
}
const sourceNode = path.join(dependencyRoot, 'bin', 'node.exe')
const packagedNode = path.join(
  packageOutput,
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'node-win-x64',
  'bin',
  'node.exe',
)

if (!existsSync(sourceNode))
  throw new Error(`Optional dependency executable is missing: ${sourceNode}`)
if (!existsSync(packagedNode)) throw new Error(`Packaged executable is missing: ${packagedNode}`)

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const sourceSha256 = sha256(sourceNode)
const packagedSha256 = sha256(packagedNode)
if (sourceSha256 !== packagedSha256) {
  throw new Error(`Packaged Node SHA-256 mismatch: ${packagedSha256} !== ${sourceSha256}`)
}

const result = spawnSync(packagedNode, ['--version'], { encoding: 'utf8', windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0)
  throw new Error(`Packaged Node --version failed (${result.status}): ${result.stderr}`)
const version = result.stdout.trim()
if (version !== `v${dependencyPackage.version}`) {
  throw new Error(
    `Packaged Node version ${version} does not match pinned v${dependencyPackage.version}`,
  )
}

const evidence = {
  executable: packagedNode,
  version,
  optionalDependencyVersion: pinnedVersion,
  sha256: packagedSha256,
}
mkdirSync(path.dirname(evidencePath), { recursive: true })
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
if (!process.env.GITHUB_ENV)
  throw new Error('GITHUB_ENV is not set; cannot pass packaged Node to GUI smoke')
writeFileSync(process.env.GITHUB_ENV, `HOLI_QA372_PACKAGED_NODE=${packagedNode}\n`, { flag: 'a' })
console.log(`Verified packaged Windows Node ${version}; evidence: ${evidencePath}`)
