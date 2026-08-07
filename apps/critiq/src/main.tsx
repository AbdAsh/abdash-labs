import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Byline } from '@labs/ui'
import { AuthGate } from '@labs/platform'
import App from './App'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <>
      <AuthGate>
      <App />
    </AuthGate>
      <Byline app="Critiq" />
    </>
  </StrictMode>,
)
