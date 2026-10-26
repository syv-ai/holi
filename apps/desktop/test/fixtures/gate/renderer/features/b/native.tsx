// FIXTURE — must fail: native <select> outside primitives/ (rule: no-restricted-syntax).
export const NativePicker = (): React.JSX.Element => (
  <select>
    <option>x</option>
  </select>
)
