/**
 * What PDF seeds into a vault (`vault/` beside this module): the Convert to PDF
 * templates under `.holi/document-templates/`, once, with the brand's fonts and
 * logo as binaries; and the md-to-pdf and pdf-comments skills, shipped.
 *
 * `_brand/` is skipped by the template picker (underscore prefix): it is the
 * foundation the branded templates import.
 */
import { seedFolder, type SeedContribution } from '../../../main/plugin-api'

const folder = seedFolder(
  import.meta.glob(['./vault/**', '!**/*.{ttf,png}', '!**/.DS_Store'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
  import.meta.glob('./vault/**/*.{ttf,png}', {
    query: '?inline',
    import: 'default',
    eager: true,
    exhaustive: true,
  }),
)

export const pdfSeed: SeedContribution = {
  id: 'pdf',
  once: folder.once,
  shipped: folder.shipped,
  // `holi pdf comments` only reads and `holi pdf typst` only finds the
  // engine, so neither asks.
  fragments: {
    '.claude/settings.json': [
      { permissions: { allow: ['Bash(holi pdf comments:*)', 'Bash(holi pdf typst:*)'] } },
    ],
  },
}
