/**
 * The code generations of apps used in this vault. The vault snapshot prunes
 * node_modules; consent and this scanner deliberately do not. Only apps whose
 * grants have been checked are watched or healed, never every bundle on disk.
 */
import { relative, join, sep } from 'node:path'
import { watch } from 'chokidar'
import { isAppPrivatePath } from '@holi/shared'
import { bundleCodeHash } from './grants'

export function createAppCode(root: string, changed: (bundle: string, codeHash: string) => void) {
  let closed = false
  const bundles = new Map<string, ReturnType<typeof track>>()

  function track(bundle: string) {
    const dir = join(root, bundle)
    let revision = 0
    let hash: string | null = null
    let tail = Promise.resolve('')
    let timer: ReturnType<typeof setTimeout> | undefined
    const watcher = watch(dir, {
      ignoreInitial: true,
      followSymlinks: false,
      // Exactly the hash's root-level exclusions, including their subtrees.
      // No generic vault ignore policy: dependencies and hidden code count.
      ignored: (abs) => {
        const rel = relative(dir, abs).split(sep).join('/')
        return rel !== '' && isAppPrivatePath(rel)
      },
    })
    let releaseReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve
      watcher.once('ready', resolve)
    })

    const read = (): Promise<string> => {
      const run = async () => {
        await ready
        if (closed) throw new Error('app code scanner closed')
        // A write during an async hash invalidates that result. Serialize
        // scans as well, so an older completion can never publish over a new one.
        let next: string
        let scanned: number
        do {
          scanned = revision
          next = await bundleCodeHash(root, bundle)
        } while (!closed && scanned !== revision)
        if (!closed) {
          const previous = hash
          hash = next
          if (previous !== null && previous !== next) changed(bundle, next)
        }
        if (closed) throw new Error('app code scanner closed')
        return next
      }
      const result = tail.then(run, run)
      tail = result
      return result
    }
    watcher.on('all', () => {
      if (closed) return
      revision++
      clearTimeout(timer)
      timer = setTimeout(() => void read().catch(report), 200)
    })
    watcher.on('error', report)
    return {
      read,
      async close() {
        clearTimeout(timer)
        releaseReady()
        await watcher.close()
      },
    }
  }

  function report(error: unknown) {
    console.error('[apps] code scan:', error)
  }

  return {
    /** The same fresh hash used by consent, enrolling this exact bundle. */
    read(_root: string, bundle: string): Promise<string> {
      if (closed) return Promise.reject(new Error('app code scanner closed'))
      let tracked = bundles.get(bundle)
      if (tracked === undefined) {
        tracked = track(bundle)
        bundles.set(bundle, tracked)
      }
      return tracked.read()
    },
    /** Existing vault scans heal dropped watcher events, only for used apps. */
    async scan(): Promise<void> {
      await Promise.all([...bundles.values()].map((bundle) => bundle.read()))
    },
    async close(): Promise<void> {
      closed = true
      await Promise.all([...bundles.values()].map((bundle) => bundle.close()))
      bundles.clear()
    },
  }
}
