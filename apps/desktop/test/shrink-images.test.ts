/**
 * `shrink-images` on real encodes: what it does to a flat graphic, a smooth
 * gradient, an oversized image, a JPEG and a small file.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { shrinkImage } from '../src/main/vault/hooks/shrink-images'

/** Noise keeps an image from compressing to nothing, so it is over the
 *  size floor the way a real screenshot or photo is. */
function noisy(width: number, height: number, pixel: (x: number, y: number) => number[]) {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 3)
  return sharp(data, { raw: { width, height, channels: 3 } })
}

const rand = (n: number) => Math.floor(Math.random() * n)

describe('shrinkImage', () => {
  it('takes a graphic of few colours to a palette', async () => {
    const colours = [
      [20, 20, 20],
      [240, 230, 210],
      [200, 80, 50],
      [40, 120, 200],
    ]
    const png = await noisy(
      1600,
      900,
      (x, y) => colours[(Math.floor(x / 37) + Math.floor(y / 23) + rand(2)) % 4]!,
    )
      .png({ compressionLevel: 0 })
      .toBuffer()
    const out = await shrinkImage(png, 'chart.png')
    expect(out).not.toBeNull()
    expect((await sharp(out!).metadata()).paletteBitDepth).toBeDefined()
  })

  it('keeps a smooth gradient in full colour, where a palette would band', async () => {
    const png = await noisy(2000, 1200, (x, y) => [
      Math.round((x / 2000) * 255),
      Math.round((y / 1200) * 255),
      128 + rand(3),
    ])
      .png({ compressionLevel: 0 })
      .toBuffer()
    const out = await shrinkImage(png, 'sky.png')
    expect(out).not.toBeNull()
    const meta = await sharp(out!).metadata()
    expect(meta.paletteBitDepth).toBeUndefined()
    expect(meta.channels).toBeGreaterThanOrEqual(3)
  })

  it('brings an image wider than 4K down to 3840, and never enlarges', async () => {
    const jpg = await noisy(5000, 2000, () => [rand(256), rand(256), rand(256)])
      .jpeg({ quality: 100 })
      .toBuffer()
    const out = await shrinkImage(jpg, 'wide.jpg')
    expect((await sharp(out!).metadata()).width).toBe(3840)

    const small = await noisy(1200, 800, () => [rand(256), rand(256), rand(256)])
      .jpeg({ quality: 100 })
      .toBuffer()
    const kept = await shrinkImage(small, 'photo.jpeg')
    if (kept !== null) expect((await sharp(kept).metadata()).width).toBe(1200)
  })

  it('leaves a small file, another format, and its own output alone', async () => {
    const tiny = await noisy(50, 50, () => [rand(256), 0, 0])
      .png()
      .toBuffer()
    expect(await shrinkImage(tiny, 'tiny.png')).toBeNull()
    const gif = Buffer.alloc(300 * 1024)
    expect(await shrinkImage(gif, 'anim.gif')).toBeNull()

    const jpg = await noisy(3000, 2000, () => [rand(256), rand(256), rand(256)])
      .jpeg({ quality: 100 })
      .toBuffer()
    const once = await shrinkImage(jpg, 'a.jpg')
    expect(once).not.toBeNull()
    expect(await shrinkImage(once!, 'a.jpg')).toBeNull()
  })
})
