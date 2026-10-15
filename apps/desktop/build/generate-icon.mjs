import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const buildDir = dirname(fileURLToPath(import.meta.url))
const svgPath = join(buildDir, 'icon.svg')
const iconsetDir = await mkdtemp(join(tmpdir(), 'holi-icon-'))
const iconsetPath = join(iconsetDir, 'Holi.iconset')
const basePng = join(iconsetDir, 'icon.png')

try {
  await mkdir(iconsetPath)
  execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', basePng], { stdio: 'inherit' })
  execFileSync('sips', ['-z', '1024', '1024', basePng, '--out', join(buildDir, 'icon.png')])
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = size * scale
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      execFileSync('sips', [
        '-z',
        String(pixels),
        String(pixels),
        basePng,
        '--out',
        join(iconsetPath, name),
      ])
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconsetPath, '-o', join(buildDir, 'icon.icns')], {
    stdio: 'inherit',
  })
} finally {
  await rm(iconsetDir, { recursive: true, force: true })
}
