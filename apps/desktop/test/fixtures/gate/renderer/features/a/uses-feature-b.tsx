// FIXTURE — must fail: feature 'a' importing feature 'b' (rule: boundaries/element-types).
import { NativePicker } from '../b/native'

export const A = (): React.JSX.Element => (
  <div>
    <NativePicker />
  </div>
)
