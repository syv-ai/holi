import { describe, expect, it, vi } from 'vitest'
import { createPiWheelRouter } from '../renderer/lib/pi-wheel-routing'

const bounds = (left = 0, top = 0, width = 800, height = 400) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect

function wheel(clientX = 20, clientY = 20, deltaY = 40) {
  return {
    clientX,
    clientY,
    deltaY,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as WheelEvent
}

function enabledRouter() {
  const write = vi.fn()
  const router = createPiWheelRouter(write)
  router.observeOutput('\x1b[?1049h\x1b[?1000h\x1b[?1006h')
  return { router, write }
}

describe('Pi wheel routing', () => {
  it.each([
    ['\x1b[?1049h', '\x1b[?1000h\x1b[?1006h'],
    ['\x1b[?1000h', '\x1b[?1049h\x1b[?1006h'],
    ['\x1b[?1002h', '\x1b[?1049h\x1b[?1006h'],
    ['\x1b[?1006h', '\x1b[?1049h\x1b[?1000h'],
  ])('observes every split boundary in enable %j', (sequence, prerequisites) => {
    for (let split = 1; split < sequence.length; split++) {
      const write = vi.fn()
      const router = createPiWheelRouter(write)
      router.observeOutput(sequence.slice(0, split))
      router.observeOutput(sequence.slice(split))
      router.observeOutput(prerequisites)
      expect(router.onWheel(wheel(), bounds(), 98, 24)).toBe(true)
      expect(write).toHaveBeenCalled()
    }
  })

  it.each(['\x1b[?1049l', '\x1b[?1000l', '\x1b[?1006l'])(
    'observes every split boundary in %j',
    (sequence) => {
      for (let split = 1; split < sequence.length; split++) {
        const { router, write } = enabledRouter()
        router.observeOutput(sequence.slice(0, split))
        router.observeOutput(sequence.slice(split))
        const event = wheel()
        expect(router.onWheel(event, bounds(), 98, 24)).toBe(false)
        expect(write).not.toHaveBeenCalled()
      }
    },
  )

  it('retains a lone ESC and ESC[ until the following chunk completes them', () => {
    for (const prefix of ['\x1b', '\x1b[']) {
      const { router, write } = enabledRouter()
      router.observeOutput('\x1b[?1049l')
      router.observeOutput(prefix)
      router.observeOutput(prefix === '\x1b' ? '[?1049h' : '?1049h')
      const event = wheel()
      expect(router.onWheel(event, bounds(), 98, 24)).toBe(true)
      expect(write).toHaveBeenCalled()
    }
  })

  it('applies controls in stream order across OSC/DCS cancellation and RIS', () => {
    const { router, write } = enabledRouter()
    router.observeOutput('\x1b]title\x07\x1b[?1049l')
    let event = wheel()
    expect(router.onWheel(event, bounds(), 98, 24)).toBe(false)

    router.observeOutput('\x1b[?1049h\x1bPdata\x18\x1b[?1000l')
    event = wheel()
    expect(router.onWheel(event, bounds(), 98, 24)).toBe(false)

    router.observeOutput('\x1b[?1000h\x1b[?1006h\x1b[?1049h\x1bc\x1b[?1049h')
    event = wheel()
    expect(router.onWheel(event, bounds(), 98, 24)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('bounds overlong CSI state and resumes parsing subsequent modes', () => {
    const { router, write } = enabledRouter()
    router.observeOutput('\x1b[?' + '1'.repeat(5000) + 'h')
    router.observeOutput('\x1b[?1049l\x1b[?1000l\x1b[?1006l')
    expect(router.onWheel(wheel(), bounds(), 98, 24)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('maps screen coordinates by rendered cell size and ignores the screen edge', () => {
    const { router, write } = enabledRouter()
    const onGrid = wheel(50, 36)
    router.onWheel(onGrid, bounds(10, 20, 784, 384), 98, 24)
    expect(write).toHaveBeenCalledWith('\x1b[<65;6;2M')

    const scrollbar = wheel(795, 36)
    expect(router.onWheel(scrollbar, bounds(10, 20, 784, 384), 98, 24)).toBe(false)
    const screenEdge = wheel(794, 36)
    expect(router.onWheel(screenEdge, bounds(10, 20, 784, 384), 98, 24)).toBe(false)
    expect(scrollbar.preventDefault).not.toHaveBeenCalled()
  })
})
