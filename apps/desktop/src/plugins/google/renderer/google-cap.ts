/**
 * Google's capabilities at the UI door, each call naming the vault it is for.
 */
import { capClient } from '@/plugin-api'
import type { GoogleCapabilities } from '../main/capabilities'

export const googleCap = capClient<GoogleCapabilities>('google')
