import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { estimateContent, estimateMessage } from '@deepseek-ai/dsh-token-meter'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  Observation,
  ObservationId,
  ObservationalCompactionConfig,
  ObservationalMemoryState,
  Reflection,
  ReflectionId,
} from './types.ts'
import { activeObservations } from './projection.ts'

const OBSERVER_SYSTEM = 'Record concrete observations from the supplied session messages. Return JSON only: {"observations":[{"content":"single-line factual event","relevance":"low|medium|high|critical","sourceSeqs":[0]}]}. Cite only supplied seq values. Preserve decisions, corrections, constraints, findings, failures, and completed outcomes. Omit routine acknowledgements and guesses.'
const REFLECTOR_SYSTEM = 'Distill durable conclusions from active observations. Return JSON only: {"reflections":[{"content":"single-line durable fact","supportingObservationIds":["id"]}]}. Cite only supplied observation ids. Emit an empty array when no new durable conclusion is justified.'
const DROPPER_SYSTEM = 'Select active observations that are safely redundant, superseded, obsolete, or fully preserved by reflections. Return JSON only: {"observationIds":["id"]}. Cite only supplied active ids and prefer retaining high and critical evidence.'

const observerOutput = z.object({
  observations: z.array(z.object({
    content: z.string().trim().min(1).max(1000),
    relevance: z.enum(['low', 'medium', 'high', 'critical']),
    sourceSeqs: z.array(z.number().int().nonnegative()).min(1).max(32),
  }).strict()).max(32),
}).strict()

const reflectorOutput = z.object({
  reflections: z.array(z.object({
    content: z.string().trim().min(1).max(1000),
    supportingObservationIds: z.array(z.string()).min(1).max(32),
  }).strict()).max(16),
}).strict()

const dropperOutput = z.object({ observationIds: z.array(z.string()).max(64) }).strict()

interface SourceEntry {
  readonly seq: SessionSeq
  readonly time: number
  readonly message: Message
  readonly tokens: number
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text).join('\n').trim()
}

function memoryDigest(prefix: string, value: unknown): string {
  return createHash('sha256').update(prefix).update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function observationId(value: unknown): ObservationId {
  return brandString<ObservationId>(memoryDigest('observation:', value))
}

function reflectionId(value: unknown): ReflectionId {
  return brandString<ReflectionId>(memoryDigest('reflection:', value))
}

function sourceEntries(session: Session, after: SessionSeq | null): SourceEntry[] {
  const entries: SourceEntry[] = []
  const start = after === null ? 0 : Number(after) + 1
  for (let index = start; index < session.seq; index += 1) {
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    entries.push({ seq: event.seq, time: event.time, message, tokens: estimateMessage(message) })
  }
  return entries
}

function renderSource(entries: readonly SourceEntry[]): string {
  return entries.map(entry => JSON.stringify({ seq: entry.seq, message: entry.message })).join('\n')
}

function workerInputTokens(system: string, input: string): number {
  const message = createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'plugin', plugin: '@alisheramantay/dsh-observational-memory' },
  })
  return estimateContent([{ type: 'text', text: system }]) + estimateMessage(message)
}

function takeObserverEntries(
  entries: readonly SourceEntry[],
  sourceMaxTokens: number,
  inputMaxTokens: number,
): SourceEntry[] {
  const selected: SourceEntry[] = []
  let sourceTokens = 0
  for (const entry of entries) {
    const candidate = [...selected, entry]
    if (sourceTokens + entry.tokens > sourceMaxTokens
      || workerInputTokens(OBSERVER_SYSTEM, renderSource(candidate)) > inputMaxTokens) break
    selected.push(entry)
    sourceTokens += entry.tokens
  }
  return selected
}

function totalTokens(entries: readonly SourceEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.tokens, 0)
}

function memoryRoute(session: Session, config: ObservationalCompactionConfig): { provider: string; model: string } {
  if (config.memoryProvider !== undefined && config.memoryModel !== undefined) {
    return { provider: config.memoryProvider, model: config.memoryModel }
  }
  const route = session.requestHeader()?.config
  if (route === undefined || route.provider.length === 0 || route.model.length === 0) {
    throw new Error('observational-memory has no configured or routed memory model')
  }
  return { provider: route.provider, model: route.model }
}

