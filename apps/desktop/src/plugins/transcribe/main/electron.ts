/**
 * The production wiring of the speech key: **the only file in `transcribe/`
 * that imports Electron**, as `google/main/electron.ts` is for Google's, so
 * the rest loads under plain Node in the tests.
 */
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { createSpeechKeyStore, type SpeechKeyStore } from './speech-key'

/**
 * This machine's speech key, keychain-encrypted in `userData`.
 *
 * Call this **after `app.whenReady()`**: `safeStorage.isEncryptionAvailable()`
 * is not reliable before it.
 */
export function speechKeyStore(userDataDir: string): SpeechKeyStore {
  return createSpeechKeyStore(join(userDataDir, 'speech-key.enc'), safeStorage)
}
