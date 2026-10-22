import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { frameSummary } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { assertNoActiveCompaction, selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/region.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { appendPluginRecord, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { estimateContent, estimateMessage } from '@deepseek-ai/dsh-token-meter'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import type { ObservationalCompactionConfig, ObservationalMemoryState, Observation, Reflection } from './types.ts'
import { OBSERVATIONAL_MEMORY_SOURCE_KIND } from './types.ts'
import { activeObservations, observationalMemoryProjection, supportedReflections } from './projection.ts'
import { observeDue, reflectDue } from './workers.ts'

export type * from './types.ts'
export { observationalMemoryProjection } from './projection.ts'

/**
 * Observer passes one trigger may run. A completed step can add more uncovered
 * tokens than a single pass covers — each pass is bounded by the observer input
 * budget — and without draining that backlog coverage falls behind the compacted
 * range. Bounded so one busy turn cannot monopolize the observer worker.
 */
const MAX_OBSERVER_PASSES_PER_TRIGGER = 4

/**
 * Forced observer passes idle compaction may run before summarizing. One
 * compaction can shadow more tokens than a step trigger drains; a short drain
 * lets a caught-up ledger win the deterministic summary. The cap keeps a
 * multi-million-token backlog from delaying compaction: the lag path still
 * summarizes, and an oversized checkpoint is excerpted rather than fatal.
 */
const MAX_PRECOMPACT_OBSERVER_PASSES = 8

/**
 * Pi's ratio-mode trigger. Calibrated `compactAfterTokens` stays the idle
 * floor; pressure must not wait until the window edge, or the provider
 * overflows before a checkpoint can land.
 */
const PI_COMPACT_RATIO = 0.68
const PI_RETAIN_RATIO = 0.16

/**
 * Worker budgets for the production 12k/4k preset on a large-window model.
 * The observer chunk cap is 60k; the input budget has to clear that plus the
 * system prompt, and the output budget has to finish a full observation array.
 */
const PI_MEMORY_INPUT_TOKENS = 80_000
const PI_MEMORY_OUTPUT_TOKENS = 8_192
const PI_MEMORY_VIEW_BYTES = 65_536

const RELEVANCE_RANK: Record<Observation['relevance'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

/**
 * Share of a shadowed span a replacement checkpoint must actually free. The
 * base engine accepts any strict reduction, so a checkpoint that is one token
 * smaller than the span it replaces satisfies it; a session parked at the
 * trigger then re-compacts the freshly written checkpoint forever, replacing a
 * 10k-token checkpoint with another 10k-token checkpoint on every step.
 */
const MIN_SHADOW_FREE_RATIO = 0.15

/**
 * Smallest absolute free-space a pressure compaction must buy. A span that
 * cannot free this much is not worth a checkpoint write: the write costs the
 * same log bytes and the same re-injected prompt bytes as the span it shadows.
 */
const MIN_SHADOW_FREE_TOKENS = 1_024

/**
 * Growth a session must add after a compaction before the same session is
 * compacted again. The pressure trigger is calibrated against the window, but
 * the fixed floor of a session — tool schemas, provider/system prompt, the
 * checkpoint itself, and the retained tail — can sit at or above that trigger.
 * Without this margin the trigger can never be satisfied, so every step buys
 * two zero-value compactions that still cost ~80 KB of log per step.
 */
const PI_GROWTH_MARGIN_TOKENS = 8_192

/**
 * Share of the usable prompt budget a pressure compaction must be able to free.
 * The trigger is `post-compaction floor + margin`, so a compaction that fires
 * frees about `margin` tokens; sizing the margin as a fraction of the budget
 * keeps that slab large on a wide window instead of paying a checkpoint write
 * for a few kilobytes of growth. Thirty percent of the prompt budget is 43k
 * tokens on the orchestrator's 272k/128k envelope, which is one compaction per
 * ~43k tokens of growth rather than one per step.
 */
const PI_GROWTH_MARGIN_RATIO = 0.3

/**
 * Largest share of the active pool that may be priced as `critical`. The
 * observer over-tags: with most of the pool critical, relevance stops ordering
 * anything and trimming degenerates into dropping the oldest records.
 */
const MAX_CRITICAL_SHARE = 0.35

/** Token-set overlap at which two observations are the same record restated. */
const DUPLICATE_SIMILARITY = 0.6

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

function framedTokens(summary: readonly ContentBlock[]): number {
  return estimateMessage(createUserMessage({
    content: frameSummary([...summary]),
    source: { kind: OBSERVATIONAL_MEMORY_SOURCE_KIND },
  }))
}

/** Free-space a replacement must buy for a span of `sourceTokens`. */
function requiredFreeTokens(sourceTokens: number): number {
  return Math.max(MIN_SHADOW_FREE_TOKENS, Math.floor(sourceTokens * MIN_SHADOW_FREE_RATIO))
}

/**
 * Order-insensitive token set for duplicate detection. Observation text is
 * single-line and short, so a plain content-token set is enough to catch the
 * same record restated with different quoting, ids, or timestamps.
 */
function observationTokens(text: string): ReadonlySet<string> {
  const tokens = new Set<string>()
  for (const token of text.toLowerCase().split(/[^a-z0-9_.:/-]+/u)) {
    if (token.length > 2) tokens.add(token)
  }
  return tokens
}

function tokenOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * Drop observations that restate a newer active record. Restatements are
 * storage the checkpoint pays for twice and, worse, they crowd the pool target
 * with the same fact, so a smaller pool ends up describing less.
 */
function dedupeObservations(observations: readonly Observation[]): readonly Observation[] {
  const tokenCache = new Map<string, ReadonlySet<string>>()
  const newestFirst = [...observations].reverse()
  const kept: Observation[] = []
  const keptTokens: ReadonlySet<string>[] = []
  for (const observation of newestFirst) {
    const tokens = tokenCache.get(observation.id) ?? observationTokens(observation.content)
    tokenCache.set(observation.id, tokens)
    if (keptTokens.some(existing => tokenOverlap(existing, tokens) >= DUPLICATE_SIMILARITY)) continue
    kept.push(observation)
    keptTokens.push(tokens)
  }
  return kept.reverse()
}

/**
 * Relevance rank with the critical tier capped. Everything above the cap is
 * priced as `high`, so the oldest over-tagged critical records compete with the
 * rest of the pool instead of being immune to trimming by definition.
 */
function calibratedRanks(observations: readonly Observation[]): Map<string, number> {
  const ranks = new Map<string, number>(observations.map(observation => [observation.id, RELEVANCE_RANK[observation.relevance]]))
  const critical = observations.filter(observation => observation.relevance === 'critical')
  const allowed = Math.max(1, Math.ceil(observations.length * MAX_CRITICAL_SHARE))
  if (critical.length <= allowed) return ranks
  for (const observation of critical.slice(0, critical.length - allowed)) ranks.set(observation.id, RELEVANCE_RANK.high)
  return ranks
}

/**
 * Newest covered observations that still fit the pool target and leave the
 * framed checkpoint smaller than the span it replaces. A checkpoint's
 * provenance reaches the whole ledger, so prepending every active observation
 * rewrites a summary that is not smaller than the content it shadows.
 *
 * `freeTokens` is the free space the replacement must buy. Passing the bare
 * `sourceTokens` comparison is what lets a checkpoint replace a span of the
 * same size: the swap is accepted, the session stays above the trigger, and
 * the next step repeats it.
 */
function boundedLedger(
  observations: readonly Observation[],
  reflections: readonly Reflection[],
  base: readonly ContentBlock[],
  sourceTokens: number,
  poolTarget: number,
  freeTokens = 1,
): string {
  const ceiling = sourceTokens - Math.max(1, freeTokens)
  let low = 0
  let high = observations.length
  let best = ''
  while (low <= high) {
    const count = Math.floor((low + high) / 2)
    const kept = observations.slice(observations.length - count)
    const rendered = count === 0 ? '' : renderMemory(kept, supportedReflections({ reflections } as ObservationalMemoryState, kept))
    const memoryTokens = rendered.length === 0 ? 0 : estimateContent([{ type: 'text', text: rendered }])
    const fits = memoryTokens <= poolTarget
      && (rendered.length === 0 || framedTokens([{ type: 'text', text: rendered }, ...base]) <= ceiling)
    if (fits) {
      best = rendered
      low = count + 1
    } else {
      high = count - 1
    }
  }
  return best
}

/**
 * Free space a pressure compaction of the selected span would buy, in tokens.
 * The checkpoint is allowed to occupy `poolTarget` tokens, so anything the span
 * prices above that is recovered. Negative means the span cannot even cover a
 * full checkpoint.
 * @param range - inclusive positional span selected for shadowing.
 * @param measurement - current token measurement of the session.
 * @param poolTarget - tokens the rendered checkpoint is allowed to occupy.
 * @returns shadowed tokens minus the checkpoint's pool target.
 */
function shadowFreeTokens(
  range: { readonly start: SessionSeq; readonly end: SessionSeq },
  measurement: { readonly nodes: readonly { readonly seq: SessionSeq; readonly tokens: number }[] },
  poolTarget: number,
): number {
  const startIdx = measurement.nodes.findIndex(node => node.seq === range.start)
  const endIdx = measurement.nodes.findIndex(node => node.seq === range.end)
  if (startIdx < 0 || endIdx < startIdx) return Number.NEGATIVE_INFINITY
  let shadowed = 0
  for (let index = startIdx; index <= endIdx; index += 1) shadowed += measurement.nodes[index]?.tokens ?? 0
  return shadowed - poolTarget
}

function poolExceedsTarget(state: ObservationalMemoryState, targetTokens: number): boolean {
  return activeObservations(state).reduce((sum, observation) => sum + observation.tokenCount, 0) > targetTokens
}

/**
 * Drop oldest, lowest-relevance observations until the active pool fits the
 * target. Pi's dropper does this with a model between compactions; a pool that
 * has already outgrown the target cannot wait for that catch-up, or the
 * rendered summary is larger than the span it is supposed to replace.
 * @returns How many observations were tombstoned.
 */
export function trimObservationPool(
  session: Session,
  state: ObservationalMemoryState,
  targetTokens: number,
): number {
  const deduped = dedupeObservations(activeObservations(state))
  const active = activeObservations(state)
  const duplicateIds = active.filter(observation => !deduped.some(kept => kept.id === observation.id))
  let tokens = deduped.reduce((sum, observation) => sum + observation.tokenCount, 0)
  if (tokens <= targetTokens && duplicateIds.length === 0) return 0
  const ledgerIndex = new Map(deduped.map((observation, index) => [observation.id, index]))
  const ranks = calibratedRanks(deduped)
  const ranked = [...deduped].sort((left, right) => {
    const relevance = (ranks.get(left.id) ?? 0) - (ranks.get(right.id) ?? 0)
    if (relevance !== 0) return relevance
    return (ledgerIndex.get(left.id) ?? 0) - (ledgerIndex.get(right.id) ?? 0)
  })
  const dropped = [...duplicateIds]
  for (const observation of ranked) {
    if (tokens <= targetTokens) break
    dropped.push(observation)
    tokens -= observation.tokenCount
  }
  if (dropped.length === 0) return 0
  const covered = dropped.flatMap(observation => observation.sourceSeqs)
    .reduce((latest, seq) => Math.max(latest, Number(seq)), 0)
  appendPluginRecord(session, 'plugin:observational-memory/observations-dropped', {
    observationIds: dropped.map(observation => observation.id),
    reviewedObservationIds: dropped.map(observation => observation.id),
    nextCursorObservationId: null,
    coversUpToSeq: state.observationCoverageSeq ?? SessionSeq(covered),
  })
  return dropped.length
}

/**
 * Raise the auxiliary worker budgets on the production 12k/4k preset. A 272k
 * model can take a larger observer and dropper call; the explicit small budgets
 * used by tests are left alone.
 */
function accommodateMemory(config: ObservationalCompactionConfig): ObservationalCompactionConfig {
  const production = config.memoryInputMaxTokens === 12_000
    && config.memoryMaxOutputTokens === 4_096
    && config.observationsPoolTargetTokens >= 10_000
  if (!production) return config
  return {
    ...config,
    memoryInputMaxTokens: PI_MEMORY_INPUT_TOKENS,
    memoryMaxOutputTokens: PI_MEMORY_OUTPUT_TOKENS,
    maxViewBytes: Math.max(config.maxViewBytes, PI_MEMORY_VIEW_BYTES),
  }
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
    debugWorkerPayloads: _debugWorkerPayloads,
    ...basic
  } = config
  // Pi compacts at 0.68 of the window. A higher ratio, including the old 0.99
  // pressure trigger, waits until the provider is already over the window.
  return {
    ...basic,
    thresholdRatio: Math.min(config.thresholdRatio ?? PI_COMPACT_RATIO, PI_COMPACT_RATIO),
  }
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
      debugWorkerPayloads: z.boolean().description('Record full worker request bodies in the session log; costly, debugging only.'),
    }),
  ]) as unknown as z<BasicCompactionConfig>

  private readonly active = new Set<Promise<void>>()
  private readonly running = new WeakSet<Session>()
  private readonly pending = new WeakSet<Session>()
  private readonly inflight = new WeakMap<Session, Promise<void>>()
  private readonly observerAttempts = new WeakMap<Session, SessionSeq>()
  private readonly compacting = new WeakSet<Agent>()
  /** Lowest total this agent has been measured at right after a compaction. */
  private readonly postCompactionTokens = new WeakMap<Agent, { tokens: number }>()
  private readonly controllers = new Set<AbortController>()
  private stopping = false

  readonly memoryConfig: ObservationalCompactionConfig

  constructor(ctx: Context, config: ObservationalCompactionConfig) {
    const memoryConfig = accommodateMemory(config)
    super(ctx, basicConfig(memoryConfig))
    this.memoryConfig = memoryConfig
    ctx.sessionProjections.register(observationalMemoryProjection)
    ctx.on('session/event', (session, event) => {
      // A completed step is enough signal: observation is clocked by uncovered
      // tokens, and waiting for `turn/end` starved coverage through multi-hour
      // turns, where compaction then summarized a range no observation covered.
      if (event.type === 'step/end') {
        this.schedule(session)
        return
      }
      if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
      this.schedule(session)
    })
    ctx.on('agent/status', async ({ agent, status }) => {
      if (status !== 'idle' || this.stopping || this.compacting.has(agent)) return
      // Same self-calibrating trigger as the pressure path: a session parked
      // above the configured ratio would otherwise re-compact on every idle.
      if (ctx.tokenMeter.measure(agent.session).totalTokens < await this.pressureThreshold(agent)) return
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
    const operation = this.prepareForCompaction(agent.session, controller.signal).catch((error: unknown) => {
      if (!this.stopping) this.ctx.logger.warn(`observational-memory pre-compaction observe failed: ${error instanceof Error ? error.message : String(error)}`)
    }).then(() => {
      if (this.stopping || controller.signal.aborted) return
      return this.compactNow(agent, controller.signal)
    }).then((result) => {
      if (result === null || result === undefined || this.stopping) return
      const after = this.ctx.tokenMeter.measure(agent.session).totalTokens
      const learned = this.postCompactionTokens.get(agent)
      this.postCompactionTokens.set(agent, { tokens: learned === undefined ? after : Math.min(learned.tokens, after) })
    }).catch((error: unknown) => {
      if (!this.stopping) this.ctx.logger.warn(`observational-memory compaction failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.compacting.delete(agent)
      this.controllers.delete(controller)
      this.active.delete(operation)
    })
    this.active.add(operation)
  }

  private schedule(session: Session): void {
    if (this.stopping) return
    if (this.running.has(session)) {
      this.pending.add(session)
      return
    }
    this.running.add(session)
    this.pending.delete(session)
    const controller = new AbortController()
    this.controllers.add(controller)
    // Defer past the triggering append. Observing synchronously would append a
    // worker record while that append is still being published.
    const operation = Promise.resolve().then(() => this.runObserver(
      session, controller.signal, MAX_OBSERVER_PASSES_PER_TRIGGER, false,
    )).catch((error: unknown) => {
      if (!this.stopping) this.ctx.logger.warn(`observational-memory worker failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.running.delete(session)
      this.inflight.delete(session)
      this.controllers.delete(controller)
      this.active.delete(operation)
      if (!this.stopping && this.pending.has(session)) {
        this.pending.delete(session)
        this.schedule(session)
      }
    })
    this.inflight.set(session, operation)
    this.active.add(operation)
  }

  /**
   * Wait out an in-flight observer, then force a bounded drain so idle
   * compaction can summarize a covered range instead of writing another
   * checkpoint ahead of the watermark.
   */
  private async prepareForCompaction(session: Session, signal: AbortSignal): Promise<void> {
    while (!this.stopping && !signal.aborted) {
      const current = this.inflight.get(session)
      if (current === undefined) {
        if (this.running.has(session)) return
        break
      }
      await current
    }
    if (this.stopping || signal.aborted || this.running.has(session)) return
    this.running.add(session)
    try {
      await this.runObserver(session, signal, MAX_PRECOMPACT_OBSERVER_PASSES, true)
      if (!this.stopping && !signal.aborted
        && poolExceedsTarget(stateOf(this.ctx, session), this.memoryConfig.observationsPoolTargetTokens)) {
        await reflectDue(this.ctx, session, stateOf(this.ctx, session), this.memoryConfig, signal)
      }
    } finally {
      if (!this.stopping && !signal.aborted) this.trimActivePool(session)
      this.running.delete(session)
      if (!this.stopping && this.pending.has(session)) {
        this.pending.delete(session)
        this.schedule(session)
      }
    }
  }

  private async runObserver(
    session: Session,
    signal: AbortSignal,
    maxPasses: number,
    force: boolean,
  ): Promise<void> {
    let cursor = this.observerAttempts.get(session)
    let drained = false
    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (signal.aborted) return
      const state = stateOf(this.ctx, session)
      const reached = state.observationCoverageSeq
      // The attempt cursor is authoritative across passes: the projection may
      // not have folded this attempt's ledger record yet, and re-reading only
      // the projection would observe the same range twice.
      const observationCoverageSeq = cursor !== undefined && (reached === null || cursor > reached)
        ? cursor
        : reached
      const observerState = observationCoverageSeq === state.observationCoverageSeq
        ? state
        : { ...state, observationCoverageSeq }
      const observedThrough = await observeDue(
        this.ctx, session, observerState, this.memoryConfig, signal, force,
      )
      if (observedThrough === null) break
      if (observedThrough === cursor) return
      cursor = observedThrough
      drained = true
      this.observerAttempts.set(session, observedThrough)
    }
    // Reflection used to wait until a trigger found nothing left to observe.
    // A long catch-up, or one message the observer keeps failing, never reaches
    // that idle point, so the pool grows without a dropper and compaction can
    // no longer shrink the context. Maintain the pool whenever it is over target.
    if (!force && !signal.aborted && (!drained
      || poolExceedsTarget(stateOf(this.ctx, session), this.memoryConfig.observationsPoolTargetTokens))) {
      await reflectDue(this.ctx, session, stateOf(this.ctx, session), this.memoryConfig, signal)
    }
  }

  /**
   * Tombstone the overflow before a summary is framed. Ignorable ledger
   * appends are not surface nodes, so this does not invalidate a compaction
   * span that was snapshotted afterwards.
   */
  private trimActivePool(session: Session): void {
    trimObservationPool(session, stateOf(this.ctx, session), this.memoryConfig.observationsPoolTargetTokens)
  }

  override async compactIfNeeded(
    agent: Agent,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
  ) {
    if (trigger !== 'context-overflow') return this.compactUnderPressure(agent, signal)
    // The base overflow path retains nothing and then asks a model to rewrite
    // the whole surface. Pi keeps the recent tail and replaces only the prefix
    // with already-written memory. Fall back to a full shadow only when the
    // tail cannot be split off.
    const pruner = this.ctx.get('toolResultPruner') as { pruneSession?: (session: Session) => void } | undefined
    pruner?.pruneSession?.(agent.session)
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const retainTokens = Math.max(0, Math.min(
      Math.floor(measurement.totalTokens * PI_RETAIN_RATIO),
      measurement.totalTokens - this.memoryConfig.observationsPoolTargetTokens - 1,
    ))
    const range = selectCompactableRange(agent.session, measurement, retainTokens)
      ?? selectCompactableRange(agent.session, measurement, 0)
    if (range === null) return null
    return this.compactRegion(range.start, range.end, agent, signal)
  }

  /**
   * Pressure trigger with a self-calibrating floor and a profitability test.
   *
   * Two properties of the base pressure loop cost this workload most of its
   * log and most of its re-injected prompt bytes:
   *
   * - Its threshold is calibrated against the window only. The fixed floor of a
   *   session — tool schemas, system prompt, the checkpoint, and the retained
   *   tail — can sit *above* that threshold, so no compaction can ever satisfy
   *   it and the trigger re-fires on every step.
   * - It accepts any strict reduction and retries until the threshold is met.
   *   A helper `compactionRetries` of 1 turns one pressured step into two
   *   compactions where the second shadows only the checkpoint the first just
   *   wrote, replacing it with an equally sized one.
   *
   * This override fires once per growth margin above the *observed* achievable
   * floor and only when the selected span actually frees meaningful space.
   * Overflow recovery still uses the base path, where forcing a reduction is
   * the whole point.
   * @param agent - agent whose session is under pressure.
   * @param signal - cancellation for the compaction.
   * @returns the compaction result, or `null` when compaction should wait.
   */
  private async compactUnderPressure(agent: Agent, signal: AbortSignal) {
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    const threshold = await this.pressureThreshold(agent, signal)
    if (measurement.totalTokens < threshold) return null
    const pruner = this.ctx.get('toolResultPruner') as { pruneSession?: (session: Session) => void } | undefined
    if (pruner?.pruneSession !== undefined) {
      pruner.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < threshold) return null
    }
    const poolTarget = this.memoryConfig.observationsPoolTargetTokens
    const retainTokens = Math.max(0, Math.min(
      Math.floor(measurement.totalTokens * PI_RETAIN_RATIO),
      measurement.totalTokens - poolTarget - 1,
    ))
    const range = selectCompactableRange(agent.session, measurement, retainTokens)
    if (range === null) return null
    const free = shadowFreeTokens(range, measurement, poolTarget)
    const shadowed = free + poolTarget
    if (free < Math.max(MIN_SHADOW_FREE_TOKENS, requiredFreeTokens(shadowed))) {
      // Writing a checkpoint that only trades one for another costs a full
      // shadow/summary pair in the log and leaves pressure unchanged. Record
      // the floor so the trigger stops asking until the session grows.
      this.postCompactionTokens.set(agent, { tokens: measurement.totalTokens })
      this.ctx.logger.info(
        `observational-memory pressure compaction deferred: shadowing ~${shadowed} tokens `
        + `would free only ${free} (need ${Math.max(MIN_SHADOW_FREE_TOKENS, requiredFreeTokens(shadowed))})`,
      )
      return null
    }
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const before = measurement.totalTokens
    const result = await this.compactRegion(range.start, range.end, agent, signal)
    const after = meter.measure(agent.session).totalTokens
    const learned = this.postCompactionTokens.get(agent)
    this.postCompactionTokens.set(agent, { tokens: learned === undefined ? after : Math.min(learned.tokens, after) })
    this.ctx.logger.info(
      `observational-memory pressure compaction: shadowed ${String(result.shadowedSeqs.length)} nodes `
      + `(~${String(result.shadowedTokenCount)} tokens), ${String(Math.max(0, before - after))} tokens saved, `
      + `${String(after)} remaining`,
    )
    return result
  }

  /**
   * Effective pressure trigger for this agent. `compactAfterTokens` is a window
   * ratio, so it can sit below the session's fixed floor; the learned
   * post-compaction total is the floor that is actually achievable, and a
   * growth margin above it is the smallest interval at which compaction can
   * still buy something.
   */
  private async pressureThreshold(agent: Agent, signal?: AbortSignal): Promise<number> {
    const learned = this.postCompactionTokens.get(agent)
    if (learned === undefined) return this.memoryConfig.compactAfterTokens
    const budget = await this.promptBudgetTokens(agent, signal)
    const margin = budget === null
      ? PI_GROWTH_MARGIN_TOKENS
      : Math.max(PI_GROWTH_MARGIN_TOKENS, Math.floor(budget * PI_GROWTH_MARGIN_RATIO))
    const grown = learned.tokens + margin
    // The prompt budget is where the provider would refuse the request, so a
    // trigger above it would only ever be satisfied by the overflow path.
    const ceiling = budget === null ? grown : Math.max(this.memoryConfig.compactAfterTokens, Math.min(grown, budget))
    return Math.max(this.memoryConfig.compactAfterTokens, ceiling)
  }

  /**
   * Prompt tokens the routed request can hold: the window minus the completion
   * reserve it asks for. Resolving the routed model is best-effort — an adapter
   * that cannot report its window leaves the fixed margin in place rather than
   * turning every pressure check into a failed request.
   */
  private async promptBudgetTokens(agent: Agent, signal?: AbortSignal): Promise<number | null> {
    const config = agent.session.requestHeader()?.config
    if (config === undefined || config.provider.length === 0 || config.model.length === 0) return null
    let info: Awaited<ReturnType<Context['llm']['resolveModelInfo']>>
    try {
      info = await this.ctx.llm.resolveModelInfo(config.provider, config.model, signal)
    } catch {
      return null
    }
    const window = info.context?.contextWindow
    if (window === undefined) return null
    return window - (config.maxTokens ?? info.defaultMaxTokens ?? 0)
  }

  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ) {
    this.trimActivePool(agent.session)
    return super.compactRegion(start, end, agent, signal)
  }

  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const state = stateOf(this.ctx, agent.session)
    const covered = new Set(input.sourceSeqs.map(Number))
    const observations = activeObservations(state)
      .filter(observation => observation.sourceSeqs.every(seq => covered.has(Number(seq))))
    const reflections = supportedReflections(state, observations)
    if (observations.length === 0 && reflections.length === 0) {
      return await super.summarize(input, agent, signal)
    }
    // Pi's session_before_compact returns the rendered ledger and does not
    // ask a model to rewrite the shadowed transcript. Keep only the newest
    // covered observations that fit the pool and still shrink the span.
    const shadowedTokens = input.messages.reduce((sum, message) => (
      message.role === 'system' ? sum : sum + estimateMessage(message)
    ), 0)
    const rendered = boundedLedger(
      observations,
      reflections,
      [],
      shadowedTokens,
      this.memoryConfig.observationsPoolTargetTokens,
      requiredFreeTokens(shadowedTokens),
    )
    if (rendered.length === 0) return await super.summarize(input, agent, signal)
    return {
      summary: [{ type: 'text', text: rendered }],
      provider: 'dsh-observational-memory',
      model: 'deterministic-v1',
    }
  }
}

export default ObservationalCompactionEngine
