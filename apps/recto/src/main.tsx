import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from '@labs/platform'
import App from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing #root')

createRoot(root).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
