import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, Provider, useSetAtom } from 'jotai'
import { MailComposer, type MailComposerHandle } from '../src/plugins/google/renderer/mail-composer'
import { HostHintLayer } from '../src/renderer/src/features/shell/host-hint-layer'
import { useShortcutDispatcher } from '../src/renderer/src/hooks/use-shortcuts'
import { activeRemoteAtom } from '../src/renderer/src/plugin-api'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import '../src/renderer/src/index.css'

const store = createStore()
store.set(activeRemoteAtom, 'synthetic/mail-vim-vault')
store.set(vimCodeEditingAtom, true)
const calls: { op: string; account: string; payload?: unknown }[] = []
;(window as unknown as { __mailVimCalls: typeof calls }).__mailVimCalls = calls
interface SmokeControls {
  context(account: string, draft: string): void
  vim(enabled: boolean): void
  state(): unknown
}
let controls: SmokeControls | null = null
;(window as unknown as { __mailVim: SmokeControls }).__mailVim = {
  context: (account, draft) => controls?.context(account, draft),
  vim: (enabled) => controls?.vim(enabled),
  state: () => controls?.state(),
}

function Fixture() {
  const [account, setAccount] = useState('fixture-account-a')
  const [draft, setDraft] = useState('new')
  const [key, setKey] = useState(0)
  const setVim = useSetAtom(vimCodeEditingAtom)
  useShortcutDispatcher()
  useEffect(() => {
    setVim(true)
  }, [setVim])
  useEffect(() => {
    controls = {
      context: (nextAccount, nextDraft) => {
        setAccount(nextAccount)
        setDraft(nextDraft)
        setKey((current) => current + 1)
      },
      vim: setVim,
      state: () => ({ account, draft }),
    }
    return () => {
      controls = null
    }
  }, [account, draft, setVim])
  const ref = (handle: MailComposerHandle | null) => {
    ;(window as unknown as { __mailVimFlush?: () => Promise<boolean> }).__mailVimFlush = handle
      ? () => handle.prepareToLeave()
      : undefined
  }
  return (
    <main className="flex h-screen flex-col gap-3 overflow-auto bg-background p-4 text-foreground">
      <button type="button" data-smoke-host-action="">
        Host action
      </button>
      <MailComposer
        key={key}
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
      <HostHintLayer scopeKey={`${account}:${draft}`} />
    </main>
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
