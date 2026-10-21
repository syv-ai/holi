/** What tasks is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

export const TASKS_INFO: PluginInfo = {
  id: 'tasks',
  label: 'Tasks',
  default: true,
  // The using-tasks skill, and the deny rules that keep Claude's own task
  // tools from passing for the vault's.
  addsTo: ['agent'],
  description:
    'Task files (task.*.md) on a board, with quick add, due dates, recurrence and reminders.',
  whenOff:
    'The board, quick add and reminders go, and a task file opens as a plain note. The files stay as they are.',
  transforms: [
    {
      // Off: a transform that rearranges someone's work is opt-in.
      name: 'archive-done',
      label: 'File finished tasks away',
      explanation:
        'Moves tasks finished more than two weeks ago into archive/, links and all. Off by default, because it changes what your board shows.',
      default: false,
    },
  ],
}
