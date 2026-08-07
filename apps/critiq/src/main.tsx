import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@labs/ui/theme.css'
import { AppShell } from '@labs/ui'
import { AuthGate } from '@labs/platform'
import App from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

// theme.css is imported before index.css so the app's own rules win on equal
// specificity. Reversing those two lines silently reverts the app to the theme's
// defaults, and nothing errors.
createRoot(root).render(
  <StrictMode>
    <AppShell app="critiq">
      <AuthGate>
        <App />
      </AuthGate>
    </AppShell>
  </StrictMode>,
)
