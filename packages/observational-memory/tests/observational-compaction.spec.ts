import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { appendPluginRecord, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter, { estimateContent, estimateMessage } from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ObservationalCompactionEngine, { trimObservationPool } from '../src/index.ts'
import type { ObservationalCompactionConfig } from '../src/types.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic'
import { frameSummary } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { activeObservations } from '../src/projection.ts'
import { reflectDue } from '../src/workers.ts'

const contexts: Context[] = []

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly outputs: Array<string | ((request: GenerateOptions) => string)>
  aborted = false
  blockRequest = 0
  waiting = false
  private blocked = false
  private releaseWait: (() => void) | undefined
  constructor(...outputs: Array<string | ((request: GenerateOptions) => string)>) {
    super()
    this.outputs = outputs
  }
  release(): void {
    this.blockRequest = 0
    this.releaseWait?.()
    this.releaseWait = undefined
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (!this.blocked && this.blockRequest > 0 && this.requests.length === this.blockRequest) {
      this.blocked = true
      this.waiting = true
      await new Promise<void>((resolve) => { this.releaseWait = resolve })
      this.waiting = false
    }
    const next = this.outputs.shift()
    const text = (typeof next === 'function' ? next(options) : next) ?? '{"observations":[]}'
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

class CompactionProbe extends TestObservationalEngine {
  compactCalls = 0
  coverageAtCompact: number | null = null
  override compactNow(agent: Agent): Promise<null> {
    this.compactCalls += 1
    const coverage = this.ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')?.observationCoverageSeq
    this.coverageAtCompact = coverage === undefined || coverage === null ? null : Number(coverage)
    return Promise.resolve(null)
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for observational-memory')
}

function requestText(request: GenerateOptions | undefined): string {
  return request?.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
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
    stream: [],
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
    expect(agent.session.snapshotEvents().map(event => event.type)).toContain('plugin:observational-memory/worker-request')
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
    const cited = (request: GenerateOptions): string => requestText(request).match(/"id":"([0-9a-f]{12})"/u)?.[1] ?? ''
    const { ctx, adapter } = await mountConfigured({
      observeAfterTokens: 15,
      reflectAfterTokens: 1,
      observationsPoolTargetTokens: 1,
    }, observer,
    (request) => JSON.stringify({ reflections: [{ content: 'Session memory is ledger-backed.', supportingObservationIds: [cited(request)] }] }),
    (request) => JSON.stringify({ observationIds: [cited(request)] }))
    const agent = agentFor(ctx, 'reflection')
    await completedTurn(agent)
    await waitFor(() => (ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')?.reflections.length ?? 0) >= 1)
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    const observationId = state?.observations[0]?.id
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
    }, observer, '{"reflections":[]}', '{"observationIds":[]}')
    const agent = agentFor(ctx, 'bounded-reflector')
    await completedTurn(agent)
    await waitFor(() => adapter.requests.length >= 3)
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

  it('prepends covered memory to a model checkpoint when coverage lags', async () => {
    const { ctx, adapter, engine } = await mount()
    const agent = agentFor(ctx, 'summary')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Record the ledger.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendPluginRecord(agent.session, 'plugin:observational-memory/observations-recorded', {
      observations: [{
        id: '0123456789ab',
        content: 'The session uses a deterministic ledger.',
        timestamp: '2026-01-01 00:00',
        relevance: 'high',
        sourceSeqs: [SessionSeq(1)],
        tokenCount: 12,
      }],
      coversUpToSeq: SessionSeq(1),
    })

    const covered = await engine.summarizeForTest({
      sourceSeqs: [SessionSeq(1)],
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Large source history. '.repeat(500) }],
        source: { kind: 'user' },
      })],
    }, agent)
    expect(covered.provider).toBe('dsh-observational-memory')
    expect(covered.model).toBe('deterministic-v1')
    expect(covered.summary).toHaveLength(1)
    const memory = covered.summary[0]
    if (memory?.type !== 'text') throw new Error('expected text summary')
    expect(memory.text).toContain('## Observations')
    expect(adapter.requests).toHaveLength(0)

    // Coverage lag does not rewrite the transcript. The summary is the rendered
    // memory, and the uncovered tail is not sent to a model.
    const partial = await engine.summarizeForTest({
      sourceSeqs: [SessionSeq(1), SessionSeq(999)],
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Partially covered source history. '.repeat(500) }],
        source: { kind: 'user' },
      })],
    }, agent)
    expect(partial.provider).toBe('dsh-observational-memory')
    expect(partial.model).toBe('deterministic-v1')
    expect(adapter.requests).toHaveLength(0)
    expect(partial.summary).toHaveLength(1)
    const ledger = partial.summary[0]
    if (ledger?.type !== 'text') throw new Error('expected rendered memory')
    expect(ledger.text).toContain('## Observations')
    expect(ledger.text).not.toContain('Partially covered source history')
  })

  it('observes from a completed step without waiting for the turn to end', async () => {
    const { ctx, adapter } = await mount('{"observations":[{"content":"Steps advance coverage.","relevance":"high","sourceSeqs":[1]}]}')
    const agent = agentFor(ctx, 'step-clock')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Keep the ledger current.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(adapter.requests).toHaveLength(1)
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(activeObservations(state!)).toHaveLength(1)
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
        appendPluginRecord(agent.session, 'plugin:observational-memory/observations-dropped', {
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

  it('excerpts an oversized source message and keeps observing past it', async () => {
    const huge = `HEAD_MARKER ${'x'.repeat(40_000)} TAIL_MARKER`
    const { ctx, adapter } = await mount(
      '{"observations":[{"content":"Oversized checkpoint was excerpted.","relevance":"high","sourceSeqs":[1]}]}',
      '{"observations":[{"content":"The follow-up was observed.","relevance":"medium","sourceSeqs":[2]}]}',
    )
    const agent = agentFor(ctx, 'oversized-source')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: huge }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Follow-up after the oversized source.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    await waitFor(() => adapter.requests.length >= 2)
    const excerpt = requestText(adapter.requests[0])
    expect(excerpt).toContain('HEAD_MARKER')
    expect(excerpt).toContain('TAIL_MARKER')
    expect(excerpt).toContain('observational-memory omitted')
    expect(excerpt).not.toContain('x'.repeat(40_000))
    const inputTokens = estimateContent([{ type: 'text', text: adapter.requests[0]?.system ?? '' }])
      + (adapter.requests[0]?.messages.reduce((total, message) => total + estimateMessage(message), 0) ?? 0)
    expect(inputTokens).toBeLessThanOrEqual(2048)
    expect(requestText(adapter.requests[1])).toContain('Follow-up after the oversized source.')
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(Number(state?.observationCoverageSeq)).toBeGreaterThanOrEqual(2)
    expect(activeObservations(state!)).toHaveLength(2)
  })

  it('does not drop a trigger that arrives while the observer is running', async () => {
    const { ctx, adapter } = await mountConfigured({ observerChunkMaxTokens: 256 },
      ...[1, 2, 3, 4].map(seq => JSON.stringify({
        observations: [{ content: `Recorded message ${String(seq)}.`, relevance: 'low', sourceSeqs: [seq] }],
      })),
    )
    adapter.blockRequest = 4
    const agent = agentFor(ctx, 'queued-trigger')
    agent.session.append('turn/start', { turn: 1 })
    for (let index = 0; index < 4; index += 1) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `chunk-${String(index)}-${'y'.repeat(1_500)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    agent.session.append('step/end', { turn: 1, step: 1 })
    await waitFor(() => adapter.waiting)
    expect(adapter.requests).toHaveLength(4)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'arrived-during-observer' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const lateSeq = Number(agent.session.seq) - 1
    adapter.outputs.push(JSON.stringify({
      observations: [{ content: 'Recorded the late message.', relevance: 'low', sourceSeqs: [lateSeq] }],
    }))
    agent.session.append('step/end', { turn: 1, step: 2 })
    adapter.release()
    await waitFor(() => adapter.requests.length >= 5)
    expect(requestText(adapter.requests[4])).toContain('arrived-during-observer')
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(activeObservations(state!).map(observation => observation.content)).toContain('Recorded the late message.')
  })

  it('drains uncovered source before idle compaction', async () => {
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
    const adapter = new ScriptedAdapter('{"observations":[{"content":"Idle drain recorded the source.","relevance":"high","sourceSeqs":[0]}]}')
    ctx.llm.registerAdapter(['test'], adapter)
    const engine = new CompactionProbe(ctx, { ...CONFIG, compactAfterTokens: 1 })
    const agent = agentFor(ctx, 'precompact-drain')
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Observe this before compacting.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    ctx.emit('agent/status', { agent, status: 'idle' })
    await waitFor(() => engine.compactCalls === 1)
    expect(adapter.requests).toHaveLength(1)
    expect(engine.coverageAtCompact).toBe(0)
    expect(requestText(adapter.requests[0])).toContain('Observe this before compacting.')
  })

  it('skips a message the observer cannot answer and keeps observing past it', async () => {
    const { ctx, adapter } = await mount(
      'not json',
      '{"observations":[{"content":"The follow-up was observed.","relevance":"medium","sourceSeqs":[2]}]}',
    )
    const agent = agentFor(ctx, 'observer-failure')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Poison checkpoint the model will not answer.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Follow-up after the failed observation.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('step/end', { turn: 1, step: 1 })
    await waitFor(() => adapter.requests.length >= 2)
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(Number(state?.observationCoverageSeq)).toBeGreaterThanOrEqual(2)
    const contents = activeObservations(state!).map(observation => observation.content)
    expect(contents.some(content => content.includes('was skipped after the observer failed'))).toBe(true)
    expect(contents).toContain('The follow-up was observed.')
  })

  it('reflects and drops while observation is still catching up once the pool exceeds its target', async () => {
    const { ctx, adapter } = await mountConfigured({ observationsPoolTargetTokens: 1, reflectAfterTokens: 100_000 },
      '{"observations":[{"content":"Pool grew past the target.","relevance":"high","sourceSeqs":[1]}]}',
      '{"reflections":[]}',
      '{"observationIds":[]}',
    )
    const agent = agentFor(ctx, 'pool-maintenance')
    await completedTurn(agent)
    await waitFor(() => adapter.requests.length >= 3)
    expect(adapter.requests[1]?.system).toContain('Distill durable conclusions')
    expect(adapter.requests[2]?.system).toContain('Select active observations')
  })

  it('trims the active pool to the target before compaction renders it', async () => {
    const { ctx } = await mount()
    const agent = agentFor(ctx, 'trim-pool')
    const observations = [
      {
        id: '000000000001',
        content: 'OLD_LOW superseded detail.',
        timestamp: '2026-01-01 00:00',
        relevance: 'low' as const,
        sourceSeqs: [SessionSeq(1)],
        tokenCount: 800,
      },
      {
        id: '000000000002',
        content: 'NEWEST_KEPT the latest covered fact.',
        timestamp: '2026-01-01 00:01',
        relevance: 'critical' as const,
        sourceSeqs: [SessionSeq(1)],
        tokenCount: 40,
      },
    ]
    appendPluginRecord(agent.session, 'plugin:observational-memory/observations-recorded', {
      observations,
      coversUpToSeq: SessionSeq(1),
    })
    const before = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    if (before === undefined) throw new Error('expected projected observational state')
    expect(trimObservationPool(agent.session, before, 100)).toBe(1)
    const after = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    expect(after?.droppedObservationIds).toEqual(['000000000001'])
    expect(activeObservations(after!).map(observation => observation.id)).toEqual(['000000000002'])
  })

  it('renders trimmed memory instead of rewriting the transcript when the pool is over target', async () => {
    const { ctx, adapter, engine } = await mount('model checkpoint for the uncovered tail')
    const agent = agentFor(ctx, 'bounded-lag')
    const observations = Array.from({ length: 30 }, (_, index) => ({
      id: index.toString(16).padStart(12, '0'),
      content: `OLD_${String(index)} ${'fact '.repeat(80)}`,
      timestamp: '2026-01-01 00:00',
      relevance: 'high' as const,
      sourceSeqs: [SessionSeq(1)],
      tokenCount: 80,
    }))
    observations.push({
      id: 'aaaaaaaaaaaa',
      content: 'NEWEST_KEPT the latest covered fact.',
      timestamp: '2026-01-01 00:01',
      relevance: 'critical',
      sourceSeqs: [SessionSeq(1)],
      tokenCount: 8,
    })
    appendPluginRecord(agent.session, 'plugin:observational-memory/observations-recorded', {
      observations,
      coversUpToSeq: SessionSeq(1),
    })
    const source = createUserMessage({
      content: [{ type: 'text', text: 'Partially covered source history. '.repeat(2_000) }],
      source: { kind: 'user' },
    })
    const partial = await engine.summarizeForTest({
      sourceSeqs: [SessionSeq(1), SessionSeq(999)],
      messages: [source],
    }, agent)
    expect(partial.provider).toBe('dsh-observational-memory')
    expect(adapter.requests).toHaveLength(0)
    const ledger = partial.summary[0]
    if (ledger?.type !== 'text') throw new Error('expected a bounded memory block')
    expect(partial.summary).toHaveLength(1)
    expect(ledger.text).toContain('NEWEST_KEPT')
    expect(ledger.text).not.toContain('OLD_0')
    expect(estimateContent([ledger])).toBeLessThanOrEqual(CONFIG.observationsPoolTargetTokens)
    const framed = estimateMessage(createUserMessage({
      content: frameSummary(partial.summary),
      source: { kind: 'user' },
    }))
    expect(framed).toBeLessThan(estimateMessage(source))
  })
})
