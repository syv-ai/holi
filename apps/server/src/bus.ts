/** Typed in-process event bus feeding the (S) SSE subscriptions. Single-node
 * by design — multi-node needs shared pub/sub (PRD: open, post-v1). */
import { EventEmitter } from 'node:events'
import type { DocMeta, Task } from '@holi/shared'

export type DocsEvent = { type: 'created' | 'renamed' | 'deleted'; doc: DocMeta }
export type TasksEvent = { type: 'upserted'; task: Task } | { type: 'deleted'; taskId: string }
export type ReminderFire = { taskId: string; title: string; fireAt: string }
export type RemindersEvent = { fires: ReminderFire[]; coalesced: boolean }

export class Bus extends EventEmitter {
  emitDocs(vaultId: string, event: DocsEvent): void {
    this.emit(`docs:${vaultId}`, event)
  }
  emitTasks(vaultId: string, event: TasksEvent): void {
    this.emit(`tasks:${vaultId}`, event)
  }
  emitReminders(vaultId: string, event: RemindersEvent): void {
    this.emit(`reminders:${vaultId}`, event)
  }
  /** Wake the evaluator loop after any reminder-affecting mutation. */
  wakeEvaluator(): void {
    this.emit('evaluator:wake')
  }
}

export function createBus(): Bus {
  const bus = new Bus()
  bus.setMaxListeners(0)
  return bus
}
