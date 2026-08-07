import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@labs/ui/theme.css'
import { AppShell } from '@labs/ui'
import App from './App'
import { registerServiceWorker } from './sw-register'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root')

// No AuthGate, and no @labs/platform import anywhere in this tree. PlaneMode
// shares an origin with six apps that do have a session; it must never read it.
// AppShell is safe here for the same reason the Byline was: @labs/ui pulls in
// nothing but React.
createRoot(container).render(
  <StrictMode>
    <AppShell app="planemode">
      <App />
    </AppShell>
  </StrictMode>,
)

// Registered after render so the first paint is never blocked by it, and always
// with the explicit /planemode/ scope.
void registerServiceWorker()
