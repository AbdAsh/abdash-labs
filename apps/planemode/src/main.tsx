import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerServiceWorker } from './sw-register'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root')

// No AuthGate, and no @labs/platform import anywhere in this tree. PlaneMode
// shares an origin with six apps that do have a session; it must never read it.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Registered after render so the first paint is never blocked by it, and always
// with the explicit /planemode/ scope.
void registerServiceWorker()
