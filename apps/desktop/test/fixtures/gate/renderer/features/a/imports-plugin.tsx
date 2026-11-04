// FIXTURE - must fail: core importing a plugin (rules: no-restricted-imports, boundaries/element-types).
import { Ok } from '../../../plugins/p/renderer/ok'

export const Bad = (): React.JSX.Element => <Ok />
