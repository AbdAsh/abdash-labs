import { execSync } from 'node:child_process'
import { mkdirSync, cpSync, existsSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { checkRedirects, htmlHandlingFrom } from './check-redirects.mjs'

// Directories starting with `_` are not apps: `_shell` is the origin landing page
// and `_probe-*` are throwaway harnesses. Everything else in apps/ builds.
const APPS = existsSync('apps')
  ? readdirSync('apps', { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .sort()
  : []

// Fail before building rather than after deploying. Cloudflare validates
// _redirects server-side, so without this the feedback costs a full build and
// arrives as a wall of line numbers from the API.
if (existsSync('public/_redirects')) {
  const htmlHandling = existsSync('wrangler.jsonc')
    ? htmlHandlingFrom(readFileSync('wrangler.jsonc', 'utf8'))
    : 'auto-trailing-slash'
  const problems = checkRedirects(readFileSync('public/_redirects', 'utf8'), htmlHandling)
  if (problems.length > 0) {
    console.error(`public/_redirects is invalid under html_handling "${htmlHandling}":`)
    for (const p of problems) console.error(`  line ${p.lineNumber}: ${p.message}\n    ${p.line}`)
    process.exit(1)
  }
  console.log(`_redirects ok (html_handling: ${htmlHandling})`)
}

// Wipe first. cpSync copies over the top without removing anything, so a file
// that stops being emitted — a renamed hashed bundle, a chunk that no longer
// splits — lingers in dist/ and ships. That is not hypothetical: a stale RAG Lab
// bundle once shipped without a component that was already in the source, and
// nothing failed or warned. The only symptom was the missing element itself.
// Clearing each app's own dist/ too, because that is the artifact copied from.
rmSync('dist', { recursive: true, force: true })
mkdirSync('dist', { recursive: true })

for (const app of APPS) {
  console.log(`building ${app}`)
  rmSync(`apps/${app}/dist`, { recursive: true, force: true })
  execSync(`npm run build -w apps/${app}`, { stdio: 'inherit' })
  cpSync(`apps/${app}/dist`, `dist/${app}`, { recursive: true })
}

// Landing page and routing rules sit at the origin root.
if (existsSync('apps/_shell')) cpSync('apps/_shell', 'dist', { recursive: true })
if (existsSync('public')) cpSync('public', 'dist', { recursive: true })
console.log(`built: ${APPS.join(', ') || '(none yet)'}`)
