// Vitest entry for this package's specs.
//
// The package lives outside the host checkout, so the checkout's own vitest
// config never collects these files (its `include` patterns are relative to
// G:/work/tool). This config points vitest at the package instead and takes its
// `@deepseek-ai/*` resolution from ../tsconfig.json, the alias map sync-paths.mjs
// generates against the host checkout — the same map the running plugin uses, so
// a spec resolves the exact module instances the host runs.
//
// Two workarounds exist because this tree is not a workspace:
//   - Alias resolution is spelled out here instead of Vite's `tsconfigPaths`,
//     which resolves a tsconfig per imported file and cannot load the sibling
//     packages' copies (they extend a path outside this tree).
//   - The transformer ignores tsconfig files for the same reason.
//
//   cd G:/work/tool
//   pnpm exec vitest run --config G:/work/dsh-mem/memory-api/vitest.config.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** This config's directory, the package root vitest scans for specs. */
const root = fileURLToPath(new URL('.', import.meta.url))

const { paths } = JSON.parse(
  readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8'),
).compilerOptions

/** Longest specifier first, so a prefix alias never shadows a longer one. */
const alias = Object.keys(paths)
  .sort((left, right) => right.length - left.length)
  .map(find => ({ find, replacement: paths[find][0] }))

export default {
  root,
  oxc: { tsconfig: false },
  resolve: { alias, tsconfigPaths: false },
  // Specs and their sources live outside the host checkout; that checkout
  // supplies their bare dependencies.
  server: { fs: { strict: false } },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
}
