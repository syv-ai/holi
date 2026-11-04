/**
 * What other plugins ask of the Holis (`@holi/shared`'s `plugin-wire.ts`): the
 * answer fits the shape the automations' Holi picker types its client with.
 */
import { expectTypeOf, test } from 'vitest'
import type { PickableHoli } from '@holi/shared'
import type { HoliSummary } from '../main/holis'

test('holis.list answers what the Holi picker reads', () => {
  expectTypeOf<HoliSummary>().toExtend<PickableHoli>()
})
