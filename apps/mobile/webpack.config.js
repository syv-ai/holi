// The root package extension supplies this transformer's undeclared TS 5.9
// dependency: the root's TS 7 package has no JavaScript compiler API.
const webpack = require('@nativescript/webpack')
const SharedGraphPlugin = require('./scripts/shared-graph.cjs')
module.exports = (env) => {
  webpack.init(env)
  webpack.useConfig('vue')
  webpack.chainWebpack((config) => {
    config.plugin('SharedGraph').use(SharedGraphPlugin)
    config.module.rule('ts').use('ts-loader').loader(require.resolve('ts-loader'))
    // Do not let webpack's Node shims mask accidental dependencies.
    config.resolve.alias.delete('module')
    config.resolve.set('fallback', {})
  })
  return webpack.resolveConfig()
}
