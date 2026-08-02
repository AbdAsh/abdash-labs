# `@labs/platform`

The shared contract every app imports. **Import from `'@labs/platform'` only** — never
from a deep path like `@labs/platform/src/session`. The deep layout is free to change;
the surface below is not.

## Public surface

```ts
// client
export const supabase: SupabaseClient
export const SUPABASE_URL: string
export const SUPABASE_ANON_KEY: string
export function requireEnv(name: string, source: Record<string, unknown>): string

// session
export interface Session { userId: string; isAnonymous: boolean; email: string | null }
export function useSession(): { session: Session | null; loading: boolean }
export function ensureAnonymousSession(captchaToken: string): Promise<Session>
export function linkGitHub(): Promise<void>
export function linkGoogle(): Promise<void>
export function sendMagicLink(email: string): Promise<void>
export function signOut(): Promise<void>

// UI
export function AuthGate(props: { children: ReactNode }): JSX.Element
export function TurnstileWidget(props: { onToken: (t: string) => void }): JSX.Element

// quotas (display only — enforcement is server-side)
export function quotaFor(app: string, key: string): Promise<number>
export function usedToday(app: string, key: string): Promise<number>
export class QuotaExceededError extends Error
```

## Usage

```tsx
import { AuthGate, useSession, quotaFor, linkGitHub } from '@labs/platform'

export default function App() {
  return <AuthGate><Workspace /></AuthGate>
}

function Workspace() {
  const { session } = useSession()
  // session.isAnonymous === true until linkGitHub() / linkGoogle() / sendMagicLink()
  return <p>{session?.userId}</p>
}
```

`AuthGate` guarantees a session before children mount: a first-time visitor solves an
invisible Turnstile challenge and gets an anonymous account; a returning visitor sees
nothing. Because every app is served from a path under one origin, that session is
shared across all of them — that is the SSO, and it needs no code per app.

## Environment

Read at module load and thrown on if missing, so a misconfigured deploy fails loudly:

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Turnstile site key |

No secret key ever belongs in these — everything `VITE_`-prefixed ships in the bundle.

## Quotas

`quotaFor` is for **resource caps** (notebooks, documents) where deleting frees a slot:
the app counts its own rows and compares. `usedToday` is for rendering "12 of 20 used".

Neither enforces anything. **Rate limits are enforced server-side only**, by
`consumeQuota` in `supabase/functions/_shared/quota.ts`, which calls the
`platform.consume_quota` RPC through the caller's own JWT. A client-side check is a
hint to the user, never a gate.

Both helpers fail closed: any error or an unconfigured key yields `0`.

## Schema note

Platform tables and RPCs live in the `platform` Postgres schema, and the exported
`supabase` client is deliberately left on the default `public` schema so each app can
chain its own — `supabase.schema('recto').from('notebooks')`. Anything touching
`platform` must chain `.schema('platform')`; `quota.ts` already does. Do not pin a
default schema on the shared client.
