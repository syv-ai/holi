import { cleanup, render, screen, waitFor, within } from '@/test/render'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { getDefaultStore } from 'jotai'
import { activeRemoteAtom, loadVaultSettingsAtom } from '@/plugin-api'
import { resetMailImagesForTests, useSetAllSenderImages } from '../renderer/mail-images'
import { SandboxedHtml } from '../renderer/sandboxed-html'

const allowImagesFromMock = vi.fn()
const imageSendersMock = vi.fn()
const setImagesFromAllSendersMock = vi.fn()
let imagePolicy = { imageSenders: [] as string[], imagesFromAllSenders: false }

vi.mock('@/lib/trpc', () => ({
  trpc: {
    settings: {
      read: { query: async () => ({ pluginValues: { google: structuredClone(imagePolicy) } }) },
    },
    cap: {
      run: {
        mutate: async ({ name, paramsJson }: { name: string; paramsJson?: string }) => {
          const params = paramsJson === undefined ? undefined : JSON.parse(paramsJson)
          if (name === 'google.imageSenders') return imageSendersMock()
          if (name === 'google.allowImagesFrom') {
            const result = await allowImagesFromMock(params)
            imagePolicy.imageSenders = [...new Set([...imagePolicy.imageSenders, params.sender])]
            return result
          }
          if (name === 'google.setImagesFromAllSenders') {
            const result = await setImagesFromAllSendersMock(params)
            imagePolicy.imagesFromAllSenders = params.enabled
            return result
          }
          throw new Error(`unexpected ${name}`)
        },
      },
    },
  },
}))

const identity = { key: 'message-1', sender: 'Jane@example.com' }
const source = '<p>hello</p><img src="https://cdn.test/logo.png">'

function PolicyControls(): React.JSX.Element {
  const setAll = useSetAllSenderImages()
  return (
    <>
      <button type="button" onClick={() => void setAll(true)}>
        Enable all senders
      </button>
      <button type="button" onClick={() => void setAll(false)}>
        Disable all senders
      </button>
    </>
  )
}

