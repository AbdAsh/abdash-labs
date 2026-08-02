import { AuthGate } from '@labs/platform'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { bootstrap } from './lib/bootstrap'
import './styles/app.css'

// Registers the real DuckDB runner and the real planner. Doing it here rather
// than at import time keeps lib/profile.ts and lib/plan.ts free of both.
bootstrap()

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
