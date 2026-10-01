/**
 * The seed contributions the app passes, for tests that need a vault seeded
 * the way a real one is.
 */
import { agentSeed } from '../../src/main/agent/seed/seed'
import { appsSeed } from '../../src/plugins/apps/main/seed'
import { googleSeed } from '../../src/plugins/google/main/seed'
import { pdfSeed } from '../../src/plugins/pdf/main/seed'
import { coreSeed } from '../../src/main/vault/seed/core'
import { ensureSeeded } from '../../src/main/vault/seed/seed'
import type { SeedResult } from '../../src/main/vault/seed/types'

export const SEED_CONTRIBUTIONS = [coreSeed([]), agentSeed, pdfSeed, googleSeed, appsSeed]

export const seedVault = (root: string): Promise<SeedResult> =>
  ensureSeeded(root, SEED_CONTRIBUTIONS)
