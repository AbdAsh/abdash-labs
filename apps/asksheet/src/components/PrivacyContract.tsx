import { MAX_SAMPLES } from '../lib/profile'

/**
 * The claim, stated plainly and specifically enough to be checked.
 *
 * Vague reassurance ("we take your privacy seriously") is worth nothing. This
 * lists exactly what is sent, exactly what is not, and tells the reader how to
 * verify it themselves in thirty seconds.
 */
export function PrivacyContract({
  strict,
  onStrictChange,
  locked,
  live,
}: {
  strict: boolean
  onStrictChange: (next: boolean) => void
  locked: boolean
  /** False on the example path, where nothing is sent and the strict toggle
   *  would be a control over traffic that does not exist. */
  live: boolean
}) {
  return (
    <section className="contract" aria-labelledby="contract-heading">
      <h2 id="contract-heading">What leaves this tab</h2>
      <dl>
        <dt>sent</dt>
        <dd>
          Column names, inferred types, the row count, and up to {MAX_SAMPLES} example values per
          column — chosen by hash, so they are neither the first rows nor the smallest values.
          Plus your question, and the SQL of earlier questions in this conversation.
        </dd>
        <dt>never sent</dt>
        <dd>
          Your rows. The file is parsed and queried by DuckDB-WASM inside this browser tab. When a
          query fails, DuckDB names the offending cell in its error — that error is stripped back
          to its diagnosis before any of it is used to ask for a corrected query.
        </dd>
        <dt>verify</dt>
        <dd>
          Open DevTools → Network and ask something. The only request is{' '}
          <code>asksheet-plan</code>, and you can read its whole body.
        </dd>
      </dl>

      {live ? (
        <label className="strict-toggle">
          <input
            type="checkbox"
            checked={strict}
            disabled={locked}
            onChange={(event) => onStrictChange(event.target.checked)}
          />
          <span>
            Strict mode — send no example values at all
            <span className="hint">
              {locked
                ? 'Locked while a question is in flight.'
                : 'Schema only. Answers get a little worse; the payload gets a little smaller. Turning it on clears the conversation, because earlier SQL can hold values from your sheet.'}
            </span>
          </span>
        </label>
      ) : (
        <p className="strict-toggle strict-inert">
          On the example path none of the above is sent, because nothing is asked — the plans were
          made once and saved. Switch to your own question to see the live payload.
        </p>
      )}
    </section>
  )
}
