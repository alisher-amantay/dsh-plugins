import { readFileSync } from 'node:fs'
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

const hostRows: EntryOptions[] = [
  { id: 'goal-round-driver', name: '@deepseek-ai/dsh-goal-round-driver' },
  { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
  { id: 'ui-goal', name: '@deepseek-ai/dsh-client-ui-goal' },
]

function composed(): EntryOptions[] {
  const manifest = JSON.parse(read('package.json')) as { dsh: { bundle: { patch: string[] } } }
  let rows = shippedIds.reduce<EntryOptions[]>((acc, id) => apply(acc, readShippedPreset(id)), hostRows)
  for (const patch of manifest.dsh.bundle.patch) rows = apply(rows, read(patch))
  return rows
}

function preset(rows: EntryOptions[], id: string): { id: string; order: number; plugins: EntryOptions[] } {
  return rows.find(entry => entry.id === `preset-${id}`)!.config as { id: string; order: number; plugins: EntryOptions[] }
}

function flatten(entries: EntryOptions[]): EntryOptions[] {
  return entries.flatMap(entry => entry.group && Array.isArray(entry.config) ? [entry, ...flatten(entry.config)] : [entry])
}

describe('custom distribution composition', () => {
  it('ships declarations regenerated from the current Harness presets', () => {
    for (const [file, yaml] of renderBundlePresets('custom-bundle')) {
      expect(read(`presets/${file}`), `${file} is stale; run node build/preset-overrides.ts`).toBe(yaml)
    }
  })

  it.each(['standard', 'ptc', 'cordis', 'weak-strong-review'])('mounts observational memory and extended goals in %s', (id) => {
    const names = flatten(preset(composed(), id).plugins).map(entry => entry.name)
    expect(names).toContain('@alisher-amantay/dsh-observational-memory')
    expect(names).toContain('@alisheramantay/dsh-tool-goal-extended')
    expect(names).not.toContain('@deepseek-ai/dsh-compaction-basic')
    expect(names).not.toContain('@deepseek-ai/dsh-tool-goal')
  })

  it('keeps minimal mode free of bundle plugins', () => {
    const names = flatten(preset(composed(), 'minimal').plugins).map(entry => entry.name)
    expect(names.filter(name => name?.startsWith('@alisher'))).toEqual([])
  })

  it('pins the weak/strong delegation pair in weak-strong-review mode', () => {
    const review = preset(composed(), 'weak-strong-review')
    expect(review.order).toBe(5)
    const entries = flatten(review.plugins)
    const delegate = (toolName: string) => entries.find(entry => (entry.config as { toolName?: string } | undefined)?.toolName === toolName)
    expect(delegate('implement')?.config).toMatchObject({ agentOptions: { provider: 'fireworks', reasoningEffort: 'xhigh' } })
    expect(delegate('review')?.config).toMatchObject({ agentOptions: { provider: 'openai', reasoningEffort: 'high' } })
    expect(entries.find(entry => entry.id === 'persona')?.config).toMatchObject({ prefix: expect.stringContaining('review-orchestrator') })
  })

  it('keeps the shipped preset ids beside the bundle preset', () => {
    expect(composed().filter(entry => entry.id?.startsWith('preset-')).map(entry => preset(composed(), entry.id!.slice('preset-'.length)).id))
      .toEqual(['standard', 'ptc', 'minimal', 'cordis', 'weak-strong-review'])
  })

  it('disables stock global rows before inserting replacements', () => {
    const rows = composed()
    expect(rows.filter(entry => entry.disabled).map(entry => entry.id)).toEqual(['goal-round-driver', 'ui-chat', 'ui-goal'])
    expect(rows.find(entry => entry.id === 'goal-round-driver-delayed')?.config).toEqual({ continuationDelayMs: 15000 })
    expect(rows.map(entry => entry.name)).toEqual(expect.arrayContaining([
      '@alisheramantay/dsh-goal-round-driver-delayed',
      '@alisheramantay/dsh-client-chat-extended',
      '@alisheramantay/dsh-client-goal-extended',
      '@alisheramantay/dsh-tool-pdf',
    ]))
  })
})
