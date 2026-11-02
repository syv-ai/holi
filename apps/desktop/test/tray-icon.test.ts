import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTray } from '../src/main/tray'

const addRepresentation = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => []) },
  nativeImage: {
    createEmpty: () => ({ addRepresentation, setTemplateImage: vi.fn() }),
  },
  Tray: class {
    setToolTip(): void {}
    setContextMenu(): void {}
  },
}))

const icon = readFileSync(fileURLToPath(new URL('../assets/menu-bar-icon.png', import.meta.url)))

describe('menu-bar icon asset', () => {
  it('is a 36px Retina RGBA PNG', () => {
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(icon.readUInt32BE(16)).toBe(36)
    expect(icon.readUInt32BE(20)).toBe(36)
    expect(icon[25]).toBe(6) // RGBA: the artwork keeps its tile, not transparency alone.
  })

  it('bundles the asset as a 2x representation without reading from disk', () => {
    createTray({ openWindow: vi.fn(), tooltip: 'Holi' })

    expect(addRepresentation).toHaveBeenCalledOnce()
    const representation = addRepresentation.mock.calls[0]![0] as {
      scaleFactor: number
      dataURL: string
    }
    expect(representation.scaleFactor).toBe(2)
    expect(representation.dataURL).toMatch(/^data:image\/png;base64,/)
    expect(Buffer.from(representation.dataURL.split(',')[1]!, 'base64')).toEqual(icon)
  })
})
