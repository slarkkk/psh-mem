// Build the installable Desktop bundle: desktop-bundle/lib/*.js.
//
// DSH Desktop is a packaged runtime (Electron Node + resources/app.asar/dsh), so
// the source-loading arrangement the Web profile uses — entries pointing at
// `src/index.ts` plus tsconfig `paths` back to the host checkout — does not apply
// there. Desktop only accepts an installed package that declares `dsh.bundle`, so
// this script compiles the four host plugins into self-contained ESM files and
// copies the browser half, leaving bare host imports external: Desktop's profile
// resolution maps them onto the runtime's own copies, which is what keeps a
// single cordis Service identity.
//
//   node build-desktop-bundle.mjs [hostRoot]
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const host = resolve(process.argv[2] ?? 'G:/work/tool')
const outDir = join(here, 'desktop-bundle', 'lib')

/** Host packages that must stay live imports, resolved by Desktop's runtime profile resolution. */
const EXTERNAL = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-util-values',
  'zod',
]

/** This repository's packages, inlined so the bundle needs no sibling installs. */
const alias = {
  '@deepseek-ai/dsh-memory': join(here, 'memory/src/index.ts'),
  '@deepseek-ai/dsh-memory-curated': join(here, 'memory-curated/src/index.ts'),
  '@deepseek-ai/dsh-memory-recall': join(here, 'memory-recall/src/index.ts'),
  '@deepseek-ai/dsh-tool-memory': join(here, 'tool-memory/src/index.ts'),
}

/** The four host plugins, keyed by their output file name. */
const entryPoints = {
  memory: join(here, 'memory/src/index.ts'),
  'memory-curated': join(here, 'memory-curated/src/index.ts'),
  'tool-memory': join(here, 'tool-memory/src/index.ts'),
  'memory-api': join(here, 'memory-api/src/index.ts'),
  lessons: join(here, 'lessons/src/index.ts'),
}

// pnpm 不把 esbuild 提升到根 node_modules：先按包解析，再从 .pnpm 存储里找。
function esbuildPath() {
  const direct = join(host, 'node_modules', 'esbuild', 'lib', 'main.js')
  if (existsSync(direct)) return direct
  const store = join(host, 'node_modules', '.pnpm')
  if (!existsSync(store)) return undefined
  const candidates = readdirSync(store)
    .filter(name => name.startsWith('esbuild@'))
    .sort()
    .reverse()
  for (const name of candidates) {
    const candidate = join(store, name, 'node_modules', 'esbuild', 'lib', 'main.js')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const resolvedEsbuild = esbuildPath()
if (resolvedEsbuild === undefined) throw new Error(`找不到 esbuild（宿主：${host}）`)
const esbuildModule = await import(pathToFileURL(resolvedEsbuild).href)
const esbuild = esbuildModule.build === undefined ? esbuildModule.default : esbuildModule

mkdirSync(outDir, { recursive: true })
await esbuild.build({
  entryPoints,
  outdir: outDir,
  outExtension: { '.js': '.js' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  alias,
  external: EXTERNAL,
  logLevel: 'warning',
})

// The browser half is a prebuilt bundle kept in ui-memory/lib: its module id is
// the package name, and client-modules serves it because package.json declares
// dsh.client + exports["./client"].
for (const file of ['index.js', 'client.js', 'client.js.map']) {
  copyFileSync(join(here, 'ui-memory/lib', file), join(outDir, file))
}

const built = readdirSync(outDir).map(file => `${file} (${statSync(join(outDir, file)).size}B)`)
console.log(`desktop-bundle/lib: ${built.join(', ')}`)
