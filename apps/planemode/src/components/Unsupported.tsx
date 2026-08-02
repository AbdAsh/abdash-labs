import type { Capability } from '../lib/hardware'

/**
 * The unsupported path.
 *
 * A visitor whose browser has no WebGPU should still see the product rather
 * than a dead page, so this explains the reason in plain language, lists what
 * does work, and links a recording of the app running.
 */
export function Unsupported({ capability }: { capability: Capability }) {
  return (
    <main className="unsupported">
      <h1>PlaneMode</h1>
      <p className="unsupported__lede">
        A small AI model that runs entirely inside your browser. No server, no API key, no account —
        and once it has downloaded, no network either.
      </p>

      <section className="unsupported__reason">
        <h2>This browser cannot run it</h2>
        <p>{capability.reason}</p>
      </section>

      <section>
        <h2>Where it does run</h2>
        <ul>
          <li>Chrome or Edge 113 and newer, on Windows, macOS, Linux or ChromeOS</li>
          <li>Chromium-based browsers on Android 12 and newer</li>
          <li>
            Safari and Firefox are shipping WebGPU on their own schedule; this page will start
            working on its own when they do
          </li>
        </ul>
      </section>

      <section>
        <h2>See it working instead</h2>
        <p>
          Thirty seconds: the app loads, the network is switched off, and it keeps answering. The
          Wi-Fi indicator is visible throughout.
        </p>
        <video
          className="unsupported__demo"
          controls
          preload="none"
          poster="/planemode/demo-poster.png"
          src="/planemode/airplane-test.mp4"
        >
          Your browser cannot play the recording.
        </video>
      </section>

      <p className="unsupported__footnote">
        Nothing on this page has been sent anywhere. PlaneMode has no backend, no analytics and no
        sign-in.
      </p>
    </main>
  )
}
