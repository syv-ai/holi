import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
)
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Holi fixture',
  GIT_AUTHOR_EMAIL: 'fixture@invalid',
  GIT_COMMITTER_NAME: 'Holi fixture',
  GIT_COMMITTER_EMAIL: 'fixture@invalid',
})
async function git(root, ...args) {
  return (
    await exec(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', root, ...args],
      { env, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
    )
  ).stdout
}
const text = async (root, ...args) => (await git(root, ...args)).toString().trim()
async function put(root, path, bytes, mode = 0o644) {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  await chmod(file, mode)
}
async function snapshot(root, prefix = '') {
  const result = {}
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name
    const full = join(root, path)
    const stat = await lstat(full)
    const mode = stat.mode & 0o7777
    if (stat.isSymbolicLink()) result[path] = { mode, link: await readlink(full) }
    else if (stat.isDirectory()) {
      result[path] = { mode, directory: true }
      Object.assign(result, await snapshot(root, path))
    } else {
      assert.ok(stat.isFile(), `Unsupported fixture entry ${path}`)
      // All paths are owned synthetic fixture files. Restore unreadable permissions after inspection.
      if (!(mode & 0o400)) await chmod(full, mode | 0o400)
      try {
        const bytes = await readFile(full)
        result[path] = {
          mode,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }
      } finally {
        if (!(mode & 0o400)) await chmod(full, mode)
      }
    }
  }
  return result
}
async function entries(root, tree) {
  const records = (await git(root, 'ls-tree', '-rz', '--full-tree', tree))
    .toString()
    .split('\0')
    .filter(Boolean)
  const output = []
  for (const record of records) {
    const split = record.indexOf('\t')
    const [mode, type, oid] = record.slice(0, split).split(' ')
    assert.equal(type, 'blob')
    output.push({
      path: record.slice(split + 1),
      mode,
      oid,
      bytes: (await git(root, 'cat-file', 'blob', oid)).toString('base64'),
    })
  }
  return output
}

