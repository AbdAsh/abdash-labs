import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@labs/ui/theme.css'
import { AppShell } from '@labs/ui'
import { AuthGate } from '@labs/platform'
import App from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// Thinner field than the other apps. GraphRead draws its own node-and-edge
// canvas, and a dense constellation behind a graph reads as a second graph.
createRoot(root).render(
  <StrictMode>
    <AppShell app="graphread" density={70}>
      <AuthGate>
        <App />
      </AuthGate>
    </AppShell>
  </StrictMode>,
)
