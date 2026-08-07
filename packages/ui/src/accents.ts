/**
 * One hue per app.
 *
 * abdash.net gives each tab its own colour and tweens between them as you move
 * across the nav; the labs extend that idea rather than inventing a new one.
 * The chrome is identical everywhere — same glass, same near-black, same type —
 * so the hue is the only thing carrying "which app am I in", and it has to do
 * that job at a glance from a browser tab strip.
 *
 * Recto takes 139/92/246 deliberately: that is the exact purple the portfolio
 * already assigns to its AI tab. Arriving in Recto from that tab is the most
 * likely path a reviewer takes, and the colour not changing is the point.
 *
 * Chosen for separation in hue, not just in name — amber and rose sit far
 * enough apart that Critiq and GraphRead are never mistaken for each other in
 * peripheral vision, which two neighbouring blues would not manage.
 */
export type AppName = 'recto' | 'asksheet' | 'critiq' | 'raglab' | 'graphread' | 'planemode'

export const ACCENTS: Record<AppName, [number, number, number]> = {
  recto: [139, 92, 246],
  asksheet: [46, 196, 182],
  critiq: [240, 169, 59],
  raglab: [78, 168, 245],
  graphread: [228, 86, 154],
  planemode: [95, 208, 138],
}

/** The portfolio's own teal, for the landing page before any app is chosen. */
export const HOUSE: [number, number, number] = [46, 196, 182]

/** Writes the triple the whole token system derives from. */
export function applyAccent(rgb: [number, number, number], el: HTMLElement = document.documentElement): void {
  el.style.setProperty('--accent-r', String(rgb[0]))
  el.style.setProperty('--accent-g', String(rgb[1]))
  el.style.setProperty('--accent-b', String(rgb[2]))
}
