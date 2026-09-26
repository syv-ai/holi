/**
 * The production wiring: **the only file in `github/` that imports Electron**.
 *
 * A static `import … from 'electron'` is a module-load side effect, and
 * `session.ts` is loaded by the test suite. Keeping the import in a file only
 * `main/index.ts` reaches makes "the suite runs under plain Node" a structural
 * fact instead of a lucky one.
 */
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { GitHubSession } from './session'
import { TokenStore } from './token-store'

/**
 * Build the session against the real OS keychain.
 *
 * Call this **after `app.whenReady()`**: `safeStorage.isEncryptionAvailable()`
 * is not reliable before it.
 */
export function createSession(userDataDir = app.getPath('userData')): Promise<GitHubSession> {
  return GitHubSession.load({
    store: new TokenStore(join(userDataDir, 'github-auth.enc'), safeStorage),
  })
}
