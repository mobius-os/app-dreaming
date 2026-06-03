import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const buildDir = join(root, '.build')
const bundled = join(buildDir, 'index.mjs')

async function bundle() {
  await rm(buildDir, { recursive: true, force: true })
  await mkdir(buildDir, { recursive: true })
  await execFileAsync('/home/hmzmrzx/projects/mobius/frontend/node_modules/.bin/esbuild', [
    join(root, '..', 'index.jsx'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--jsx=automatic',
    `--outfile=${bundled}`,
  ])
  return import(pathToFileURL(bundled))
}

test('hardenReportHtml injects a restrictive CSP into full reports', async () => {
  const { hardenReportHtml } = await bundle()

  const html = '<!doctype html><html><head><title>Brief</title></head><body><h1>Morning</h1></body></html>'
  const hardened = hardenReportHtml(html)

  assert.match(hardened, /Content-Security-Policy/)
  assert.match(hardened, /default-src 'none'/)
  assert.match(hardened, /style-src 'unsafe-inline'/)
  assert.match(hardened, /img-src data: blob:/)
  assert.equal((hardened.match(/Content-Security-Policy/g) || []).length, 1)
  assert.ok(hardened.indexOf('Content-Security-Policy') < hardened.indexOf('<title>Brief</title>'))
})

test('hardenReportHtml wraps fragments in a complete document', async () => {
  const { hardenReportHtml } = await bundle()

  const hardened = hardenReportHtml('<main>hello</main>')

  assert.match(hardened, /^<!doctype html>/i)
  assert.match(hardened, /<body><main>hello<\/main><\/body>/)
})
