/**
 * `shrink-images`: a large PNG or JPEG is made smaller before it reaches the
 * vault's history, where every version of a binary stays forever.
 *
 * **In place, same name, same format**, so nothing that refers to the image
 * (a note, a deck's slides.md, a component, a stylesheet) can break. Three
 * rules, each chosen so a slide on a conference screen looks the same:
 *
 * - **At most 3840 by 2160**, the most a 4K screen shows edge to edge.
 *   Smaller images are never enlarged.
 * - **A PNG goes to 256 colours only when that is near-lossless** (a PSNR of
 *   at least 38 dB against the original, with dithering): flat graphics and most screenshots
 *   do, a photo or a smooth gradient that would band does not, and keeps its
 *   full colour, recompressed losslessly.
 * - **A JPEG is re-encoded at quality 85.**
 *
 * A file is rewritten only when the result is at least a tenth smaller, so a
 * second commit of an image this already shrank leaves it alone. An animated
 * image, a small one, or one that does not decode is left as it is.
 */
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { vaultRelPath } from '@holi/shared'
import { absPathFor, writeAtomic } from '../vault-files'
import type { StagedChanges } from './staged'
import type { TransformResult } from './relink'

/** Below this an image is not worth a lossy pass. */
const MIN_BYTES = 200 * 1024
const MAX_WIDTH = 3840
const MAX_HEIGHT = 2160
/** The palette is kept only at or above this. Dithering's fine noise lowers
 *  PSNR more than it shows: photos land at 36 to 41 dB and are not told
 *  apart from their originals at full size, while a palette that would
 *  band a gradient or blur anti-aliasing lands far lower (about 26 dB). */
const MIN_PALETTE_PSNR = 38
const JPEG_QUALITY = 85
/** A rewrite must save at least this share of the file. */
const MIN_SAVING = 0.1

const IMAGE = /\.(png|jpe?g)$/i

/** Peak signal-to-noise ratio of two same-sized RGBA buffers, in dB. */
function psnr(a: Buffer, b: Buffer): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!
    sum += d * d
  }
  const mse = sum / a.length
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}

const rgba = (input: Buffer) =>
  sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

/**
 * The smaller version of an image's bytes, or null when it should stay as it
 * is. `name` decides the format by its extension. The one rule for how an
 * image is shrunk: the commit transform and any one-off rewrite call this.
 */
export async function shrinkImage(bytes: Buffer, name: string): Promise<Buffer | null> {
  if (bytes.length < MIN_BYTES || !IMAGE.test(name)) return null
  const meta = await sharp(bytes)
    .metadata()
    .catch(() => null)
  if (meta === null || (meta.pages ?? 1) > 1) return null

  // Turned upright first, since the re-encode drops the EXIF orientation;
  // the colour profile stays.
  const base = sharp(bytes)
    .rotate()
    .resize({ width: MAX_WIDTH, height: MAX_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .keepIccProfile()

  let out: Buffer
  if (/\.png$/i.test(name)) {
    const full = await base.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    const palette = await base
      .clone()
      .png({ palette: true, colours: 256, dither: 1, effort: 10, compressionLevel: 9 })
      .toBuffer()
    const [a, b] = await Promise.all([rgba(full), rgba(palette)])
    out = psnr(a.data, b.data) >= MIN_PALETTE_PSNR && palette.length < full.length ? palette : full
  } else {
    out = await base.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer()
  }
  return out.length <= bytes.length * (1 - MIN_SAVING) ? out : null
}

export async function shrinkImages(root: string, staged: StagedChanges): Promise<TransformResult> {
  const targets = [...staged.added, ...staged.modified, ...staged.renamed.map((r) => r.to)]
  const changed: string[] = []
  let before = 0
  let after = 0

  for (const path of [...new Set(targets)].sort()) {
    if (!IMAGE.test(path)) continue
    const rel = vaultRelPath(path)
    const bytes = await readFile(absPathFor(root, rel)).catch(() => null)
    if (bytes === null) continue
    const smaller = await shrinkImage(bytes, path)
    if (smaller === null) continue
    await writeAtomic(root, rel, smaller)
    changed.push(path)
    before += bytes.length
    after += smaller.length
  }

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
  return {
    changed,
    notes:
      changed.length === 0
        ? []
        : [`shrink-images: ${changed.length} image(s), ${mb(before)} MB to ${mb(after)} MB`],
  }
}
