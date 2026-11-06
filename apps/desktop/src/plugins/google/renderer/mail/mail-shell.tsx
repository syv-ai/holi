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
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { SidebarProvider } from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  activeRemoteAtom,
  cn,
  openDocumentAtom,
  openSettingsSectionAtom,
  useAgentService,
  useHasCapability,
} from '@/plugin-api'
import type { ComposeIntent } from '../compose-intent'
import { MailComposer, type MailComposerHandle } from '../mail-composer'
import { ComposeSessionGate } from '../compose-session'
import { buildSummarizePrompt } from '../summarize-prompt'
import { TASKS_CREATE, tasksCreateCap } from '../tasks-cap'
import { googleCap } from '../google-cap'
import { useGoogleAccount } from '../account'
import { AppHeader, type ThreadCommands } from './mail-header'
import { AppSidebar } from './mail-sidebar'
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
  const openNote = useSetAtom(openDocumentAtom)
  const agent = useAgentService()
  const store = useStore()
  const canLinkToTask = useHasCapability(TASKS_CREATE) && remote !== null

  const composerRef = useRef<MailComposerHandle | null>(null)
  const composeGate = useRef(new ComposeSessionGate()).current
  const transitionRef = useRef(0)
  const continueRef = useRef(0)
  const sequenceRef = useRef(0)
  const liveContext = useRef({ remote, account: currentSub, selectedThread: mail.openId })
  liveContext.current = { remote, account: currentSub, selectedThread: mail.openId }
  const [expanded, setExpanded] = useState(true)
  /** Exactly one active composition, whether standalone or attached to a thread. */
  const [composition, setComposition] = useState<{
    intent: ComposeIntent
    draftId?: string
    identity: object
    key: number
  } | null>(null)
  const compositionOwner = useRef<object | null>(null)
  compositionOwner.current = composition?.identity ?? null

  const openConnections = () => openSettingsSection('connections')
  const thread = mail.reader.kind === 'ready' ? mail.reader.thread : null
  const contextIsCurrent = (expectedRemote: string | null, expectedAccount: string | null) =>
    store.get(activeRemoteAtom) === expectedRemote &&
    liveContext.current.remote === expectedRemote &&
    liveContext.current.account === expectedAccount
  const transition = (action: () => void): Promise<boolean> => {
    const request = ++transitionRef.current
    const expectedRemote = remote
    const expectedAccount = currentSub
    return composeGate.leave(
      () => {
        continueRef.current++
        action()
      },
      () => transitionRef.current === request && contextIsCurrent(expectedRemote, expectedAccount),
    )
  }
  const navigate = (action: () => void) =>
    transition(() => {
      action()
      if (compositionOwner.current !== null) {
        compositionOwner.current = null
        composerRef.current = null
        setComposition(null)
        mail.reloadDrafts()
      }
    })
  const beginComposition = (intent: ComposeIntent, draftId?: string) => {
    transition(() => {
      const session = composeGate.begin()
      composerRef.current = null
      setComposition({ intent, draftId, identity: session.identity, key: ++sequenceRef.current })
    })
  }
  const startCompose = (draftId?: string) => beginComposition({ kind: 'new' }, draftId)
  const openDraft = (draft: DraftSummary) => startCompose(draft.draftId)
  const previousContext = useRef({ remote, account: currentSub })
  useEffect(() => {
    if (
      previousContext.current.remote !== remote ||
      previousContext.current.account !== currentSub
    ) {
      previousContext.current = { remote, account: currentSub }
      transitionRef.current++
      continueRef.current++
      compositionOwner.current = null
      composerRef.current = null
      composeGate.invalidate()
      setComposition(null)
    }
  }, [remote, currentSub, composeGate])

  useEffect(
    () => () => {
      transitionRef.current++
      continueRef.current++
      compositionOwner.current = null
      composeGate.invalidate()
      composerRef.current = null
    },
    [composeGate],
  )

  const guardedMail = {
    ...mail,
    openThread: (row: Parameters<typeof mail.openThread>[0]) => {
      void navigate(() => mail.openThread(row))
    },
    setCategory: (value: Parameters<typeof mail.setCategory>[0]) => {
      void navigate(() => mail.setCategory(value))
    },
    setUnreadOnly: (value: Parameters<typeof mail.setUnreadOnly>[0]) => {
      void navigate(() => mail.setUnreadOnly(value))
    },
    search: (value: Parameters<typeof mail.search>[0]) => {
      void navigate(() => mail.search(value))
    },
    removeThreads: (...args: Parameters<typeof mail.removeThreads>) =>
      navigate(() => {
        void mail.removeThreads(...args)
      }).then(() => undefined),
  }

  const commands: ThreadCommands = {
    reply: (all) => {
      if (thread === null) return
      const parent = replyTarget(thread, mail.sendAs)
      if (parent === null) return
      beginComposition({
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
      beginComposition({
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
      const request = ++continueRef.current
      const expectedRemote = remote
      const expectedAccount = currentSub
      void mail
        .call((r) => googleCap.drafts(r))
        .then((drafts) => {
          if (
            request !== continueRef.current ||
            liveContext.current.selectedThread !== id ||
            !contextIsCurrent(expectedRemote, expectedAccount)
          )
            return
          const newest = drafts
            .filter((draft) => draft.threadId === id)
            .sort((a, b) => a.date.localeCompare(b.date))
            .pop()
          if (newest !== undefined) openDraft(newest)
        })
        .catch(() => {
          if (
            request === continueRef.current &&
            liveContext.current.selectedThread === id &&
            contextIsCurrent(expectedRemote, expectedAccount)
          )
            mail.reportError('Could not open that draft.')
        })
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
          void tasksCreateCap
            .create(remote, {
              title: row.subject,
              folder: '',
              description: `[${row.subject}](${row.webUrl})\n`,
            })
            .then(({ path }) => openNote(path))
            .catch(() => mail.reportError('Could not make a task from this thread.'))
        },
  }

  const finishComposition = (identity: object, reloadThread: boolean) => {
    if (
      compositionOwner.current !== identity ||
      composeGate.current()?.identity !== identity ||
      !contextIsCurrent(remote, currentSub)
    )
      return
    compositionOwner.current = null
    composeGate.invalidate()
    composerRef.current = null
    setComposition(null)
    mail.reloadDrafts()
    if (reloadThread) {
      mail.reloadThread()
      mail.load()
    }
  }
  const composer =
    composition === null ? null : (
      <MailComposer
        ref={(handle) => {
          composeGate.attach(composition.identity, handle)
          if (composeGate.current()?.identity === composition.identity) composerRef.current = handle
        }}
        key={composition.key}
        intent={composition.intent}
        draftId={composition.draftId}
        accountSub={currentSub ?? undefined}
        sendAs={mail.sendAs}
        suggestions={mail.contacts}
        onSent={() => finishComposition(composition.identity, true)}
        onDiscarded={() => finishComposition(composition.identity, false)}
        onClose={() => finishComposition(composition.identity, false)}
        onReconnect={openConnections}
        bare={composition.intent.kind === 'new'}
      />
    )
  const standaloneComposer = composition?.intent.kind === 'new' ? composer : null
  const inlineComposer =
    composition !== null &&
    composition.intent.kind !== 'new' &&
    composition.intent.threadId === mail.openId &&
    thread !== null ? (
      <div className="pt-4">{composer}</div>
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
            mail={guardedMail}
            account={
              <NavUser
                onManage={openConnections}
                onError={mail.reportError}
                onBeforeChange={() => navigate(() => undefined)}
              />
            }
            onSelectFolder={(folder) => {
              void navigate(() => mail.setFolder(folder))
            }}
            onCompose={() => startCompose()}
            onOpenDraft={openDraft}
            onOpenConnections={openConnections}
          />
        </AppSidebar>

        {/* No fill of its own: the window's surface shows through. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader
            mail={
              composition?.intent.kind === 'new' ? { ...guardedMail, openId: null } : guardedMail
            }
            commands={commands}
          />
          <MailReader
            mail={guardedMail}
            composer={inlineComposer}
            onCompose={() => startCompose()}
            standaloneComposer={standaloneComposer}
          />
        </div>
      </SidebarProvider>
    </TooltipProvider>
  )
}
