// FIXTURE - must fail: a plugin importing another plugin (rule: boundaries/element-types).
import { Other } from '../../q/renderer/other'

export const Bad = (): React.JSX.Element => <Other />
