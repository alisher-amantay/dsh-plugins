import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { estimateContent, estimateMessage } from '@deepseek-ai/dsh-token-meter'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { ObservationalCompactionConfig, ObservationalMemoryState, Observation, Reflection } from './types.ts'
import { activeObservations, observationalMemoryProjection, supportedReflections } from './projection.ts'
import { observeDue, reflectDue } from './workers.ts'

export type * from './types.ts'
export { observationalMemoryProjection } from './projection.ts'

function boundUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const suffix = '…'
  if (Buffer.byteLength(suffix, 'utf8') > maxBytes) return ''
  let bounded = ''
  for (const character of text) {
    if (Buffer.byteLength(`${bounded}${character}${suffix}`, 'utf8') > maxBytes) break
    bounded += character
  }
  return `${bounded}${suffix}`
}

function evidencePage(id: string, payload: string, offset: number, maxBytes: number): string {
  const bytes = Buffer.from(payload, 'utf8')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length
    || (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80)) {
    throw new Error('memory evidence offset must be a returned UTF-8 page boundary')
  }
  const boundaries = [offset]
  const candidateLimit = Math.min(bytes.length, offset + maxBytes)
  for (let index = offset + 1; index <= candidateLimit; index += 1) {
    if (index === bytes.length || (((bytes[index] ?? 0) & 0xc0) !== 0x80)) boundaries.push(index)
  }
  let low = 0
  let high = boundaries.length - 1
  let accepted: string | undefined
  while (low <= high) {
    const boundaryIndex = Math.floor((low + high) / 2)
    const end = boundaries[boundaryIndex] ?? offset
    const encoded = JSON.stringify({
      id,
      offset,
      totalBytes: bytes.length,
      nextOffset: end < bytes.length ? end : null,
      evidenceJson: bytes.subarray(offset, end).toString('utf8'),
    })
    if (Buffer.byteLength(encoded, 'utf8') <= maxBytes) {
      accepted = encoded
      low = boundaryIndex + 1
    } else {
      high = boundaryIndex - 1
    }
  }
  if (accepted === undefined) throw new Error('maxViewBytes is too small for the evidence page envelope')
  const decoded = JSON.parse(accepted) as { nextOffset: number | null }
  if (decoded.nextOffset === offset) throw new Error('maxViewBytes is too small to return memory evidence')
  return accepted
}

function renderMemory(observations: readonly Observation[], reflections: readonly Reflection[]): string {
  if (observations.length === 0 && reflections.length === 0) return ''
  const lines = [
    'These are condensed memories from earlier in this session.',
    '',
    'Treat them as past records. When entries conflict, the newest observation reflects the latest known state. Use observational_memory_recall with a listed id when exact source evidence is needed.',
  ]
  if (reflections.length > 0) {
    lines.push('', '## Reflections', ...reflections.map(item => `[${item.id}] ${item.content}`))
  }
  if (observations.length > 0) {
    lines.push('', '## Observations', ...observations.map(item => `[${item.id}] ${item.timestamp} [${item.relevance}] ${item.content}`))
  }
  return lines.join('\n')
}

function basicConfig(config: ObservationalCompactionConfig): BasicCompactionConfig {
  if ((config.memoryProvider === undefined) !== (config.memoryModel === undefined)) {
    throw new Error('ObservationalCompactionConfig: memoryProvider and memoryModel must be set together')
  }
  if (config.memoryInputMaxTokens < 2048) {
    throw new Error('ObservationalCompactionConfig: memoryInputMaxTokens must be at least 2048')
  }
  if (config.memoryInputMaxTokens < config.observationsPoolTargetTokens) {
    throw new Error('ObservationalCompactionConfig: memoryInputMaxTokens must cover observationsPoolTargetTokens')
  }
  if (config.maxViewBytes < 128) {
    throw new Error('ObservationalCompactionConfig: maxViewBytes must be at least 128')
  }
  const {
    memoryProvider: _memoryProvider,
    memoryModel: _memoryModel,
    observeAfterTokens: _observeAfterTokens,
    reflectAfterTokens: _reflectAfterTokens,
    compactAfterTokens: _compactAfterTokens,
    observationsPoolTargetTokens: _observationsPoolTargetTokens,
    observerChunkMaxTokens: _observerChunkMaxTokens,
    memoryInputMaxTokens: _memoryInputMaxTokens,
    memoryMaxOutputTokens: _memoryMaxOutputTokens,
    memoryTimeoutMs: _memoryTimeoutMs,
    maxViewBytes: _maxViewBytes,
    ...basic
  } = config
  return basic
}

