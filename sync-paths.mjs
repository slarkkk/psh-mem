// Regenerate this plugin's tsconfig from the host checkout's aliases.
//
// The host launches from TypeScript source and resolves @deepseek-ai/* through
// tsconfig `paths`. A plugin living outside the host tree gets none of that, so
// it needs its own copy of those aliases pointing at the SAME source files —
// same real path means the same module instance, which is what keeps one
// cordis Service identity across host and plugin.
//
// Run after the host checkout moves or its aliases change:
//   node sync-paths.mjs [hostRoot]
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const hostRoot = resolve(process.argv[2] ?? 'G:/work/tool')

/** Strip `//` line comments from JSONC without touching string contents. */
function stripLineComments(text) {
  return text
    .split('\n')
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n')
}

const hostConfig = JSON.parse(stripLineComments(readFileSync(join(hostRoot, 'tsconfig.base.json'), 'utf8')))
const paths = {}
for (const [name, targets] of Object.entries(hostConfig.compilerOptions.paths)) {
  paths[name] = targets.map(target => (target.startsWith('./') ? `${hostRoot}/${target.slice(2)}` : target))
}

// This plugin's own packages resolve to itself, not to the host.
for (const [name, dir] of [
  ['@deepseek-ai/dsh-memory', 'memory'],
  ['@deepseek-ai/dsh-memory-curated', 'memory-curated'],
  ['@deepseek-ai/dsh-memory-recall', 'memory-recall'],
  ['@deepseek-ai/dsh-tool-memory', 'tool-memory'],
]) {
  paths[name] = [`${here.replaceAll('\\', '/')}/${dir}/src`]
}

writeFileSync(
  join(here, 'tsconfig.json'),
  `${JSON.stringify({ compilerOptions: { paths } }, null, 2)}\n`,
)
console.log(`sync-paths: wrote ${Object.keys(paths).length} aliases against ${hostRoot}`)
