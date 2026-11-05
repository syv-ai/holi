/**
 * The production wiring: **the only file in `booking/` that imports
 * Electron**, so the rest loads under plain Node in the tests.
 */
import { safeStorage } from 'electron'
import { join } from 'node:path'
import { createSessionStore, type SessionStore } from './session-store'

/** The session file, encrypted with the OS keychain. Call after `whenReady`. */
export function createKeychainSessionStore(userData: string): SessionStore {
  return createSessionStore(join(userData, 'booking-session.enc'), safeStorage)
}
