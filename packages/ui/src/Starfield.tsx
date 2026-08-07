/**
 * The ambient layer from abdash.net, running behind the labs.
 *
 * This is the single strongest continuity cue between the two origins: the same
 * drifting field, the same constellation threads, the same cursor glow, tinted
 * by whichever accent the current app owns. Land on labs.abdash.net from the
 * portfolio and the background does not change — only its colour does.
 *
 * Ported rather than copied. Four things differ from the original, all of them
 * because a component that mounts and unmounts inside an SPA is held to a
 * standard a page-level script is not:
 *
 *   - the shooting-star interval is cleared on unmount (the original leaks one
 *     timer per mount, which in a hot-reloading dev session becomes dozens)
 *   - the canvas is scaled for devicePixelRatio, so it is not soft on retina
 *   - the loop stops entirely when the tab is hidden, rather than burning a
 *     background thread on a field nobody is looking at
 *   - star count scales with viewport area, because the constellation pass is
 *     O(n²) and a fixed 200 is a different proposition on a phone
 *
 * Zero dependencies beyond React, and no import from @labs/platform. PlaneMode
 * renders this too.
 */
import { useEffect, useRef } from 'react'

export interface StarfieldProps {
  /**
   * Accent as an `r, g, b` triple. Omit to track the live value of the
   * --accent-* custom properties, which is what lets the field follow a hover
   * that retints the page.
   */
  rgb?: [number, number, number]
  /** Upper bound on stars. Lowered automatically on small viewports. */
  density?: number
}

interface Star {
  x: number; y: number; s: number; o: number
  ts: number; to: number; vx: number; vy: number
}

interface Shoot {
  x: number; y: number; len: number; spd: number; a: number; life: number
}

/** Pair distance² below which two stars are threaded together. */
const LINK_DISTANCE_SQ = 6000

