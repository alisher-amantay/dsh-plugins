import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import CommandRegistry from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createAssistantMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { appendPluginRecord, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter, { estimateContent, estimateMessage } from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ObservationalCompactionEngine, { trimObservationPool } from '../src/index.ts'
import type { ObservationalCompactionConfig, ObservationalMemoryState } from '../src/types.ts'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic'
import { frameSummary } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

const contexts: Context[] = []

/** Records every request and replays one scripted JSON answer per call. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly outputs: string[]
  constructor(...outputs: string[]) {
    super()
    this.outputs = outputs
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.outputs.shift() ?? '{"observations":[]}'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class TestEngine extends ObservationalCompactionEngine {
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

async function mount(overrides: Partial<ObservationalCompactionConfig> = {}, ...outputs: string[]) {
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
  const engine = new TestEngine(ctx, { ...CONFIG, ...overrides })
  return { ctx, adapter, engine }
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

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setImmediate(resolve))
}

async function completedTurn(agent: Agent, text: string): Promise<void> {
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'Acknowledged.' }],
      source: { provider: 'test', model: 'chat' },
    }),
  }, { surfaceOp: 'append' })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
}

function workerRequests(agent: Agent): Record<string, unknown>[] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === 'plugin:observational-memory/worker-request')
    .map(event => event.data as unknown as Record<string, unknown>)
}

function coveredSummary(tokens: number): SummarizationInput {
  return {
    sourceSeqs: [SessionSeq(1)],
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'Large source history. '.repeat(tokens) }],
      source: { kind: 'user' },
    })],
  }
}

function framedSummaryTokens(result: SummaryResult): number {
  return estimateMessage(createUserMessage({
    content: frameSummary(result.summary),
    source: { kind: 'user' },
  }))
}

describe('worker request storage', () => {
  it('records pricing metadata and a digest instead of the conversation body', async () => {
    const { ctx } = await mount({}, '{"observations":[{"content":"The ledger is deterministic.","relevance":"medium","sourceSeqs":[1]}]}')
    const agent = agentFor(ctx, 'compact-worker-request')
    await completedTurn(agent, `${'Record the ledger decision. '.repeat(60)}`)
    const requests = workerRequests(agent)
    expect(requests).toHaveLength(1)
    const record = requests[0]
    if (record === undefined) throw new Error('expected a recorded worker request')
    expect(record['worker']).toBe('observer')
    expect(record['system']).toBeUndefined()
    expect(record['messages']).toBeUndefined()
    expect(typeof record['digest']).toBe('string')
    expect(record['digest']).toMatch(/^[0-9a-f]{64}$/u)
    expect(record['inputBytes']).toBeGreaterThan(0)
    expect(record['systemBytes']).toBeGreaterThan(0)
    expect(record['inputTokens']).toBeGreaterThan(0)
    // The record must stay small relative to the request it describes.
    const recordBytes = Buffer.byteLength(JSON.stringify(record), 'utf8')
    expect(recordBytes).toBeLessThan(1024)
    expect(Number(record['inputBytes'])).toBeGreaterThan(recordBytes * 2)
  })

  it('keeps the exact bodies when payload debugging is enabled', async () => {
    const { ctx } = await mount({ debugWorkerPayloads: true }, '{"observations":[{"content":"The ledger is deterministic.","relevance":"medium","sourceSeqs":[1]}]}')
    const agent = agentFor(ctx, 'debug-worker-request')
    await completedTurn(agent, `${'Record the ledger decision. '.repeat(60)}`)
    const record = workerRequests(agent)[0]
    if (record === undefined) throw new Error('expected a recorded worker request')
    expect(Array.isArray(record['messages'])).toBe(true)
    expect(typeof record['system']).toBe('string')
    const system = record['system'] as string
    const input = (record['messages'] as Array<{ content: Array<{ type: string; text?: string }> }>)
      .flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n')
    expect(record['digest']).toBe(createHash('sha256').update(system).update('\u0000').update(input).digest('hex'))
  })
})

describe('checkpoint profitability', () => {
  it('refuses a deterministic checkpoint that does not free real space', async () => {
    const { ctx, adapter, engine } = await mount()
    const agent = agentFor(ctx, 'unprofitable-summary')
    const source = createUserMessage({
      content: [{ type: 'text', text: 'k'.repeat(6800) }],
      source: { kind: 'user' },
    })
    agent.session.append('user/message', source, { surfaceOp: 'append' })
    appendPluginRecord(agent.session, 'plugin:observational-memory/observations-recorded', {
      observations: [{
        id: '0123456789ab',
        content: 'k'.repeat(6600),
        timestamp: '2026-01-01 00:00',
        relevance: 'high',
        sourceSeqs: [SessionSeq(1)],
        tokenCount: 1650,
      }],
      coversUpToSeq: SessionSeq(1),
    })
    const result = await engine.summarizeForTest({ sourceSeqs: [SessionSeq(1)], messages: [source] }, agent)
    // Replacing a span with a checkpoint of the same size is the no-op that
    // keeps a session parked above its trigger, so the ledger cannot win here
    // and the base summarizer takes over.
    expect(result.provider).toBe('test')
    expect(adapter.requests).toHaveLength(1)
  })

  it('makes the deterministic checkpoint free at least fifteen percent of the span', async () => {
    const { ctx, engine } = await mount()
    const agent = agentFor(ctx, 'profitable-summary')
    const source = createUserMessage({
      content: [{ type: 'text', text: 'Large source history. '.repeat(500) }],
      source: { kind: 'user' },
    })
    agent.session.append('user/message', source, { surfaceOp: 'append' })
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
    const result = await engine.summarizeForTest({ sourceSeqs: [SessionSeq(1)], messages: [source] }, agent)
    expect(result.provider).toBe('dsh-observational-memory')
    const shadowed = estimateMessage(source)
    const framed = framedSummaryTokens(result)
    expect(framed).toBeLessThanOrEqual(shadowed - Math.max(1024, Math.floor(shadowed * 0.15)))
  })
})

describe('pressure trigger', () => {
  it('defers compaction when the compactable span cannot buy space', async () => {
    const { ctx, engine } = await mount({ compactAfterTokens: 100 })
    const agent = agentFor(ctx, 'deferred-pressure')
    for (let step = 0; step < 3; step += 1) {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Surface message body. '.repeat(80) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    const measurement = ctx.tokenMeter.measure(agent.session)
    expect(measurement.totalTokens).toBeGreaterThanOrEqual(100)
    const result = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)
    expect(result).toBeNull()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/start')).toHaveLength(0)
    // The deferred attempt teaches the trigger the achievable floor, so the
    // very next idle settlement does not ask again at the same pressure.
    expect(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal)).toBeNull()
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/start')).toHaveLength(0)
  })
})

describe('observation pool hygiene', () => {
  function seeded(ctx: Context, id: string, observations: Array<{ id: string; content: string; relevance: 'low' | 'medium' | 'high' | 'critical'; seq: number; tokens: number }>): { agent: Agent; state: ObservationalMemoryState } {
    const agent = agentFor(ctx, id)
    for (const observation of observations) {
      appendPluginRecord(agent.session, 'plugin:observational-memory/observations-recorded', {
        observations: [{
          id: observation.id,
          content: observation.content,
          timestamp: '2026-01-01 00:00',
          relevance: observation.relevance,
          sourceSeqs: [SessionSeq(observation.seq)],
          tokenCount: observation.tokens,
        }],
        coversUpToSeq: SessionSeq(observation.seq),
      })
    }
    const state = ctx.sessionProjections.stateOf(agent.session, 'observationalMemory')
    if (state === undefined) throw new Error('expected observational memory state')
    return { agent, state }
  }

  it('tombstones a restated observation even when the pool has room', async () => {
    const { ctx } = await mount()
    const { agent, state } = seeded(ctx, 'duplicate-pool', [
      { id: 'aaaaaaaaaaaa', content: 'Drex Max result 16 measured 4.2 s on the Oregon replica.', relevance: 'high', seq: 1, tokens: 20 },
      { id: 'bbbbbbbbbbbb', content: 'Drex Max result 16 measured 4.2 s on the Oregon replica.', relevance: 'high', seq: 2, tokens: 20 },
    ])
    const dropped = trimObservationPool(agent.session, state, 100000)
    expect(dropped).toBe(1)
    const record = agent.session.snapshotEvents()
      .filter(event => event.type === 'plugin:observational-memory/observations-dropped')
      .at(-1)
    expect(record?.data.observationIds).toEqual(['aaaaaaaaaaaa'])
  })

  it('drops an over-cap critical observation before younger lower-relevance records', async () => {
    const { ctx } = await mount()
    const { agent, state } = seeded(ctx, 'critical-cap-pool', [
      { id: 'c00000000001', content: 'Gateway route /drex-max is not live yet.', relevance: 'critical', seq: 1, tokens: 10 },
      { id: 'c00000000002', content: 'Worker cca0de64 must not restart the harness.', relevance: 'critical', seq: 2, tokens: 10 },
      { id: 'c00000000003', content: 'TP=2 harness belongs on nacecloud #392.', relevance: 'critical', seq: 3, tokens: 10 },
      { id: 'c00000000004', content: 'Schedule prompts should stay under four kilobytes.', relevance: 'critical', seq: 4, tokens: 10 },
      { id: 'h00000000001', content: 'Drex Max latency measured 4.2 s on Oregon replica.', relevance: 'high', seq: 5, tokens: 10 },
      { id: 'h00000000002', content: 'Recall output is capped at 64 KiB per page.', relevance: 'high', seq: 6, tokens: 10 },
    ])
    // 60 tokens with a 35% critical cap allows three critical records, so the
    // oldest one competes with the high tier instead of outranking it.
    const dropped = trimObservationPool(agent.session, state, 40)
    const record = agent.session.snapshotEvents()
      .filter(event => event.type === 'plugin:observational-memory/observations-dropped')
      .at(-1)
    const ids = record?.data.observationIds ?? []
    expect(dropped).toBe(2)
    expect(ids).toContain('c00000000001')
    expect(ids).toContain('h00000000001')
    expect(ids).not.toContain('c00000000004')
  })
})

describe('summary framing', () => {
  it('keeps the framed checkpoint smaller than the shadowed span', async () => {
    const { ctx, engine } = await mount()
    const agent = agentFor(ctx, 'framed')
    const source = createUserMessage({
      content: [{ type: 'text', text: 'Late source history. '.repeat(400) }],
      source: { kind: 'user' },
    })
    agent.session.append('user/message', source, { surfaceOp: 'append' })
    appendPluginRecord(agent.session, 'plugin:observational-memory/observations-recorded', {
      observations: [{
        id: '0123456789ab',
        content: 'Memory is a deterministic ledger.',
        timestamp: '2026-01-01 00:00',
        relevance: 'medium',
        sourceSeqs: [SessionSeq(1)],
        tokenCount: 10,
      }],
      coversUpToSeq: SessionSeq(1),
    })
    const result = await engine.summarizeForTest({ sourceSeqs: [SessionSeq(1)], messages: [source] }, agent)
    expect(estimateContent(result.summary)).toBeLessThanOrEqual(CONFIG.observationsPoolTargetTokens)
    expect(framedSummaryTokens(result)).toBeLessThan(estimateMessage(source))
  })
})
