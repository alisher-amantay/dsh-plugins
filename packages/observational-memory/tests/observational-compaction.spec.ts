import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter, { estimateContent, estimateMessage } from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ObservationalCompactionEngine from '../src/index.ts'
import type { ObservationalCompactionConfig } from '../src/types.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic'
import { activeObservations } from '../src/projection.ts'
import { reflectDue } from '../src/workers.ts'

const contexts: Context[] = []

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly outputs: string[]
  aborted = false
  constructor(...outputs: string[]) {
    super()
    this.outputs = outputs
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.outputs.shift() ?? '{"observations":[]}'
    if (text === '__HANG__') {
      const signal = options.signal
      if (signal === undefined) throw new Error('hanging test request requires a signal')
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          this.aborted = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('worker aborted'))
        }, { once: true })
      })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class TestObservationalEngine extends ObservationalCompactionEngine {
  summarizeForTest(input: SummarizationInput, agent: Agent): Promise<SummaryResult> {
    return this.summarize(input, agent)
  }
}

const CONFIG: ObservationalCompactionConfig = {
  auto: false,
  summarizationProvider: 'test',
  summarizationModel: 'memory-model',
  memoryProvider: 'test',
  memoryModel: 'memory-model',
  observeAfterTokens: 1,
  reflectAfterTokens: 10000,
  compactAfterTokens: 100000,
  observationsPoolTargetTokens: 1000,
  observerChunkMaxTokens: 1000,
  memoryInputMaxTokens: 2048,
  memoryMaxOutputTokens: 500,
  memoryTimeoutMs: 5000,
  maxViewBytes: 10000,
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mountConfigured(overrides: Partial<typeof CONFIG>, ...outputs: string[]) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  new TokenMeter(ctx)
  new CommandRegistry(ctx)
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx)
  const adapter = new ScriptedAdapter(...outputs)
  ctx.llm.registerAdapter(['test'], adapter)
  const engine = new TestObservationalEngine(ctx, { ...CONFIG, ...overrides })
  return { ctx, adapter, engine }
}

async function mount(...outputs: string[]) {
  return mountConfigured({}, ...outputs)
}