export function Starfield({ rgb, density = 170 }: StarfieldProps) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let W = 0
    let H = 0
    let dpr = 1
    let stars: Star[] = []

    function resize() {
      if (!canvas || !ctx) return
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // Roughly one star per 9k css px², bounded. A phone gets ~60, a wide
      // desktop the full density — the constellation pass is quadratic, so
      // this is the difference between smooth and a warm laptop.
      const target = Math.round(Math.min(density, Math.max(45, (W * H) / 9000)))
      if (stars.length > target) stars.length = target
      while (stars.length < target) {
        stars.push({
          x: Math.random() * W,
          y: Math.random() * H,
          s: Math.random() * 2.5 + 0.5,
          o: Math.random() * 0.6 + 0.2,
          ts: Math.random() * 0.015 + 0.004,
          to: Math.random() * Math.PI * 2,
          vx: (Math.random() - 0.5) * 0.15,
          vy: (Math.random() - 0.5) * 0.15,
        })
      }
    }
    resize()
    window.addEventListener('resize', resize)

    // Accent tracking. Reading computed style is not free, so it is sampled
    // every twelfth frame rather than every frame; the tween is 800ms, so the
    // lag is invisible.
    let accent: [number, number, number] = rgb ?? [46, 196, 182]
    let sampleTick = 0
    function sampleAccent() {
      if (rgb) { accent = rgb; return }
      const cs = getComputedStyle(document.documentElement)
      const r = parseFloat(cs.getPropertyValue('--accent-r'))
      const g = parseFloat(cs.getPropertyValue('--accent-g'))
      const b = parseFloat(cs.getPropertyValue('--accent-b'))
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) accent = [r, g, b]
    }
    sampleAccent()

    let mx = W / 2
    let my = H / 2
    let smx = mx
    let smy = my
    function onMove(e: MouseEvent) { mx = e.clientX; my = e.clientY }
    document.addEventListener('mousemove', onMove, { passive: true })

    let shoots: Shoot[] = []
    const shootTimer = reduced
      ? undefined
      : window.setInterval(() => {
          if (document.hidden) return
          shoots.push({
            x: Math.random() * W * 0.8,
            y: Math.random() * H * 0.3,
            len: Math.random() * 100 + 40,
            spd: Math.random() * 12 + 6,
            a: Math.PI / 4 + (Math.random() - 0.5) * 0.5,
            life: 1,
          })
        }, 3200)

    let raf = 0

    function frame(t: number) {
      if (!ctx) return
      ctx.clearRect(0, 0, W, H)

      if (sampleTick++ % 12 === 0) sampleAccent()
      const c = `${Math.round(accent[0])},${Math.round(accent[1])},${Math.round(accent[2])}`

      smx += (mx - smx) * 0.05
      smy += (my - smy) * 0.05

      // Two offset vignettes give the field a light source instead of an even
      // scatter, which is what stops it reading as a screensaver.
      const vg1 = ctx.createRadialGradient(W * 0.15, H * 0.3, 0, W * 0.15, H * 0.3, W * 0.6)
      vg1.addColorStop(0, `rgba(${c},0.06)`)
      vg1.addColorStop(0.5, `rgba(${c},0.015)`)
      vg1.addColorStop(1, 'transparent')
      ctx.fillStyle = vg1
      ctx.fillRect(0, 0, W, H)

      const vg2 = ctx.createRadialGradient(W * 0.85, H * 0.75, 0, W * 0.85, H * 0.75, W * 0.5)
      vg2.addColorStop(0, `rgba(${c},0.035)`)
      vg2.addColorStop(0.6, `rgba(${c},0.008)`)
      vg2.addColorStop(1, 'transparent')
      ctx.fillStyle = vg2
      ctx.fillRect(0, 0, W, H)

      if (!reduced) {
        const g = ctx.createRadialGradient(smx, smy, 0, smx, smy, 400)
        g.addColorStop(0, `rgba(${c},0.14)`)
        g.addColorStop(0.3, `rgba(${c},0.06)`)
        g.addColorStop(0.6, `rgba(${c},0.02)`)
        g.addColorStop(1, 'transparent')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, W, H)
      }

      for (const st of stars) {
        if (!reduced) {
          st.x += st.vx
          st.y += st.vy
          if (st.x < -5) st.x = W + 5
          if (st.x > W + 5) st.x = -5
          if (st.y < -5) st.y = H + 5
          if (st.y > H + 5) st.y = -5
        }

        const tw = reduced ? 1 : Math.sin(t * st.ts + st.to) * 0.3 + 0.7
        const dx = st.x - smx
        const dy = st.y - smy
        const boost = reduced ? 0 : Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 400) * 0.6
        const op = Math.min(1, st.o * tw + boost)

        ctx.beginPath()
        ctx.arc(st.x, st.y, st.s * (1 + boost * 0.3), 0, Math.PI * 2)
        // The larger stars stay white so the field keeps depth instead of
        // flattening into a single tinted haze.
        ctx.fillStyle = st.s > 1.4 ? `rgba(255,255,255,${op * 0.85})` : `rgba(${c},${op})`
        ctx.fill()
      }

      // Hoisted out of the inner loop rather than indexed four times per pair:
      // this runs on the order of 10k times a frame, and it also satisfies
      // noUncheckedIndexedAccess without sprinkling non-null assertions.
      for (let i = 0; i < stars.length; i++) {
        const a = stars[i]
        if (!a) continue
        for (let j = i + 1; j < stars.length; j++) {
          const b = stars[j]
          if (!b) continue
          const dx = a.x - b.x
          const dy = a.y - b.y
          const d = dx * dx + dy * dy
          if (d < LINK_DISTANCE_SQ) {
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.strokeStyle = `rgba(${c},${0.08 * (1 - Math.sqrt(d) / 77)})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        }
      }

      shoots = shoots.filter((s) => {
        s.x += Math.cos(s.a) * s.spd
        s.y += Math.sin(s.a) * s.spd
        s.life -= 0.01
        if (s.life <= 0) return false

        const tx = s.x - Math.cos(s.a) * s.len
        const ty = s.y - Math.sin(s.a) * s.len
        const sg = ctx.createLinearGradient(tx, ty, s.x, s.y)
        sg.addColorStop(0, 'transparent')
        sg.addColorStop(1, `rgba(${c},${s.life * 0.8})`)
        ctx.beginPath()
        ctx.moveTo(tx, ty)
        ctx.lineTo(s.x, s.y)
        ctx.strokeStyle = sg
        ctx.lineWidth = 1.8
        ctx.stroke()

        ctx.beginPath()
        ctx.arc(s.x, s.y, 2, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${s.life * 0.6})`
        ctx.fill()
        return true
      })

      raf = requestAnimationFrame(frame)
    }

    // A hidden tab gets no frames at all. rAF already throttles, but browsers
    // differ on how aggressively, and there is nothing to draw either way.
    function onVisibility() {
      cancelAnimationFrame(raf)
      if (!document.hidden) raf = requestAnimationFrame(frame)
    }
    document.addEventListener('visibilitychange', onVisibility)
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      if (shootTimer !== undefined) clearInterval(shootTimer)
      window.removeEventListener('resize', resize)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [rgb, density])

  return <canvas ref={ref} className="labs-starfield" aria-hidden="true" />
}
