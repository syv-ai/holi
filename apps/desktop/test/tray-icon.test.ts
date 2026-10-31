import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const icon = readFileSync(fileURLToPath(new URL('../assets/menu-bar-icon.png', import.meta.url)))

describe('menu-bar icon asset', () => {
  it('is a 36px Retina RGBA PNG', () => {
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(icon.readUInt32BE(16)).toBe(36)
    expect(icon.readUInt32BE(20)).toBe(36)
    expect(icon[25]).toBe(6) // RGBA: the artwork keeps its tile, not transparency alone.
  })
})
