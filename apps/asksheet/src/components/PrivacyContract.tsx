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
}: {
  strict: boolean
  onStrictChange: (next: boolean) => void
  locked: boolean
}) {
  return (
    <section className="contract" aria-labelledby="contract-heading">
      <h2 id="contract-heading">What leaves this tab</h2>
      <dl>
        <dt>sent</dt>
        <dd>
          Column names, inferred types, the row count, and up to {MAX_SAMPLES} example values per
          column — plus your question.
        </dd>
        <dt>never sent</dt>
        <dd>Your rows. The file is parsed and queried by DuckDB-WASM inside this browser tab.</dd>
        <dt>verify</dt>
        <dd>
          Open DevTools → Network and ask something. The only request is{' '}
          <code>asksheet-plan</code>, and you can read its whole body.
        </dd>
      </dl>

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
              : 'Schema only. Answers get a little worse; the payload gets a little smaller.'}
          </span>
        </span>
      </label>
    </section>
  )
}
