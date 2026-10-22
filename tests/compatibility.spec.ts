/**
 * Repository-wide compatibility with the sibling Harness checkout.
 *
 * The workspace consumes unreleased Harness APIs through `link:` overrides, so
 * nothing here can rely on a registry resolving a range: every dependency must
 * name a package the checkout ships, and every pin must name the version the
 * checkout carries. A Harness bump therefore fails here until the manifests are
 * updated with it, which is the point.
 */
import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { harnessRoot, parsePatch } from '../build/preset-overrides.ts'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Fields whose Harness dependencies this repository must resolve and pin. */
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies'] as const

type DependencyField = typeof DEPENDENCY_FIELDS[number]

/** Fields of a workspace package manifest this check reads. */
interface Manifest {
  readonly name: string
  readonly version?: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly dsh?: {
    readonly bundle?: { readonly patch?: string | readonly string[] }
    readonly client?: { readonly inject?: readonly string[] }
  }
}

/** One resolved Harness package. */
interface HarnessPackage {
  /** Version the checkout carries. */
  readonly version: string
  /** Manifest path relative to the Harness checkout. */
  readonly path: string
}

/** One workspace package of this repository. */
interface WorkspacePackage {
  /** Package directory relative to the repository root. */
  readonly dir: string
  /** Parsed manifest. */
  readonly manifest: Manifest
}

/**
 * Read and parse a JSON manifest.
 * @param path - absolute manifest path.
 * @returns parsed manifest.
 */
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * Index the packages the Harness checkout ships.
 * @returns map of package name to version and manifest path.
 */
function harnessPackages(): Map<string, HarnessPackage> {
  const packages = new Map<string, HarnessPackage>()
  for (const file of globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: harnessRoot })) {
    const manifest = readJson<Manifest>(resolve(harnessRoot, file))
    packages.set(manifest.name, { version: manifest.version ?? '0.0.0', path: file })
  }
  return packages
}

/**
 * Index the workspace packages of this repository.
 * @returns map of package name to its directory and manifest.
 */
function workspacePackages(): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>()
  for (const file of globSync('packages/*/package.json', { cwd: repositoryRoot })) {
    const manifest = readJson<Manifest>(resolve(repositoryRoot, file))
    packages.set(manifest.name, { dir: dirname(file), manifest })
  }
  return packages
}

/** Parsed version with a prerelease tail. */
interface ParsedVersion {
  readonly numbers: readonly number[]
  readonly prerelease: readonly string[]
}

/**
 * Split a semver string into numeric and prerelease parts.
 * @param version - semver string, optionally with a prerelease tail.
 * @returns parsed version.
 */
