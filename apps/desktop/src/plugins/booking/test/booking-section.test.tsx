/**
 * The settings section shows the machine's booking sign-in as main has it,
 * signs in through the same `booking.login` the app and the agent use, and
 * falls back to a pasted link when Gmail does not deliver it.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BookingSection } from '../renderer/booking-section'

const verbs: Record<string, ReturnType<typeof vi.fn<(params?: unknown) => unknown>>> = {
  'booking.status': vi.fn(),
  'booking.login': vi.fn(),
  'booking.finish': vi.fn(),
  'booking.logout': vi.fn(),
  'google.status': vi.fn(),
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
          const verb = verbs[name]
          if (verb === undefined) throw new Error(`unexpected ${name}`)
          return verb(paramsJson === undefined ? undefined : JSON.parse(paramsJson))
        },
      },
    },
  },
}))

const OUT = { signedIn: false, email: null, site: 'booking.example.test' }
const IN = { ...OUT, signedIn: true, email: 'ada@syv.ai' }

beforeEach(() => {
  for (const verb of Object.values(verbs)) verb.mockReset()
  verbs['google.status']!.mockResolvedValue({ account: { email: 'ada@syv.ai' } })
})

describe('Mødelokale Booking settings', () => {
  it('shows a saved sign-in, and signs out', async () => {
    verbs['booking.status']!.mockResolvedValue(IN)
    verbs['booking.logout']!.mockResolvedValue(OUT)
    render(<BookingSection remote="o/r" />)
    expect(await screen.findByText('ada@syv.ai')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(verbs['booking.logout']).toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'Send login link' })).toBeTruthy()
  })

  it('says when the sign-in cannot be read, and reads it again on Retry', async () => {
    verbs['booking.status']!.mockRejectedValueOnce(new Error('no such method: booking.status'))
    verbs['booking.status']!.mockResolvedValue(IN)
    render(<BookingSection remote="o/r" />)
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'no such method: booking.status',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('ada@syv.ai')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers the Google address and signs in through Gmail', async () => {
    verbs['booking.status']!.mockResolvedValue(OUT)
    verbs['booking.login']!.mockResolvedValue({ ...IN, message: null })
    render(<BookingSection remote="o/r" />)
    const email = await screen.findByLabelText('Email')
    await waitFor(() => expect((email as HTMLInputElement).value).toBe('ada@syv.ai'))
    await userEvent.click(screen.getByRole('button', { name: 'Send login link' }))
    expect(verbs['booking.login']).toHaveBeenCalledWith({ email: 'ada@syv.ai' })
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy()
  })

  it('asks for the pasted link when Gmail does not deliver it', async () => {
    verbs['booking.status']!.mockResolvedValue(OUT)
    verbs['google.status']!.mockRejectedValue(new Error('no such method: google.status'))
    verbs['booking.login']!.mockResolvedValue({
      ...OUT,
      message: 'Gmail is not connected here. Paste the link.',
    })
    verbs['booking.finish']!.mockResolvedValue(IN)
    render(<BookingSection remote="o/r" />)
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@syv.ai{Enter}')
    expect(await screen.findByText(/Gmail is not connected here/)).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Login link'), 'https://x/callback?code=1{Enter}')
    expect(verbs['booking.finish']).toHaveBeenCalledWith({ link: 'https://x/callback?code=1' })
    expect(await screen.findByText('ada@syv.ai')).toBeTruthy()
  })
})
