import Module from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBundledWindowsNode } from '../src/main/windows-node-runtime'

// Vitest provides a module-local require. Intercept its resolution (and
// createRequire's) at the Node loader, without installing the optional package.
const loader = Module as typeof Module & {
  _resolveFilename(request: string, ...args: unknown[]): string
}

function mockRuntime(resolve: () => string): void {
  const original = loader._resolveFilename
  vi.spyOn(loader, '_resolveFilename').mockImplementation(function (
    this: typeof loader,
    request,
    ...args
  ) {
    return request === 'node-win-x64/bin/node.exe'
      ? resolve()
      : original.call(this, request, ...args)
  })
}

afterEach(() => vi.restoreAllMocks())

describe('resolveBundledWindowsNode', () => {
  it('returns the resolved executable path unchanged outside the packaged archive', () => {
    const path = '/holi/node_modules/node-win-x64/bin/node.exe'
    mockRuntime(() => path)
    expect(resolveBundledWindowsNode()).toBe(path)
  })

  it.each([
    [
      'C:\\Program Files\\Holi\\resources\\app.asar\\node_modules\\node-win-x64\\bin\\node.exe',
      'C:\\Program Files\\Holi\\resources\\app.asar.unpacked\\node_modules\\node-win-x64\\bin\\node.exe',
    ],
    [
      'C:/Holi/Resources/App.Asar/node_modules/node-win-x64/bin/node.exe',
      'C:/Holi/resources/app.asar.unpacked/node_modules/node-win-x64/bin/node.exe',
    ],
  ])('rewrites %s to the unpacked executable path', (resolved, unpacked) => {
    mockRuntime(() => resolved)
    expect(resolveBundledWindowsNode()).toBe(unpacked)
  })

  it('returns null when the optional runtime cannot be resolved', () => {
    mockRuntime(() => {
      throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })
    })
    expect(resolveBundledWindowsNode()).toBeNull()
  })
})
