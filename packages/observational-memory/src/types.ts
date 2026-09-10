import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Stable identity of one source-backed observation. */
export type ObservationId = Branded<'ObservationId'>

/** Stable identity of one reflection backed by observations. */
export type ReflectionId = Branded<'ReflectionId'>

/** Importance assigned to one observation. */
export type ObservationRelevance = 'low' | 'medium' | 'high' | 'critical'

/** One timestamped factual record derived from exact Session events. */
export interface Observation {
  readonly id: ObservationId
  readonly content: string
  readonly timestamp: string
  readonly relevance: ObservationRelevance
  readonly sourceSeqs: readonly SessionSeq[]
  readonly tokenCount: number
}

/** One durable conclusion supported by recorded observations. */
export interface Reflection {
  readonly id: ReflectionId
  readonly content: string
  readonly supportingObservationIds: readonly ObservationId[]
  readonly tokenCount: number
}

/** Folded branch-local memory used by workers, compaction, and exact recall. */
export interface ObservationalMemoryState {
  readonly observations: readonly Observation[]
  readonly reflections: readonly Reflection[]
  readonly droppedObservationIds: readonly ObservationId[]
  readonly reflectedObservationIds: readonly ObservationId[]
  readonly dropperCursorObservationId: ObservationId | null
  readonly observationCoverageSeq: SessionSeq | null
  readonly reflectionCoverageSeq: SessionSeq | null
  readonly dropperCoverageSeq: SessionSeq | null
}

/** Exact auxiliary request recorded before one memory worker dispatch. */
export interface ObservationalMemoryWorkerRequest {
  readonly worker: 'observer' | 'reflector' | 'dropper'
  readonly sourceSeqs: readonly SessionSeq[]
  readonly route: { readonly provider: string; readonly model: string }
  readonly system: string
  readonly messages: readonly Message[]
  readonly maxTokens: number
}

/** Observational-memory policy layered over the regular compaction backend. */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Non-empty source-backed observations accepted from one bounded source range. */
    'observational-memory/observations-recorded': {
      observations: Observation[]
      coversUpToSeq: SessionSeq
    }
    /** One bounded reflection batch, including the observations reviewed by that batch. */
    'observational-memory/reflections-recorded': {
      reflections: Reflection[]
      processedObservationIds: ObservationId[]
      coversUpToSeq: SessionSeq
    }
    /** One bounded dropper batch and any tombstones accepted from it. */
    'observational-memory/observations-dropped': {
      observationIds: ObservationId[]
      reviewedObservationIds: ObservationId[]
      nextCursorObservationId: ObservationId | null
      coversUpToSeq: SessionSeq
    }
    /** Exact auxiliary request dispatched to one observational-memory worker. */
    'observational-memory/worker-request': ObservationalMemoryWorkerRequest
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    observationalMemory: ObservationalMemoryState
  }
}

/** Observational-memory policy layered over the regular compaction backend. */
export interface ObservationalCompactionConfig extends BasicCompactionConfig {
  /** Provider used by memory workers; set with `memoryModel`, or inherit the latest conversation route. */
  readonly memoryProvider?: string
  /** Model used by memory workers; set with `memoryProvider`, or inherit the latest conversation route. */
  readonly memoryModel?: string
  /** New source-token estimate required before observer work. */
  readonly observeAfterTokens: number
  /** New source-token estimate required before reflection work. */
  readonly reflectAfterTokens: number
  /** Total context estimate that triggers idle compaction after agent settlement. */
  readonly compactAfterTokens: number
  /** Active-observation budget that enables dropper maintenance. */
  readonly observationsPoolTargetTokens: number
  /** Maximum source tokens serialized into one observer request. */
  readonly observerChunkMaxTokens: number
  /** Maximum estimated system-and-message input tokens for every memory worker request. */
  readonly memoryInputMaxTokens: number
  /** Output-token cap for every memory worker request. */
  readonly memoryMaxOutputTokens: number
  /** Deadline for every memory worker request. */
  readonly memoryTimeoutMs: number
  /** Maximum UTF-8 bytes returned by recall and memory-view surfaces. */
  readonly maxViewBytes: number
}
