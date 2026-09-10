import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import ObservationalCompactionEngine from '../src/index.ts'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const contexts = new Set<Context>()

class Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'text',
        text: '{"observations":[{"content":"Loader composition preserved the session fact.","relevance":"high","sourceSeqs":[1]}]}',
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await Promise.all([...contexts].map(ctx => ctx.fiber.dispose()))
  contexts.clear()
})

describe('observational compaction Loader composition', () => {
  it('loads the service provider and records observations from committed turns', async () => {
    const ctx = await boot(
      'observational-compaction-test',
      resolve(import.meta.dirname, 'fixtures/base.cordis.yml'),
      [],
      (host) => {
        contexts.add(host)
        host.loader.builtins['session'] = SessionStore
        host.loader.builtins['projection'] = SessionProjectionRegistry
        host.loader.builtins['agent'] = AgentRegistry
        host.loader.builtins['llm'] = LlmRuntime
        host.loader.builtins['token-meter'] = TokenMeter
        host.loader.builtins['commands'] = CommandRegistry
        host.loader.builtins['system-prompt'] = SystemPrompt
        host.loader.builtins['tools'] = ToolRuntime
        host.loader.builtins['observational'] = ObservationalCompactionEngine
      },
    )
    const adapter = new Adapter()
    ctx.llm.registerAdapter(['test'], adapter)
    const session = ctx.sessions.create(SessionId('loader-observational'), { meta: { cwd: process.cwd() } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Preserve this fact.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'Fact preserved.' }],
        source: { provider: 'test', model: 'chat' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (let attempt = 0; attempt < 20 && adapter.requests.length === 0; attempt += 1) {
      await new Promise(resolveWait => setTimeout(resolveWait, 5))
    }
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.compaction).toBeInstanceOf(ObservationalCompactionEngine)
    expect(ctx.sessionProjections.stateOf(session, 'observationalMemory')?.observations).toHaveLength(1)
  })
})
