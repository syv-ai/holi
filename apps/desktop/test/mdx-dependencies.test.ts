import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectMdxDependencies } from '../src/main/mdx-dependencies'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function setup() {
  const inspected: string[] = []
  const root = await mkdtemp(join(tmpdir(), 'holi-mdx-'))
  roots.push(root)
  const inspect = async (_owner: object, source: string) => {
    inspected.push(source)
    return {
      diagnostics: [],
      dependencies: [...source.matchAll(/import\s+[^'"\n]*?from\s+['"]([^'"]+)['"]/g)].map(
        (match) => ({
          specifier: match[1],
          line: 2,
          column: 1,
        }),
      ),
    }
  }
  const run = (source: string) =>
    inspectMdxDependencies({
      root,
      path: 'entry.mdx',
      source,
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      owner: {},
      inspect,
    })
  return { root, run, inspected }
}

describe('inspectMdxDependencies', () => {
  it('returns no diagnostics for a safe nested graph and diagnoses a missing child', async () => {
    const { root, run } = await setup()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'child.mdx'), 'export default 1')
    expect(await run("import Child from './nested/child.mdx'")).toEqual([])
    const missing = await run("import Missing from './nested/absent.mdx'")
    expect(missing).toHaveLength(1)
    expect(missing[0].line).toBe(2)
  })

  it('refuses protected paths, lowercase aliases, and symlink targets without inspecting them', async () => {
    const { root, run, inspected } = await setup()
    await writeFile(join(root, '.env'), 'SECRET_BYTES_MUST_NOT_BE_INSPECTED')
    await writeFile(join(root, 'secret.mdx'), 'SYMLINK_BYTES_MUST_NOT_BE_INSPECTED')
    await symlink(join(root, 'secret.mdx'), join(root, 'linked.mdx'))
    const diagnostics = await run("import Secret from './.ENV'\nimport Linked from './linked.mdx'")
    expect(diagnostics).toHaveLength(2)
    expect(inspected).toEqual([])
  })

  it('rejects a dependency changed after it was inspected', async () => {
    const { root } = await setup()
    const child = join(root, 'child.mdx')
    await writeFile(child, 'DISTINCT_CHILD_SOURCE')
    await expect(
      inspectMdxDependencies({
        root,
        path: 'entry.mdx',
        source: "import Child from './child.mdx'",
        signal: new AbortController().signal,
        assertCurrent: async () => {},
        owner: {},
        inspect: async (_owner, source) => {
          if (source === 'DISTINCT_CHILD_SOURCE') await writeFile(child, 'changed after inspection')
          return {
            diagnostics: [],
            dependencies: [...source.matchAll(/import\s+[^'"\n]*?from\s+['"]([^'"]+)['"]/g)].map(
              (m) => ({ specifier: m[1], line: 1 }),
            ),
          }
        },
      }),
    ).rejects.toBeDefined()
  })

  it('bounds file size, aggregate bytes, depth, and module count', async () => {
    const { root, run } = await setup()
    expect(await run('x'.repeat(256 * 1024 + 1))).not.toEqual([])

    const aggregate = Array.from(
      { length: 5 },
      (_, index) => `import M${index} from './m${index}.mdx'`,
    ).join('\n')
    for (let index = 0; index < 5; index++)
      await writeFile(join(root, `m${index}.mdx`), 'x'.repeat(220 * 1024))
    expect(await run(aggregate)).not.toEqual([])

    for (let index = 0; index < 18; index++) {
      await writeFile(
        join(root, `d${index}.mdx`),
        index < 17 ? `import Next from './d${index + 1}.mdx'` : 'export default 1',
      )
    }
    expect(await run("import First from './d0.mdx'")).not.toEqual([])

    for (let index = 0; index < 65; index++)
      await writeFile(join(root, `m-count-${index}.mdx`), 'export default 1')
    const many = Array.from(
      { length: 65 },
      (_, index) => `import M from './m-count-${index}.mdx'`,
    ).join('\n')
    expect(await run(many)).not.toEqual([])
  })

  it('does not deliver results if the request is cancelled during inspection', async () => {
    const { root } = await setup()
    await mkdir(join(root, 'nested'))
    const controller = new AbortController()
    await expect(
      inspectMdxDependencies({
        root,
        path: 'entry.mdx',
        source: 'x',
        signal: controller.signal,
        assertCurrent: async () => {},
        owner: {},
        inspect: async () => {
          controller.abort()
          return { diagnostics: [], dependencies: [] }
        },
      }),
    ).rejects.toBeDefined()
  })
})
