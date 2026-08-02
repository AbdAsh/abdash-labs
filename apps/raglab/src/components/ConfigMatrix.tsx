import { useMemo } from 'react'
import { CHUNKERS, type ChunkerId } from '../lib/chunkers'
import {
  EMBEDDING_MODELS,
  MAX_CONFIGS,
  MatrixTooLargeError,
  estimateTokens,
  expandMatrix,
  type Config,
  type MatrixSelection,
} from '../lib/engine'

const SIZES = [200, 400, 800, 1600]
const OVERLAPS = [0, 80, 160, 320]
const KS = [1, 3, 5, 10]

interface Props {
  selection: MatrixSelection
  onChange: (selection: MatrixSelection) => void
  text: string
  questions: string[]
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function Row<T extends string | number>({
  label, hint, values, selected, format, onToggle,
}: {
  label: string
  hint?: string
  values: readonly T[]
  selected: T[]
  format?: (v: T) => string
  onToggle: (v: T) => void
}) {
  return (
    <div className="matrix-row">
      <div className="matrix-label">
        {label}
        {hint && <span className="matrix-hint">{hint}</span>}
      </div>
      <div className="chips">
        {values.map((v) => (
          <button
            key={String(v)}
            type="button"
            className={`chip${selected.includes(v) ? ' chip-on' : ''}`}
            aria-pressed={selected.includes(v)}
            onClick={() => onToggle(v)}
          >
            {format ? format(v) : String(v)}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The matrix picker and the pre-run cost estimate.
 *
 * The estimate is not decoration. Showing projected tokens and dollars before the
 * run commits is the difference between a demo and a tool someone would trust
 * with a real document, and it is the only place a user learns that doubling
 * overlap doubles what they pay for the same document.
 */
export function ConfigMatrix({ selection, onChange, text, questions }: Props) {
  const { configs, error } = useMemo(() => {
    try {
      return { configs: expandMatrix(selection), error: null as string | null }
    } catch (e) {
      return {
        configs: [] as Config[],
        error: e instanceof Error ? e.message : String(e),
      }
    }
  }, [selection])

  const estimate = useMemo(
    () => (configs.length > 0 ? estimateTokens(text, configs, questions) : { tokens: 0, usd: 0 }),
    [text, configs, questions],
  )

  const set = (patch: Partial<MatrixSelection>) => onChange({ ...selection, ...patch })

  return (
    <section className="panel">
      <h2>2 · Configurations</h2>
      <p className="lede">
        Every combination is embedded and scored separately. Capped at {MAX_CONFIGS} —
        past that a run stops being something you wait for.
      </p>

      <Row
        label="Chunker"
        values={CHUNKERS.map((c) => c.id)}
        selected={selection.chunkers}
        format={(id) => CHUNKERS.find((c) => c.id === id)?.label ?? id}
        onToggle={(v) => set({ chunkers: toggle(selection.chunkers, v as ChunkerId) })}
      />
      <Row
        label="Chunk size"
        hint="characters"
        values={SIZES}
        selected={selection.sizes}
        onToggle={(v) => set({ sizes: toggle(selection.sizes, v) })}
      />
      <Row
        label="Overlap"
        hint="characters repeated between neighbours"
        values={OVERLAPS}
        selected={selection.overlaps}
        onToggle={(v) => set({ overlaps: toggle(selection.overlaps, v) })}
      />
      <Row
        label="Embedding model"
        values={Object.keys(EMBEDDING_MODELS)}
        selected={selection.models}
        format={(m) => EMBEDDING_MODELS[m]?.label ?? m}
        onToggle={(v) => set({ models: toggle(selection.models, v) })}
      />
      <Row
        label="Top-k"
        hint="chunks retrieved per question"
        values={KS}
        selected={selection.ks}
        onToggle={(v) => set({ ks: toggle(selection.ks, v) })}
      />

      {error
        ? (
          <p className="error" role="alert">
            {error}
            {error.includes(String(MAX_CONFIGS)) && (
              <span className="error-note">
                {' '}
                Nothing is dropped silently — a truncated matrix would report a
                comparison you did not ask for.
              </span>
            )}
          </p>
        )
        : (
          <dl className="estimate">
            <div>
              <dt>Configurations</dt>
              <dd>{configs.length}</dd>
            </div>
            <div>
              <dt>Embedding tokens</dt>
              <dd>{estimate.tokens.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Estimated cost</dt>
              <dd>{estimate.usd < 0.01 ? '< $0.01' : `$${estimate.usd.toFixed(3)}`}</dd>
            </div>
          </dl>
        )}
    </section>
  )
}

export { MatrixTooLargeError }
