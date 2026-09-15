/**
 * Test config for the out-of-tree memory tab plugin.
 *
 * The suites import host Client packages, and those imports must reach the
 * host's SOURCE files rather than a built `lib/` artifact — otherwise the run
 * loads a second copy of a module whose identity is supposed to be shared. The
 * host's own suites get that from its `tsconfig.base.json` `paths` facade, so
 * this config reads that map and expands it into exact Vite aliases (wildcard
 * patterns resolved against the checkout, longest specifier first).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** The host checkout whose sources and tsconfig facade this plugin builds against. */
const HOST = 'G:/work/tool'

/** One Vite alias entry. */
interface Alias {
  readonly find: string
  readonly replacement: string
}

/**
 * Strip `//` line comments from JSONC without touching string contents.
 * @param text - the host tsconfig text.
 * @returns the same text with whole-line comments removed.
 */
function stripLineComments(text: string): string {
  return text.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
}

/**
 * Resolve one `paths` target to the module file Vite should load.
 * @param path - a file, or a directory holding an index module.
 * @returns the absolute module path, or undefined when nothing is on disk.
 */
function moduleEntry(path: string): string | undefined {
  if (existsSync(path) && statSync(path).isFile()) return path
  for (const candidate of [`${path}/index.ts`, `${path}/index.tsx`, `${path}/index.js`]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Expand the host `paths` map into concrete aliases.
 * @returns every resolvable specifier, longest first so a specific subpath
 * wins over the package prefix that also matches it.
 */
function hostAliases(): Alias[] {
  const manifest = JSON.parse(stripLineComments(readFileSync(join(HOST, 'tsconfig.base.json'), 'utf8'))) as {
    compilerOptions: { paths: Record<string, readonly string[]> }
  }
  const aliases: Alias[] = []
  const push = (find: string, target: string): void => {
    const entry = moduleEntry(target)
    if (entry !== undefined) aliases.push({ find, replacement: entry.split('\\').join('/') })
  }
  for (const [pattern, targets] of Object.entries(manifest.compilerOptions.paths)) {
    const target = targets[0]
    if (target === undefined) continue
    // Forward slashes throughout: the wildcard split below is separator-sensitive.
    const absolute = (target.startsWith('./') ? join(HOST, target.slice(2)) : target).split('\\').join('/')
    const wildcard = absolute.indexOf('*')
    if (wildcard < 0) {
      push(pattern, absolute)
      continue
    }
    // One wildcard segment, expanded against the checkout so the alias list
    // stays exact instead of depending on regex substitution.
    const boundary = absolute.lastIndexOf('/', wildcard)
    const directory = absolute.slice(0, boundary)
    const prefix = absolute.slice(boundary + 1, wildcard)
    const tail = absolute.slice(wildcard + 1)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
      push(pattern.replace('*', entry.name), join(directory, entry.name) + tail)
    }
  }
  return aliases.sort((left, right) => right.find.length - left.find.length)
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: hostAliases() },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    // jsdom comes from the per-file `@vitest-environment jsdom` pragma.
    environment: 'node',
  },
})
