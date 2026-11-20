import { createRequire } from 'node:module'

/** Resolve the optional runtime without making it a requirement on other OSes. */
export function resolveBundledWindowsNode(): string | null {
  try {
    const moduleRequire = typeof require === 'function' ? require : createRequire(import.meta.url)
    const file = moduleRequire.resolve('node-win-x64/bin/node.exe')
    return file.replace(
      /(.*[\\/])resources([\\/])app\.asar([\\/])/i,
      '$1resources$2app.asar.unpacked$3',
    )
  } catch {
    return null
  }
}