function stateOf(ctx: Context, session: Session): ObservationalMemoryState {
  const state = ctx.sessionProjections.stateOf(session, 'observationalMemory')
  if (state === undefined) throw new Error('observational-memory projection is unavailable')
  return state
}

function exactEvidence(session: Session, state: ObservationalMemoryState, id: string): string {
  const observation = state.observations.find(candidate => candidate.id === id)
  if (observation !== undefined) {
    const sources = observation.sourceSeqs.map((seq) => {
      const event = session.eventAt(seq)
      if (event === undefined) return { seq, missing: true }
      return { seq, time: event.time, message: session.deriveEventMessage(event) }
    })
    return JSON.stringify({ kind: 'observation', observation, sources })
  }
  const reflection = state.reflections.find(candidate => candidate.id === id)
  if (reflection === undefined) throw new Error(`observational memory id not found: ${id}`)
  const observations = reflection.supportingObservationIds.map((observationId) => {
    const support = state.observations.find(candidate => candidate.id === observationId)
    if (support === undefined) return { id: observationId, missing: true }
    const sources = support.sourceSeqs.map((seq) => {
      const event = session.eventAt(seq)
      if (event === undefined) return { seq, missing: true }
      return { seq, time: event.time, message: session.deriveEventMessage(event) }
    })
    return { observation: support, sources }
  })
  return JSON.stringify({ kind: 'reflection', reflection, observations })
}

/** Compaction backend with token-clocked session memory and deterministic prepared summaries. */
export class ObservationalCompactionEngine extends BasicCompactionEngine {
  static override inject = ['llm', 'tokenMeter', 'sessions', 'sessionProjections', 'commands', 'tools']

  // The base schema remains authoritative for inherited policy fields.
  static override Config: z<BasicCompactionConfig> = z.intersect([
    BasicCompactionEngine.Config,
    z.object({
      memoryProvider: z.string(),
      memoryModel: z.string(),
      observeAfterTokens: z.number().step(1).min(1).required(),
      reflectAfterTokens: z.number().step(1).min(1).required(),
      compactAfterTokens: z.number().step(1).min(1).required(),
      observationsPoolTargetTokens: z.number().step(1).min(1).required(),
      observerChunkMaxTokens: z.number().step(1).min(256).required(),
      memoryInputMaxTokens: z.number().step(1).min(2048).required(),
      memoryMaxOutputTokens: z.number().step(1).min(1).required(),
      memoryTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
      maxViewBytes: z.number().step(1).min(128).required(),
    }),
  ]) as unknown as z<BasicCompactionConfig>

  private readonly active = new Set<Promise<void>>()
  private readonly running = new WeakSet<Session>()
  private readonly observerAttempts = new WeakMap<Session, SessionSeq>()
  private readonly compacting = new WeakSet<Agent>()
  private readonly controllers = new Set<AbortController>()
  private stopping = false

