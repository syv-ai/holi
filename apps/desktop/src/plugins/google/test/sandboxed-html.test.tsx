import { cleanup, render, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { activeRemoteAtom } from '@/plugin-api'
import { resetMailImagesForTests } from '../renderer/mail-images'
import { SandboxedHtml } from '../renderer/sandboxed-html'

const allowImagesFromMock = vi.fn()
const imageSendersMock = vi.fn()

vi.mock('@/lib/trpc', () => ({
  trpc: {
    cap: {
      run: {
        mutate: async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
          const params = paramsJson === undefined ? undefined : JSON.parse(paramsJson)
          if (name === 'google.imageSenders') return imageSendersMock()
          if (name === 'google.allowImagesFrom') return allowImagesFromMock(params)
          throw new Error(`unexpected ${name}`)
        },
      },
    },
  },
}))

const identity = { key: 'message-1', sender: 'Jane@example.com' }
const source = '<p>hello</p><img src="https://cdn.test/logo.png">'

beforeEach(() => {
  allowImagesFromMock.mockReset().mockResolvedValue({ ok: true })
  imageSendersMock.mockReset().mockResolvedValue([])
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  resetMailImagesForTests()
})

afterEach(() => {
  cleanup()
})

/** Wait for the real frame document before capturing the identity under test. */
async function initialFrame(container: HTMLElement): Promise<HTMLIFrameElement> {
  const rendered = container.querySelector('iframe')
  expect(rendered, 'SandboxedHtml must render an iframe').not.toBeNull()
  await waitFor(() => expect(rendered!.contentDocument?.body.firstChild).toBeTruthy())
  const frame = container.querySelector('iframe')
  expect(frame, 'the initial iframe must still exist after its document loads').not.toBeNull()
  expect(frame).toBe(rendered)
  return frame!
}

function expectBlockedFrame(frame: HTMLIFrameElement): void {
  const document = frame.contentDocument!
  expect(document.querySelector('img')?.hasAttribute('src')).toBe(false)
  expect(
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
  ).not.toContain('https:')
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
  expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts')
}

async function expectAllowedFreshFrame(
  container: HTMLElement,
  previous: HTMLIFrameElement,
): Promise<HTMLIFrameElement> {
  await waitFor(() => {
    const current = container.querySelector('iframe')
    expect(current).not.toBeNull()
    expect(current).not.toBe(previous)
  })
  const current = container.querySelector('iframe')!
  await waitFor(() => expect(current.contentDocument?.body.firstChild).toBeTruthy())
  expect(current.contentDocument?.querySelector('img')?.getAttribute('src')).toBe(
    'https://cdn.test/logo.png',
  )
  expect(current.getAttribute('sandbox')).toBe('allow-same-origin')
  expect(current.getAttribute('sandbox')).not.toContain('allow-scripts')
  return current
}

test('unblocking builds a NEW frame, because a document cannot shed a CSP', async () => {
  const user = userEvent.setup()
  const view = render(<SandboxedHtml html={source} label="Message" identity={identity} />)
  const before = await initialFrame(view.container)
  expectBlockedFrame(before)

  await user.click(await within(view.container).findByRole('button', { name: /^load images$/i }))

  await expectAllowedFreshFrame(view.container, before)
})

test('“always from this sender” rebuilds the frame too, not just the banner', async () => {
  const user = userEvent.setup()
  const view = render(<SandboxedHtml html={source} label="Message" identity={identity} />)
  const before = await initialFrame(view.container)
  expectBlockedFrame(before)

  await user.click(
    await within(view.container).findByRole('button', { name: /always from this sender/i }),
  )

  await expectAllowedFreshFrame(view.container, before)
  expect(allowImagesFromMock).toHaveBeenCalledWith({ sender: 'jane@example.com' })
})

test('does not churn the frame when nothing about the policy changed', async () => {
  const props = { html: '<p>just a sentence</p>', label: 'Message', identity }
  const view = render(<SandboxedHtml {...props} />)
  const first = await initialFrame(view.container)

  view.rerender(<SandboxedHtml {...props} />)

  expect(view.container.querySelector('iframe')).toBe(first)
})
