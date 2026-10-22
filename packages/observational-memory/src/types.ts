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

/**
 * Auxiliary request recorded before one memory worker dispatch.
 *
 * The record is written once per worker call — 2,809 times in one 7-day session
 * — and the request body is a near-copy of the conversation (mean 242 KB, peak
 * 331 KB). Keeping the body inline made these records the largest single
 * consumer of session storage, so the durable record carries the pricing
 * metadata and a content digest, and the bodies are kept only when
 * `debugWorkerPayloads` is enabled.
 */
export interface ObservationalMemoryWorkerRequest {
  readonly worker: 'observer' | 'reflector' | 'dropper'
  readonly sourceSeqs: readonly SessionSeq[]
  readonly route: { readonly provider: string; readonly model: string }
  /** Estimated tokens of the exact system-and-message input sent. */
  readonly inputTokens: number
  /** UTF-8 length of the system prompt sent. */
  readonly systemBytes: number
  /** UTF-8 length of the rendered input sent. */
  readonly inputBytes: number
  /** SHA-256 of the exact system and input text, for correlation with debug output. */
  readonly digest: string
  readonly maxTokens: number
  /** Exact system prompt; present only when `debugWorkerPayloads` is enabled. */
  readonly system?: string
  /** Exact messages; present only when `debugWorkerPayloads` is enabled. */
  readonly messages?: readonly Message[]
}

/** Message source kind of every message this package builds; V3 `plugin` sources migrate to the same kind. */
export const OBSERVATIONAL_MEMORY_SOURCE_KIND = 'plugin:@alisher-amantay/dsh-observational-memory'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:@alisher-amantay/dsh-observational-memory': { kind: typeof OBSERVATIONAL_MEMORY_SOURCE_KIND }
  }
}

/** Durable observational-memory records; V3 `observational-memory/*` events migrate to these names. */
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Non-empty source-backed observations accepted from one bounded source range. */
    'plugin:observational-memory/observations-recorded': {
      observations: Observation[]
      coversUpToSeq: SessionSeq
    }
    /** One bounded reflection batch, including the observations reviewed by that batch. */
    'plugin:observational-memory/reflections-recorded': {
      reflections: Reflection[]
      processedObservationIds: ObservationId[]
      coversUpToSeq: SessionSeq
    }
    /** One bounded dropper batch and any tombstones accepted from it. */
    'plugin:observational-memory/observations-dropped': {
      observationIds: ObservationId[]
      reviewedObservationIds: ObservationId[]
      nextCursorObservationId: ObservationId | null
      coversUpToSeq: SessionSeq
    }
    /** Exact auxiliary request dispatched to one observational-memory worker. */
    'plugin:observational-memory/worker-request': ObservationalMemoryWorkerRequest
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
  /** Record full worker request bodies in the session log; costly, for debugging only. */
  readonly debugWorkerPayloads?: boolean
}
