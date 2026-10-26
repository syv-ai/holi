// FIXTURE — must fail: a composite importing Radix (rule: boundaries/external).
import * as RadixDialog from '@radix-ui/react-dialog'

export const Bad = (): string => String(RadixDialog)
