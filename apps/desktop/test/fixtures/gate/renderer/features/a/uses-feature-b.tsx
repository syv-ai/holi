// FIXTURE - must PASS: a feature may import another feature (docs/renderer.md, Layers).
// Cycles are the one thing the layer rules cannot see; review catches those.
import { NativePicker } from '../b/native'

export const A = (): React.JSX.Element => (
  <div>
    <NativePicker />
  </div>
)
