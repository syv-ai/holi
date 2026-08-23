/**
 * Developer → Test onboarding: the whole ritual, against nothing.
 *
 * The one property worth guarding is the one the mode promises — **it creates
 * nothing**. Everything else is covered by the reducer tests and
 * `VaultSettingsAct.test.tsx`; what those cannot cover is the seam between them,
 * because the settings act and the threshold are unreachable until a vault
 * exists. This mode is what makes them reachable, so this walks the ritual end
 * to end and asserts nothing was written anywhere.
 *
 * Stubs `window.holi` directly rather than using `test/helpers/fake-holi`: that
 * helper *creates* a `window` for the node environment, which replaces jsdom's
 * and takes `addEventListener` with it.
 */
import { render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { OnboardingRitual } from '../OnboardingRitual'

/** Every tRPC path the ritual reached for, in order. */
let paths: string[] = []

beforeEach(() => {
  paths = []
  // @ts-expect-error — the preload bridge is not typed onto window in tests.
  window.holi = {
    trpc: async (op: { path: string }) => {
      paths.push(op.path)
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
 * **Every act is mounted at once** — they crossfade on `data-state` rather than
 * unmounting — so a bare `getByRole('button', {name: /continue/i})` finds the
 * settings act's CTA while the naming act is showing, clicks it, and advances
 * the reducer. That reads exactly like the ritual working. Scope to the active
 * act or the test measures the wrong thing.
 */
const activeAct = () => {
  const el = document.querySelector('.obrit-act[data-state="active"]')
  if (el === null) throw new Error('no act is active')
  return el as HTMLElement
}

/** Name the vault and leave the naming act — the click that, in a real run,
 *  creates a GitHub repo and clones it.
 *
 *  Queried from `screen`, not the active act: the naming CTA lives in the
 *  ritual's FOOTER rather than inside its section, and it is the only button
 *  with this name. */
async function nameAndCreate() {
  await userEvent.type(screen.getByPlaceholderText('your vault'), 'scratch')
  await userEvent.click(screen.getByRole('button', { name: /create vault/i }))
}

test('walks naming → settings → threshold without creating anything', async () => {
  const onDismiss = vi.fn()
  render(<OnboardingRitual mode="add-vault" dryRun onDismiss={onDismiss} />)

  await nameAndCreate()

  // The settings act is reachable, which is the whole point of the mode.
  await waitFor(() => expect(activeAct()).toHaveClass('obrit-settings-act'))
  const settings = activeAct()
  expect(within(settings).getByRole('group', { name: 'Keep a daily note' })).toBeInTheDocument()

  // Answer something, so the write would fire if it were going to.
  await userEvent.click(within(settings).getByRole('radio', { name: 'The board' }))
  await userEvent.click(within(settings).getByRole('button', { name: /continue/i }))

  // The threshold — which in a real run shows the live remote.
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

  // Every descriptor's row, rendered — the seam the other tests cannot cover.
  await waitFor(() => expect(activeAct()).toHaveClass('obrit-settings-act'))
  expect(within(activeAct()).getAllByRole('group').length).toBeGreaterThan(0)
  expect(paths).not.toContain('vaults.create')
})

test('a real run still creates — the dry run is the exception, not the rule', async () => {
  // Guards the guard: if `dryRun` stopped being read, every assertion above
  // would pass for the wrong reason.
  render(<OnboardingRitual mode="add-vault" onDismiss={vi.fn()} />)
  await nameAndCreate()
  // A real submit is async — the dry run short-circuits before the await, which
  // is exactly the difference being asserted.
  await waitFor(() => expect(paths).toContain('vaults.create'))
})
