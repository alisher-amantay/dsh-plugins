import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'

const PRESET_ROOT = fileURLToPath(new URL('../presets', import.meta.url))

/** Agent-preset roster that replaces stock non-minimal presets with custom variants. */
export default class CustomAgentPresets extends AgentPresets {
  constructor(ctx: Context, config: Config) {
    super(ctx, {
      ...config,
      includeShippedRoot: false,
      roots: [{ path: PRESET_ROOT, trust: 'system' }, ...config.roots],
    })
  }
}
