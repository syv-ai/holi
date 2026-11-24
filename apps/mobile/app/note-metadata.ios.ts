import { getString, setString } from '@nativescript/core/application-settings'
import type { MetadataKeyValue } from './note-metadata'

/** Machine-local application-settings adapter; values never enter the vault. */
export const noteMetadataSettings: MetadataKeyValue = {
  get: (key) => getString(key),
  set: (key, value) => setString(key, value),
}
