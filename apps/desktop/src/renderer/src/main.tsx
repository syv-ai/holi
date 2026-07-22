import React from 'react'
import { createRoot } from 'react-dom/client'
import { Panel } from './panel/Panel'
import './index.css'

/**
 * Plan 4 renders the instrument panel, not `App`. The real shell cannot boot:
 * `Shell.tsx` and `EditorPane.tsx` import modules the D60 pivot deleted, and
 * vite resolves imports even though it does not typecheck. `App.tsx` is left on
 * disk, unimported, for plan 5 to restore.
 */
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Panel />
  </React.StrictMode>,
)
