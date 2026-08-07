import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@labs/ui/theme.css'
import { AppShell } from '@labs/ui'
import { App } from './App'
import { bootstrap } from './lib/bootstrap'
import './styles/app.css'

// Registers the real DuckDB runner and the real planner. Doing it here rather
// than at import time keeps lib/profile.ts and lib/plan.ts free of both.
bootstrap()

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// No `AuthGate` here, deliberately.
//
// Gating the whole app would create an anonymous account — a network request,
// and a row on a server — before a visitor who only wanted to look at the
// finished example had asked for anything. The example path needs no identity
// because it spends no quota and calls nothing, so `App` puts the gate around
// the live path only. See the note above the render in `App.tsx`.
createRoot(root).render(
  <StrictMode>
    <AppShell app="asksheet">
      <App />
    </AppShell>
  </StrictMode>,
)
