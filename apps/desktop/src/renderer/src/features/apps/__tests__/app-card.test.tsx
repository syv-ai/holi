import { AppWindowIcon } from 'lucide-react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@/test/render'
import { AppCard } from '../app-card'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('hiding a card closes its portaled menu without returning focus into it', () => {
  const view = render(
    <AppCard
      path="apps/launchpad"
      name="Launchpad"
      icon={AppWindowIcon}
      stamp="v1"
      visible
      onOpen={() => {}}
      actions={{ onOpenBeside: () => {}, onReveal: () => {}, onCopyPath: () => {} }}
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Open Launchpad' })
  fireEvent.contextMenu(trigger, { clientX: 20, clientY: 20 })
  const menu = screen.getByRole('menu', { name: 'Launchpad actions' })
  expect(menu).toBeInTheDocument()

  view.rerender(
    <AppCard
      path="apps/launchpad"
      name="Launchpad"
      icon={AppWindowIcon}
      stamp="v1"
      visible={false}
      onOpen={() => {}}
      actions={{ onOpenBeside: () => {}, onReveal: () => {}, onCopyPath: () => {} }}
    />,
  )

  expect(screen.queryByRole('menu', { name: 'Launchpad actions' })).not.toBeInTheDocument()
  expect(document.activeElement).not.toBe(trigger)
  expect(document.activeElement).not.toHaveAttribute('data-slot', 'card')

  view.rerender(
    <AppCard
      path="apps/launchpad"
      name="Launchpad"
      icon={AppWindowIcon}
      stamp="v1"
      visible
      onOpen={() => {}}
      actions={{ onOpenBeside: () => {}, onReveal: () => {}, onCopyPath: () => {} }}
    />,
  )
  expect(screen.queryByRole('menu', { name: 'Launchpad actions' })).not.toBeInTheDocument()
})

test('hidden cards defer async descriptions and previews and discard stale results', async () => {
  const previewWork = [deferred<string | null>(), deferred<string | null>()]
  const describeWork = [deferred<string | null>(), deferred<string | null>()]
  const preview = vi
    .fn<() => Promise<string | null>>()
    .mockImplementationOnce(() => previewWork[0]!.promise)
    .mockImplementationOnce(() => previewWork[1]!.promise)
  const describe = vi
    .fn<() => Promise<string | null>>()
    .mockImplementationOnce(() => describeWork[0]!.promise)
    .mockImplementationOnce(() => describeWork[1]!.promise)
  const view = render(
    <AppCard
      path="apps/launchpad"
      name="Launchpad"
      icon={AppWindowIcon}
      stamp="v1"
      preview={preview}
      describe={describe}
      visible={false}
      onOpen={() => {}}
    />,
  )

  expect(preview).not.toHaveBeenCalled()
  expect(describe).not.toHaveBeenCalled()

  view.rerender(
    <AppCard
      path="apps/launchpad"
      name="Launchpad"
      icon={AppWindowIcon}
      stamp="v1"
      preview={preview}
      describe={describe}
      visible
      onOpen={() => {}}
    />,
  )
  expect(preview).toHaveBeenCalledTimes(1)
  expect(describe).toHaveBeenCalledTimes(1)

  view.rerender(
    <AppCard
      path="apps/launchpad"
      name="Launchpad"
      icon={AppWindowIcon}
      stamp="v1"
      preview={preview}
      describe={describe}
      visible={false}
      onOpen={() => {}}
    />,
  )
  await act(async () => {
    previewWork[0]!.resolve('data:image/png;base64,stale')
    describeWork[0]!.resolve('stale description')
    await Promise.resolve()
  })
  expect(screen.queryByAltText('Launchpad, as it last looked')).not.toBeInTheDocument()
  expect(screen.queryByText('stale description')).not.toBeInTheDocument()

  view.rerender(
    <AppCard
      path="apps/launchpad"
      name="Launchpad"
      icon={AppWindowIcon}
      stamp="v1"
      preview={preview}
      describe={describe}
      visible
      onOpen={() => {}}
    />,
  )
  expect(preview).toHaveBeenCalledTimes(2)
  expect(describe).toHaveBeenCalledTimes(2)
  await act(async () => {
    previewWork[1]!.resolve('data:image/png;base64,current')
    describeWork[1]!.resolve('current description')
    await Promise.resolve()
  })
  expect(screen.getByAltText('Launchpad, as it last looked')).toHaveAttribute(
    'src',
    'data:image/png;base64,current',
  )
  expect(screen.getByText('current description')).toBeInTheDocument()
})
