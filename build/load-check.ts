/**
 * Load every built package entry the way a DSH profile does: through the real
 * node module graph, so `@deepseek-ai/*` resolves to the sibling Harness
 * checkout's built output instead of the test-time source aliases. This is the
 * check that catches a package whose published entry cannot be imported beside
 * the Harness version the manifests pin.
 *
 * Runs as part of `pnpm run check`, after the build.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Fields of a workspace package manifest this check reads. */
interface Manifest {
  readonly name: string
  readonly type?: string
  readonly main?: string
  readonly exports?: Record<string, unknown>
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string | readonly string[] }
    readonly client?: { readonly inject?: readonly string[]; readonly entry?: string }
  }
}

/** Outcome for one package. */
interface Result {
  /** Package directory name. */
  readonly package: string
  /** Loaded entry, when the package ships one. */
  readonly entry?: string
  /** Exported names observed on the entry. */
  readonly exports?: readonly string[]
  /** Bundle patch files, for patch-only bundles. */
  readonly patches?: readonly string[]
}

const failures: string[] = []

/**
 * Assert a condition, recording a failure instead of throwing so one broken
 * package still reports the rest.
 * @param condition - condition to hold.
 * @param message - failure description.
 */
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message)
}

/**
 * Resolve a conditional export target to its path.
 * @param exported - `exports` value to read.
 * @returns the declared path, if any.
 */
function exportTarget(exported: unknown): string | undefined {
  if (typeof exported === 'string') return exported
  if (exported === null || typeof exported !== 'object') return undefined
  const conditions = exported as Record<string, unknown>
  for (const condition of ['default', 'import', 'require']) {
    const target = conditions[condition]
    if (typeof target === 'string') return target
  }
  return undefined
}

/**
 * Resolve the entry file a manifest declares.
 * @param dir - package directory.
 * @param manifest - parsed manifest.
 * @returns absolute entry path, or undefined for a patch-only package.
 */
function entryFile(dir: string, manifest: Manifest): string | undefined {
  const declared = exportTarget(manifest.exports?.['.']) ?? manifest.main
  return declared === undefined ? undefined : resolve(dir, declared)
}

/**
 * Normalize a bundle patch declaration, which a manifest may declare as one
 * path or a list.
 * @param manifest - parsed manifest.
 * @returns declared patch paths.
 */
function declaredPatches(manifest: Manifest): readonly string[] {
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) return []
  return typeof patch === 'string' ? [patch] : patch
}

const results: Result[] = []
for (const name of readdirSync(resolve(repositoryRoot, 'packages')).sort()) {
  const dir = resolve(repositoryRoot, 'packages', name)
  if (!existsSync(join(dir, 'package.json'))) continue
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
  const require = createRequire(join(dir, 'package.json'))
  for (const specifier of manifest.dsh?.client?.inject ?? []) {
    const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
    try {
      require.resolve(`${packageName}/package.json`)
    } catch {
      failures.push(`${manifest.name}: browser inject ${specifier} does not resolve beside the package`)
    }
  }
  const patches = declaredPatches(manifest)
  for (const patch of patches) {
    check(existsSync(resolve(dir, patch)), `${manifest.name}: missing bundle patch ${patch}`)
  }
  const entry = entryFile(dir, manifest)
  if (entry === undefined) {
    results.push({ package: name, patches })
    continue
  }
  check(existsSync(entry), `${manifest.name}: missing entry ${entry}; run pnpm run build`)
  if (!existsSync(entry)) continue
  const loaded = await import(pathToFileURL(entry).href) as Record<string, unknown>
  const exported = Object.keys(loaded).sort()
  check(
    typeof loaded.default === 'function' || typeof loaded.apply === 'function' || typeof loaded.name === 'string',
    `${manifest.name}: entry exports no plugin face (${exported.join(', ') || 'empty'})`,
  )
  const clientFile = exportTarget(manifest.exports?.['./client'])
  if (clientFile !== undefined) {
    check(existsSync(resolve(dir, clientFile)), `${manifest.name}: missing browser bundle ${clientFile}; run pnpm run build`)
  }
  results.push({ package: name, entry: entry.slice(repositoryRoot.length + 1), exports: exported })
}

for (const result of results) {
  const detail = result.entry === undefined
    ? `patch-only bundle (${result.patches?.join(', ') ?? 'none'})`
    : `${result.entry} exports ${result.exports?.join(', ') ?? ''}`
  console.log(`${failures.some(failure => failure.includes(result.package)) ? 'FAIL' : 'ok  '} ${result.package}: ${detail}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} load failure(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`\nloaded ${results.length} packages against the pinned Harness checkout`)
}
