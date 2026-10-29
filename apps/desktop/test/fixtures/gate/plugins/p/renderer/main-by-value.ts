// FIXTURE - must fail: a plugin renderer importing its main side as a value, not a type
// (rule: @typescript-eslint/no-restricted-imports). The type import below passes.
import { table } from '../main/cap'
import type { Table } from '../main/cap'

export const value = table
export type T = Table
