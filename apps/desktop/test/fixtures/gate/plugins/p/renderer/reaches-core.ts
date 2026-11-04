// FIXTURE - must fail: a plugin importing core directly instead of through @/plugin-api
// (rules: no-restricted-imports, boundaries/element-types).
import { cn } from '@/lib/cn'

export const joined = cn
