/**
 * The production wiring — **the only file in `github/` that imports Electron**.
 *
 * It is its own file rather than a function at the bottom of `session.ts`
 * because a static `import … from 'electron'` is a module-load side effect, and
 * `session.ts` is loaded by the test suite. Under vitest that import happens to
 * resolve (Electron's Node entry point exports a path string), so it would pass
 * today and break on a machine or a CI image where it does not — for a reason
 * that has nothing to do with the code under test. Keeping the import in a file
 * nothing but `main/index.ts` reaches makes "the suite runs under plain Node" a
 * structural fact instead of a lucky one.
 */
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { GitHubSession } from './session'
import { TokenStore } from './token-store'

/**
 * Build the session against the real OS keychain.
 *
 * Call this **after `app.whenReady()`**. `safeStorage.isEncryptionAvailable()`
 * is not reliable before it, and a sign-in that fails on the first launch of
 * the day and works on the second is a miserable bug to go looking for.
 */
export function createSession(userDataDir = app.getPath('userData')): Promise<GitHubSession> {
  return GitHubSession.load({
    store: new TokenStore(join(userDataDir, 'github-auth.enc'), safeStorage),
  })
}