beforeEach(async () => {
  allowImagesFromMock.mockReset().mockResolvedValue({ ok: true })
  imageSendersMock.mockReset().mockResolvedValue({ senders: [], allSenders: false })
  setImagesFromAllSendersMock.mockReset().mockResolvedValue({ ok: true })
  imagePolicy = { imageSenders: [], imagesFromAllSenders: false }
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  resetMailImagesForTests()
  await getDefaultStore().set(loadVaultSettingsAtom, { force: true })
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

test('sender consent updates mounted copies and later mounts through the shared policy', async () => {
  const user = userEvent.setup()
  const view = render(
    <>
      <SandboxedHtml html={source} label="First" identity={identity} />
      <SandboxedHtml
        html={source}
        label="Copy"
        identity={{ key: 'message-2', sender: 'jane@example.com' }}
      />
    </>,
  )
  const before = [...view.container.querySelectorAll('iframe')]
  await waitFor(() => before.forEach(expectBlockedFrame))
  await user.click(
    (
      await within(view.container).findAllByRole('button', { name: /always from this sender/i })
    )[0]!,
  )
  await waitFor(() => {
    const frames = [...view.container.querySelectorAll('iframe')]
    frames.forEach((frame, index) => {
      expect(frame).not.toBe(before[index])
      expect(frame.contentDocument?.querySelector('img')?.getAttribute('src')).toBe(
        'https://cdn.test/logo.png',
      )
    })
  })
  const later = render(
    <SandboxedHtml
      html={source}
      label="Later"
      identity={{ key: 'message-3', sender: 'JANE@example.com' }}
    />,
  )
  const frame = await initialFrame(later.container)
  expect(frame.contentDocument?.querySelector('img')?.getAttribute('src')).toBe(
    'https://cdn.test/logo.png',
  )
})

test('all-senders consent allows current HTML without a parsed sender and rebuilds its CSP frame', async () => {
  const user = userEvent.setup()
  const view = render(
    <SandboxedHtml html={source} label="Message" identity={{ key: null, sender: null }} />,
  )
  const before = await initialFrame(view.container)
  expectBlockedFrame(before)
  await user.click(
    await within(view.container).findByRole('button', { name: /always from all senders/i }),
  )
  await expectAllowedFreshFrame(view.container, before)
  expect(setImagesFromAllSendersMock).toHaveBeenCalledWith({ enabled: true })
})

test('failed all-senders save exposes a reachable retry and does not unblock before persistence', async () => {
  const user = userEvent.setup()
  setImagesFromAllSendersMock.mockRejectedValueOnce(new Error('disk unavailable'))
  const view = render(<SandboxedHtml html={source} label="Message" identity={identity} />)
  const before = await initialFrame(view.container)
  await user.click(
    await within(view.container).findByRole('button', { name: /always from all senders/i }),
  )
  expect(await within(view.container).findByRole('status')).toHaveTextContent(/could not save/i)
  expect(view.container.querySelector('iframe')).toBe(before)
  await user.click(within(view.container).getByRole('button', { name: 'Retry' }))
  await expectAllowedFreshFrame(view.container, before)
  expect(setImagesFromAllSendersMock).toHaveBeenCalledTimes(2)
})

test('global consent updates mounted copies and disabling it rebuilds both frames as blocked', async () => {
  const user = userEvent.setup()
  const view = render(
    <>
      <PolicyControls />
      <SandboxedHtml html={source} label="First" identity={identity} />
      <SandboxedHtml
        html={source}
        label="Second"
        identity={{ key: 'message-2', sender: 'Other@example.com' }}
      />
    </>,
  )
  const previous = [...view.container.querySelectorAll('iframe')]
  expect(previous).toHaveLength(2)
  await waitFor(() => previous.forEach(expectBlockedFrame))
  await user.click(screen.getByRole('button', { name: 'Enable all senders' }))
  await waitFor(() => {
    const frames = [...view.container.querySelectorAll('iframe')]
    expect(frames).toHaveLength(2)
    frames.forEach((frame, index) => {
      expect(frame).not.toBe(previous[index])
      expect(frame.contentDocument?.querySelector('img')?.getAttribute('src')).toBe(
        'https://cdn.test/logo.png',
      )
    })
  })
  await user.click(screen.getByRole('button', { name: 'Disable all senders' }))
  await waitFor(() => {
    const frames = [...view.container.querySelectorAll('iframe')]
    frames.forEach(expectBlockedFrame)
  })
  expect(setImagesFromAllSendersMock).toHaveBeenNthCalledWith(2, { enabled: false })
})

test('one-off consent is isolated by vault even when message keys repeat across an A-B-A switch', async () => {
  const user = userEvent.setup()
  const view = render(<SandboxedHtml html={source} label="Message" identity={identity} />)
  await user.click(await within(view.container).findByRole('button', { name: /^load images$/i }))
  expect(within(view.container).queryByRole('button', { name: /^load images$/i })).toBeNull()
  getDefaultStore().set(activeRemoteAtom, 'another/vault')
  expect(
    await within(view.container).findByRole('button', { name: /^load images$/i }),
  ).toBeInTheDocument()
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  await waitFor(() =>
    expect(within(view.container).queryByRole('button', { name: /^load images$/i })).toBeNull(),
  )
})

test('a deferred preference write cannot publish after switching A-B-A', async () => {
  let finish!: (value: { ok: true }) => void
  setImagesFromAllSendersMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
  const user = userEvent.setup()
  const view = render(
    <>
      <PolicyControls />
      <SandboxedHtml html={source} label="Message" identity={identity} />
    </>,
  )
  await user.click(screen.getByRole('button', { name: 'Enable all senders' }))
  getDefaultStore().set(activeRemoteAtom, 'another/vault')
  getDefaultStore().set(activeRemoteAtom, 'syv-ai/vault')
  await waitFor(() => expect(setImagesFromAllSendersMock).toHaveBeenCalledTimes(1))
  finish({ ok: true })
  await waitFor(() =>
    expect(
      within(view.container).getByRole('button', { name: /^load images$/i }),
    ).toBeInTheDocument(),
  )
})

test('does not churn the frame when nothing about the policy changed', async () => {
  const props = { html: '<p>just a sentence</p>', label: 'Message', identity }
  const view = render(<SandboxedHtml {...props} />)
  const first = await initialFrame(view.container)

  view.rerender(<SandboxedHtml {...props} />)

  expect(view.container.querySelector('iframe')).toBe(first)
})
