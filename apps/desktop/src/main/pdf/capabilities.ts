/**
 * PDF's capabilities: the agent's read of a PDF someone marked up.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { commentThreadsJson, formatCommentThreads } from '@holi/shared'
import { CapabilityError } from '../capabilities/error'
import { pathParams } from '../capabilities/params'
import { cap } from '../capabilities/registry'
import { pdfCommentsInVault } from './comments'

/** A comment's JSON timestamps back into the dates its formatter reads. */
function dated<C extends { created: string | null; modified: string | null }>(c: C) {
  const date = (iso: string | null) => (iso === null ? null : new Date(iso))
  return { ...c, created: date(c.created), modified: date(c.modified) }
}

export const PDF_NAMESPACES = ['pdf'] as const

export const PDF_CAPABILITIES = {
  // Its threads as the viewer shows them. The value is the `--json` shape, so
  // the text revives its dates.
  'pdf.comments': cap({
    doors: ['cli'],
    cli: {
      args: ['path'],
      summary: "a vault PDF's comments: page, mark, marked text, author, dates and replies",
    },
    params: pathParams,
    run: async (ctx, { path }) => {
      const result = await pdfCommentsInVault(ctx.root, path)
      if (!result.ok) throw new CapabilityError('BAD_REQUEST', result.error)
      return commentThreadsJson(result.path, result.threads)
    },
    text: ({ path, threads }) =>
      formatCommentThreads(
        path,
        threads.map((t) => ({ ...dated(t), replies: t.replies.map(dated) })),
      ),
  }),
}
