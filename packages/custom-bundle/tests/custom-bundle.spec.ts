import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CustomAgentPresets from '../src/index.ts'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function read(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), 'utf8')
}

describe('custom distribution composition', () => {
  it.each(['standard', 'ptc', 'cordis'])('mounts observational memory in %s mode', (preset) => {
    const composition = read(`presets/${preset}/agent.cordis.yml`)
    expect(composition).toContain("name: '@alisher-amantay/dsh-observational-memory'")
    expect(composition).toContain("name: '@alisheramantay/dsh-tool-goal-extended'")
    expect(composition).not.toContain("name: '@deepseek-ai/dsh-compaction-basic'")
  })

  it('keeps minimal mode free of observational memory', () => {
    const composition = read('presets/minimal/agent.cordis.yml')
    expect(composition).not.toContain('@alisheramantay/')
    expect(composition).not.toContain('observational-memory')
  })

  it('publishes the replacement roster as the four built-in mode ids', async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(resolve(packageRoot, 'package.json')).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(CustomAgentPresets, {
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

  it('disables stock global rows before inserting replacements', () => {
    const patches = parse(read('cordis.patch.yml'))
    const base = [
      { id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets' },
      { id: 'goal-round-driver', name: '@deepseek-ai/dsh-goal-round-driver' },
      { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
      { id: 'ui-goal', name: '@deepseek-ai/dsh-client-ui-goal' },
    ]
    const warnings: string[] = []
    const result = applyEntryPatches(base, patches, message => warnings.push(message))

    expect(warnings).toEqual([])
    expect(result.filter(entry => entry.disabled)).toHaveLength(4)
    expect(result.map(entry => entry.name)).toEqual(expect.arrayContaining([
      '@alisheramantay/dsh-custom-bundle',
      '@alisheramantay/dsh-goal-round-driver-delayed',
      '@alisheramantay/dsh-client-chat-extended',
      '@alisheramantay/dsh-client-goal-extended',
      '@alisheramantay/dsh-tool-pdf',
    ]))
  })
})