/** Separate repositories and independent object databases; no status fixture is mutated. */
export async function createWorkingCopyTreeFixture(parent, runId, libraryRoot) {
  await mkdir(parent, { recursive: true })
  const cases = []
  const names = [
    'mixed',
    'noop',
    'protected-only',
    'conflict-protected',
    'identity',
    'branch',
    'symlink',
    'unsupported-metadata',
    'unsafe-objects',
    'directory-to-file',
    'mode-true',
    'mode-false',
    'invalid-path',
    'corrupt-blob',
    'race-ignore',
    'race-inventory',
    'race-head',
  ]
  for (const name of names) {
    const root = await mkdtemp(join(parent, `holi-tree-${runId}-${name}-`))
    await git(root, '-c', 'init.templateDir=', 'init', '-b', 'fixture-start')
    const remote = `holi/tree-${runId}-${name}`
    await git(root, 'remote', 'add', 'origin', `https://github.com/${remote}.git`)
    for (const [path, bytes] of [
      ['note.md', 'base\n'],
      ['.hidden-data', Buffer.from([0, 254])],
      ['binary.bin', Buffer.from([0, 1, 2])],
      ['run.sh', '#!/bin/sh\nexit 0\n'],
      ['gone.md', 'delete me'],
      ['replace', 'file'],
      ['staged.md', 'base'],
      ['tracked-ignored.md', 'tracked'],
      ['.gitignore', 'tracked-ignored.md\nignored-*\n'],
    ])
      await put(root, path, bytes)
    const protectedNames = ['.env', 'private.local.bin', 'TOKEN.LOCAL.bin', 'CONFIG/.ENV']
    const protectedCase = ['mixed', 'protected-only', 'conflict-protected'].includes(name)
    if (protectedCase)
      for (const path of protectedNames) await put(root, path, `synthetic protected ${path}`)
    if (name === 'directory-to-file') await put(root, 'directory/child.md', 'old child')
    await git(root, 'add', '-A')
    await git(root, 'add', '-f', 'tracked-ignored.md', ...(protectedCase ? protectedNames : []))
    await git(root, 'commit', '-m', 'fixture base')
    if (name === 'mixed') {
      await put(root, 'staged.md', 'staged intermediate')
      await git(root, 'add', 'staged.md')
      await put(root, 'staged.md', 'unstaged final\n')
      await put(root, 'binary.bin', Buffer.from([0, 255, 1, 0]))
      await chmod(join(root, 'run.sh'), 0o755)
      await put(root, 'added.md', 'added\n')
      await rm(join(root, 'gone.md'))
      await rm(join(root, 'replace'))
      await put(root, 'replace/child.bin', Buffer.from([9, 8]))
      await put(root, 'tracked-ignored.md', 'tracked ignored changed')
      await put(root, 'ignored-private.bin', 'untracked ignored')
    }
    if (name === 'directory-to-file') {
      await rm(join(root, 'directory'), { recursive: true })
      await put(root, 'directory', 'replacement file')
    }
    if (name === 'mode-true' || name === 'mode-false') {
      await git(root, 'config', 'core.filemode', name === 'mode-true' ? 'true' : 'false')
      await chmod(join(root, 'run.sh'), 0o755)
    }
    if (name === 'invalid-path') await put(root, 'bad\\name.md', 'unsupported name')
    if (name === 'corrupt-blob') {
      const oid = await text(root, 'rev-parse', 'HEAD:note.md')
      await chmod(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)), 0o600)
      await writeFile(
        join(root, '.git/objects', oid.slice(0, 2), oid.slice(2)),
        'corrupt existing blob',
      )
    }
    let mutation
    if (name.startsWith('race-')) mutation = { kind: name.slice(5) }
    if (name === 'race-head') {
      await git(root, 'checkout', '-b', 'future-head')
      await put(root, 'head-added.md', 'new parent file')
      await git(root, 'add', '-A')
      await git(root, 'commit', '-m', 'future head')
      mutation.head = await text(root, 'rev-parse', 'HEAD')
      await git(root, 'checkout', 'fixture-start')
    }
    if (name === 'conflict-protected') {
      await git(root, 'checkout', '-b', 'side')
      await put(root, '.env', 'side secret')
      await git(root, 'add', '-f', '.env')
      await git(root, 'commit', '-m', 'side')
      await git(root, 'checkout', 'fixture-start')
      await put(root, '.env', 'main secret')
      await git(root, 'add', '-f', '.env')
      await git(root, 'commit', '-m', 'main')
      await assert.rejects(git(root, 'merge', '--no-commit', 'side'))
      assert.ok((await text(root, 'ls-files', '-u')).length)
      // Prove index conflict refusal independently of the MERGE state marker.
      await rm(join(root, '.git/MERGE_HEAD'))
    }
    if (name === 'identity')
      await git(root, 'remote', 'set-url', 'origin', 'https://github.com/holi/wrong.git')
    if (name === 'symlink') await symlink('note.md', join(root, 'alias.md'))
    if (name === 'unsupported-metadata')
      await put(root, '.git/info/attributes', '*.md filter=forbidden\n')
    if (name === 'unsafe-objects') {
      const outside = await mkdtemp(join(parent, `holi-tree-outside-${runId}-`))
      await put(outside, 'sentinel', 'untouched outside')
      const occupied = new Set(await readdir(join(root, '.git/objects')))
      const prefix = Array.from({ length: 256 }, (_, n) => n.toString(16).padStart(2, '0')).find(
        (x) => !occupied.has(x),
      )
      await symlink(outside, join(root, '.git/objects', prefix))
    }
    const refusal = ![
      'mixed',
      'noop',
      'protected-only',
      'directory-to-file',
      'mode-true',
      'mode-false',
    ].includes(name)
    let expectedTree = null
    let expectedEntries = null
    if (!refusal) {
      const oracle = await mkdtemp(join(parent, `holi-tree-oracle-${runId}-`))
      try {
        await git(parent, 'clone', '--no-local', root, oracle)
        if (name === 'mixed') {
          await put(oracle, 'staged.md', 'unstaged final\n')
          await put(oracle, 'binary.bin', Buffer.from([0, 255, 1, 0]))
          await chmod(join(oracle, 'run.sh'), 0o755)
          await put(oracle, 'added.md', 'added\n')
          await rm(join(oracle, 'gone.md'))
          await rm(join(oracle, 'replace'))
          await put(oracle, 'replace/child.bin', Buffer.from([9, 8]))
          await put(oracle, 'tracked-ignored.md', 'tracked ignored changed')
        }
        if (name === 'directory-to-file') {
          await rm(join(oracle, 'directory'), { recursive: true })
          await put(oracle, 'directory', 'replacement file')
        }
        if (name === 'mode-true' || name === 'mode-false') {
          await git(oracle, 'config', 'core.filemode', name === 'mode-true' ? 'true' : 'false')
          await chmod(join(oracle, 'run.sh'), 0o755)
        }
        await git(oracle, 'add', '-A')
        if (protectedCase)
          await git(oracle, 'rm', '--cached', '--ignore-unmatch', ...protectedNames)
        expectedTree = await text(oracle, 'write-tree')
        expectedEntries = await entries(oracle, expectedTree)
      } finally {
        await rm(oracle, { recursive: true, force: true })
      }
    }
    if (protectedCase) for (const path of protectedNames) await chmod(join(root, path), 0)
    const baseHead = await text(root, 'rev-parse', 'HEAD')
    const headTree = await text(root, 'rev-parse', 'HEAD^{tree}')
    await mkdir(join(libraryRoot, name), { recursive: true })
    cases.push({
      name,
      runId,
      root,
      remote,
      branch: name === 'branch' ? 'wrong-branch' : 'fixture-start',
      expectedTree,
      expectedEntries,
      mutation,
      refusal,
      baseHead,
      unchanged: expectedTree === headTree,
      before: await snapshot(root),
    })
  }
  return { runId, cases }
}

