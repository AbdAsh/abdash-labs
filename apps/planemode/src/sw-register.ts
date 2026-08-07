/**
 * Service worker registration.
 *
 * PlaneMode is one of seven apps served from path prefixes on a single origin
 * (labs.abdash.net). A service worker registered at the origin root would
 * control every sibling app and serve them PlaneMode's cached shell. That is
 * the sharpest edge the one-origin decision introduces, and it lives here.
 *
 * These two constants are hard-coded rather than derived from
 * `import.meta.env.BASE_URL` on purpose: a build misconfiguration must not be
 * able to widen the scope to `/`. The value is asserted in sw-register.test.ts.
 */
export const SW_SCOPE = '/planemode/'
export const SW_URL = '/planemode/sw.js'

/**
 * The second layer of the scoping defence, consumed by `vite.config.ts` as
 * Workbox's `navigateFallbackDenylist`.
 *
 * It lives here rather than inline in the build config so that a test can
 * assert the exact regex the build ships. Any path that is not under
 * `/planemode/` matches, and a match means the worker declines to serve the
 * navigation fallback for it.
 */
export const NAVIGATE_FALLBACK_DENYLIST = [/^\/(?!planemode\/)/]

/** True only for a scope whose path is exactly `/planemode/`. */
export function isScopedToPlaneMode(scope: string | undefined | null): boolean {
  if (!scope) return false
  try {
    // The base is only used to resolve relative scopes; the origin is irrelevant.
    return new URL(scope, 'https://labs.abdash.net').pathname === SW_SCOPE
  } catch {
    return false
  }
}

/**
 * Registers the offline shell worker, scoped to `/planemode/`.
 *
 * Returns `null` — never throws — when service workers are unavailable, when
 * registration fails, or when the browser resolves a scope wider than
 * `/planemode/`. In that last case the registration is torn down first, so a
 * misconfigured `Service-Worker-Allowed` header can never leave a worker
 * controlling the sibling apps.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const container = (globalThis as { navigator?: Partial<Navigator> }).navigator?.serviceWorker
  if (!container || typeof container.register !== 'function') return null

  let registration: ServiceWorkerRegistration
  try {
    registration = await container.register(SW_URL, {
      scope: SW_SCOPE,
      // The shell must be revalidated from the network when one is available,
      // otherwise a stale worker can pin an old build indefinitely.
      updateViaCache: 'none',
    })
  } catch {
    return null
  }

  if (!isScopedToPlaneMode(registration?.scope)) {
    await registration?.unregister?.().catch(() => undefined)
    return null
  }

  takeUpdatesImmediately(container, registration)
  return registration
}

/**
 * Lets a new build replace the running one on the next load.
 *
 * Without this a returning visitor keeps the previously cached shell until they
 * close every PlaneMode tab, because that is when a waiting worker is allowed
 * to activate. It is the default, and for most offline apps it is the safe
 * default — but here it means a visitor who saw this page once is pinned to
 * whatever it looked like that day. That is not theoretical: an entire restyle
 * shipped and this app kept serving the old stylesheet, which cost real time to
 * diagnose because the served bundle and the built bundle disagreed.
 *
 * The generated worker already listens for SKIP_WAITING; nothing was sending it.
 *
 * `reloaded` guards the one real hazard here. `controllerchange` also fires on
 * the very first registration, and reloading on that would be an infinite loop.
 * Reloading is limited to the case where a controller was already in place —
 * an update, not an install — and to once per page.
 */
function takeUpdatesImmediately(
  container: Partial<ServiceWorkerContainer>,
  registration: ServiceWorkerRegistration,
): void {
  const prompt = (worker: ServiceWorker | null) => {
    if (worker?.state === 'installed' && container.controller) {
      worker.postMessage({ type: 'SKIP_WAITING' })
    }
  }

  prompt(registration.waiting)

  registration.addEventListener?.('updatefound', () => {
    const installing = registration.installing
    installing?.addEventListener('statechange', () => prompt(installing))
  })

  let reloaded = false
  container.addEventListener?.('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    globalThis.location?.reload()
  })
}
