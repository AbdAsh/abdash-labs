import { linkGitHub, linkGoogle, useSession } from '@labs/platform'

/**
 * The "raise your limit" line, shown when the daily allowance runs out.
 *
 * A component rather than a variable in `App`, and that is not tidying. It is
 * the only thing in the app that needs to know who the visitor is, and
 * `useSession()` reads the stored session — which supabase-js will refresh over
 * the network if the token has expired. Calling it unconditionally in `App`
 * would put that read on the example path, whose entire claim is that it makes
 * no request. Mounted only where a quota exists to be exhausted, it cannot.
 */
export function UpgradePrompt() {
  const { session } = useSession()
  if (!session?.isAnonymous) return null

  return (
    <p>
      You are anonymous, which is the lowest limit.{' '}
      <button type="button" className="link" onClick={() => void linkGitHub()}>
        Link GitHub
      </button>{' '}
      or{' '}
      <button type="button" className="link" onClick={() => void linkGoogle()}>
        Google
      </button>{' '}
      to raise it. Your sheet is not involved either way — it never left this tab.
    </p>
  )
}
