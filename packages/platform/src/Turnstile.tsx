import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void }) => string
    }
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

export function TurnstileWidget({ onToken }: { onToken: (token: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const rendered = useRef(false)

  useEffect(() => {
    const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string
    if (!sitekey || rendered.current) return

    const mount = () => {
      if (!ref.current || !window.turnstile || rendered.current) return
      rendered.current = true
      window.turnstile.render(ref.current, { sitekey, callback: onToken })
    }

    if (window.turnstile) return mount()
    const s = document.createElement('script')
    s.src = SCRIPT
    s.async = true
    s.onload = mount
    document.head.appendChild(s)
  }, [onToken])

  return <div ref={ref} />
}