async function runJson(
  ctx: Context,
  session: Session,
  config: ObservationalCompactionConfig,
  worker: 'observer' | 'reflector' | 'dropper',
  system: string,
  sourceSeqs: readonly SessionSeq[],
  input: string,
  signal: AbortSignal,
): Promise<unknown> {
  const route = memoryRoute(session, config)
  const inputTokens = workerInputTokens(system, input)
  if (inputTokens > config.memoryInputMaxTokens) {
    throw new Error(`observational-memory ${worker} input exceeds memoryInputMaxTokens (${inputTokens} > ${config.memoryInputMaxTokens})`)
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: input }],
    source: { kind: 'plugin', plugin: '@alisheramantay/dsh-observational-memory' },
  })]
  session.append('observational-memory/worker-request', {
    worker,
    sourceSeqs: [...sourceSeqs],
    route,
    system,
    messages,
    maxTokens: config.memoryMaxOutputTokens,
  }, { ignorable: true })
  using requestDeadline = deadline(signal, config.memoryTimeoutMs, 'OBSERVATIONAL_MEMORY_TIMEOUT')
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    system,
    messages,
    maxTokens: config.memoryMaxOutputTokens,
    sessionId: session.id,
    signal: requestDeadline.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  if (assembler.finish.kind !== 'stop') throw new Error(`observational-memory ${worker} ended with ${assembler.finish.kind}`)
  const raw = textOf(assembler.blocks())
  return JSON.parse(raw) as unknown
}

/**
 * Run one due observer range and append accepted source-backed observations.
 * @param ctx - Agent-scoped context providing the LLM runtime.
 * @param session - Session whose source messages are observed and logged.
 * @param state - Folded memory state before this attempt.
 * @param config - Worker token, route, output, and timeout policy.
 * @param signal - Cancellation for this attempt.
 * @returns The attempted source watermark, or `null` when the token clock is not due.
 */
export async function observeDue(
  ctx: Context,
  session: Session,
  state: ObservationalMemoryState,
  config: ObservationalCompactionConfig,
  signal: AbortSignal,
): Promise<SessionSeq | null> {
  const uncovered = sourceEntries(session, state.observationCoverageSeq)
  if (totalTokens(uncovered) < config.observeAfterTokens) return null
  const selected = takeObserverEntries(uncovered, config.observerChunkMaxTokens, config.memoryInputMaxTokens)
  const coversUpToSeq = selected.at(-1)?.seq
  if (coversUpToSeq === undefined) {
    throw new Error('observational-memory observer cannot fit the oldest source message within its input bounds')
  }
  const allowed = new Set(selected.map(entry => Number(entry.seq)))
  const output = observerOutput.parse(await runJson(
    ctx, session, config, 'observer', OBSERVER_SYSTEM, selected.map(entry => entry.seq), renderSource(selected), signal,
  ))
  if (output.observations.length === 0) return coversUpToSeq
  const observations: Observation[] = output.observations.flatMap((candidate) => {
    if (!candidate.sourceSeqs.every(seq => allowed.has(seq))) return []
    const sourceSeqs = [...new Set(candidate.sourceSeqs)].sort((left, right) => left - right).map(SessionSeq)
    const latest = selected.findLast(entry => sourceSeqs.includes(entry.seq))
    if (latest === undefined) return []
    const timestamp = new Date(latest.time).toISOString().slice(0, 16).replace('T', ' ')
    return [{
      id: observationId({ content: candidate.content, sourceSeqs }),
      content: candidate.content.replaceAll(/\s+/g, ' ').trim(),
      timestamp,
      relevance: candidate.relevance,
      sourceSeqs,
      tokenCount: Math.max(1, Math.ceil(candidate.content.length / 4)),
    }]
  })
  if (observations.length > 0) {
    session.append('observational-memory/observations-recorded', {
      observations,
      coversUpToSeq,
    }, { ignorable: true })
  }
  return coversUpToSeq
}

/**
 * Run a due reflection pass and optional post-reflection dropper maintenance.
 * @param ctx - Agent-scoped context providing the LLM runtime.
 * @param session - Session whose ledger events are read and appended.
 * @param state - Folded memory state before this attempt.
 * @param config - Worker token, route, output, and timeout policy.
 * @param signal - Cancellation for this attempt.
 * @returns Whether the reflection token clock was due and attempted.
 */
