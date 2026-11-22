import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useSetAtom } from 'jotai'
import { MailComposer, type MailComposerHandle } from '../src/plugins/google/renderer/mail-composer'
import { TooltipProvider } from '../src/renderer/src/components/ui/tooltip'
import { MailReader } from '../src/plugins/google/renderer/mail/mail-reader'
import type { MailState } from '../src/plugins/google/renderer/mail/use-mail'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import { activeRemoteAtom } from '../src/renderer/src/plugin-api'
import { useForgetImageSenders } from '../src/plugins/google/renderer/mail-images'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import '../src/renderer/src/index.css'

const store = createStore()
store.set(activeRemoteAtom, 'synthetic/mail-vim-vault')
store.set(vimCodeEditingAtom, true)
const calls: { op: string; account: string; payload?: unknown; vault?: string; view?: string }[] =
  []
;(window as unknown as { __mailVimCalls: typeof calls }).__mailVimCalls = calls
const liveContext = {
  account: 'fixture-account-a',
  vault: 'synthetic/mail-vim-vault',
  view: 'thread-a',
}
;(window as unknown as { __mailVimContext: typeof liveContext }).__mailVimContext = liveContext
const imagePolicy = { senders: [] as string[], allSenders: false }
;(window as unknown as { __mailVimPolicy: typeof imagePolicy }).__mailVimPolicy = imagePolicy
Object.defineProperty(window, 'holi', {
  configurable: true,
  value: {
    openExternal: (url: string) =>
      calls.push({
        op: 'openExternal',
        account: liveContext.account,
        vault: liveContext.vault,
        view: liveContext.view,
        payload: url,
      }),
    trpc: async (op: { path: string }) =>
      op.path === 'settings.read'
        ? {
            ok: true,
            data: {
              pluginValues: {
                google: {
                  imageSenders: [...imagePolicy.senders],
                  imagesFromAllSenders: imagePolicy.allSenders,
                },
              },
            },
          }
        : { ok: false, message: `Unexpected smoke RPC: ${op.path}` },
  },
})
interface SmokeControls {
  context(account: string, draft: string): void
  vim(enabled: boolean): void
  hideComposer(): void
  reorderedTargets(enabled: boolean): void
  reader(visible: boolean, account: string, view: string, vault: string): void
  state(): unknown
}
let controls: SmokeControls | null = null
;(window as unknown as { __mailVim: SmokeControls }).__mailVim = {
  context: (account, draft) => controls?.context(account, draft),
  vim: (enabled) => controls?.vim(enabled),
  hideComposer: () => controls?.hideComposer(),
  reorderedTargets: (enabled) => controls?.reorderedTargets(enabled),
  reader: (visible, account, view, vault) => controls?.reader(visible, account, view, vault),
  state: () => controls?.state(),
}

function ImagePolicyControls() {
  const forget = useForgetImageSenders()
  return (
    <button type="button" onClick={() => void forget()}>
      Revoke image consent
    </button>
  )
}

