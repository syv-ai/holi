/**
 * Developer → Test onboarding: the whole ritual, against nothing.
 *
 * The property the mode promises: **it creates nothing**. This walks the
 * ritual end to end, through the settings act and threshold that are otherwise
 * unreachable until a vault exists, and asserts nothing was written anywhere.
 *
 * Stubs `window.holi` directly rather than using `test/helpers/fake-holi`: that
 * helper *creates* a `window` for the node environment, which replaces jsdom's
 * and takes `addEventListener` with it.
 */
import { Provider, createStore } from 'jotai'
import { render, screen, waitFor, within } from '@/test/render'
import { activeRemoteAtom } from '../../../state/vaults'
import { installedPluginsAtom } from '../../../state/plugins'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { OnboardingRitual } from '../OnboardingRitual'

/** Every tRPC path the ritual reached for, in order, and what it sent. */
let paths: string[] = []
let inputs: { path: string; input: unknown }[] = []

beforeEach(() => {
  paths = []
  inputs = []
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = {
    trpc: async (op: { path: string; input: unknown }) => {
      paths.push(op.path)
      inputs.push(op)
      if (op.path === 'github.orgs') return { ok: true, data: { orgs: [] } }
      return { ok: true, data: undefined }
    },
  }
})

afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
})

/**
 * The act currently on screen.
 *
 * **Every act is mounted at once** (they crossfade on `data-state`), so a bare
 * `getByRole('button', {name: /continue/i})` can find the settings act's CTA
 * while the naming act is showing, and still advance the reducer. Scope to the
 * active act or the test measures the wrong thing.
 */
const activeAct = () => {
  const el = document.querySelector('.obrit-act[data-state="active"]')
  if (el === null) throw new Error('no act is active')
  return el as HTMLElement
}

/** Name the vault and leave the naming act: the click that, in a real run,
 *  creates a GitHub repo and clones it.
 *
 *  Queried from `screen`, not the active act: the naming CTA lives in the
 *  ritual's FOOTER rather than inside its section, and it is the only button
 *  with this name. */
async function nameAndCreate() {
  await userEvent.type(screen.getByPlaceholderText('your vault'), 'scratch')
  await userEvent.click(screen.getByRole('button', { name: /create vault/i }))
}

/** Leave the plugins act as it is, onto the settings act. */
async function pastPlugins() {
  await waitFor(() => expect(activeAct()).toHaveClass('obrit-plugins-act'))
  await userEvent.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(activeAct()).not.toHaveClass('obrit-plugins-act'))
}

test('walks naming → plugins → settings → threshold without creating anything', async () => {
  const onDismiss = vi.fn()
  render(<OnboardingRitual mode="add-vault" dryRun onDismiss={onDismiss} />)

  await nameAndCreate()
  await pastPlugins()

  // The settings act is reachable, which is the whole point of the mode.
  expect(activeAct()).toHaveClass('obrit-settings-act')
  const settings = activeAct()
  expect(within(settings).getByRole('group', { name: 'Keep a daily note' })).toBeInTheDocument()

  // Answer something, so the write would fire if it were going to.
  await userEvent.click(within(settings).getByRole('radio', { name: 'Today’s note' }))
  // The settings CTA lives in the FOOTER, beside the naming act's, so a list
  // that scrolls cannot push it off the bottom edge.
  await userEvent.click(screen.getByRole('button', { name: /continue/i }))

  // The threshold, which in a real run shows the live remote.
  await waitFor(() => expect(activeAct()).toHaveClass('obrit-threshold'))
  await userEvent.click(within(activeAct()).getByRole('button', { name: /open vault/i }))
  expect(onDismiss).toHaveBeenCalled()

  // ── The promise. No repo, no vault, no settings, no refreshed list. ────────
  expect(paths).not.toContain('vaults.create')
  expect(paths).not.toContain('vaults.add')
  expect(paths).not.toContain('settings.write')
  expect(paths).not.toContain('vaults.list')
})

test('reaches the settings act, which no real run can do without a repo', async () => {
  render(<OnboardingRitual mode="add-vault" dryRun onDismiss={vi.fn()} />)
  await nameAndCreate()
  await pastPlugins()

  // Every descriptor's row, rendered.
  expect(activeAct()).toHaveClass('obrit-settings-act')
  expect(within(activeAct()).getAllByRole('group').length).toBeGreaterThan(0)
  expect(paths).not.toContain('vaults.create')
})

test('creating does not activate the vault before the settings act has asked', async () => {
  // Activation makes the Shell open and LAND a vault, so it must come after
  // the settings act; otherwise the vault reads the seeded defaults before the
  // answers are written.
  const store = createStore()
  render(
    <Provider store={store}>
      <OnboardingRitual mode="add-vault" onDismiss={vi.fn()} />
    </Provider>,
  )
  await nameAndCreate()
  await waitFor(() => expect(paths).toContain('vaults.create'))

  // Still on the vault we came from, whatever that was.
  expect(store.get(activeRemoteAtom)).toBeNull()
})

test('a real run still creates — the dry run is the exception, not the rule', async () => {
  // Guards the guard: if `dryRun` stopped being read, every assertion above
  // would pass for the wrong reason.
  render(<OnboardingRitual mode="add-vault" onDismiss={vi.fn()} />)
  await nameAndCreate()
  // A real submit is async; the dry run short-circuits before the await, which
  // is exactly the difference being asserted.
  await waitFor(() => expect(paths).toContain('vaults.create'))
})

test('a plugin turned off is written into the new vault’s settings', async () => {
  const store = createStore()
  store.set(installedPluginsAtom, [
    { info: { id: 'pdf', label: 'PDF', default: true } },
  ] as never)
  render(
    <Provider store={store}>
      <OnboardingRitual mode="add-vault" onDismiss={vi.fn()} />
    </Provider>,
  )
  await nameAndCreate()
  await waitFor(() => expect(activeAct()).toHaveClass('obrit-plugins-act'))
  await userEvent.click(within(activeAct()).getByRole('switch', { name: 'PDF' }))
  await userEvent.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(activeAct()).not.toHaveClass('obrit-plugins-act'))
  await userEvent.click(screen.getByRole('button', { name: /continue/i }))

  await waitFor(() => expect(paths).toContain('settings.write'))
  const write = inputs.find((op) => op.path === 'settings.write')!.input as {
    committedJson: string
  }
  expect(JSON.parse(write.committedJson).plugins).toEqual({ pdf: false })
})
