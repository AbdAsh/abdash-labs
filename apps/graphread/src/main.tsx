import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Byline } from '@labs/ui'
import { AuthGate } from '@labs/platform'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <>
      <AuthGate>
      <App />
    </AuthGate>
      <Byline app="GraphRead" />
    </>
  </StrictMode>,
)
