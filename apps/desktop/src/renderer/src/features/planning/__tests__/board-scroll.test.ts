import { expect, test } from 'vitest'
import { captureBoardScroll, restoreBoardScroll } from '../board-scroll'

test('captures and restores both board scroll axes', () => {
  const viewport = { scrollTop: 600, scrollLeft: 240 }

  const position = captureBoardScroll(viewport)
  viewport.scrollTop = 0
  viewport.scrollLeft = 0
  restoreBoardScroll(viewport, position)

  expect(viewport).toEqual({ scrollTop: 600, scrollLeft: 240 })
})
