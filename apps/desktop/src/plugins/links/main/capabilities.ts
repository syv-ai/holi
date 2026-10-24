/**
 * Links' capabilities: a page's preview, which every card shows, and a new
 * link file named after its page, which New Link and `holi links create`
 * make.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { readFile } from 'node:fs/promises'
import { vaultRelPath, type VaultRelPath } from '@holi/shared'
import {
  absPathFor,
  cap,
  CapabilityError,
  optionalStringParam,
  paramsObject,
  stringParam,
  withFileLock,
  writeAtomic,
  type CapabilityContext,
} from '../../../main/plugin-api'
import { linkFilePath, linkFileText, titleFromUrl } from '../shared/link-file'
import { isWebUrl, type LinkPreview } from '../shared/preview'

export const LINKS_NAMESPACES = ['links'] as const

export interface LinkCapabilitiesDeps {
  preview(url: string): Promise<LinkPreview>
}

function webUrl(raw: Record<string, unknown>): string {
  const url = stringParam(raw, 'url').trim()
  if (!isWebUrl(url)) throw new CapabilityError('BAD_REQUEST', `not a web address: ${url}`)
  return url
}

function safe(path: string): VaultRelPath {
  try {
    return vaultRelPath(path)
  } catch (err) {
    throw new CapabilityError('BAD_REQUEST', (err as Error).message)
  }
}

/**
 * `text` written to the first free name for `title` in `folder`: the title
 * itself, then "title 2", "title 3". Each name is checked and written under
 * its file's lock, so two saves of one page take two names and neither is
 * overwritten.
 */
async function createLinkFile(
  ctx: CapabilityContext,
  folder: string,
  title: string,
  text: string,
): Promise<VaultRelPath> {
  for (let n = 1; n <= 1000; n++) {
    const rel = safe(linkFilePath(folder, title, n))
    const abs = absPathFor(ctx.root, rel)
    const created = await withFileLock(abs, async () => {
      if ((await readFile(abs, 'utf8').catch(() => null)) !== null) return false
      await writeAtomic(ctx.root, rel, text)
      return true
    })
    if (created) return rel
  }
  throw new CapabilityError('BAD_REQUEST', `too many links named like: ${title}`)
}

export function linkCapabilities(deps: LinkCapabilitiesDeps) {
  return {
    'links.preview': cap({
      doors: ['ui'],
      params: (raw): { url: string } => ({ url: webUrl(paramsObject(raw)) }),
      run: (_ctx, { url }) => deps.preview(url),
    }),

    'links.create': cap({
      doors: ['ui', 'cli'],
      cli: {
        args: ['url', 'folder?'],
        summary: "save a web address as a link file named after its page's title",
      },
      writes: true,
      params: (raw): { url: string; folder: string } => {
        const p = paramsObject(raw)
        const folder = optionalStringParam(p, 'folder') ?? ''
        return { url: webUrl(p), folder: folder === '' ? '' : safe(folder) }
      },
      run: async (ctx, { url, folder }): Promise<{ path: string }> => {
        const preview = await deps.preview(url)
        const path = await createLinkFile(
          ctx,
          folder,
          preview.title ?? titleFromUrl(url),
          linkFileText(url, preview.description),
        )
        return { path }
      },
      text: (r) => r.path,
    }),
  }
}
