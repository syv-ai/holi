/**
 * Tasks' main side (docs/features/tasks.md): the task files it claims in the
 * snapshot, its capabilities (the board's, `holi tasks` and vault apps'), the
 * archive-done commit transform, the skill it seeds, and reminders, which
 * fire across every registered vault that runs it while Holi runs.
 */
import { taskClaim } from '../shared/task-file'
import { localDate } from '@holi/shared'
import type { MainPlugin } from '../../../main/plugin-api'
import { TASKS_INFO } from '../info'
import { archiveDone } from './archive-done'
import { taskCapabilities, TASKS_NAMESPACES } from './capabilities'
import { startReminders } from './reminders/start'
import { tasksSeed } from './seed'

export const tasksMain: MainPlugin = {
  info: TASKS_INFO,
  seed: tasksSeed,
  claims: [taskClaim],
  transforms: [{ name: 'archive-done', run: (root, staged) => archiveDone(root, staged) }],
  activate: (ctx) => ctx.register(TASKS_NAMESPACES, taskCapabilities({ today: () => localDate(new Date()) })),
  background: { why: 'Holi stays open for reminders', start: startReminders },
}
