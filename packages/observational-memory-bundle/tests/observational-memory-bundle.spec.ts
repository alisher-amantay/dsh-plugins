import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, type EntryOptions, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'
import { parsePatch, readShippedPreset, renderBundlePresets, type ShippedPresetId } from '../../../build/preset-overrides.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shippedIds: ShippedPresetId[] = ['standard', 'ptc', 'minimal', 'cordis']

function read(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), 'utf8')
}

function apply(rows: EntryOptions[], source: string): EntryOptions[] {
  const warnings: string[] = []
  const result = applyEntryPatches(rows, parsePatch(source) as PatchOptions[], message => warnings.push(message))
  expect(warnings).toEqual([])
  return result
}

function composed(): EntryOptions[] {
  const manifest = JSON.parse(read('package.json')) as { dsh: { bundle: { patch: string[] } } }
  let rows = shippedIds.reduce<EntryOptions[]>((acc, id) => apply(acc, readShippedPreset(id)), [])
  for (const patch of manifest.dsh.bundle.patch) rows = apply(rows, read(patch))
  return rows
}

function plugins(rows: EntryOptions[], presetId: string): EntryOptions[] {
  const row = rows.find(entry => entry.id === `preset-${presetId}`)
  return (row?.config as { plugins: EntryOptions[] }).plugins
}

function flatten(entries: EntryOptions[]): EntryOptions[] {
  return entries.flatMap(entry => entry.group && Array.isArray(entry.config) ? [entry, ...flatten(entry.config)] : [entry])
}

describe('observational-memory distribution bundle', () => {
  it('ships declarations regenerated from the current Harness presets', () => {
    for (const [file, yaml] of renderBundlePresets('observational-memory-bundle')) {
      expect(read(`presets/${file}`), `${file} is stale; run node build/preset-overrides.ts`).toBe(yaml)
    }
  })

  it.each(['standard', 'ptc', 'cordis'])('replaces Basic Compaction in the shared compaction realm of %s', (preset) => {
    const compaction = plugins(composed(), preset).find(entry => entry.id === 'compaction')!
    expect(compaction.isolate).toEqual({ compaction: true, toolResultPruner: true })
    const names = (compaction.config as EntryOptions[]).map(entry => entry.name)
    expect(names).toContain('@alisher-amantay/dsh-observational-memory')
    expect(names).not.toContain('@deepseek-ai/dsh-compaction-basic')
  })

  it('changes nothing outside the compaction entry', () => {
    const rows = composed()
    const stock = shippedIds.reduce<EntryOptions[]>((acc, id) => apply(acc, readShippedPreset(id)), [])
    for (const preset of shippedIds) {
      const strip = (entries: EntryOptions[]) => flatten(entries).filter(entry => !['compaction-basic', 'observational-memory'].includes(entry.id!) && entry.id !== 'compaction')
      expect(strip(plugins(rows, preset))).toEqual(strip(plugins(stock, preset)))
    }
    expect(rows.find(entry => entry.id === 'preset-minimal')).toEqual(stock.find(entry => entry.id === 'preset-minimal'))
  })

  it('overrides only shipped presets that compact', () => {
    expect(existsSync(resolve(packageRoot, 'presets/minimal.patch.yml'))).toBe(false)
    expect(composed().map(entry => entry.id)).toEqual(['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'])
  })

  it('depends on no unrelated custom plugin', () => {
    const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    expect(Object.keys(manifest.dependencies)).toEqual(['@alisher-amantay/dsh-observational-memory'])
  })
})
