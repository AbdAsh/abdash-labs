import { execSync } from 'node:child_process'
import { mkdirSync, cpSync, existsSync, readdirSync, rmSync } from 'node:fs'

// Directories starting with `_` are not apps: `_shell` is the origin landing page
// and `_probe-*` are throwaway harnesses. Everything else in apps/ builds.
const APPS = existsSync('apps')
  ? readdirSync('apps', { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name)
      .sort()
  : []

mkdirSync('dist', { recursive: true })

for (const app of APPS) {
  console.log(`building ${app}`)
  execSync(`npm run build -w apps/${app}`, { stdio: 'inherit' })
  cpSync(`apps/${app}/dist`, `dist/${app}`, { recursive: true })
}

// Landing page and routing rules sit at the origin root.
if (existsSync('apps/_shell')) cpSync('apps/_shell', 'dist', { recursive: true })
if (existsSync('public')) cpSync('public', 'dist', { recursive: true })
console.log(`built: ${APPS.join(', ') || '(none yet)'}`)
