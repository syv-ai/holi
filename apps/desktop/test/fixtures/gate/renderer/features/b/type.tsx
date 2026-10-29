// Every size here is under the floor: the gate must flag each one.
export function Small(): React.JSX.Element {
  const meta = `text-[10px]`
  return (
    <div className="text-[11px]">
      <span className="text-[0.6875rem]">{meta}</span>
    </div>
  )
}

// And these are at or above it: none may be flagged.
export function Fine(): React.JSX.Element {
  return <div className="text-xs text-[12px] text-[13px] text-[0.75rem]" />
}
