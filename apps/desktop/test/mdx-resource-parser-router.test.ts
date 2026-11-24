import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resourceRig } from './fixtures/mdx-router'

const entry = 'https://one.example/entry.js'

it('requires origin consent for an empty MDX re-export and diagnoses its dependency', async () => {
  const { mdx, acquire, contacts, routes } = await resourceRig()
  const owner = await acquire()
  const source = `# Preview\n\nexport {} from '${entry}'\n`
  routes.set(entry, { text: 'export const = 1' })
  try {
    const diagnose = (generation: number) => mdx.compile({ ...owner, generation, source })
    expect(await diagnose(1)).toMatchObject([{ line: 3 }])
    const { pending } = await mdx.externalResources(owner)
    expect(pending).toMatchObject([
      { origin: 'https://one.example', purpose: 'mdx-dependency-diagnostics' },
    ])
    expect(contacts).toEqual([])

    await mdx.approveExternalResource({ ...owner, requestId: pending[0]!.id })
    expect(await diagnose(2)).toMatchObject([
      { line: 3, message: expect.stringMatching(/invalid javascript syntax/i) },
    ])
    expect(contacts).toEqual([entry])
    expect((await mdx.externalResources(owner)).pending).toEqual([])

    await expect(
      mdx.compile({
        ...owner,
        generation: 3,
        source: "# Preview\n\nexport {} from './missing.js'\n",
      }),
    ).resolves.toMatchObject([{ line: 3, message: expect.stringContaining('missing.js') }])
    expect(contacts).toEqual([entry])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it('reports consent at each original MDX declaration, including one that supplies the layout', async () => {
  const { mdx, acquire, contacts } = await resourceRig()
  const owner = await acquire()
  try {
    const source = [
      '# Preview',
      '',
      `import { feature } from '${entry}'`,
      `export { default, helper } from 'https://one.example/layout.js'`,
      `export * from 'https://one.example/widgets.js'`,
      '',
      '<div>',
      '',
      `import '${entry}'`,
      '',
      '</div>',
    ].join('\n')
    const diagnostics = await mdx.compile({ ...owner, generation: 1, source })
    expect(diagnostics).toMatchObject(
      [3, 4, 5, 9].map((line) => ({ line, message: expect.stringMatching(/consent/i) })),
    )
    expect((await mdx.externalResources(owner)).pending).toMatchObject([
      { origin: 'https://one.example' },
    ])
    expect(contacts).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it('diagnoses empty and populated import attributes before requesting consent or contacting an origin', async () => {
  const { root, mdx, acquire, contacts, routes } = await resourceRig()
  const owner = await acquire()
  const withInUrl = 'https://one.example/plain.js?note=with{}'
  routes.set(withInUrl, { text: 'export const plain = 1' })
  routes.set(entry, { text: 'export const other = 2' })
  await mdx.compile({ ...owner, generation: 1, source: `import '${entry}'\n` })
  const { pending } = await mdx.externalResources(owner)
  await mdx.approveExternalResource({ ...owner, requestId: pending[0]!.id })

  const approved = 'https://one.example/data.js?token=private-url-value'
  const unapproved = 'https://two.example/data.js'
  await writeFile(
    join(root, 'child.js'),
    [
      `import payload from '${approved}' with { type: 'json' };`,
      `export { default as metadata } from '${unapproved}' with {};`,
      `export * from '${approved}&kind=star' /* gap */ with { /* empty */ };`,
      `export {} from '${approved}&kind=empty' with {};`,
      `import '${withInUrl}' /* with {} */;`,
    ].join('\n'),
  )
  await writeFile(
    join(root, 'child.jsx'),
    [
      `import '${unapproved}?kind=side-effect' with {}`,
      `export { default as metadata } from '${approved}&kind=named' with { loader: 'private-loader-value' };`,
      `export * from '${unapproved}?kind=star' with { type: 'json' };`,
      `export * from '${entry}' // with {}`,
      'export const view = <div>{"with {}"}</div>;',
    ].join('\n'),
  )
  const diagnostics = await mdx.compile({
    ...owner,
    generation: 2,
    source: "import './child.js'\nimport './child.jsx'\n\n# Preview",
  })
  expect(diagnostics.map(({ message }) => message)).toEqual(
    ['js', 'jsx'].flatMap((format) =>
      (format === 'js' ? [1, 2, 3, 4] : [1, 2, 3]).map((line) =>
        expect.stringMatching(
          new RegExp(`child\\.${format}:${line}:1: .*unsupported import attributes`, 'i'),
        ),
      ),
    ),
  )
  expect(JSON.stringify(diagnostics)).not.toMatch(
    /https:\/\/|private-url-value|private-loader-value/,
  )
  expect((await mdx.externalResources(owner)).pending).toEqual([])
  expect(contacts).toEqual([withInUrl, entry])

  // MDX's parser may reject the syntax itself. Even if it accepts the clause,
  // neither an ordinary dependency nor a rewritten layout import may escape.
  for (const [index, declaration] of [
    `import '${approved}' with {};`,
    `export { default } from '${unapproved}' with {};`,
    `export * from '${approved}&kind=star' with {};`,
    `export {} from '${approved}&kind=empty' with {};`,
  ].entries()) {
    const invalidMdx = await mdx.compile({
      ...owner,
      generation: index + 3,
      source: `# Preview\n\n${declaration}\n`,
    })
    expect(invalidMdx).toMatchObject([{ line: 3, column: expect.any(Number) }])
    expect(JSON.stringify(invalidMdx)).not.toMatch(/https:\/\/|private-url-value/)
    expect((await mdx.externalResources(owner)).pending).toEqual([])
    expect(contacts).toEqual([withInUrl, entry])
  }
  await mdx.releaseDiagnosticsLease(owner)
})

it('accepts CommonJS spellings bound by browser ESM in JS, JSX and MDX', async () => {
  const { root, mdx, acquire, contacts } = await resourceRig()
  const owner = await acquire()
  try {
    await writeFile(
      join(root, 'local.js'),
      [
        'const exports = { value: 1 };',
        'const module = { exports };',
        'module.exports.value = require();',
        'function require() { if (exports.value) { var module = exports; } return module.value; }',
        'export const value = exports.value;',
        'export const View = () => null;',
      ].join('\n'),
    )
    await writeFile(
      join(root, 'view.jsx'),
      [
        "import * as exports from './local.js';",
        'export const view = ({ module }, require = (value) => value) =>',
        '  <exports require="module.exports"><exports.View />{require(module.exports)}{exports.value}</exports>;',
      ].join('\n'),
    )
    const source = [
      "import * as module from './local.js'",
      "import './view.jsx'",
      '',
      'export const exports = { View: module.View, value: module.value }',
      'export const require = Object.assign(({ value }) => value, { View: module.View })',
      '',
      '# Preview',
      '',
      '<module.View>',
      '<exports.View require={require(exports)} {...{ module }} />',
      '',
      'Inline <require.View /> and {exports.value + require({ value: module.value })}.',
      '',
      '</module.View>',
    ].join('\n')
    await expect(mdx.compile({ ...owner, generation: 1, source })).resolves.toEqual([])
    expect(contacts).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it('diagnoses free CommonJS references without echoing source', async () => {
  const { root, mdx, acquire, contacts } = await resourceRig()
  const owner = await acquire()
  try {
    const define = "Object.defineProperty(exports, 'private-guest-value', { value: 1 });"
    const initialize = 'export function load(loader = require) { var require = () => null; }'
    await writeFile(join(root, 'child.js'), `${define}\n${initialize}`)
    const view = 'export const view = <exports require="module"><module.View /></exports>;'
    await writeFile(join(root, 'child.jsx'), view)
    const alias = '  {...(() => { const loader = require; return { exports: 1, module: 2 } })()}'
    const destructure =
      '  require={(() => { const { privateValue } = exports; return privateValue })()}'
    const inlineTags =
      'Preview <\u00a0exports . PrivateGroup.View /> <UI.require.module.exports /> <module />'
    const source = [
      "import './child.js'",
      "import './child.jsx'",
      '',
      '<module.PrivateModuleView',
      alias,
      destructure,
      '>',
      '<>',
      '  <require.PrivateLoader />',
      '',
      inlineTags,
      '',
      '</>',
      '</module.PrivateModuleView>',
      '',
      `{import('${entry}')}`,
      '',
      '{import.meta.url}',
    ].join('\n')
    const diagnostics = await mdx.compile({ ...owner, generation: 1, source })
    const position = (line: string, name: string) => line.indexOf(name) + 1
    expect(diagnostics).toHaveLength(10)
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        ...[
          [1, 'js', 1, position(define, 'exports')],
          [1, 'js', 2, position(initialize, 'require')],
          [2, 'jsx', 1, position(view, 'module.View')],
        ].map(([line, format, moduleLine, column]) =>
          expect.objectContaining({
            line,
            message: expect.stringMatching(`child\\.${format}:${moduleLine}:${column}: .*CommonJS`),
          }),
        ),
        ...[
          [4, 2],
          [5, position(alias, 'require')],
          [6, position(destructure, 'exports')],
          [9, 4],
          [11, position(inlineTags, 'exports')],
        ].map(([line, column]) =>
          expect.objectContaining({ line, column, message: expect.stringMatching(/CommonJS/) }),
        ),
        expect.objectContaining({
          line: 16,
          column: 2,
          message: expect.stringMatching(/dynamic import/i),
        }),
        expect.objectContaining({
          line: 18,
          column: 2,
          message: expect.stringMatching(/import\.meta/),
        }),
      ]),
    )
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /private-guest-value|privateValue|PrivateModuleView|PrivateLoader|PrivateGroup|one\.example/,
    )
    expect((await mdx.externalResources(owner)).pending).toEqual([])
    expect(contacts).toEqual([])
  } finally {
    await mdx.releaseDiagnosticsLease(owner)
  }
})

it.each(['local', 'external'] as const)(
  'anchors dependency diagnostics at the parent declaration for %s modules',
  async (kind) => {
    const { mdx, acquire, root, routes } = await resourceRig()
    const syntax = 'export const invalid = ;'
    if (kind === 'local') await writeFile(join(root, 'broken.js'), syntax)
    else routes.set(entry, { text: syntax })
    const owner = await acquire()
    const prefix = 'export const beforeDeclaration = true; '
    const source = `${prefix}import '${kind === 'local' ? './broken.js' : entry}'\n`
    const parentColumn = prefix.length + 1
    try {
      let diagnostics = await mdx.compile({ ...owner, generation: 1, source })
      if (kind === 'external') {
        expect(diagnostics[0]).toMatchObject({ line: 1, column: parentColumn })
        const requestId = (await mdx.externalResources(owner)).pending[0]!.id
        await mdx.approveExternalResource({ ...owner, requestId })
        diagnostics = await mdx.compile({ ...owner, generation: 2, source })
      }
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ line: 1, column: parentColumn })
      expect(diagnostics[0]!.message).toContain(`:1:${syntax.indexOf(';') + 1}:`)
    } finally {
      await mdx.releaseDiagnosticsLease(owner)
    }
  },
)
