import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { inspectMdxDependencies } from '../src/main/mdx-dependencies'
import { fetchMdxExternalData } from '../src/main/mdx-external-data'
import type { MdxInspectResult } from '../src/main/mdx-resources'
import { createMdxExternalNetworkFixture } from './fixtures/mdx-external-network'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

type GraphOptions = Parameters<typeof inspectMdxDependencies>[0]

function imports(source: string, line: number): MdxInspectResult['dependencies'] {
  return [...source.matchAll(/import\s+[^'"\n]*?from\s+['"]([^'"]+)['"]/g)].flatMap(
    ([, specifier]) => (specifier === undefined ? [] : [{ specifier, line, column: 1 }]),
  )
}

async function setup(overrides: Partial<Pick<GraphOptions, 'inspect' | 'external'>> = {}) {
  const inspected: string[] = []
  const root = await mkdtemp(join(tmpdir(), 'holi-mdx-'))
  roots.push(root)
  const inspect = async (_owner: object, source: string) => {
    inspected.push(source)
    return {
      diagnostics: [],
      dependencies: imports(source, 2),
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
      ...overrides,
    })
  return { root, run, inspected }
}

async function setupExternal(inspect?: GraphOptions['inspect']) {
  const network = await createMdxExternalNetworkFixture()
  onTestFinished(() => network.close())
  const { run } = await setup({
    ...(inspect && { inspect }),
    external: {
      fetch: (url, signal) => fetchMdxExternalData({ url, signal, assertAccess: () => true }),
      retainSnapshot: () => {},
    },
  })
  return { network, run }
}

describe('inspectMdxDependencies', () => {
  it('rejects an invalid raw spelling even if its canonical URL was already inspected', async () => {
    const { network, run } = await setupExternal()
    const result = await run(
      `import A from '${network.entryURL}'\nimport B from 'https://%6fne.example/index.js'`,
    )
    expect(result).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/unsupported/i) }),
    ])
    expect(network.requests).toHaveLength(1)
  })

  it('reports unsupported specifiers and remote syntax errors without reproducing private input', async () => {
    // Exercise the real browser guest's request/result protocol under Node, not a native window.
    await import('../src/mdx-compiler/guest')
    const guest = globalThis as typeof globalThis & {
      __holiMdxReceive(encoded: string): void
      __holiMdxTakeResult(): (MdxInspectResult & { id: string }) | null
    }
    const { network, run } = await setupExternal(async (_owner, source, _signal, format) => {
      guest.__holiMdxReceive(
        Buffer.from(JSON.stringify({ id: 'inspection', source, format })).toString('base64'),
      )
      return vi.waitFor(() => {
        const result = guest.__holiMdxTakeResult()
        if (!result) throw new Error('Compiler guest has not replied')
        return result
      })
    })
    const secret = 'SYNTHETIC_MDX_SECRET'
    network.routes.respond = (_, res) => res.end(`// first line\nexport default /${secret}[z-a]/;`)
    const result = await run(
      [
        `import './child.js?token=${secret}'`,
        `import 'https://user:${secret}@one.example/blocked.js?key=${secret}'`,
        `import '${network.entryURL}'`,
      ].join('\n'),
    )
    expect(result).toHaveLength(3)
    expect(result[2]).toMatchObject({
      line: 3,
      message: expect.stringMatching(/^https:\/\/one\.example:2:\d+: Invalid JavaScript syntax/),
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(network.requests).toHaveLength(1)
  })

  it('returns no diagnostics for a safe nested graph and diagnoses a missing child', async () => {
    const { root, run } = await setup()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'child.mdx'), 'export default 1')
    expect(await run("import Child from './nested/child.mdx'")).toEqual([])
    const missing = await run("import Missing from './nested/absent.mdx'")
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({ line: 2 })
  })

  it('refuses protected paths, lowercase aliases, and symlink targets without inspecting them', async () => {
    const { root, run, inspected } = await setup()
    await writeFile(join(root, '.env'), 'SECRET_BYTES_MUST_NOT_BE_INSPECTED')
    await writeFile(join(root, 'secret.mdx'), 'SYMLINK_BYTES_MUST_NOT_BE_INSPECTED')
    await symlink(join(root, 'secret.mdx'), join(root, 'linked.mdx'))
    const diagnostics = await run("import Secret from './.ENV'\nimport Linked from './linked.mdx'")
    expect(diagnostics).toHaveLength(2)
    expect(inspected).toEqual(["import Secret from './.ENV'\nimport Linked from './linked.mdx'"])
  })

  it.each(['.holi/state', '.HOLI/STATE'])(
    'does not read or inspect machine state at %s',
    async (directory) => {
      const { root, run, inspected } = await setup()
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(
        join(root, directory, 'private.js'),
        "export const privateMarker = 'MACHINE_STATE_BYTES'\n",
      )
      const source = `import Private from './${directory}/private.js'`
      const diagnostics = await run(source)
      expect(diagnostics).toHaveLength(1)
      expect(inspected).toEqual([source])
    },
  )

  it('rejects a shared diamond dependency changed while another branch is inspected', async () => {
    const { root } = await setup()
    const shared = join(root, 'shared.mdx')
    await writeFile(shared, 'shared source')
    await writeFile(join(root, 'left.mdx'), "import Shared from './shared.mdx'")
    await writeFile(join(root, 'right.mdx'), "import Shared from './shared.mdx'\n// right source")
    await expect(
      inspectMdxDependencies({
        root,
        path: 'entry.mdx',
        source: "import Left from './left.mdx'\nimport Right from './right.mdx'",
        signal: new AbortController().signal,
        assertCurrent: async () => {},
        owner: {},
        inspect: async (_owner, source) => {
          if (source.includes('// right source')) await writeFile(shared, 'changed source')
          return { diagnostics: [], dependencies: imports(source, 1) }
        },
      }),
    ).rejects.toBeDefined()
  })

  it('does not inspect replacement-root bytes after ownership validation', async () => {
    const { root } = await setup()
    const originalChild = join(root, 'child.mdx')
    await writeFile(originalChild, 'ORIGINAL_BYTES')
    const movedRoot = `${root}-moved`
    roots.push(movedRoot)
    let replaceRoot = false
    const inspected: string[] = []
    const request = inspectMdxDependencies({
      root,
      path: 'entry.mdx',
      source: "import Child from './child.mdx'",
      signal: new AbortController().signal,
      assertCurrent: async () => {
        if (replaceRoot) {
          replaceRoot = false
          await rename(root, movedRoot)
          await mkdir(root)
          await writeFile(join(root, 'child.mdx'), 'REPLACEMENT_BYTES')
        }
      },
      owner: {},
      inspect: async (_owner, source) => {
        inspected.push(source)
        if (source.includes('import Child')) {
          replaceRoot = true
          return {
            diagnostics: [],
            dependencies: [{ specifier: './child.mdx', line: 1, column: 1 }],
          }
        }
        return { diagnostics: [], dependencies: [] }
      },
    })
    await expect(request).rejects.toBeDefined()
    expect(inspected).not.toContain('REPLACEMENT_BYTES')
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
          return { diagnostics: [], dependencies: imports(source, 1) }
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
