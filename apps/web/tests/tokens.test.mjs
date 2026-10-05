import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { test } from 'node:test'

const WEB = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1')
const TOKENS_REL = join('styles', 'tokens.css')
const TOKENS = join(WEB, TOKENS_REL)
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      out.push(...walk(full))
    } else {
      out.push(full)
    }
  }
  return out
}

test('tokens.css defines both themes', () => {
  const css = readFileSync(TOKENS, 'utf8')
  assert.match(css, /:root\s*{/)
  // Quote-agnostic: prettier normalises attribute-selector quotes, so pinning either style
  // makes this test fail on formatting alone.
  assert.match(css, /\[data-theme=['"]dark['"]\]/)
})

test('tokens.css is the only file containing raw colour literals', () => {
  const offenders = []
  for (const file of walk(WEB)) {
    if (!['.css', '.tsx', '.ts'].includes(extname(file))) continue
    if (relative(WEB, file) === TOKENS_REL) continue
    if (RAW_COLOUR.test(readFileSync(file, 'utf8'))) offenders.push(relative(WEB, file).split(sep).join('/'))
  }
  assert.deepEqual(offenders, [], `raw colour literals outside tokens.css: ${offenders.join(', ')}`)
})

test('dark mode is a partial override, not a second palette', () => {
  // Every custom property the dark block redefines must also exist in :root. A token that
  // only exists in dark mode is invisible to the light theme's cascade and silently unset.
  const css = readFileSync(TOKENS, 'utf8')
  const root = css.slice(css.indexOf(':root'), css.indexOf('[data-theme'))
  const dark = css.slice(css.indexOf('[data-theme'))
  const defined = new Set([...root.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]))
  const overridden = [...dark.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1])
  assert.ok(overridden.length > 10, 'the dark theme should override more than a handful of tokens')
  for (const token of overridden) {
    assert.ok(defined.has(token), `dark theme overrides --${token}, which :root never defines`)
  }
})

test('every interactive element has a focus ring', () => {
  const css = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8')
  assert.match(css, /:focus-visible\s*{[^}]*outline:/)
  // The skip link is the first thing a keyboard user reaches; it must become visible.
  assert.match(css, /\.skip-link:focus-visible/)
})

test('motion is collapsed for reduced-motion readers', () => {
  const tokens = readFileSync(TOKENS, 'utf8')
  const css = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8')
  assert.match(tokens, /prefers-reduced-motion/)
  assert.match(css, /prefers-reduced-motion/)
})

test('the pages do not fetch inside components', () => {
  // The data layer is the only place allowed to reach the engine. A stray fetch in a
  // component is how a data-access rule quietly stops being true.
  const offenders = []
  for (const file of walk(join(WEB, 'components'))) {
    if (extname(file) !== '.tsx') continue
    const source = readFileSync(file, 'utf8')
    if (/[^.\w]fetch\(/.test(source)) offenders.push(relative(WEB, file).split(sep).join('/'))
  }
  assert.deepEqual(offenders, [], `components must go through lib/data.ts: ${offenders.join(', ')}`)
})

test('every page has an h1', () => {
  const pages = join(WEB, 'app')
  const offenders = []
  for (const file of walk(pages)) {
    if (extname(file) !== '.tsx') continue
    const rel = relative(pages, file).split(sep).join('/')
    if (!rel.endsWith('page.tsx')) continue
    if (!/<h1[ >]/.test(readFileSync(file, 'utf8'))) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], `pages without an h1: ${offenders.join(', ')}`)
})

test('the generated samples module is present and committed', () => {
  // The web app cannot read the filesystem at runtime, so this module is the only way it gets
  // recordings. If it is missing, the landing page has no product data to render.
  const generated = readFileSync(join(WEB, 'lib', 'generated-samples.ts'), 'utf8')
  assert.match(generated, /GENERATED FILE/)
  assert.match(generated, /SAMPLE_TRACES/)
  assert.match(generated, /before:/)
  assert.match(generated, /after:/)
})
