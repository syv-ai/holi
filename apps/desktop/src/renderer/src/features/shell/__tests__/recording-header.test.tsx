import { Provider, atom, createStore } from 'jotai'
import { expect, test } from 'vitest'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { act, render, screen } from '@/test/render'
import { Sheet } from '@/components/ui/sheet'
import { installedPluginsAtom } from '@/state/plugins'
import { activeRemoteAtom } from '@/state/vaults'
import { vaultSettingsAtom } from '@/state/settings'
import { MobileHeader } from '../mobile-header'
import { TitleBar } from '../title-bar'

// A contribution through the public renderer-plugin interface; recording's
// controller/timer/navigation are exercised by transcribe's surface tests.
function RecordingShortcut() {
  return <button type="button">Recording meeting</button>
}

const noop = () => {}

test.each(['desktop', 'compact'] as const)(
  '%s header swaps its brand only while the recording contribution is visible',
  (layout) => {
    const store = createStore()
    const visible = atom(false)
    store.set(activeRemoteAtom, 'team/meeting')
    store.set(installedPluginsAtom, [
      {
        info: { id: 'transcribe', label: 'Meetings', default: true },
        titleBarItem: { visible, Component: RecordingShortcut },
      },
    ])
    render(
      <Provider store={store}>
        {layout === 'desktop' ? (
          <TitleBar sidebarOpen={false} sidebarWidth={240} leadRef={null} onToggleSidebar={noop}>
            <span>Open document</span>
          </TitleBar>
        ) : (
          <Sheet>
            <MobileHeader onOpenSearch={noop} onNewDocument={noop} />
          </Sheet>
        )}
      </Provider>,
    )
    expect(screen.getByRole('img', { name: 'Holi' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Recording meeting' })).toBeNull()

    act(() => store.set(visible, true))
    expect(screen.getByRole('button', { name: 'Recording meeting' })).toBeVisible()
    expect(screen.queryByRole('img', { name: 'Holi' })).toBeNull()

    // The recording belongs to A even when B disables the Meetings plugin.
    act(() => {
      store.set(activeRemoteAtom, 'personal/notes')
      store.set(vaultSettingsAtom, {
        remote: 'personal/notes',
        settings: {
          ...VAULT_SETTING_DEFAULTS,
          warnings: [],
          plugins: { ...VAULT_SETTING_DEFAULTS.plugins, vault: { transcribe: false } },
        },
      })
    })
    expect(screen.getByRole('button', { name: 'Recording meeting' })).toBeVisible()

    act(() => store.set(visible, false))
    expect(screen.getByRole('img', { name: 'Holi' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Recording meeting' })).toBeNull()
    expect(
      screen.getByRole('button', {
        name: layout === 'desktop' ? 'Expand sidebar' : 'Search',
      }),
    ).toBeVisible()
  },
)
