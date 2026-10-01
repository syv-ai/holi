/**
 * The production wiring: **the only file in `google/` that imports Electron**,
 * for the same reason as `github/electron.ts` (the test suite runs under plain
 * Node).
 */
import { app, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { createGoogleAccounts, type GoogleAccountsManager } from './accounts'
import { GoogleTokenStore } from './token-store'
import { createVaultAccounts } from './vault-accounts'
import { listenLoopback } from './loopback-server'

/**
 * Build the Google accounts manager against the real OS keychain and a real
 * loopback listener.
 *
 * Call this **after `app.whenReady()`**: `safeStorage.isEncryptionAvailable()`
 * is not reliable before it.
 */
export function createGoogleAccountsManager(
  userDataDir = app.getPath('userData'),
): Promise<GoogleAccountsManager> {
  return createGoogleAccounts({
    store: new GoogleTokenStore(join(userDataDir, 'google-auth.enc'), safeStorage),
    // Which vault uses which account. Plain JSON beside the tokens.
    vaults: createVaultAccounts(join(userDataDir, 'google-vault-accounts.json')),
    listen: listenLoopback,
    // The **system** browser, so the consent reuses the user's existing Google
    // session and no credential ever enters the app's web context.
    openBrowser: (url) => shell.openExternal(url),
  })
}