function parseVersion(version: string): ParsedVersion {
  const [release = '', prerelease = undefined] = version.split('-', 2)
  return {
    numbers: release.split('.').map(part => Number(part)),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/**
 * Order two semver strings, treating a prerelease as lower than its release.
 * @param left - left version.
 * @param right - right version.
 * @returns negative when left is lower, zero when equal, positive when higher.
 */
function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumber = Number(left)
    const rightNumber = Number(right)
    const numeric = !Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)
    if (numeric && leftNumber !== rightNumber) return leftNumber - rightNumber
    if (!numeric && left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * Compute the exclusive upper bound of a tilde range.
 * @param version - range operand.
 * @returns the version that range excludes.
 */
function tildeUpperBound(version: string): string {
  const [major = 0, minor = 0] = parseVersion(version).numbers
  return `${major}.${minor + 1}.0`
}

/**
 * Compute the exclusive upper bound of a caret range.
 * @param version - range operand.
 * @returns the version that range excludes.
 */
function caretUpperBound(version: string): string {
  const [major = 0, minor = 0] = parseVersion(version).numbers
  return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`
}

/**
 * Decide whether a range admits a version using the operators this repository declares.
 * @param range - declared range.
 * @param version - version to test.
 * @returns whether the range admits the version.
 */
function admits(range: string, version: string): boolean {
  return range.split(/\s+/u).filter(Boolean).every((part) => {
    const match = /^(>=|<=|>|<|~|\^|=)?(.+)$/u.exec(part)
    if (match === null) throw new Error(`unparseable range component: ${part}`)
    const operator = match[1] ?? '='
    const operand = match[2]!
    switch (operator) {
      case '>=': return compareVersions(version, operand) >= 0
      case '>': return compareVersions(version, operand) > 0
      case '<=': return compareVersions(version, operand) <= 0
      case '<': return compareVersions(version, operand) < 0
      case '~': return compareVersions(version, operand) >= 0 && compareVersions(version, tildeUpperBound(operand)) < 0
      case '^': return compareVersions(version, operand) >= 0 && compareVersions(version, caretUpperBound(operand)) < 0
      default: return compareVersions(version, operand) === 0
    }
  })
}

/**
 * Extract the package name of a manifest specifier, dropping any subpath.
 * @param specifier - dependency or plugin name.
 * @returns the package name.
 */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}


/**
 * Normalize the declared bundle patches, which a manifest may declare as a
 * single path or a list.
 * @param manifest - workspace package manifest.
 * @returns declared patch paths, empty when the package ships no bundle.
 */
function bundlePatches(manifest: Manifest): readonly string[] {
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) return []
  return typeof patch === 'string' ? [patch] : patch
}

const harness = harnessPackages()
const workspace = workspacePackages()

describe('Harness dependency compatibility', () => {
  it('resolves every declared Harness dependency from the sibling checkout', () => {
    const missing: string[] = []
    for (const { dir, manifest } of workspace.values()) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          if (name.startsWith('@deepseek-ai/') && !harness.has(name)) missing.push(`${dir}: ${field}.${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('pins every Harness dependency to the version the checkout carries', () => {
    const drifted: string[] = []
    for (const { dir, manifest } of workspace.values()) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, range] of Object.entries(manifest[field] ?? {})) {
          if (!name.startsWith('@deepseek-ai/')) continue
          const version = harness.get(name)!.version
          if (!admits(range, version)) drifted.push(`${dir}: ${field}.${name} = ${range} does not admit ${version}`)
          const [lowerBound = ''] = range.split(/\s+/u)
          if (lowerBound.replace(/^(?:>=|~|\^)/u, '') !== version) {
            drifted.push(`${dir}: ${field}.${name} = ${range} does not name the checkout version ${version}`)
          }
        }
      }
    }
    expect(drifted).toEqual([])
  })

  it('keeps declared browser halves and bundle patches inside the package that declares them', () => {
    const broken: string[] = []
    for (const { dir, manifest } of workspace.values()) {
      for (const file of bundlePatches(manifest)) {
        if (!globSync(file, { cwd: resolve(repositoryRoot, dir) }).length) broken.push(`${dir}: missing bundle patch ${file}`)
      }
      for (const specifier of manifest.dsh?.client?.inject ?? []) {
        if (!harness.has(packageNameOf(specifier))) broken.push(`${dir}: client inject ${specifier} is not a Harness package`)
        if (!globSync(`node_modules/${packageNameOf(specifier)}/package.json`, { cwd: resolve(repositoryRoot, dir) }).length) {
          broken.push(`${dir}: client inject ${specifier} is not installed beside the package`)
        }
      }
    }
    expect(broken).toEqual([])
  })
})

/**
 * Collect package specifiers a patch names, ignoring display names.
 * @param value - parsed patch fragment.
 * @param found - accumulator.
 * @returns the scoped package names the fragment references.
 */
function packageSpecifiers(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) packageSpecifiers(item, found)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'name' && typeof item === 'string' && /^@(?:deepseek-ai|alisher)/u.test(item)) found.add(item)
      else packageSpecifiers(item, found)
    }
  }
  return found
}

describe('bundled preset rosters', () => {
  it('names only packages the workspace or the Harness checkout provides', () => {
    const unresolved: string[] = []
    for (const { dir, manifest } of workspace.values()) {
      for (const patch of bundlePatches(manifest)) {
        const specifiers = packageSpecifiers(parsePatch(readFileSync(resolve(repositoryRoot, dir, patch), 'utf8')))
        for (const specifier of specifiers) {
          const packageName = packageNameOf(specifier)
          if (!harness.has(packageName) && !workspace.has(packageName)) unresolved.push(`${dir}/${patch}: ${specifier}`)
        }
      }
    }
    expect(unresolved).toEqual([])
  })

  it('declares exactly the workspace packages its roster mounts', () => {
    const mismatched: string[] = []
    for (const { dir, manifest } of workspace.values()) {
      const patches = bundlePatches(manifest)
      if (patches.length === 0) continue
      const mounted = new Set<string>()
      for (const patch of patches) {
        for (const specifier of packageSpecifiers(parsePatch(readFileSync(resolve(repositoryRoot, dir, patch), 'utf8')))) {
          const packageName = packageNameOf(specifier)
          if (workspace.has(packageName)) mounted.add(packageName)
        }
      }
      const declared = new Set(Object.keys(manifest.dependencies ?? {}).filter(name => !name.startsWith('@deepseek-ai/')))
      const undeclared = [...mounted].filter(name => name !== manifest.name && !declared.has(name))
      const unused = [...declared].filter(name => !mounted.has(name))
      if (undeclared.length > 0) mismatched.push(`${dir}: mounts undeclared ${undeclared.join(', ')}`)
      if (unused.length > 0) mismatched.push(`${dir}: declares unmounted ${unused.join(', ')}`)
    }
    expect(mismatched).toEqual([])
  })
})
