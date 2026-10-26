// FIXTURE - must PASS the gate: components/ui is the vendored layer, so it may use
// native elements, Radix, its own motion, small type and a native title.
import * as RadixDialog from '@radix-ui/react-dialog'

export const Vendored = (): React.JSX.Element => (
  <button title="x" className="transition-all text-[10px]">
    {String(RadixDialog)}
  </button>
)
