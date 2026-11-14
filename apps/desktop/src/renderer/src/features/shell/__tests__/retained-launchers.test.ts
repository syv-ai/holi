import { expect, test } from 'vitest'
import { isLauncherSurfaceKey } from '../retained-surfaces'

test('the shell retains every launcher identity and no ordinary view', () => {
  expect(isLauncherSurfaceKey('holi:none')).toBe(true)
  expect(isLauncherSurfaceKey('holi:new:1')).toBe(true)
  expect(isLauncherSurfaceKey('holi:apps')).toBe(true)
  expect(isLauncherSurfaceKey('holi:board')).toBe(false)
  expect(isLauncherSurfaceKey('holi:settings')).toBe(false)
})