/** Validate complete results and permit only new, valid immutable loose objects. */
export async function verifyWorkingCopyTreeResults(results, manifest) {
  assert.ok(Array.isArray(results))
  assert.equal(results.length, manifest.cases.length)
  assert.equal(new Set(results.map((r) => r.name)).size, results.length)
  const proof = []
  for (const item of manifest.cases) {
    const result = results.find((r) => r.name === item.name)
    assert.ok(result, `Missing tree result ${item.name}`)
    assert.equal(result.runId, item.runId)
    assert.equal(result.root, item.root)
    assert.equal(result.refused, item.refusal, `${item.name}: ${result.refusal}`)
    const injected = result.injected ?? {}
    if (!item.mutation) assert.deepEqual(injected, {})
    else {
      assert.ok(Object.keys(injected).length > 0, 'Race was not exercised')
      for (const [path, value] of Object.entries(injected)) {
        if (item.mutation.kind === 'head') {
          assert.equal(path, '.git/refs/heads/fixture-start')
          assert.equal(value, `${item.mutation.head}\n`)
        } else if (item.mutation.kind === 'ignore') {
          assert.equal(path, '.gitignore')
          assert.equal(value, 'ignored-*\n# concurrent synthetic edit\n')
        } else {
          assert.match(path, /^race-created-[1-9][0-9]*\.bin$/)
          assert.equal(value, 'concurrent synthetic file\n')
          assert.ok(Object.keys(injected).length <= 10)
        }
      }
    }
    const after = await snapshot(item.root)
    for (const [path, before] of Object.entries(item.before)) {
      const expected = Object.hasOwn(injected, path)
        ? {
            ...before,
            size: Buffer.byteLength(injected[path]),
            sha256: createHash('sha256').update(injected[path]).digest('hex'),
          }
        : before
      assert.deepEqual(after[path], expected, `${item.name} mutated ${path}`)
    }
    for (const [path, value] of Object.entries(after)) {
      if (Object.hasOwn(item.before, path)) continue
      if (Object.hasOwn(injected, path)) {
        assert.equal(value.sha256, createHash('sha256').update(injected[path]).digest('hex'))
        assert.equal(value.size, Buffer.byteLength(injected[path]))
        continue
      }
      assert.equal(item.refusal, false, `Refusal mutated ${path}`)
      if (/^\.git\/objects\/[0-9a-f]{2}$/.test(path)) {
        assert.equal(value.directory, true)
        continue
      }
      assert.match(path, /^\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/)
      assert.ok(!value.link && !value.directory)
      const oid = path.replace('.git/objects/', '').replace('/', '')
      const decoded = inflateSync(await readFile(join(item.root, path)), {
        maxOutputLength: 64 * 1024 * 1024 + 128,
      })
      const end = decoded.indexOf(0)
      assert.ok(end > 0)
      const header = decoded
        .subarray(0, end)
        .toString('ascii')
        .match(/^(blob|tree|commit|tag) (0|[1-9][0-9]*)$/)
      assert.ok(header)
      assert.equal(decoded.length - end - 1, Number(header[2]))
      assert.equal(createHash('sha1').update(decoded).digest('hex'), oid)
    }
    if (item.refusal) assert.equal(result.tree, null)
    else {
      assert.equal(result.tree.treeOID, item.expectedTree, item.name)
      assert.equal(result.tree.parentOID, item.baseHead)
      assert.equal(result.tree.branch, item.branch)
      assert.equal(result.tree.unchanged, item.unchanged)
      assert.equal(await text(item.root, 'rev-parse', 'HEAD'), item.baseHead)
      assert.deepEqual(await entries(item.root, result.tree.treeOID), item.expectedEntries)
    }
    proof.push({
      name: item.name,
      runId: item.runId,
      root: item.root,
      refused: result.refused,
      tree: result.tree,
      repositoryUnchanged: !item.mutation,
      onlyDeclaredConcurrentEdits: Boolean(item.mutation),
      rawEntriesVerified: !item.refusal,
    })
  }
  return proof
}
