import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MailMarkersSettings } from '../renderer/mail-markers-settings'
import { DEFAULT_MAIL_MARKER_PREFERENCES } from '../shared/mail-markers'

const { read, write } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
vi.mock('../renderer/google-cap', () => ({
  googleCap: {
    mailMarkerPreferences: read,
    setMailMarkerPreferences: write,
  },
}))

const initial = {
  enabledOrder: ['yellow-star'] as ('yellow-star' | 'red-star' | 'blue-question')[],
}
const renderSettings = (vault = 'syv-ai/vault', accountSub = 'sub-a') =>
  render(<MailMarkersSettings vault={vault} accountSub={accountSub} />)

beforeEach(() => {
  vi.clearAllMocks()
  read.mockResolvedValue(initial)
  write.mockResolvedValue({ ok: true })
})

describe('MailMarkersSettings', () => {
  it('loads, reorders, toggles and acknowledges saved marker preferences', async () => {
    renderSettings()
    expect(await screen.findByRole('switch', { name: 'Enable Yellow star' })).toBeChecked()
    expect(read).toHaveBeenCalledWith('syv-ai/vault', { expectedAccountSub: 'sub-a' })
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Enable Red star' })))
    await waitFor(() =>
      expect(write.mock.calls[0]?.[1]).toEqual({
        expectedAccountSub: 'sub-a',
        preferences: { enabledOrder: ['yellow-star', 'red-star'] },
      }),
    )
    expect(await screen.findByText('Saved on this machine.')).toBeInTheDocument()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move Red star up' })))
    await waitFor(() =>
      expect(write.mock.calls.at(-1)?.[1]).toEqual({
        expectedAccountSub: 'sub-a',
        preferences: { enabledOrder: ['red-star', 'yellow-star'] },
      }),
    )
  })

  it('normalizes disabling every marker back to the default yellow star', async () => {
    read.mockResolvedValue({ enabledOrder: ['yellow-star', 'red-star'] })
    renderSettings()
    await screen.findByRole('switch', { name: 'Enable Red star' })
    await act(async () =>
      fireEvent.click(screen.getByRole('switch', { name: 'Enable Yellow star' })),
    )
    await waitFor(() =>
      expect(write.mock.calls.at(-1)?.[1]).toEqual({
        expectedAccountSub: 'sub-a',
        preferences: { enabledOrder: ['red-star'] },
      }),
    )
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Enable Red star' })))
    await waitFor(() =>
      expect(write.mock.calls.at(-1)?.[1]).toEqual({
        expectedAccountSub: 'sub-a',
        preferences: DEFAULT_MAIL_MARKER_PREFERENCES,
      }),
    )
    expect(screen.getByRole('switch', { name: 'Enable Yellow star' })).toBeChecked()
  })

  it('retries failed reads and saves, retaining the failed preference until acknowledged', async () => {
    read.mockRejectedValueOnce(new Error('offline'))
    renderSettings()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load personal markers')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    await screen.findByRole('switch', { name: 'Enable Yellow star' })
    write.mockRejectedValueOnce(new Error('disk full'))
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Enable Red star' })))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save personal markers')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2))
    expect(write.mock.calls.at(-1)?.[1]).toEqual({
      expectedAccountSub: 'sub-a',
      preferences: { enabledOrder: ['yellow-star', 'red-star'] },
    })
    expect(await screen.findByText('Saved on this machine.')).toBeInTheDocument()
  })

  it('ignores stale read and save completions across A→B→A identity changes', async () => {
    let finishRead!: (value: typeof initial) => void
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve
      }),
    )
    const view = renderSettings('vault-a', 'sub-a')
    view.rerender(<MailMarkersSettings vault="vault-b" accountSub="sub-b" />)
    await screen.findByRole('switch', { name: 'Enable Yellow star' })
    view.rerender(<MailMarkersSettings vault="vault-a" accountSub="sub-a" />)
    await screen.findByRole('switch', { name: 'Enable Yellow star' })
    await act(async () => finishRead({ enabledOrder: ['blue-question'] }))
    expect(screen.getByRole('switch', { name: 'Enable Yellow star' })).toBeChecked()

    let finishSave!: (value: { ok: true }) => void
    write.mockReturnValueOnce(
      new Promise((resolve) => {
        finishSave = resolve
      }),
    )
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Enable Red star' })))
    view.rerender(<MailMarkersSettings vault="vault-b" accountSub="sub-b" />)
    await screen.findByRole('switch', { name: 'Enable Yellow star' })
    view.rerender(<MailMarkersSettings vault="vault-a" accountSub="sub-a" />)
    await screen.findByRole('switch', { name: 'Enable Yellow star' })
    await act(async () => finishSave({ ok: true }))
    expect(screen.getByRole('switch', { name: 'Enable Red star' })).not.toBeChecked()
    expect(screen.queryByText('Saved on this machine.')).toBeInTheDocument()
  })
})