function Fixture() {
  const [account, setAccount] = useState('fixture-account-a')
  const [draft, setDraft] = useState('new')
  const [showComposer, setShowComposer] = useState(true)
  const [readerVisible, setReaderVisible] = useState(true)
  const [readerView, setReaderView] = useState('thread-a')
  const [reorderedTargets, setReorderedTargets] = useState(false)
  const [vault, setVault] = useState('synthetic/mail-vim-vault')
  const setActiveRemote = useSetAtom(activeRemoteAtom)
  const setVim = useSetAtom(vimCodeEditingAtom)
  liveContext.account = account
  liveContext.vault = vault
  liveContext.view = readerView
  useShortcutDispatcher()
  useEffect(() => {
    setVim(true)
  }, [setVim])
  useEffect(() => {
    controls = {
      context: (nextAccount, nextDraft) => {
        setAccount(nextAccount)
        setDraft(nextDraft)
      },
      vim: setVim,
      hideComposer: () => setShowComposer(false),
      reorderedTargets: setReorderedTargets,
      reader: (visible, nextAccount, view, nextVault) => {
        setReaderVisible(visible)
        setAccount(nextAccount)
        setReaderView(view)
        setVault(nextVault)
        setActiveRemote(nextVault)
      },
      state: () => ({ account, draft, readerVisible, readerView, vault }),
    }
    return () => {
      controls = null
    }
  }, [account, draft, readerVisible, readerView, reorderedTargets, vault, setActiveRemote, setVim])
  const ref = (handle: MailComposerHandle | null) => {
    ;(window as unknown as { __mailVimFlush?: () => Promise<boolean> }).__mailVimFlush = handle
      ? () => handle.prepareToLeave()
      : undefined
  }
  const threadUrl =
    account === 'fixture-account-a' &&
    vault === 'synthetic/mail-vim-vault' &&
    readerView === 'thread-a'
      ? 'https://example.test/thread'
      : `https://example.test/${encodeURIComponent(vault)}/${account}/${readerView}`
  const messageBody = `Fixture message ${account} ${vault} ${readerView}`
  const isOriginalFixture =
    account === 'fixture-account-a' &&
    vault === 'synthetic/mail-vim-vault' &&
    readerView === 'thread-a'
  const html = reorderedTargets
    ? '<style>body{height:70px;columns:2;column-fill:auto;column-gap:20px;direction:rtl} p{direction:ltr;margin:0} .spacer{height:55px}</style><p class="spacer">Fixture spacer</p><p><a href="https://example.test/reordered-first">Reordered first target</a></p><p><a href="https://example.test/reordered-second">Reordered second target</a></p>'
    : isOriginalFixture
      ? '<p>Fixture message text</p><p><a href="https://example.test/">Fixture external link</a></p><details><summary>Expand fixture details</summary><p>Only static fixture content.</p></details><img src="https://images.example.test/fixture.png" width="1" height="1" alt="">'
      : `<p>${messageBody}</p><p><a href="https://example.test/${account}/${readerView}/link">${messageBody} external link</a></p><details><summary>Expand ${messageBody} details</summary><p>${messageBody}</p></details>`
  return (
    <TooltipProvider>
      <main
        data-pane=""
        data-pane-focused=""
        className="flex h-screen flex-col gap-3 overflow-auto bg-background p-4 text-foreground"
      >
        <button type="button" data-smoke-host-action="">
          Host action
        </button>
        <section
          hidden={!readerVisible}
          data-testid="reader-retained"
          className="flex min-h-0 flex-1 flex-col"
        >
          <MailReader
            mail={
              {
                reader: {
                  kind: 'ready',
                  thread: {
                    id: 'fixture-thread',
                    subject: `Fixture message ${account} ${readerView}`,
                    webUrl: threadUrl,
                    messages: [
                      {
                        id: 'fixture-message',
                        from: { name: 'Fixture', email: 'fixture@example.test' },
                        to: [],
                        cc: [],
                        bcc: [],
                        date: '2026-11-15T12:00:00.000Z',
                        body: messageBody,
                        html,
                        attachments: [
                          { filename: 'fixture.txt', mimeType: 'text/plain', size: 128 },
                        ],
                      },
                    ],
                  },
                },
                reloadThread: async () => {},
              } as unknown as MailState
            }
            composer={null}
            onCompose={() => {}}
            visible={readerVisible}
            accountSub={account}
          />
        </section>
        {showComposer && (
          <MailComposer
            ref={ref}
            intent={{ kind: 'new' }}
            accountSub={account}
            draftId={draft === 'new' ? undefined : draft}
            bare
            suggestions={[
              { name: 'Alice Fixture', email: 'alice@example.test' },
              { name: 'Bob Fixture', email: 'bob@example.test' },
            ]}
            onSent={() => calls.push({ op: 'sent-callback', account })}
            onDiscarded={() => calls.push({ op: 'discard-callback', account })}
            onClose={() => calls.push({ op: 'close-callback', account })}
          />
        )}
        <ImagePolicyControls />
        <HostHintLayer scopeKey="mail-native-smoke" />
      </main>
    </TooltipProvider>
  )
}

window.addEventListener('error', (event) => {
  ;(window as unknown as { __mailVimErrors?: string[] }).__mailVimErrors ??= []
  ;(window as unknown as { __mailVimErrors: string[] }).__mailVimErrors.push(event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  ;(window as unknown as { __mailVimErrors?: string[] }).__mailVimErrors ??= []
  ;(window as unknown as { __mailVimErrors: string[] }).__mailVimErrors.push(String(event.reason))
})

createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <Fixture />
  </Provider>,
)