export async function reflectDue(
  ctx: Context,
  session: Session,
  state: ObservationalMemoryState,
  config: ObservationalCompactionConfig,
  signal: AbortSignal,
): Promise<boolean> {
  const uncovered = sourceEntries(session, state.reflectionCoverageSeq)
  const allActive = activeObservations(state)
  if (state.observationCoverageSeq === null) return false
  const reflectionFloor = state.reflectionCoverageSeq === null ? -1 : Number(state.reflectionCoverageSeq)
  const reflected = new Set(state.reflectedObservationIds)
  const pendingActive = allActive.filter(observation => !reflected.has(observation.id))
  const activeTokens = allActive.reduce((sum, observation) => sum + observation.tokenCount, 0)
  const dropperBehind = activeTokens > config.observationsPoolTargetTokens
    && (state.dropperCursorObservationId !== null || state.dropperCoverageSeq === null
      || state.dropperCoverageSeq < state.observationCoverageSeq)
  if (pendingActive.length === 0 && totalTokens(uncovered) < config.reflectAfterTokens && !dropperBehind) return false
  const active: Observation[] = []
  for (const observation of pendingActive) {
    const candidate = [...active, observation]
    const input = JSON.stringify({ observations: candidate, reflections: [] })
    if (workerInputTokens(REFLECTOR_SYSTEM, input) > config.memoryInputMaxTokens) break
    active.push(observation)
  }
  if (pendingActive.length > 0 && active.length === 0) {
    throw new Error('observational-memory reflector cannot fit one pending observation within memoryInputMaxTokens')
  }
  const priorReflections: Reflection[] = []
  for (const reflection of [...state.reflections].reverse()) {
    const candidate = [reflection, ...priorReflections]
    const input = JSON.stringify({ observations: active, reflections: candidate })
    if (workerInputTokens(REFLECTOR_SYSTEM, input) > config.memoryInputMaxTokens) break
    priorReflections.unshift(reflection)
  }
  const known = new Set(active.map(observation => observation.id))
  let reflections: Reflection[] = []
  if (active.length > 0) {
    const reflectionInput = JSON.stringify({ observations: active, reflections: priorReflections })
    const output = reflectorOutput.parse(await runJson(
      ctx, session, config, 'reflector', REFLECTOR_SYSTEM, active.flatMap(item => item.sourceSeqs), reflectionInput, signal,
    ))
    reflections = output.reflections.flatMap((candidate) => {
      if (!candidate.supportingObservationIds.every(id => known.has(id as ObservationId))) return []
      const supportingObservationIds = [...new Set(candidate.supportingObservationIds)] as ObservationId[]
      return [{
        id: reflectionId({ content: candidate.content, supportingObservationIds }),
        content: candidate.content.replaceAll(/\s+/g, ' ').trim(),
        supportingObservationIds,
        tokenCount: Math.max(1, Math.ceil(candidate.content.length / 4)),
      }]
    })
  }
  const selectedCoverage = active.flatMap(observation => observation.sourceSeqs)
    .reduce((latest, seq) => Math.max(latest, Number(seq)), reflectionFloor)
  const coversUpToSeq = active.length === pendingActive.length
    ? state.observationCoverageSeq
    : SessionSeq(selectedCoverage)
  session.append('observational-memory/reflections-recorded', {
    reflections,
    processedObservationIds: active.map(observation => observation.id),
    coversUpToSeq,
  }, { ignorable: true })
  if (!dropperBehind) return true
  const dropperActive: Observation[] = []
  const ledgerIndexes = new Map(state.observations.map((observation, index) => [observation.id, index]))
  const cursorIndex = state.dropperCursorObservationId === null
    ? -1
    : ledgerIndexes.get(state.dropperCursorObservationId) ?? -1
  const dropperCandidates = allActive.filter(observation => (ledgerIndexes.get(observation.id) ?? -1) > cursorIndex)
  if (dropperCandidates.length === 0) {
    session.append('observational-memory/observations-dropped', {
      observationIds: [],
      reviewedObservationIds: [],
      nextCursorObservationId: null,
      coversUpToSeq: state.observationCoverageSeq,
    }, { ignorable: true })
    return true
  }
  for (const observation of dropperCandidates) {
    const candidate = [...dropperActive, observation]
    const input = JSON.stringify({ observations: candidate, reflections: [] })
    if (workerInputTokens(DROPPER_SYSTEM, input) > config.memoryInputMaxTokens) break
    dropperActive.push(observation)
  }
  if (dropperActive.length === 0) {
    throw new Error('observational-memory dropper cannot fit one active observation within memoryInputMaxTokens')
  }
  const dropperReflections: Reflection[] = []
  for (const reflection of [...priorReflections, ...reflections].reverse()) {
    const candidate = [reflection, ...dropperReflections]
    const input = JSON.stringify({ observations: dropperActive, reflections: candidate })
    if (workerInputTokens(DROPPER_SYSTEM, input) > config.memoryInputMaxTokens) break
    dropperReflections.unshift(reflection)
  }
  const dropperKnown = new Set(dropperActive.map(observation => observation.id))
  const dropOutput = dropperOutput.parse(await runJson(
    ctx,
    session,
    config,
    'dropper',
    DROPPER_SYSTEM,
    dropperActive.flatMap(item => item.sourceSeqs),
    JSON.stringify({ observations: dropperActive, reflections: dropperReflections }),
    signal,
  ))
  const observationIds = [...new Set(dropOutput.observationIds)]
    .filter(id => dropperKnown.has(id as ObservationId)) as ObservationId[]
  const completedDropperCycle = dropperActive.at(-1)?.id === dropperCandidates.at(-1)?.id
  const reviewedCoverage = dropperActive.flatMap(observation => observation.sourceSeqs)
    .reduce((latest, seq) => Math.max(latest, Number(seq)), Number(state.dropperCoverageSeq ?? 0))
  session.append('observational-memory/observations-dropped', {
    observationIds,
    reviewedObservationIds: dropperActive.map(observation => observation.id),
    nextCursorObservationId: completedDropperCycle ? null : dropperActive.at(-1)?.id ?? null,
    coversUpToSeq: completedDropperCycle ? state.observationCoverageSeq : SessionSeq(reviewedCoverage),
  }, { ignorable: true })
  return true
}
