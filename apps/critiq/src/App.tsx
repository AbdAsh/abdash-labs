import { useCallback, useEffect, useState } from 'react'
import { parseRoute } from './lib/router'
import { Submit } from './routes/Submit'
import { Report } from './routes/Report'

export default function App() {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next: string) => {
    if (next === window.location.pathname) return
    window.history.pushState({}, '', next)
    setPath(next)
    window.scrollTo(0, 0)
  }, [])

  const route = parseRoute(path)

  return (
    <main className="app">
      {route.name === 'report'
        ? <Report slug={route.slug} navigate={navigate} />
        : <Submit navigate={navigate} />}
    </main>
  )
}
