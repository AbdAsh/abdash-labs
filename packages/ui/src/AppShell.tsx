/**
 * Everything an app needs to belong to abdash labs, in one wrapper.
 *
 * Sets the app's accent, mounts the ambient field behind the content, stages
 * the entrance, and puts the byline in the corner. An app opts in with one
 * element and keeps full control of everything inside it — this deliberately
 * imposes no layout, because six apps that share a container start looking like
 * six tabs of the same app.
 *
 * The entrance is staged rather than instant. The portfolio holds its panels at
 * opacity 0 until the loader finishes and then raises them; doing the same here
 * means the transition between the two origins is continuous rather than a cut.
 */
import { useEffect, type ReactNode } from 'react'
import { ACCENTS, applyAccent, type AppName } from './accents'
import { Byline } from './Byline'
import { DevBanner } from './DevBanner'
import { Starfield } from './Starfield'

export interface AppShellProps {
  app: AppName
  children: ReactNode
  /** Ambient field behind the content. On by default. */
  starfield?: boolean
  /**
   * Star count ceiling. Lower it for apps that draw their own graphics —
   * GraphRead has a force-directed canvas of its own, and two busy layers
   * competing for the same attention serves neither.
   */
  density?: number
}

export function AppShell({ app, children, starfield = true, density }: AppShellProps) {
  useEffect(() => {
    applyAccent(ACCENTS[app])
  }, [app])

  return (
    <>
      {starfield && <Starfield rgb={ACCENTS[app]} density={density} />}
      <DevBanner />
      <div className="labs-above labs-fade">{children}</div>
      <Byline app={app} />
    </>
  )
}
