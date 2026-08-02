import { useRef, useState, type DragEvent } from 'react'
import { SAMPLES, type Sample } from '../samples'

/**
 * File intake. Drag, click, or take one of the two bundled datasets — a
 * portfolio visitor will not go hunting for a CSV, so the demo has to work with
 * zero effort.
 */
export function Dropzone({
  onFile,
  onSample,
  busy,
}: {
  onFile: (file: File) => void
  onSample: (sample: Sample) => void
  busy: boolean
}) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const accept = (files: FileList | null) => {
    const file = files?.[0]
    if (file) onFile(file)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setOver(false)
    if (!busy) accept(event.dataTransfer.files)
  }

  return (
    <section className="panel" aria-labelledby="load-heading">
      <h2 id="load-heading">Load a sheet</h2>

      <div
        className={`dropzone${over ? ' is-over' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p>Drop a CSV or TSV here — it is read in this tab and never uploaded.</p>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          Choose a file
        </button>
        <input
          ref={input}
          type="file"
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          className="visually-hidden"
          onChange={(event) => {
            accept(event.target.files)
            event.target.value = ''
          }}
        />
        <p className="filetypes">CSV and TSV. Excel files are not supported yet.</p>
      </div>

      <div className="samples">
        {SAMPLES.map((sample) => (
          <button
            key={sample.id}
            type="button"
            className="sample-card"
            disabled={busy}
            onClick={() => onSample(sample)}
          >
            <strong>{sample.name}</strong>
            <span>{sample.description}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
