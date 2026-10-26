/**
 * What other plugins ask of the tasks (`@holi/shared`'s `plugin-wire.ts`): the
 * draft Google sends fits what `tasks.create` takes.
 */
import { expectTypeOf, test } from 'vitest'
import type { TaskCreateDraft } from '@holi/shared'
import type { CreateTaskInput } from '../main/capabilities'

test('a task made from a thread or an event is a create input', () => {
  expectTypeOf<TaskCreateDraft>().toExtend<CreateTaskInput>()
})
