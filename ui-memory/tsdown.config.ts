/**
 * Build config for the out-of-tree memory tab plugin.
 *
 * This package lives outside the host checkout, so it cannot use
 * `packages/client/tsdown.client.ts`: that preset locates a package by
 * globbing every package manifest under the checkout root. The artifacts it
 * must produce are the same two, and the browser-side contract is fixed by the
 * shell's module loader:
 *
 * - `lib/index.js` — the node half the loader imports (an empty `apply`).
 * - `lib/client.js` — a CJS closure factory that calls
 *   `window.__ModuleLoader__.load({ id, factory })` and resolves the
 *   shell-seeded module table through the injected `require`. Every other
 *   specifier is inlined, because a `require` the table cannot answer throws.
 *
 * CSS Modules are compiled here (lightningcss) and injected as a style tag
 * tagged with the plugin id; the class map is the module's default export.
 */
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** Package name; stamped into the loader handoff and the injected style tags. */
const ID = '@deepseek-ai/dsh-client-ui-memory'

const ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * The shell-seeded module table (`packages/client/web/src/platform.ts`). These
 * specifiers stay `require` calls; everything else is bundled privately.
 */
const PLATFORM_MODULES: readonly string[] = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Virtual-id prefixes keeping stylesheets out of tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Emit the style injector plus the CSS Modules class map for one stylesheet. */
function styleInjectionModule(fileId: string, css: string, classMap: Record<string, string>): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${ID}/${relative(ROOT, fileId).split(sep).join('/')}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Inline `*.module.css` imports as an injected style tag plus a class map. */
function cssModulesPlugin() {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const absolute = importer === undefined ? source : resolvePath(dirname(importer), source)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const { code, exports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, entry] of Object.entries(exports ?? {})) classMap[local] = entry.name
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }
}

/** The node half the host Loader imports: an empty `apply`, never bundled. */
function nodeHalf(): UserConfig {
  return {
    name: `${ID}/node`,
    // Absolute, because tsdown resolves relative entries against its own
    // working directory (the host checkout) rather than this config's home.
    entry: { index: resolvePath(ROOT, 'src/index.ts') },
    outDir: resolvePath(ROOT, 'lib'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
}

/** The browser half: one CJS closure factory registering into the module table. */
function clientHalf(): UserConfig {
  const isSeeded = (specifier: string): boolean => PLATFORM_MODULES.includes(specifier)
  return {
    name: `${ID}/client`,
    entry: { client: resolvePath(ROOT, 'src/client/index.ts') },
    outDir: resolvePath(ROOT, 'lib'),
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    // `clean` would wipe the node half emitted by the sibling config.
    clean: false,
    deps: {
      neverBundle: (specifier: string) => isSeeded(specifier),
      alwaysBundle: (specifier: string) => !isSeeded(specifier),
    },
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
    plugins: [cssModulesPlugin()],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

export default [nodeHalf(), clientHalf()]
