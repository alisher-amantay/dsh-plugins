import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, SessionSeq } from '@deepseek-ai/dsh-session'
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
import { OBSERVATIONAL_MEMORY_SOURCE_KIND } from './types.ts'
import { activeObservations } from './projection.ts'

const OBSERVER_SYSTEM = 'Record concrete observations from the supplied session messages. Return JSON only: {"observations":[{"content":"single-line factual event","relevance":"low|medium|high|critical","sourceSeqs":[0]}]}. Cite only supplied seq values. Preserve decisions, corrections, constraints, findings, failures, and completed outcomes. Omit routine acknowledgements and guesses. Relevance ranks trimming priority: default to medium, use high only for a constraint, decision, or correction still in force, and critical only for something that must never be lost; keep high and critical under a tenth of what you record. Record one observation per fact: restate nothing, and when a fact changes record the correction instead of repeating the superseded version. A message may contain an observational-memory omission marker; treat that span as unseen and do not invent it.'
const REFLECTOR_SYSTEM = 'Distill durable conclusions from active observations. Return JSON only: {"reflections":[{"content":"single-line durable fact","supportingObservationIds":["id"]}]}. Cite only supplied observation ids. Emit an empty array when no new durable conclusion is justified.'
const DROPPER_SYSTEM = 'Select active observations that are safely redundant, superseded, obsolete, or fully preserved by reflections. Return JSON only: {"observationIds":["id"]}. Cite only supplied active ids and prefer retaining high and critical evidence.'

const observerOutput = z.object({
  observations: z.array(z.object({
    content: z.string().trim().min(1).max(1000),
    relevance: z.enum(['low', 'medium', 'high', 'critical']),
    sourceSeqs: z.array(z.number().int().nonnegative()).min(1).max(32),
  }).strict()).max(64),
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
    source: { kind: OBSERVATIONAL_MEMORY_SOURCE_KIND },
  })
  return estimateContent([{ type: 'text', text: system }]) + estimateMessage(message)
}

function observerInputFits(entries: readonly SourceEntry[], inputMaxTokens: number): boolean {
  return workerInputTokens(OBSERVER_SYSTEM, renderSource(entries)) <= inputMaxTokens
}

function boundExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return ''
  const prefix = '… [observational-memory omitted '
  const suffix = ' chars] …'
  let best = `…[omitted ${String(text.length)}]`.slice(0, maxChars)
  let low = 0
  let high = text.length
  while (low <= high) {
    const keep = Math.floor((low + high) / 2)
    const head = Math.ceil(keep / 2)
    const tail = keep - head
    const marker = `${prefix}${String(text.length - keep)}${suffix}`
    const excerpt = `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ''}`
    if (excerpt.length <= maxChars) {
      best = excerpt
      low = keep + 1
    } else {
      high = keep - 1
    }
  }
  return best
}

function excerptBlock(block: ContentBlock, maxChars: number): ContentBlock {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return { ...block, text: boundExcerpt(block.text, maxChars) }
    case 'tool-call':
      return {
        ...block,
        name: boundExcerpt(block.name, maxChars),
        arguments: boundExcerpt(block.arguments, maxChars),
      }
    case 'image':
    case 'file':
      return { type: 'text', text: `[observational-memory omitted ${block.type} block]` }
    default:
      return { type: 'text', text: '[observational-memory omitted block]' }
  }
}

function longestText(blocks: readonly ContentBlock[]): number {
  let longest = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        longest = Math.max(longest, block.text.length)
        break
      case 'tool-call':
        longest = Math.max(longest, block.name.length, block.arguments.length)
        break
      default:
        break
    }
  }
  return longest
}

function excerptEntry(entry: SourceEntry, maxChars: number): SourceEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      content: entry.message.content.map(block => excerptBlock(block, maxChars)),
    },
  }
}

function collapseEntry(entry: SourceEntry): SourceEntry {
  return {
    ...entry,
    message: {
      ...entry.message,
      content: [{
        type: 'text',
        text: `[observational-memory omitted ${entry.message.role} message of ${String(entry.tokens)} estimated tokens]`,
      }],
    },
  }
}

/**
 * Keep one source message inside the observer input budget.
 * A compaction checkpoint or tool result is one derived message and cannot be
 * split across calls. Excerpting its head and tail, instead of refusing the
 * call, is what lets coverage move past it.
 */
