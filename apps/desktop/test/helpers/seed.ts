/**
 * The seed contributions the app passes, for tests that need a vault seeded
 * the way a real one is.
 */
import { agentSeed } from '../../src/main/agent/seed/seed'
import { pdfSeed } from '../../src/main/pdf/seed'
import { coreSeed } from '../../src/main/vault/seed/core'
import { ensureSeeded } from '../../src/main/vault/seed/seed'
import type { SeedResult } from '../../src/main/vault/seed/types'

export const SEED_CONTRIBUTIONS = [coreSeed([]), agentSeed, pdfSeed]

export const seedVault = (root: string): Promise<SeedResult> =>
  ensureSeeded(root, SEED_CONTRIBUTIONS)
