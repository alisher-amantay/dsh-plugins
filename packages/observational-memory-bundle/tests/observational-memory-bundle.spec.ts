import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import ObservationalMemoryAgentPresets from '../src/index.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const shippedPresetRoot = resolve(
  dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent-presets/package.json'))),
  'presets',
)

function read(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), 'utf8')
}

function readShipped(relativePath: string): string {
  return readFileSync(resolve(shippedPresetRoot, relativePath), 'utf8')
}

function withoutCompaction(composition: string): string {
  const start = composition.indexOf('# ── compaction')
  const end = composition.indexOf('# ── delegation', start)
  if (start < 0 || end < 0) throw new Error('expected bounded compaction section')
  return composition.slice(0, start) + composition.slice(end)
}

describe('observational-memory distribution bundle', () => {
  it('snapshots every preset in the compatible shipped roster', () => {
    const directoryIds = (root: string): string[] => readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    expect(directoryIds(resolve(packageRoot, 'presets'))).toEqual(directoryIds(shippedPresetRoot))
  })

  it.each(['standard', 'ptc', 'cordis'])('replaces Basic Compaction in %s mode', (preset) => {
    const composition = read(`presets/${preset}/agent.cordis.yml`)
    expect(composition).toContain("name: '@alisheramantay/dsh-observational-memory'")
    expect(composition).not.toContain("name: '@deepseek-ai/dsh-compaction-basic'")
    expect(composition).toContain('compaction: true')
    expect(composition).toContain('toolResultPruner: true')
  })

  it('changes no non-compaction content in full modes', () => {
    for (const preset of ['standard', 'ptc', 'cordis']) {
      expect(withoutCompaction(read(`presets/${preset}/agent.cordis.yml`)))
        .toBe(withoutCompaction(readShipped(`${preset}/agent.cordis.yml`)))
      expect(read(`presets/${preset}/preset.yml`)).toBe(readShipped(`${preset}/preset.yml`))
    }
  })

  it('keeps Minimal byte-identical to the shipped preset', () => {
    expect(read('presets/minimal/agent.cordis.yml')).toBe(readShipped('minimal/agent.cordis.yml'))
    expect(read('presets/minimal/preset.yml')).toBe(readShipped('minimal/preset.yml'))
  })

  it('ships the stock Cordis authoring skills unchanged', () => {
    for (const skill of ['cordis-plugin-development', 'editing-cordis-compositions']) {
      const relative = `cordis/skills/${skill}/SKILL.md`
      expect(read(`presets/${relative}`)).toBe(readShipped(relative))
    }
  })

  it('depends on no unrelated custom plugin', () => {
    const manifest = JSON.parse(read('package.json')) as { dependencies: Record<string, string> }
    const customDependencies = Object.keys(manifest.dependencies).filter(name => name.startsWith('@alisheramantay/'))
    expect(customDependencies).toEqual(['@alisheramantay/dsh-observational-memory'])
  })

  it('publishes the four built-in preset ids', async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(resolve(packageRoot, 'package.json')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ObservationalMemoryAgentPresets, {
      default: 'standard',
      roots: [],
      includeShippedRoot: true,
      includeUserRoot: false,
    })

    try {
      const presets = await ctx.agentPresets.list()
      expect(presets.map(preset => preset.id).sort()).toEqual(['cordis', 'minimal', 'ptc', 'standard'])
      expect(presets.every(preset => preset.trust === 'system')).toBe(true)
      expect(presets.every(preset => preset.path.startsWith(resolve(packageRoot, 'presets')))).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replaces only the stock preset-roster row', () => {
    const patches = parse(read('cordis.patch.yml'))
    const base = [
      { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets' },
      { id: 'goal-round-driver', name: '@deepseek-ai/dsh-goal-round-driver' },
      { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
    ]
    const warnings: string[] = []
    const result = applyEntryPatches(base, patches, message => warnings.push(message))

    expect(warnings).toEqual([])
    expect(result.find(entry => entry.id === 'agent-presets')?.disabled).toBe(true)
    expect(result.find(entry => entry.id === 'agent-presets-observational-memory')?.name)
      .toBe('@alisheramantay/dsh-observational-memory-bundle')
    expect(result.find(entry => entry.id === 'goal-round-driver')?.disabled).not.toBe(true)
    expect(result.find(entry => entry.id === 'ui-chat')?.disabled).not.toBe(true)
  })
})
