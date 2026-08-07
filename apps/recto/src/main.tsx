import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthGate } from '@labs/platform'
import App from './App'
import { ExampleApp } from './example/ExampleApp'
import { initialMode, rememberMode, type Mode } from './example/mode'
import './index.css'

/**
 * Two paths, and the cheap one is the default.
 *
 * `AuthGate` is deliberately *inside* the live branch. Mounting it around both
 * would make every visitor solve a captcha and take an anonymous account before
 * they could see anything at all — which is exactly the cost the saved example
 * exists to avoid. Someone reading the example never touches the network.
 */
function Root() {
  const [mode, setMode] = useState<Mode>(initialMode)

  const go = (next: Mode) => {
    rememberMode(next)
    setMode(next)
    window.scrollTo({ top: 0 })
  }

  if (mode === 'example') return <ExampleApp onLeave={() => go('live')} />

  return (
    <AuthGate>
      <App onSeeExample={() => go('example')} />
    </AuthGate>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing #root')

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