function agentFor(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: process.cwd() } })
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function completedTurn(agent: Agent): Promise<void> {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Use a deterministic session ledger.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Implemented the ledger.' }],
      source: { provider: 'test', model: 'chat' },
    }),
  }, { surfaceOp: 'append' })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('observational compaction', () => {
  it('rejects a reflector input budget below the observation pool target', async () => {
    await expect(mountConfigured({ memoryInputMaxTokens: 2048, observationsPoolTargetTokens: 2049 }))
      .rejects.toThrow(/memoryInputMaxTokens must cover observationsPoolTargetTokens/u)
  })

  it('records source-backed observations after the token threshold', async () => {
    const { ctx, adapter } = await mount('{"observations":[{"content":"The session uses a deterministic ledger.","relevance":"high","sourceSeqs":[1]}]}')
    const agent = agentFor(ctx, 'observer')
    await completedTurn(agent)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.purpose).toBeUndefined()
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(state).toBeDefined()
    expect(activeObservations(state!)).toHaveLength(1)
    expect(state?.observations[0]?.sourceSeqs).toEqual([1])
    expect(agent.session.snapshotEvents().map(event => event.type)).toContain('observational-memory/worker-request')
  })

  it('ignores aborted turns', async () => {
    const { ctx, adapter } = await mount()
    const agent = agentFor(ctx, 'aborted')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(adapter.requests).toHaveLength(0)
  })

  it('records reflections and drops only after a successful reflection pass', async () => {
    const observer = '{"observations":[{"content":"The session uses a deterministic ledger.","relevance":"high","sourceSeqs":[1]}]}'
    const { ctx, adapter } = await mountConfigured({
      observeAfterTokens: 15,
      reflectAfterTokens: 1,
      observationsPoolTargetTokens: 1,
    }, observer)
    const agent = agentFor(ctx, 'reflection')
    await completedTurn(agent)
    const observationId = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')?.observations[0]?.id
    expect(observationId).toBeDefined()
    adapter.outputs.push(
      JSON.stringify({ reflections: [{ content: 'Session memory is ledger-backed.', supportingObservationIds: [observationId] }] }),
      JSON.stringify({ observationIds: [observationId] }),
    )
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(state?.reflections).toHaveLength(1)
    expect(state?.droppedObservationIds).toEqual([observationId])
    expect(activeObservations(state!)).toHaveLength(0)
    const reflectionId = state?.reflections[0]?.id
    const recalled = await ctx.tools.execute({
      callId: ToolCallId('reflection-recall'),
      name: 'observational_memory_recall',
      arguments: { id: reflectionId },
      agent,
      signal: new AbortController().signal,
    })
    expect(recalled.isError).toBe(false)
    if (recalled.isError || typeof recalled.value !== 'string') throw new Error('expected recalled evidence page')
    const evidence = JSON.parse(recalled.value) as { evidenceJson: string }
    expect(evidence.evidenceJson).toContain('"sources"')
    expect(evidence.evidenceJson).toContain('deterministic session ledger')
    expect(adapter.requests.map(request => request.purpose)).toEqual([undefined, undefined, undefined])
  })

  it('bounds reflector input and still runs dropper after an empty reflection', async () => {
    const first = '\0'.repeat(1000)
    const second = '\u0001'.repeat(1000)
    const observer = JSON.stringify({ observations: [
      { content: first, relevance: 'medium', sourceSeqs: [1] },
      { content: second, relevance: 'low', sourceSeqs: [1] },
    ] })
    const { ctx, adapter } = await mountConfigured({
      observeAfterTokens: 15,
      reflectAfterTokens: 1,
      observationsPoolTargetTokens: 1,
      memoryInputMaxTokens: 2048,
    }, observer)
    const agent = agentFor(ctx, 'bounded-reflector')
    await completedTurn(agent)
    adapter.outputs.push('{"reflections":[]}', '{"observationIds":[]}')
    agent.session.append('turn/start', { turn: 2 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(adapter.requests).toHaveLength(3)
    const reflectorText = adapter.requests[1]?.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    let state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    const firstId = state?.observations[0]?.id
    const secondId = state?.observations[1]?.id
    expect(reflectorText).toContain(String(firstId))
    expect(reflectorText).not.toContain(String(secondId))
    expect(state?.reflections).toHaveLength(0)
    expect(Number(state?.reflectionCoverageSeq)).toBeLessThan(Number(state?.observationCoverageSeq))
    adapter.outputs.push('{"reflections":[]}', '{"observationIds":[]}')
    if (state === undefined) throw new Error('expected projected observational state')
    await reflectDue(ctx, agent.session, state, { ...CONFIG,
      reflectAfterTokens: 1,
      observationsPoolTargetTokens: 1,
      memoryInputMaxTokens: 2048,
    }, new AbortController().signal)
    const nextReflectorText = adapter.requests[3]?.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    expect(nextReflectorText).toContain(String(secondId))
    const nextDropperText = adapter.requests[4]?.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    expect(nextDropperText).toContain(String(secondId))
    expect(nextDropperText).not.toContain(String(firstId))
    state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(state?.reflectionCoverageSeq).toBe(state?.observationCoverageSeq)
    expect(state?.dropperCursorObservationId).toBeNull()
    expect(state?.dropperCoverageSeq).toBe(state?.observationCoverageSeq)
    for (const request of adapter.requests) {
      const inputTokens = estimateContent([{ type: 'text', text: request.system ?? '' }])
        + request.messages.reduce((total, message) => total + estimateMessage(message), 0)
      expect(inputTokens).toBeLessThanOrEqual(2048)
    }
  })

  it('renders covered memory without another model request', async () => {
    const { ctx, adapter, engine } = await mount('{"observations":[{"content":"The session uses a deterministic ledger.","relevance":"high","sourceSeqs":[1]}]}')
    const agent = agentFor(ctx, 'summary')
    await completedTurn(agent)
    const summary = await engine.summarizeForTest({
      sourceSeqs: [SessionSeq(1)],
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Large source history. '.repeat(500) }],
        source: { kind: 'user' },
      })],
    }, agent)
    expect(summary.provider).toBe('dsh-observational-memory')
    expect(summary.model).toBe('deterministic-v1')
    expect(summary.summary).toHaveLength(1)
    expect(summary.summary[0]?.type).toBe('text')
    if (summary.summary[0]?.type !== 'text') throw new Error('expected text summary')
    expect(summary.summary[0].text).toContain('## Observations')
    expect(adapter.requests).toHaveLength(1)
    const fallback = await engine.summarizeForTest({
      sourceSeqs: [SessionSeq(1), SessionSeq(999)],
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Partially covered source history. '.repeat(500) }],
        source: { kind: 'user' },
      })],
    }, agent)
    expect(fallback.provider).toBe('test')
    expect(adapter.requests).toHaveLength(2)
  })

  it('pages complete multibyte recall evidence within the byte limit', async () => {
    const { ctx } = await mountConfigured({ maxViewBytes: 128 }, '{"observations":[{"content":"重要事实", "relevance":"high","sourceSeqs":[1]}]}')
    const agent = agentFor(ctx, 'bounded-recall')
    await completedTurn(agent)
    const id = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')?.observations[0]?.id
    let offset: number | null = 0
    let evidence = ''
    let tombstoned = false
    while (offset !== null) {
      const result = await ctx.tools.execute({
        callId: ToolCallId(`bounded-recall-${String(offset)}`),
        name: 'observational_memory_recall',
        arguments: { id, offset },
        agent,
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      if (result.isError || typeof result.value !== 'string') throw new Error('expected bounded string result')
      expect(Buffer.byteLength(result.value, 'utf8')).toBeLessThanOrEqual(128)
      const page = JSON.parse(result.value) as { evidenceJson: string; nextOffset: number | null }
      evidence += page.evidenceJson
      offset = page.nextOffset
      if (!tombstoned && offset !== null && id !== undefined) {
        agent.session.append('observational-memory/observations-dropped', {
          observationIds: [id],
          reviewedObservationIds: [id],
          nextCursorObservationId: null,
          coversUpToSeq: SessionSeq(1),
        })
        tombstoned = true
      }
    }
    expect(tombstoned).toBe(true)
    expect(JSON.parse(evidence)).toMatchObject({ kind: 'observation', observation: { content: '重要事实' } })
  })

  it('aborts and drains an active worker during disposal', async () => {
    const { ctx, adapter } = await mount('__HANG__')
    const agent = agentFor(ctx, 'dispose-worker')
    await completedTurn(agent)
    expect(adapter.requests).toHaveLength(1)
    const tools = ctx.tools
    expect(tools.schemas().map(schema => schema.name)).toContain('observational_memory_recall')
    await ctx.fiber.dispose()
    expect(adapter.aborted).toBe(true)
    expect(tools.schemas().map(schema => schema.name)).not.toContain('observational_memory_recall')
  })

  it('recalls exact evidence by id and rejects prefixes', async () => {
    const { ctx } = await mount('{"observations":[{"content":"The session uses a deterministic ledger.","relevance":"high","sourceSeqs":[1]}]}')
    const agent = agentFor(ctx, 'recall')
    await completedTurn(agent)
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    const id = state?.observations[0]?.id
    expect(id).toBeDefined()
    const result = await ctx.tools.execute({
      callId: ToolCallId('recall-call'),
      name: 'observational_memory_recall',
      arguments: { id },
      agent,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toContain('deterministic session ledger')
    const prefix = await ctx.tools.execute({
      callId: ToolCallId('recall-prefix'),
      name: 'observational_memory_recall',
      arguments: { id: id?.slice(0, 11) },
      agent,
      signal: new AbortController().signal,
    })
    expect(prefix.isError).toBe(true)
  })
})
