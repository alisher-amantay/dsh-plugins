import { globSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const repositoryRoot = dirname(fileURLToPath(import.meta.url))
const harnessRoot = resolve(repositoryRoot, '../deepseek-harness')
const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m
const require = createRequire(import.meta.url)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const sourceAliases = [
  { find: /^@testing-library\/react$/u, replacement: require.resolve('@testing-library/react') },
  { find: /^@testing-library\/dom$/u, replacement: require.resolve('@testing-library/dom') },
  {
    find: /^use-sync-external-store\/shim\/with-selector$/u,
    replacement: require.resolve('use-sync-external-store/shim/with-selector'),
  },
  { find: /^use-sync-external-store$/u, replacement: require.resolve('use-sync-external-store') },
  { find: /^react\/jsx-runtime$/u, replacement: require.resolve('react/jsx-runtime') },
  { find: /^react$/u, replacement: require.resolve('react') },
  { find: /^react-dom\/client$/u, replacement: require.resolve('react-dom/client') },
  { find: /^react-dom$/u, replacement: require.resolve('react-dom') },
  ...globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: harnessRoot })
    .flatMap((manifestPath) => {
      const manifest = JSON.parse(readFileSync(resolve(harnessRoot, manifestPath), 'utf8')) as { name?: unknown }
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) return []
      const source = resolve(harnessRoot, dirname(manifestPath), 'src')
      const name = escapeRegExp(manifest.name)
      return [
        { find: new RegExp(`^${name}/src(?:/(.*))?$`), replacement: `${source}/$1` },
        { find: new RegExp(`^${name}(?:/(.*))?$`), replacement: `${source}/$1` },
      ]
    }),
]

function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          jsx: file.endsWith('x') ? ts.JsxEmit.ReactJSX : undefined,
          sourceMap: true,
        },
      })
      return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
    },
  }
}

export default defineConfig({
  resolve: {
    alias: sourceAliases,
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'use-sync-external-store'],
  },
  plugins: [standardDecoratorPlugin()],
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
    execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [],
  },
})
