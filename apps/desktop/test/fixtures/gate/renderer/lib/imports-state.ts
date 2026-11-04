// FIXTURE - must fail: lib is pure and imports nothing in the renderer (rule: boundaries/element-types).
import { count } from '../state/count'

export const doubled = (): number => count * 2
