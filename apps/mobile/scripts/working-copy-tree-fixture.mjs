import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Holi fixture',
  GIT_AUTHOR_EMAIL: 'fixture@invalid',
  GIT_COMMITTER_NAME: 'Holi fixture',
  GIT_COMMITTER_EMAIL: 'fixture@invalid',
}
const git = async (root, ...args) =>
  (await exec('git', ['-C', root, ...args], { env })).stdout.trim()
const put = async (root, path, bytes, mode) => {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, bytes)
  if (mode) await chmod(file, mode)
}

export async function createWorkingCopyTreeFixture(parent, runId, libraryRoot) {
  const cases = []
  const specs = [
    {
      name: 'mixed',
      changes: [
        ['binary.bin', Buffer.from([0, 255, 1])],
        ['run.sh', '#!/bin/sh\nexit 0\n', 0o755],
        ['added.md', 'added'],
        ['gone.md', null],
        ['replace', null],
        ['replace/child.bin', Buffer.from([9, 8])],
      ],
    },
    { name: 'noop', changes: [] },
    { name: 'conflict', refusal: true },
    { name: 'identity', refusal: true },
    { name: 'symlink', refusal: true },
    { name: 'unsupported-metadata', refusal: true },
  ]
  for (const spec of specs) {
    const root = await mkdtemp(join(parent, `holi-tree-${runId}-${spec.name}-`))
    await git(root, 'init', '-b', 'fixture-start')
    await put(root, 'protected.md', 'protected initial')
    await put(root, 'binary.bin', Buffer.from([0, 1, 2]))
    await put(root, '.gitignore', 'tracked-ignored.md\nignored-*.bin\n')
    await put(root, 'tracked-ignored.md', 'tracked before')
    await put(root, 'replace', 'file before')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-m', 'base')
    const baseHead = await git(root, 'rev-parse', 'HEAD')
    const beforeObjects = (await git(root, 'count-objects', '-v')).match(/count: (\d+)/)?.[1]
    if (!spec.refusal) {
      await put(root, 'protected.md', 'protected changed')
      await put(root, 'binary.bin', Buffer.from([0, 255, 1]))
      await put(root, 'run.sh', '#!/bin/sh\nexit 0\n', 0o755)
      await put(root, 'added.md', 'added')
      await rm(join(root, 'gone.md'), { force: true })
      await put(root, 'gone.md', 'gone')
      await git(root, 'add', 'gone.md')
      await git(root, 'commit', '-m', 'tracked deletion')
      await rm(join(root, 'gone.md'))
      await rm(join(root, 'replace'))
      await put(root, 'replace/child.bin', Buffer.from([9, 8]))
      await put(root, 'ignored-private.bin', 'ignored')
      await put(root, 'tracked-ignored.md', 'tracked ignored changed')
    }
    const oracle = await mkdtemp(join(parent, `holi-tree-oracle-${runId}-${spec.name}-`))
    await git(oracle, 'clone', '--no-hardlinks', root, '.')
    if (!spec.refusal) {
      await put(oracle, 'protected.md', 'protected changed')
      await put(oracle, 'binary.bin', Buffer.from([0, 255, 1]))
      await put(oracle, 'run.sh', '#!/bin/sh\nexit 0\n', 0o755)
      await put(oracle, 'added.md', 'added')
      await rm(join(oracle, 'gone.md'), { force: true })
      await rm(join(oracle, 'replace'))
      await put(oracle, 'replace/child.bin', Buffer.from([9, 8]))
      await put(oracle, 'tracked-ignored.md', 'tracked ignored changed')
    }
    await git(oracle, 'add', '-A')
    const expectedTree = await git(oracle, 'write-tree')
    const remote = `holi/tree-${runId}/${spec.name}`
    const library = join(libraryRoot, spec.name)
    await mkdir(library, { recursive: true })
    const result = {
      name: spec.name,
      runId,
      root,
      remote,
      branch: 'fixture-start',
      expectedTree,
      refusal: Boolean(spec.refusal),
      baseHead,
      beforeObjects,
    }
    cases.push(result)
    await rm(oracle, { recursive: true, force: true })
  }
  return { cases }
}

export async function verifyWorkingCopyTreeResults(results, manifest) {
  if (!Array.isArray(results) || results.length !== manifest.cases.length)
    throw new Error('Working-copy tree result count mismatch')
  for (const item of manifest.cases) {
    const result = results.find(
      (candidate) => candidate.name === item.name && candidate.runId === item.runId,
    )
    if (!result) throw new Error(`Missing tree result ${item.name}`)
    if (item.refusal) {
      if (!result.refused) throw new Error(`Expected refusal: ${item.name}`)
      continue
    }
    if (result.tree !== item.expectedTree)
      throw new Error(`Working-copy tree mismatch: ${item.name}`)
    if ((await git(item.root, 'rev-parse', 'HEAD')) !== item.baseHead)
      throw new Error(`HEAD mutated: ${item.name}`)
    await git(item.root, 'cat-file', '-e', `${result.tree}^{tree}`)
  }
  return true
}
