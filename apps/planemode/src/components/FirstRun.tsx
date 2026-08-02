import { useState } from 'react'
import { ModelPicker } from './ModelPicker'
import { formatBytes, tierById, type TierId } from '../lib/tiers'
import type { Capability } from '../lib/hardware'

/**
 * The first run is the product.
 *
 * Nobody waits out a gigabyte-scale download they do not understand, so the
 * bargain is stated before anything is asked for: what gets downloaded, how
 * big it is, and what you get in return. The exact size is on screen before the
 * button is pressed.
 */
export function FirstRun({
  capability,
  onStart,
}: {
  capability: Capability
  onStart: (tier: TierId) => void
}) {
  const [selected, setSelected] = useState<TierId>(capability.recommended ?? 'small')
  const tier = tierById(selected)

  return (
    <main className="firstrun">
      <h1>PlaneMode</h1>

      <p className="firstrun__pitch">
        <strong>Download once, own it forever.</strong> A small language model downloads into this
        browser and runs on your GPU. After that it works with the network off — on a plane, on the
        Underground, anywhere.
      </p>

      <ul className="firstrun__deal">
        <li>Your words never leave this device. There is no server to send them to.</li>
        <li>No account, no sign-in, no API key, nothing to pay for.</li>
        <li>One download of {formatBytes(tier.approxBytes)}, then it is yours offline.</li>
        <li>Delete it in one tap whenever you like.</li>
      </ul>

      {capability.reason && <p className="firstrun__hardware">{capability.reason}</p>}

      <ModelPicker value={selected} recommended={capability.recommended} onChange={setSelected} />

      <button className="firstrun__go" type="button" onClick={() => onStart(selected)}>
        Download {formatBytes(tier.approxBytes)} and start
      </button>

      <p className="firstrun__smallprint">
        This is a small model. It is quick and private, not omniscient — verify anything that
        matters. Weights are fetched from the HuggingFace CDN; that is the only network request
        PlaneMode ever makes, and it never happens again once they are cached.
      </p>
    </main>
  )
}
