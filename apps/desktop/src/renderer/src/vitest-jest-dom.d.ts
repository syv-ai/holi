// Makes the jest-dom matchers (toBeInTheDocument, toHaveClass, …) visible to tsc.
// The runtime extension happens in test/setup.dom.ts; this ambient import applies
// the matching `declare module 'vitest'` augmentation across the project's tests.
import '@testing-library/jest-dom/vitest'
