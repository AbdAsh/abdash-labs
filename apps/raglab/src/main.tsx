import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Byline } from '@labs/ui'
import { App } from './App'
import './app.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

/**
 * No `AuthGate` here, deliberately. It lives inside `App`, wrapped around the
 * benchmark tool alone.
 *
 * Two of the three things this app renders need no account at all: the bundled
 * finished example is a file, and a shared permalink is read through an RPC
 * granted to `anon`. Gating the whole tree would make both of them wait on a
 * captcha and mint an anonymous user for somebody who came to read a saved
 * result — a cost with nothing on the other side of it.
 */
createRoot(root).render(
  <StrictMode>
    <>
      <App />
      <Byline app="RAG Lab" />
    </>
  </StrictMode>,
)