function fitObserverEntry(entry: SourceEntry, inputMaxTokens: number): SourceEntry {
  if (observerInputFits([entry], inputMaxTokens)) return entry
  let low = 0
  let high = longestText(entry.message.content)
  let fitted: SourceEntry | undefined
  while (low <= high) {
    const maxChars = Math.floor((low + high) / 2)
    const candidate = excerptEntry(entry, maxChars)
    if (observerInputFits([candidate], inputMaxTokens)) {
      fitted = candidate
      low = maxChars + 1
    } else {
      high = maxChars - 1
    }
  }
  if (fitted !== undefined) return fitted
  const collapsed = collapseEntry(entry)
  return observerInputFits([collapsed], inputMaxTokens) ? collapsed : entry
}

function takeObserverEntries(
  entries: readonly SourceEntry[],
  sourceMaxTokens: number,
  inputMaxTokens: number,
): SourceEntry[] {
  const first = entries[0]
  if (first === undefined) return []
  // The oldest message is mandatory. Leaving it unselected used to throw, and
  // every later trigger retried the same message until coverage froze.
  const selected = [fitObserverEntry(first, inputMaxTokens)]
  let sourceTokens = first.tokens
  for (const entry of entries.slice(1)) {
    if (sourceTokens + entry.tokens > sourceMaxTokens) break
    const candidate = [...selected, entry]
    if (!observerInputFits(candidate, inputMaxTokens)) break
    selected.push(entry)
    sourceTokens += entry.tokens
  }
  return selected
}

function recordSkipped(session: Session, entry: SourceEntry, content: string): void {
  const sourceSeqs = [entry.seq]
  appendPluginRecord(session, 'plugin:observational-memory/observations-recorded', {
    observations: [{
      id: observationId({ content, sourceSeqs }),
      content,
      timestamp: new Date(entry.time).toISOString().slice(0, 16).replace('T', ' '),
      relevance: 'low',
      sourceSeqs,
      tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    }],
    coversUpToSeq: entry.seq,
  })
}

function recordUnfittable(session: Session, entry: SourceEntry): void {
  recordSkipped(session, entry, `Source seq ${String(entry.seq)} exceeded the observer input bound and was skipped.`)
}

function recordFailed(session: Session, entry: SourceEntry, reason: string): void {
  const detail = reason.replaceAll(/\s+/g, ' ').trim().slice(0, 160)
  recordSkipped(session, entry, `Source seq ${String(entry.seq)} was skipped after the observer failed (${detail}).`)
}

/**
 * Recover a truncated observer object. A checkpoint excerpt often makes the
 * model hit the output cap mid-array; the complete objects before that cut are
 * still source-backed observations, and discarding them retries the same message.
 */
function salvageObserverJson(raw: string): z.infer<typeof observerOutput> | undefined {
  const start = raw.indexOf('{')
  if (start < 0) return undefined
  const body = raw.slice(start)
  const closers = [
    body,
    `${body.replace(/,\s*$/u, '')}}`,
    `${body.replace(/,\s*\{[^}]*$/u, '')}]}`,
  ]
  for (const candidate of closers) {
    try {
      return observerOutput.parse(JSON.parse(candidate))
    } catch {
      // Truncated, or not the observer schema. The caller skips the message.
    }
  }
  return undefined
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
    source: { kind: OBSERVATIONAL_MEMORY_SOURCE_KIND },
  })]
  // The request body is a near-copy of the conversation; persisting it once per
  // worker call dominated session growth. Price it and keep a digest, and only
  // write the bodies themselves when payload debugging is on.
  const digest = createHash('sha256').update(system).update('\u0000').update(input).digest('hex')
  const request = {
    worker,
    sourceSeqs: [...sourceSeqs],
    route,
    inputTokens,
    systemBytes: Buffer.byteLength(system, 'utf8'),
    inputBytes: Buffer.byteLength(input, 'utf8'),
    digest,
    maxTokens: config.memoryMaxOutputTokens,
    ...(config.debugWorkerPayloads === true ? { system, messages } : {}),
  }
  appendPluginRecord(session, 'plugin:observational-memory/worker-request', request)
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
  const raw = textOf(assembler.blocks())
  if (assembler.finish.kind !== 'stop') {
    const error = new Error(`observational-memory ${worker} ended with ${assembler.finish.kind}`) as Error & {
      raw?: string
      finishKind?: string
    }
    error.raw = raw
    error.finishKind = assembler.finish.kind
    throw error
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error))
    const failed = wrapped as Error & { raw?: string }
    failed.raw = raw
    throw failed
  }
}

