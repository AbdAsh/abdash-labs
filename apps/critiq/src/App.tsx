import { useCallback, useEffect, useState } from 'react'
import { AuthGate } from '@labs/platform'
import { parseRoute } from './lib/router'
import { Submit } from './routes/Submit'
import { Report } from './routes/Report'

export default function App() {
  const [path, setPath] = useState(() => globalThis.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(globalThis.location.pathname)
    globalThis.addEventListener('popstate', onPop)
    return () => globalThis.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next: string) => {
    if (next === globalThis.location.pathname) return
    globalThis.history.pushState({}, '', next)
    setPath(next)
    globalThis.scrollTo(0, 0)
  }, [])

  const route = parseRoute(path)

  return (
    <AuthGate>
      <main className="app">
        {route.name === 'report'
          ? <Report slug={route.slug} navigate={navigate} />
          : <Submit navigate={navigate} />}
      </main>
    </AuthGate>
  )
}
