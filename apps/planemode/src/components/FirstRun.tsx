import { useState } from 'react'
import { ModelPicker } from './ModelPicker'
import { fitsInFreeSpace } from '../lib/hardware'
import { formatBytes, tierById, type TierId } from '../lib/tiers'
import type { Capability } from '../lib/hardware'

/**
 * The first run is the product.
 *
 * Nobody waits out a gigabyte-scale download they do not understand, so the
 * bargain is stated before anything is asked for: what gets downloaded, how big
 * it is, whether it will fit, and what you get in return. Every one of those is
 * on screen before the button is pressed, because every one of them is a reason
 * someone would otherwise close the tab at 40%.
 */
export function FirstRun({
  capability,
  cached,
  resuming,
  onStart,
}: {
  capability: Capability
  /** Tiers already fully on disk — these need no download at all. */
  cached: TierId[]
  /** A tier this browser began downloading and did not finish. */
  resuming: TierId | null
  onStart: (tier: TierId) => void
}) {
  // A tier that is fully on disk beats one that is half-downloaded, which beats
  // whatever the hardware check suggested. Preselecting the abandoned download
  // over a finished one would offer the slower of two options first.
  const [selected, setSelected] = useState<TierId>(
    cached[0] ?? resuming ?? capability.recommended ?? 'small',
  )
  const tier = tierById(selected)
  const onDisk = cached.includes(selected)
  const verdict = onDisk ? 'fits' : fitsInFreeSpace(tier.approxBytes, capability.freeBytes)

  const action = onDisk
    ? 'Start — it is already on this device'
    : resuming === selected
      ? `Resume the ${formatBytes(tier.approxBytes)} download`
      : `Download ${formatBytes(tier.approxBytes)} and start`

  return (
    <main className="firstrun">
      <h1>PlaneMode</h1>

      <p className="firstrun__pitch">
        <strong>Download once, own it forever.</strong> A small language model downloads into this
        browser and runs on your GPU. After that it works with the network off — on a plane, on the
        Underground, anywhere.
      </p>

      {resuming === selected && (
        <p className="firstrun__resume">
          <strong>You started this download before.</strong> Every piece that already reached this
          device is still here, so carrying on fetches only what is missing — it does not begin
          again from zero.
        </p>
      )}

      <ul className="firstrun__deal">
        <li>Your words never leave this device. There is no server to send them to.</li>
        <li>No account, no sign-in, no API key, nothing to pay for.</li>
        <li>
          {onDisk
            ? `The ${formatBytes(tier.approxBytes)} is already downloaded. This is a straight start.`
            : `One download of ${formatBytes(tier.approxBytes)}, then it is yours offline.`}
        </li>
        <li>Delete it in one tap whenever you like.</li>
      </ul>

      {capability.reason && <p className="firstrun__hardware">{capability.reason}</p>}

      {capability.freeBytes !== null && !onDisk && (
        <p className="firstrun__space">
          This browser will let this site use about {formatBytes(capability.freeBytes)} more.
        </p>
      )}

      <ModelPicker
        value={selected}
        recommended={capability.recommended}
        cached={cached}
        freeBytes={capability.freeBytes}
        onChange={setSelected}
      />

      {verdict === 'too-small' && (
        <p className="firstrun__blocked">
          There is not enough room for this one. The download would reach the end of the space this
          browser allows and fail — pick the smaller model, or free some disk space first.
        </p>
      )}

      <button
        className="firstrun__go"
        type="button"
        onClick={() => onStart(selected)}
        disabled={verdict === 'too-small'}
      >
        {action}
      </button>

      <p className="firstrun__smallprint">
        This is a small model. It is quick and private, not omniscient — verify anything that
        matters. Three things ever touch the network: this page, its offline worker, and one fetch
        of the weights from the HuggingFace CDN. Nothing you type is among them, because there is
        nowhere to send it.
      </p>
    </main>
  )
}