/**
 * Run one due observer range and append accepted source-backed observations.
 * A source message larger than the input budget is excerpted, not refused.
 * A worker failure records a skip for the oldest message and advances through
 * it, so one checkpoint the model cannot answer cannot freeze the watermark.
 * @param ctx - Agent-scoped context providing the LLM runtime.
 * @param session - Session whose source messages are observed and logged.
 * @param state - Folded memory state before this attempt.
 * @param config - Worker token, route, output, and timeout policy.
 * @param signal - Cancellation for this attempt.
 * @param force - Observe a remaining range even when it is under `observeAfterTokens`.
 * @returns The attempted source watermark, or `null` when the token clock is not due.
 */
export async function observeDue(
  ctx: Context,
  session: Session,
  state: ObservationalMemoryState,
  config: ObservationalCompactionConfig,
  signal: AbortSignal,
  force = false,
): Promise<SessionSeq | null> {
  const uncovered = sourceEntries(session, state.observationCoverageSeq)
  if (uncovered.length === 0) return null
  if (!force && totalTokens(uncovered) < config.observeAfterTokens) return null
  const selected = takeObserverEntries(uncovered, config.observerChunkMaxTokens, config.memoryInputMaxTokens)
  const coversUpToSeq = selected.at(-1)?.seq
  if (coversUpToSeq === undefined) return null
  const rendered = renderSource(selected)
  if (!observerInputFits(selected, config.memoryInputMaxTokens)) {
    const oldest = uncovered[0]
    if (oldest === undefined) return null
    recordUnfittable(session, oldest)
    return oldest.seq
  }
  const allowed = new Set(selected.map(entry => Number(entry.seq)))
  let output: z.infer<typeof observerOutput>
  try {
    const parsed = await runJson(
      ctx, session, config, 'observer', OBSERVER_SYSTEM, selected.map(entry => entry.seq), rendered, signal,
    )
    output = observerOutput.parse(parsed)
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof Error && error.message.includes('no configured or routed memory model')) throw error
    const failed = error as { raw?: string; finishKind?: string }
    const salvaged = failed.finishKind === 'max-tokens' && typeof failed.raw === 'string'
      ? salvageObserverJson(failed.raw)
      : undefined
    if (salvaged === undefined) {
      const oldest = selected[0]
      if (oldest === undefined) throw error
      recordFailed(session, oldest, error instanceof Error ? error.message : String(error))
      return oldest.seq
    }
    output = salvaged
  }
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
    appendPluginRecord(session, 'plugin:observational-memory/observations-recorded', {
      observations,
      coversUpToSeq,
    })
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
  appendPluginRecord(session, 'plugin:observational-memory/reflections-recorded', {
    reflections,
    processedObservationIds: active.map(observation => observation.id),
    coversUpToSeq,
  })
  if (!dropperBehind) return true
  const dropperActive: Observation[] = []
  const ledgerIndexes = new Map(state.observations.map((observation, index) => [observation.id, index]))
  const cursorIndex = state.dropperCursorObservationId === null
    ? -1
    : ledgerIndexes.get(state.dropperCursorObservationId) ?? -1
  const dropperCandidates = allActive.filter(observation => (ledgerIndexes.get(observation.id) ?? -1) > cursorIndex)
  if (dropperCandidates.length === 0) {
    appendPluginRecord(session, 'plugin:observational-memory/observations-dropped', {
      observationIds: [],
      reviewedObservationIds: [],
      nextCursorObservationId: null,
      coversUpToSeq: state.observationCoverageSeq,
    })
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
  appendPluginRecord(session, 'plugin:observational-memory/observations-dropped', {
    observationIds,
    reviewedObservationIds: dropperActive.map(observation => observation.id),
    nextCursorObservationId: completedDropperCycle ? null : dropperActive.at(-1)?.id ?? null,
    coversUpToSeq: completedDropperCycle ? state.observationCoverageSeq : SessionSeq(reviewedCoverage),
  })
  return true
}
