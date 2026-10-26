/**
 * Mail, as ReUI's app-shell-4 without its folder rail: the account and the
 * thread list (its title switches mailbox), and the open thread with its
 * actions. Wired to Google's capabilities through
 * `useMail`; HTML bodies go through `SandboxedHtml` as everywhere else.
 *
 * Self-contained so it can be mounted anywhere in Holi's shell: it fills its
 * parent (`h-full`) and brings its own folder rail and list column. Not
 * mounted yet; see the plugin's `index.tsx` for the surfaces that are.
 */
import { useState, type CSSProperties } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  activeRemoteAtom,
  cn,
  openNoteTabAtom,
  openSettingsSectionAtom,
  useAgentService,
  useHasCapability,
} from '@/plugin-api'
import type { ComposeIntent } from '../compose-intent'
import { MailComposer } from '../mail-composer'
import { buildSummarizePrompt } from '../summarize-prompt'
import { TASKS_CREATE, tasksCap } from '../tasks'
import { googleCap, useGoogleAccount } from '../account'
import { AppHeader, type ThreadCommands } from './mail-header'
import { AppSidebar } from './mail-sidebar'
import { ComposeDialog, type ComposeRequest } from './compose-dialog'
import { MailList } from './mail-list'
import { MailReader } from './mail-reader'
import { NavUser } from './nav-user'
import { replyTarget, useMail, type DraftSummary } from './use-mail'

/** The block's provider is only context here: its open state, keyboard
 *  shortcut and cookie belong to Holi's own sidebar, so this one never
 *  changes it. */
const keepOpen = () => undefined

export function MailShell({ className }: { className?: string }) {
  const { currentSub } = useGoogleAccount()
  const mail = useMail(currentSub)
  const remote = useAtomValue(activeRemoteAtom)
  const openSettingsSection = useSetAtom(openSettingsSectionAtom)
  const openNote = useSetAtom(openNoteTabAtom)
  const agent = useAgentService()
  const store = useStore()
  const canLinkToTask = useHasCapability(TASKS_CREATE) && remote !== null

  const [expanded, setExpanded] = useState(true)
  /** A new message or a draft, in a dialog: it has no thread to keep in view. */
  const [compose, setCompose] = useState<ComposeRequest | null>(null)
  /** A reply or forward, inline under the thread it answers. */
  const [inline, setInline] = useState<{
    intent: ComposeIntent
    key: number
  } | null>(null)

  const openConnections = () => openSettingsSection('connections')
  const thread = mail.reader.kind === 'ready' ? mail.reader.thread : null

  const startCompose = (draftId?: string) =>
    setCompose((previous) => ({ draftId, key: (previous?.key ?? 0) + 1 }))

  const openDraft = (draft: DraftSummary) => startCompose(draft.draftId)

  /** Bumped on every open, so the composer remounts: it reads its intent
   *  once, on mount. */
  const openInline = (intent: ComposeIntent) =>
    setInline((previous) => ({ intent, key: (previous?.key ?? 0) + 1 }))

  const commands: ThreadCommands = {
    reply: (all) => {
      if (thread === null) return
      const parent = replyTarget(thread, mail.sendAs)
      if (parent === null) return
      openInline({
        kind: 'reply',
        threadId: thread.id,
        subject: thread.subject,
        parent,
        all,
      })
    },
    forward: () => {
      if (thread === null) return
      const parent = replyTarget(thread, mail.sendAs)
      if (parent === null) return
      openInline({
        kind: 'forward',
        threadId: thread.id,
        subject: thread.subject,
        parent,
      })
    },
    /** The newest draft in the open thread, asked of Gmail: it may have been
     *  written there or by the agent. */
    continueDraft: () => {
      const id = mail.openId
      if (id === null) return
      void mail
        .call((r) => googleCap.drafts(r))
        .then((drafts) => {
          const newest = drafts
            .filter((draft) => draft.threadId === id)
            .sort((a, b) => a.date.localeCompare(b.date))
            .pop()
          if (newest !== undefined) openDraft(newest)
        })
        .catch(() => mail.reportError('Could not open that draft.'))
    },
    summarize:
      agent === null
        ? null
        : () => {
            if (thread === null) return
            const text = buildSummarizePrompt({
              subject: thread.subject,
              threadId: thread.id,
              webUrl: thread.webUrl,
            })
            const target = store.get(agent.targets).default
            void agent.ask({ text, target }).then((res) => {
              if (!res.ok && target !== 'new') void agent.ask({ text, target: 'new' })
            })
          },
    linkToTask: !canLinkToTask
      ? null
      : () => {
          const row = thread ?? mail.openRow
          if (row === null || remote === null) return
          void tasksCap
            .create(remote, {
              title: row.subject,
              folder: '',
              description: `[${row.subject}](${row.webUrl})\n`,
            })
            .then(({ path }) => openNote(path))
            .catch(() => mail.reportError('Could not make a task from this thread.'))
        },
  }

  const closeInline = () => {
    setInline(null)
    mail.reloadDrafts()
  }

  const composer =
    inline !== null && thread !== null ? (
      <div className="pt-4">
        <MailComposer
          key={inline.key}
          intent={inline.intent}
          sendAs={mail.sendAs}
          suggestions={mail.contacts}
          onSent={() => {
            closeInline()
            mail.reloadThread()
            mail.load()
          }}
          onDiscarded={closeInline}
          onClose={closeInline}
          onReconnect={openConnections}
        />
      </div>
    ) : null

  return (
    <TooltipProvider delayDuration={0}>
      <SidebarProvider
        open
        onOpenChange={keepOpen}
        className={cn('relative h-full min-h-0', className)}
        style={
          {
            '--sidebar-width': '440px',
            '--header-height': '50px',
            '--sidebar-accent': 'color-mix(in oklab, var(--color-primary) 5%, transparent)',
            '--sidebar-accent-foreground': 'var(--color-primary)',
          } as CSSProperties
        }
      >
        {/* The list column, with the account and the mailbox menu atop it */}
        <AppSidebar expanded={expanded} onToggle={() => setExpanded((value) => !value)}>
          <MailList
            mail={mail}
            account={<NavUser onManage={openConnections} onError={mail.reportError} />}
            onSelectFolder={(folder) => {
              mail.setFolder(folder)
              setInline(null)
            }}
            onCompose={() => startCompose()}
            onOpenDraft={openDraft}
            onOpenConnections={openConnections}
          />
        </AppSidebar>

        {/* No fill of its own: the window's surface shows through. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader mail={mail} commands={commands} />
          <MailReader
            mail={mail}
            composer={
              inline !== null &&
              inline.intent.kind !== 'new' &&
              inline.intent.threadId === mail.openId
                ? composer
                : null
            }
            onCompose={() => startCompose()}
          />
        </div>
      </SidebarProvider>

      <ComposeDialog
        request={compose}
        sendAs={mail.sendAs}
        contacts={mail.contacts}
        onReconnect={openConnections}
        onClose={() => {
          setCompose(null)
          mail.reloadDrafts()
        }}
      />
    </TooltipProvider>
  )
}
