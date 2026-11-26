import { afterEach, expect, test, vi } from 'vitest'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal, type ILinkProvider } from '@xterm/xterm'
import { createTerminalHintAdapter } from '../terminal-hints'
import { activateHostHint, discoverHostHintTargets } from '@/lib/host-hints'
import { installHintLayout } from '@/test/host-hint-layout'

const terminals: Terminal[] = []
afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  delete (document as Partial<Document>).elementFromPoint
})

function openedTerminal(cols = 32, rows = 3) {
  const mount = document.createElement('div')
  const grid = document.createElement('div')
  grid.className = 'xterm-screen'
  mount.append(grid)
  document.body.append(mount)
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  terminals.push(term)
  term.open(mount)
  const screen = mount.querySelector<HTMLElement>('.xterm-screen')!
  const rect = new DOMRect(0, 0, cols * 10, rows * 20)
  vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue(rect)
  vi.spyOn(mount, 'getBoundingClientRect').mockReturnValue(rect)
  vi.stubGlobal('innerWidth', rect.width)
  vi.stubGlobal('innerHeight', rect.height)
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null
      return grid
    },
  })
  const providers: ILinkProvider[] = []
  const register = term.registerLinkProvider.bind(term)
  term.registerLinkProvider = ((provider: ILinkProvider) => {
    providers.push(provider)
    return register(provider)
  }) as Terminal['registerLinkProvider']
  term.loadAddon(new WebLinksAddon(() => {}))
  term.registerLinkProvider = register
  return { term, mount, screen, providers }
}

function adapter(
  term: Terminal,
  mount: HTMLElement,
  providers: ILinkProvider[],
  current = () => true,
) {
  return createTerminalHintAdapter({
    term,
    mount,
    providers,
    isVisible: () => true,
    isCurrent: current,
  })
}

async function write(term: Terminal, text: string) {
  await new Promise<void>((resolve) => term.write(text, resolve))
}

function discover(providers: ILinkProvider[], row: number) {
  return providers.flatMap((provider) => {
    let links: Parameters<Parameters<ILinkProvider['provideLinks']>[1]>[0] = undefined
    provider.provideLinks(row, (value) => (links = value))
    return links ?? []
  })
}

test('discovers the real WebLinksAddon URL provider and chooses a visible wrapped row', async () => {
  const { term, mount, providers } = openedTerminal(22, 3)
  const target = 'https://example.test/界e\u0301?x=wide%E2%9C%93&y=done.'
  await write(term, `\r\n${target}`)
  const linkRows = Array.from({ length: term.rows }, (_, i) => discover(providers, i + 1)).flat()
  expect(linkRows.length).toBeGreaterThan(0)
  const { adapter: hints } = adapter(term, mount, providers)
  hints.capture?.()
  const targets = hints.discover()
  expect(targets).toHaveLength(1)
  expect(targets[0]?.label).toBe(target.replace(/[.]$/, ''))
  expect(targets[0]?.y).toBeGreaterThanOrEqual(10)
})

test('partly clipped links use visible uncovered cells; fully occluded links have no target', async () => {
  const { term, mount, screen, providers } = openedTerminal(32, 3)
  await write(term, '\r\nhttps://example.test/partly-visible')
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: (_x: number, y: number) => (y >= 30 ? screen : document.createElement('aside')),
  })
  const { adapter: hints } = adapter(term, mount, providers)
  hints.capture?.()
  expect(hints.discover()).toHaveLength(1)
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => document.createElement('aside'),
  })
  expect(hints.discover()).toHaveLength(0)
})

test('output invalidates before queued parsing and lifetime is checked with no URL targets', async () => {
  const { term, mount, providers } = openedTerminal()
  let current = true
  const {
    adapter: hints,
    write: enqueue,
    invalidate,
  } = adapter(term, mount, providers, () => current)
  hints.capture?.()
  const changed = vi.fn()
  hints.subscribe?.(changed)
  const replay = enqueue('pending replay')
  expect(changed).toHaveBeenCalledOnce()
  expect(hints.unchanged([])).toBe(false)
  await replay
  hints.capture?.()
  expect(hints.unchanged([])).toBe(true)
  current = false
  expect(hints.unchanged([])).toBe(false)
  invalidate()
  expect(changed).toHaveBeenCalledTimes(3)
})

test('native controls cannot activate after a shell scope ABA even with no links', async () => {
  const { term, mount, providers } = openedTerminal()
  const layout = installHintLayout()
  const control = document.createElement('button')
  control.textContent = 'Native terminal control'
  mount.append(control)
  layout.place(control, 10, 10)
  const click = vi.fn()
  control.addEventListener('click', click)
  const { adapter: hints, invalidate } = adapter(term, mount, providers)
  hints.capture?.()
  const target = discoverHostHintTargets(mount, hints).find(({ element }) => element === control)!
  expect(target).toBeDefined()
  invalidate() // hidden → another vault → this shell again; the captured epoch is not reusable.
  expect(activateHostHint(target)).toBe(false)
  expect(click).not.toHaveBeenCalled()
})

test('a disposed adapter never writes late replay into its terminal', async () => {
  const { term, mount, providers } = openedTerminal()
  const writeSpy = vi.spyOn(term, 'write')
  const session = adapter(term, mount, providers)
  session.dispose()
  await session.write('late replay')
  expect(writeSpy).not.toHaveBeenCalled()
  expect(session.adapter.unchanged([])).toBe(false)
})
