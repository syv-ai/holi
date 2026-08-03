import { WidgetType } from '@codemirror/view'
import type { TaskStatus } from '@holi/shared'

/**
 * Inline chip for a `[[path]]` / `[[path|Label]]` wiki-link (notes-editor PRD FR-6).
 *
 * Every chip routes by path — a task is a file like any other (D27/D60), so there is
 * one grammar and one click target. A chip is a task chip when `task` is present: it
 * carries the task's status, which draws a coloured orb and strikes the title when done,
 * so it reads as a task rather than a note. `label` arrives already resolved (the caller
 * folds in `|Label` and, for a task, the path→title join).
 */
export class WikiLinkChip extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string,
    readonly exists: boolean,
    readonly task?: { status: TaskStatus },
  ) {
    super()
  }

  override eq(other: WikiLinkChip): boolean {
    return (
      other.target === this.target &&
      other.label === this.label &&
      other.exists === this.exists &&
      other.task?.status === this.task?.status
    )
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    const done = this.task?.status === 'done'
    el.className = [
      'cm-wikilink',
      this.task ? 'cm-wikilink-task' : 'cm-wikilink-note',
      // A missing tint applies to notes only — a task chip resolved from a real file.
      !this.task && !this.exists ? 'cm-wikilink-missing' : '',
      done ? 'cm-wikilink-done' : '',
    ]
      .filter(Boolean)
      .join(' ')
    // The dataset key `resolveLinkClick` routes on. Always a path now.
    el.dataset['wikiTarget'] = this.target
    if (this.task) {
      const orb = document.createElement('span')
      orb.className = `cm-task-orb cm-task-orb-${this.task.status}`
      el.appendChild(orb)
    }
    el.appendChild(document.createTextNode(this.label))
    return el
  }

  override ignoreEvent(): boolean {
    return false // clicks bubble to the editor's click handler (open target)
  }
}