  constructor(ctx: Context, readonly memoryConfig: ObservationalCompactionConfig) {
    super(ctx, basicConfig(memoryConfig))
    ctx.sessionProjections.register(observationalMemoryProjection)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
      this.schedule(session)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || this.stopping || this.compacting.has(agent)) return
      if (ctx.tokenMeter.measure(agent.session).totalTokens < memoryConfig.compactAfterTokens) return
      this.scheduleSettledCompaction(agent)
    })
    ctx.commands.register({
      name: 'memory-status',
      description: 'Show observational-memory counts and progress',
      handler: ({ agent }: CommandInvocation) => {
        const state = stateOf(ctx, agent.session)
        return {
          kind: 'success',
          text: `Observations: ${String(state.observations.length)} recorded, ${String(activeObservations(state).length)} active\nReflections: ${String(state.reflections.length)}\nObservation coverage: ${String(state.observationCoverageSeq ?? 'none')}\nReflection coverage: ${String(state.reflectionCoverageSeq ?? 'none')}`,
        }
      },
    })
    ctx.commands.register({
      name: 'memory-view',
      description: 'Show current active observational memory',
      handler: ({ agent }: CommandInvocation) => {
        const state = stateOf(ctx, agent.session)
        const observations = activeObservations(state)
        return { kind: 'success', text: boundUtf8(renderMemory(observations, supportedReflections(state, observations)), memoryConfig.maxViewBytes) }
      },
    })
    ctx.tools.register(defineTool({
      name: 'observational_memory_recall',
      description: 'Recover exact session evidence for one observation or reflection id already present in compacted memory. Continue with nextOffset until it is null.',
      parameters: {
        id: { type: 'string', required: true, description: 'Exact 12-character lowercase hexadecimal memory id.' },
        offset: { type: 'number', description: 'UTF-8 page offset returned as nextOffset by the preceding recall.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute: (args, execution) => {
        if (execution.agent === undefined) return Promise.reject(new Error('observational_memory_recall requires an agent session'))
        if (!/^[0-9a-f]{12}$/u.test(args.id)) return Promise.reject(new Error('memory id must be 12 lowercase hexadecimal characters'))
        const offset = args.offset ?? 0
        const evidence = exactEvidence(execution.agent.session, stateOf(ctx, execution.agent.session), args.id)
        return Promise.resolve(evidencePage(args.id, evidence, offset, memoryConfig.maxViewBytes))
      },
    }))
    ctx.effect(() => async () => {
      this.stopping = true
      for (const controller of this.controllers) controller.abort(new Error('observational-memory disposed'))
      await Promise.allSettled(this.active)
    })
  }

  private scheduleSettledCompaction(agent: Agent): void {
    this.compacting.add(agent)
    const controller = new AbortController()
    this.controllers.add(controller)
    const operation = this.compactNow(agent, controller.signal).then(() => {}).catch((error: unknown) => {
      if (!this.stopping) this.ctx.logger.warn(`observational-memory compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.compacting.delete(agent)
      this.controllers.delete(controller)
      this.active.delete(operation)
    })
    this.active.add(operation)
  }

  private schedule(session: Session): void {
    if (this.stopping || this.running.has(session)) return
    this.running.add(session)
    const controller = new AbortController()
    this.controllers.add(controller)
    const operation = Promise.resolve().then(async () => {
      const state = stateOf(this.ctx, session)
      const attempted = this.observerAttempts.get(session)
      const observationCoverageSeq = attempted !== undefined
        && (state.observationCoverageSeq === null || attempted > state.observationCoverageSeq)
        ? attempted
        : state.observationCoverageSeq
      const observerState = observationCoverageSeq === state.observationCoverageSeq
        ? state
        : { ...state, observationCoverageSeq }
      const observedThrough = await observeDue(this.ctx, session, observerState, this.memoryConfig, controller.signal)
      if (observedThrough !== null) {
        this.observerAttempts.set(session, observedThrough)
        return
      }
      await reflectDue(this.ctx, session, state, this.memoryConfig, controller.signal)
    }).catch((error: unknown) => {
      if (!this.stopping) this.ctx.logger.warn(`observational-memory worker failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.running.delete(session)
      this.controllers.delete(controller)
      this.active.delete(operation)
    })
    this.active.add(operation)
  }

  protected override summarize(input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const state = stateOf(this.ctx, agent.session)
    const covered = new Set(input.sourceSeqs.map(Number))
    const requiredCoverage = input.sourceSeqs.reduce((latest, seq) => Math.max(latest, Number(seq)), -1)
    if (state.observationCoverageSeq === null || Number(state.observationCoverageSeq) < requiredCoverage) {
      return super.summarize(input, agent, signal)
    }
    const observations = activeObservations(state)
      .filter(observation => observation.sourceSeqs.every(seq => covered.has(Number(seq))))
    const reflections = supportedReflections(state, observations)
    const rendered = renderMemory(observations, reflections)
    const sourceTokens = input.messages.reduce((sum, message) => sum + estimateMessage(message), 0)
    const memoryTokens = estimateContent([{ type: 'text', text: rendered }]) + 256
    if (rendered.length === 0 || memoryTokens >= sourceTokens) return super.summarize(input, agent, signal)
    return Promise.resolve({
      summary: [{ type: 'text', text: rendered }],
      provider: 'dsh-observational-memory',
      model: 'deterministic-v1',
    })
  }
}

export default ObservationalCompactionEngine
