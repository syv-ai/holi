/**
 * Developer → Test onboarding: the whole ritual, against nothing.
 *
 * The property the mode promises: **it creates nothing**. This walks the
 * ritual end to end, through the build and the threshold, and asserts nothing
 * was written anywhere.
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
      if (op.path === 'github.repos') {
        return {
          ok: true,
          data: [{ remote: 'ada/team', isVault: true, canPush: true, visibility: 'private' }],
        }
      }
      return { ok: true, data: undefined }
    },
  }
})

afterEach(() => {
  // @ts-expect-error — as above.
  delete window.holi
})

/** The act currently on screen: the only one mounted. */
const activeAct = () => {
  const el = document.querySelector('[data-act]')
  if (el === null) throw new Error('no act is active')
  return el as HTMLElement
}

/** Name the vault and leave the naming act. Nothing is created here any
 *  more: the CTA is Continue, and creation waits for the last question.
 *
 *  Queried from `screen`, not the active act: the CTAs live in the ritual's
 *  FOOTER rather than inside its section. */
async function nameAndContinue() {
  await userEvent.type(screen.getByRole('textbox', { name: 'Vault name' }), 'scratch')
  await userEvent.click(screen.getByRole('button', { name: /continue/i }))
}

/** Leave the plugins act as it is, onto the settings act. */
async function pastPlugins() {
  await waitFor(() => expect(activeAct()).toHaveAttribute('data-act', 'plugins'))
  await userEvent.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(activeAct()).toHaveAttribute('data-act', 'settings'))
}

/** "Create vault", on the last question: the one press that changes the world. */
async function create() {
  await userEvent.click(screen.getByRole('button', { name: /create vault/i }))
}

/** The build holds each step on screen for a beat, so "ready" takes a few. */
const BUILT = { timeout: 5000 }

/** Let a started build finish before the test ends. It carries on past an
 *  unmount (the repo exists, so its answers still belong in it), and a write
 *  landing after `beforeEach` would be read as the next test's. */
const settled = () =>
  waitFor(() => expect(screen.getByText(/your vault is ready/i)).toBeInTheDocument(), BUILT)

test('only the act on screen can be reached: the others are not mounted', async () => {
  render(<OnboardingRitual mode="first-run" dryRun onDismiss={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: /begin/i }))
  // The greeting's Begin must not be reachable from naming: pressed there, it
  // would skip the questions.
  expect(document.querySelector('[data-act="greeting"]')).toBeNull()
  expect(screen.queryByRole('button', { name: /begin/i })).toBeNull()
  expect(activeAct()).toHaveAttribute('data-act', 'naming')
})

test('walks naming → plugins → settings → build → threshold without creating anything', async () => {
  const onDismiss = vi.fn()
  render(<OnboardingRitual mode="add-vault" dryRun onDismiss={onDismiss} />)

  await nameAndContinue()
  await pastPlugins()

  const settings = activeAct()
  expect(within(settings).getByRole('group', { name: 'Keep a daily note' })).toBeInTheDocument()

  // Answer something, so the write would fire if it were going to.
  await userEvent.click(within(settings).getByRole('radio', { name: 'Today’s note' }))
  await create()

  // The threshold builds first, then says ready.
  await waitFor(() => expect(activeAct()).toHaveAttribute('data-act', 'threshold'))
  expect(within(activeAct()).getByText(/building your vault/i)).toBeInTheDocument()
  await userEvent.click(
    await within(activeAct()).findByRole('button', { name: /open vault/i }, BUILT),
  )
  expect(onDismiss).toHaveBeenCalled()

  // ── The promise. No repo, no vault, no settings, no refreshed list. ────────
  expect(paths).not.toContain('vaults.create')
  expect(paths).not.toContain('vaults.add')
  expect(paths).not.toContain('settings.write')
  expect(paths).not.toContain('vaults.list')
})

test('a real run creates nothing until the last question is answered', async () => {
  render(<OnboardingRitual mode="add-vault" onDismiss={vi.fn()} />)
  await nameAndContinue()
  await pastPlugins()
  expect(paths).not.toContain('vaults.create')

  await create()
  await waitFor(() => expect(paths).toContain('vaults.create'))
  await settled()
})

test('creating does not activate the vault before its answers are written', async () => {
  // Activation makes the Shell open and LAND a vault, so it waits for "Open
  // vault"; otherwise the vault reads the seeded defaults before the answers.
  const store = createStore()
  render(
    <Provider store={store}>
      <OnboardingRitual mode="add-vault" onDismiss={vi.fn()} />
    </Provider>,
  )
  await nameAndContinue()
  await pastPlugins()
  await create()
  await waitFor(() => expect(paths).toContain('vaults.create'))

  // Still on the vault we came from, whatever that was.
  expect(store.get(activeRemoteAtom)).toBeNull()
  await settled()
})

test('a plugin turned off is written into the new vault’s settings', async () => {
  const store = createStore()
  store.set(installedPluginsAtom, [{ info: { id: 'pdf', label: 'PDF', default: true } }] as never)
  render(
    <Provider store={store}>
      <OnboardingRitual mode="add-vault" onDismiss={vi.fn()} />
    </Provider>,
  )
  await nameAndContinue()
  await waitFor(() => expect(activeAct()).toHaveAttribute('data-act', 'plugins'))
  await userEvent.click(within(activeAct()).getByRole('checkbox', { name: 'PDF' }))
  await userEvent.click(screen.getByRole('button', { name: /continue/i }))
  await waitFor(() => expect(activeAct()).toHaveAttribute('data-act', 'settings'))
  await create()

  await waitFor(() => expect(paths).toContain('settings.write'), BUILT)
  const write = inputs.find((op) => op.path === 'settings.write')!.input as {
    committedJson: string
  }
  expect(JSON.parse(write.committedJson).plugins).toEqual({ pdf: false })
})

test('joining in a dry run clones nothing', async () => {
  const onDismiss = vi.fn()
  render(<OnboardingRitual mode="add-vault" dryRun onDismiss={onDismiss} />)
  await userEvent.click(screen.getByRole('button', { name: /join vaults in your accounts/i }))
  await userEvent.click(await screen.findByRole('button', { name: /ada\/team/ }))
  await waitFor(() => expect(onDismiss).toHaveBeenCalled())
  expect(paths).not.toContain('vaults.add')
})
