import { flush, getString, remove, setString } from '@nativescript/core/application-settings'
import type { MetadataKeyValue } from './note-metadata'

/** Machine-local application-settings adapter; values never enter the vault. */
export const noteMetadataSettings: MetadataKeyValue = {
  get: (key) => getString(key),
  set(key, value) {
    const previous = getString(key)
    try {
      setString(key, value)
      if (!flush()) throw new Error('Could not persist note metadata')
    } catch (error) {
      // Restore the settings cache too, so reconstruction cannot accept the failed write.
      if (previous === undefined) remove(key)
      else setString(key, previous)
      flush()
      throw error
    }
  },
}
