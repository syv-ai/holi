/**
 * What other plugins ask of the automations (`@holi/shared`'s `plugin-wire.ts`):
 * the answers fit the shapes they type their clients with, and the draft they
 * send fits what `schedules.save` takes.
 */
import { expectTypeOf, test } from 'vitest'
import type { HabitDraft, HabitSummary } from '@holi/shared'
import type { ScheduleDraft } from '@holi/shared'
import type { ScheduleSummary } from '../main/scheduler'

test('schedules.list answers what the Habits tab reads', () => {
  expectTypeOf<ScheduleSummary>().toExtend<HabitSummary>()
})

test("a Holi's first habit is a schedule draft", () => {
  expectTypeOf<HabitDraft>().toExtend<ScheduleDraft>()
})
