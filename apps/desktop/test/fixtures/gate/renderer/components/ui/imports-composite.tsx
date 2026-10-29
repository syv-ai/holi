// FIXTURE - must fail: components/ui importing upward (rule: boundaries/element-types).
import { Bad } from '../../composites/radix'

export const Up = (): string => Bad()
