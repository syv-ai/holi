const { dirname, relative } = require('node:path')
const { builtinModules } = require('node:module')

// A deliberately closed graph: adding a shared dependency requires reviewing it here.
const expected = ['path-safety.ts', 'vault-format.ts', 'vault-format.v1.json']
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')))

class SharedGraphPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('SharedGraph', (compilation) => {
      let evidence
      compilation.hooks.finishModules.tap('SharedGraph', (modules) => {
        const root = dirname(require.resolve('@holi/shared/vault-format'))
        const shared = [...modules].filter((module) => module.resource?.startsWith(`${root}/`))
        const resources = shared.map((module) => relative(root, module.resource)).sort()
        if (JSON.stringify(resources) !== JSON.stringify(expected)) {
          throw new Error(`Unexpected shared bundle graph: ${JSON.stringify(resources)}`)
        }
        const edges = []
        for (const module of shared) {
          for (const connection of compilation.moduleGraph.getOutgoingConnections(module)) {
            const request = connection.dependency?.request
            if (!request) continue
            const target = connection.module?.resource
            if (
              builtins.has(request.replace(/^node:/, '')) ||
              request.includes('electron') ||
              !target ||
              !expected.includes(relative(root, target))
            ) {
              throw new Error(`Non-portable shared dependency: ${request} -> ${target}`)
            }
            edges.push({
              from: relative(root, module.resource),
              request,
              to: relative(root, target),
            })
          }
        }
        evidence = { schemaVersion: 1, resources, edges }
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
