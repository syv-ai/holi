import { useState, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'

import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
} from '@/components/reui/code-block/code-block'
import { Button } from '@/components/ui/button'

/**
 * A log line, opened under its row (docs/features/status-bar.md), for the
 * Output and the Logs tab alike: its fields, the detail it came with, and
 * the line as JSON. After the expandable rows of ReUI's `c-data-grid-8`.
 */

export type LogDetailField = { label: string; value: ReactNode }

/** Keyed by line by the caller, so a "Copied" state never carries over. */
function CopyLineButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => setCopied(true))
          .catch(() => toast.error('Could not copy the line'))
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
      {copied ? 'Copied' : 'Copy line'}
    </Button>
  )
}

function Field({ label, value }: LogDetailField) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="min-w-0 truncate text-sm">{value}</dd>
    </div>
  )
}

export function LogDetail({
  id,
  fields,
  detail,
  raw,
  copyText,
}: {
  id: number
  fields: LogDetailField[]
  /** The lines after the first: a stack, git's error text. */
  detail: string | undefined
  /** The line as kept, shown as JSON. */
  raw: object
  copyText: string
}) {
  return (
    <div className="bg-muted/30 @container flex flex-col gap-3 border-b px-3 py-3">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 @lg:grid-cols-4">
        {fields.map((f) => (
          <Field key={f.label} {...f} />
        ))}
      </dl>

      <div className="grid min-w-0 gap-3 @2xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-muted-foreground text-xs font-medium">Detail</h3>
          {detail === undefined ? (
            <p className="text-muted-foreground text-xs">
              This line has no more to say than its message.
            </p>
          ) : (
            <CodeBlock
              code={detail}
              language="text"
              highlight={false}
              defaultWrap
              maxLines={12}
              label="Detail"
            >
              <CodeBlockContent />
              <CodeBlockCopyButton />
            </CodeBlock>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-muted-foreground text-xs font-medium">Raw</h3>
          <CodeBlock
            code={JSON.stringify(raw, null, 2)}
            language="json"
            defaultWrap
            maxLines={12}
            label="The line as JSON"
          >
            <CodeBlockContent />
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <CopyLineButton key={id} text={copyText} />
      </div>
    </div>
  )
}
