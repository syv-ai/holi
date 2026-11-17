/**
 * `shrink-images` on real encodes: what it does to a flat graphic, a smooth
 * gradient, an oversized image, a JPEG and a small file.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { shrinkImage } from '../src/main/vault/hooks/shrink-images'

/** Build raw RGB data from the pixel callback. */
function noisy(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 3)
  return sharp(data, { raw: { width, height, channels: 3 } })
}

function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

const LARGE_IMAGE_BYTES = 200 * 1024

describe('shrinkImage', () => {
  it('takes a graphic of few colours to a palette', async () => {
    const colours = [
      [20, 20, 20],
      [240, 230, 210],
      [200, 80, 50],
      [40, 120, 200],
    ]
    const png = await noisy(
      512,
      384,
      (x, y) => colours[(Math.floor(x / 19) + Math.floor(y / 13) + (x % 3 === 0 ? 1 : 0)) % 4]!,
    )
      .png({ compressionLevel: 0 })
      .toBuffer()
    expect(png.length).toBeGreaterThan(LARGE_IMAGE_BYTES)
    const out = await shrinkImage(png, 'chart.png')
    expect(out).not.toBeNull()
    expect((await sharp(out!).metadata()).paletteBitDepth).toBeDefined()
  })

  it('keeps a smooth gradient in full colour, where a palette would band', async () => {
    const random = seededRandom(0x457)
    const png = await noisy(720, 480, (x, y) => [
      Math.round((x / 720) * 255),
      Math.round((y / 480) * 255),
      128 + (random() % 3),
    ])
      .png({ compressionLevel: 0 })
      .toBuffer()
    expect(png.length).toBeGreaterThan(LARGE_IMAGE_BYTES)
    const out = await shrinkImage(png, 'sky.png')
    expect(out).not.toBeNull()
    const meta = await sharp(out!).metadata()
    expect(meta.paletteBitDepth).toBeUndefined()
    expect(meta.channels).toBeGreaterThanOrEqual(3)
  })

  it('brings an image wider than 4K down to 3840, and never enlarges', async () => {
    const wideRandom = seededRandom(0x458)
    const jpg = await noisy(4000, 160, () => [
      wideRandom() % 256,
      wideRandom() % 256,
      wideRandom() % 256,
    ])
      .jpeg({ quality: 100 })
      .toBuffer()
    expect(jpg.length).toBeGreaterThan(LARGE_IMAGE_BYTES)
    const out = await shrinkImage(jpg, 'wide.jpg')
    expect(out).not.toBeNull()
    const resized = await sharp(out!).metadata()
    expect(resized.width).toBe(3840)
    expect(resized.height).toBeLessThan(160)

    const smallRandom = seededRandom(0x459)
    const small = await noisy(1200, 300, () => [
      smallRandom() % 256,
      smallRandom() % 256,
      smallRandom() % 256,
    ])
      .jpeg({ quality: 100 })
      .toBuffer()
    expect(small.length).toBeGreaterThan(LARGE_IMAGE_BYTES)
    const kept = await shrinkImage(small, 'photo.jpeg')
    expect(kept).not.toBeNull()
    expect((await sharp(kept!).metadata()).width).toBe(1200)
  })

  it('leaves a small file, another format, and its own output alone', async () => {
    const tinyRandom = seededRandom(0x45a)
    const tiny = await noisy(50, 50, () => [tinyRandom() % 256, 0, 0])
      .png()
      .toBuffer()
    expect(await shrinkImage(tiny, 'tiny.png')).toBeNull()
    const gif = Buffer.alloc(300 * 1024)
    expect(await shrinkImage(gif, 'anim.gif')).toBeNull()

    const idempotenceRandom = seededRandom(0x45b)
    const jpg = await noisy(900, 600, () => [
      idempotenceRandom() % 256,
      idempotenceRandom() % 256,
      idempotenceRandom() % 256,
    ])
      .jpeg({ quality: 100 })
      .toBuffer()
    expect(jpg.length).toBeGreaterThan(LARGE_IMAGE_BYTES)
    const once = await shrinkImage(jpg, 'a.jpg')
    expect(once).not.toBeNull()
    expect(once!.length).toBeGreaterThan(LARGE_IMAGE_BYTES)
    expect(await shrinkImage(once!, 'a.jpg')).toBeNull()
  })
})
