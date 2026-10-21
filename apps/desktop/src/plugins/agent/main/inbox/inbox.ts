/**
 * The agent inbox of one vault (docs/features/agent-inbox.md): what the agent
 * (`holi agent notify`) and Holi (a session that needs you) want the person
 * to see, kept in `.holi/state/inbox.local.json` on this machine.
 *
 * Every notice that is not a repeat becomes an entry; it is a native banner
 * too only while no Holi window has focus and no banner went up in the last
 * `BANNER_GAP_MS` (`rules.ts`). Clicking the banner opens the entry, as
 * clicking it in the inbox does. The whole inbox is told to the renderer as
 * the agent's `inbox` event on every change.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { randomUUID } from 'node:crypto'
import type { JsonFileStore, Notice } from '../../../../main/plugin-api'
import {
  admit,
  viewOf,
  withEntry,
  withoutEntry,
  type InboxEntry,
  type InboxFile,
  type InboxNotice,
  type InboxView,
} from './rules'

export interface InboxDeps {
  store: JsonFileStore<InboxFile>
  /** A native banner, raised only while no Holi window has focus. */
  notify(notice: Notice): boolean
  /** Tell the renderer the inbox. */
  changed(view: InboxView): void
  /** Open what an entry points at: its banner was clicked. */
  open(entry: InboxEntry): void
  now?: () => Date
}

export type RaiseResult = 'repeat' | 'banner' | 'inbox'

export interface Inbox {
  raise(notice: InboxNotice): Promise<RaiseResult>
  view(): Promise<InboxView>
  dismiss(id: string): Promise<InboxView>
  /** The person looked: everything in it is read. */
  seen(): Promise<InboxView>
}

export function createInbox(deps: InboxDeps): Inbox {
  const now = deps.now ?? (() => new Date())
  /** When the last banner went up, epoch ms. Per run of Holi: a restart may
   *  show one banner sooner than the gap. */
  let lastBanner: number | null = null

  const change = async (edit: (file: InboxFile) => InboxFile): Promise<InboxView> => {
    const view = viewOf(await deps.store.update(edit))
    deps.changed(view)
    return view
  }

  return {
    async raise(notice) {
      const at = now()
      // Decided inside the queued update, against the file as it is then.
      const outcome: { entry: InboxEntry | null; banner: boolean } = { entry: null, banner: false }
      const file = await deps.store.read()
      if (admit(file, notice, at.getTime(), lastBanner).kind === 'repeat') return 'repeat'
      await change((current) => {
        const decision = admit(current, notice, at.getTime(), lastBanner)
        if (decision.kind === 'repeat') return current
        outcome.entry = { id: randomUUID(), at: at.toISOString(), ...notice }
        outcome.banner = decision.banner
        return withEntry(current, outcome.entry)
      })
      const { entry, banner } = outcome
      if (entry === null) return 'repeat'
      if (!banner) return 'inbox'
      const shown = deps.notify({
        title: entry.title,
        body: entry.line,
        onClick: () => deps.open(entry),
      })
      if (!shown) return 'inbox'
      lastBanner = at.getTime()
      return 'banner'
    },
    view: async () => viewOf(await deps.store.read()),
    dismiss: (id) => change((file) => withoutEntry(file, id)),
    seen: () => change((file) => ({ ...file, seen: now().toISOString() })),
  }
}
