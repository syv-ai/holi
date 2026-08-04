/**
 * The production wiring — **the only file in `google/` that imports Electron**.
 *
 * Same reasoning as `github/electron.ts`: a static `import … from 'electron'`
 * is a module-load side effect, and every other file here is loaded by the test
 * suite. Keeping the import in a file nothing but `main/index.ts` reaches makes
 * "the suite runs under plain Node" a structural fact rather than a lucky one.
 */
import { app, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { GoogleSession } from './session'
import { GoogleTokenStore } from './token-store'
import { listenLoopback } from './loopback-server'

/**
 * Build the Google session against the real OS keychain and a real loopback
 * listener.
 *
 * Call this **after `app.whenReady()`** — `safeStorage.isEncryptionAvailable()`
 * is not reliable before it, and a connect that fails on the first launch of the
 * day and works on the second is a miserable bug to go looking for.
 */
export function createGoogleSession(userDataDir = app.getPath('userData')): Promise<GoogleSession> {
  return GoogleSession.load({
    store: new GoogleTokenStore(join(userDataDir, 'google-auth.enc'), safeStorage),
    listen: listenLoopback,
    // The **system** browser, so the consent reuses the user's existing Google
    // session and no credential ever enters the app's web context.
    openBrowser: (url) => shell.openExternal(url),
  })
}
