/**
 * Runs a TypeScript script of this folder with Vite's SSR loader, so it can
 * import the app's own modules (extensionless, `@holi/shared`) exactly as the
 * tests do, with no extra runtime dependency.
 *
 *   node scripts/run-ts.mjs scripts/chat-drift.ts [args...]
 *
 * The script exports `main(argv): Promise<number>`; its result is the exit code.
 */
import { resolve } from 'node:path'
import { createServer } from 'vite'

const [script, ...args] = process.argv.slice(2)
if (!script) {
  console.error('usage: node scripts/run-ts.mjs <script.ts> [args...]')
  process.exit(2)
}

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
})
let code = 1
try {
  const mod = await server.ssrLoadModule(resolve(script))
  code = await mod.main(args)
} catch (error) {
  console.error(error)
} finally {
  await server.close()
}
// Let piped output drain before the process ends.
process.stdout.write('', () => process.exit(code))
