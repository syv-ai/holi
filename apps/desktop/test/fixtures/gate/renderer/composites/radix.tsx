// FIXTURE — must fail: a composite importing Radix (rule: boundaries/external).
import * as RadixDialog from 'radix-ui'

export const Bad = (): string => String(RadixDialog)
