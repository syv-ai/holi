// FIXTURE — must fail: native <select> outside components/ui/ (rule: no-restricted-syntax).
export const NativePicker = (): React.JSX.Element => (
  <select>
    <option>x</option>
  </select>
)
