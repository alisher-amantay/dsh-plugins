import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'

const PRESET_ROOT = fileURLToPath(new URL('../presets', import.meta.url))

/** Preset roster that replaces stock compaction with observational memory. */
export default class ObservationalMemoryAgentPresets extends AgentPresets {
  constructor(ctx: Context, config: Config) {
    super(ctx, {
      ...config,
      includeShippedRoot: false,
      roots: [{ path: PRESET_ROOT, trust: 'system' }, ...config.roots],
    })
  }
}
