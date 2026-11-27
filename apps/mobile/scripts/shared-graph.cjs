const { dirname, relative, join } = require('node:path')
const { builtinModules } = require('node:module')

// Every shared module and parser dependency is explicitly reviewed here.
const expected = [
  'markdown-move-links.ts',
  'mobile-path-safety.ts',
  'path-safety.ts',
  'vault-format.ts',
  'vault-format.v1.json',
  'wiki-links.ts',
]
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

class SharedGraphPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('SharedGraph', (compilation) => {
      let evidence
      compilation.hooks.finishModules.tap('SharedGraph', (modules) => {
        const root = dirname(require.resolve('@holi/shared/vault-format'))
        const markdown = require.resolve('@lezer/markdown', { paths: [root] })
        const reviewed = new Map(expected.map((name) => [join(root, name), name]))
        for (const name of ['@lezer/markdown', '@lezer/common', '@lezer/highlight']) {
          const entry = require.resolve(name, { paths: [dirname(markdown)] })
          reviewed.set(join(dirname(entry), 'index.js'), name)
        }
        const decoder = dirname(require.resolve('entities/decode', { paths: [root] }))
        const decoderRoot = join(dirname(decoder), 'esm')
        const decoderFiles = [
          ['decode.js', 'entities/decode'],
          ['decode-codepoint.js', 'entities/decode-codepoint'],
          ['generated/decode-data-html.js', 'entities/decode-data-html'],
          ['generated/decode-data-xml.js', 'entities/decode-data-xml'],
        ]
        for (const [file, label] of decoderFiles) reviewed.set(join(decoderRoot, file), label)
        const bundled = [...modules].filter((module) => reviewed.has(module.resource))
        const resources = bundled.map((module) => reviewed.get(module.resource)).sort()
        const allowed = [
          ...expected,
          '@lezer/common',
          '@lezer/highlight',
          '@lezer/markdown',
          ...decoderFiles.map(([, label]) => label),
        ].sort()
        if (JSON.stringify(resources) !== JSON.stringify(allowed))
          throw new Error(`Unexpected shared bundle graph: ${JSON.stringify(resources)}`)
        const unknownShared = [...modules].filter(
          (module) => module.resource?.startsWith(`${root}/`) && !reviewed.has(module.resource),
        )
        if (unknownShared.length)
          throw new Error(
            `Unreviewed shared modules: ${unknownShared.map((module) => relative(root, module.resource)).join(', ')}`,
          )
        const edges = []
        for (const module of bundled) {
          for (const connection of compilation.moduleGraph.getOutgoingConnections(module)) {
            const request = connection.dependency?.request
            if (!request) continue
            const target = connection.module?.resource
            if (
              builtins.has(request.replace(/^node:/, '')) ||
              request.includes('electron') ||
              !reviewed.has(target)
            )
              throw new Error(`Non-portable shared dependency: ${request} -> ${target}`)
            edges.push({ from: reviewed.get(module.resource), request, to: reviewed.get(target) })
          }
        }
        evidence = { schemaVersion: 2, resources, edges }
      })
      compilation.hooks.processAssets.tap(
        {
          name: 'SharedGraph',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          if (!evidence) throw new Error('Missing shared graph evidence')
          compilation.emitAsset(
            'shared-bundle-graph.json',
            new compiler.webpack.sources.RawSource(JSON.stringify(evidence, null, 2)),
          )
        },
      )
    })
  }
}
module.exports = SharedGraphPlugin
