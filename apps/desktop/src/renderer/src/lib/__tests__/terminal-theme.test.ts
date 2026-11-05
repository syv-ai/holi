import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalTheme, watchTerminalTheme } from '../terminal-theme'

const originalGetContext = HTMLCanvasElement.prototype.getContext
let sampled = [0, 0, 0, 255]
const canvasContext = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(sampled) })),
  set fillStyle(value: string) {
    const rgb = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
    if (rgb) sampled = [+rgb[1]!, +rgb[2]!, +rgb[3]!, Math.round(+(rgb[4] ?? '1') * 255)]
  },
}

function mountTerminal(): HTMLDivElement {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => canvasContext) as never
  const mount = document.createElement('div')
  mount.style.color = 'rgb(20, 30, 40)'
  document.documentElement.style.setProperty('--background', 'rgb(20, 40, 60)')
  mount.style.setProperty('--terminal-red', 'rgb(200, 0, 0)')
  mount.style.setProperty('--terminal-bright-white', 'rgb(255, 255, 255)')
  mount.style.setProperty('--terminal-selection', 'rgba(0, 0, 0, 0.2)')
  document.body.append(mount)
  return mount
}

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext
  document.documentElement.removeAttribute('data-theme')
})

describe('terminalTheme', () => {
  it('provides readable ANSI colors and a visible selection for terminal output', () => {
    const mount = mountTerminal()
    const theme = terminalTheme(mount)
    expect(theme.background).toBe('#14283c00')
    expect(theme.foreground).toBeDefined()
    expect(theme.red).toBeDefined()
    expect(theme.brightWhite).toBeDefined()
    expect(theme.selectionBackground).toBeDefined()
    mount.remove()
  })

  it('updates an existing terminal after root theme changes without replacing it', async () => {
    const mount = mountTerminal()
    const instance = { options: { theme: terminalTheme(mount) } }
    const original = instance.options.theme
    const update = vi.fn((theme) => {
      instance.options.theme = theme
    })
    const stop = watchTerminalTheme(mount, update)
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(update).toHaveBeenCalled()
    expect(instance.options.theme).not.toBe(original)
    const afterMode = instance.options.theme
    document.documentElement.style.setProperty('--foreground', 'rgb(40, 50, 60)')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(update).toHaveBeenCalledTimes(2)
    expect(instance.options.theme).not.toBe(afterMode)
    expect(instance.options.theme.background).toBe('#14283c00')
    stop()
    mount.remove()
  })
})
