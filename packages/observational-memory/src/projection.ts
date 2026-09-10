import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ObservationalMemoryState, Observation, Reflection } from './types.ts'

const observationSchema = z.object({
  id: z.string(),
  content: z.string(),
  timestamp: z.string(),
  relevance: z.enum(['low', 'medium', 'high', 'critical']),
  sourceSeqs: z.array(z.number().int().nonnegative()),
  tokenCount: z.number().int().nonnegative(),
}).strict()

const reflectionSchema = z.object({
  id: z.string(),
  content: z.string(),
  supportingObservationIds: z.array(z.string()),
  tokenCount: z.number().int().nonnegative(),
}).strict()

const stateSchema = z.object({
  observations: z.array(observationSchema),
  reflections: z.array(reflectionSchema),
  droppedObservationIds: z.array(z.string()),
  reflectedObservationIds: z.array(z.string()),
  dropperCursorObservationId: z.string().nullable(),
  observationCoverageSeq: z.number().int().nonnegative().nullable(),
  reflectionCoverageSeq: z.number().int().nonnegative().nullable(),
  dropperCoverageSeq: z.number().int().nonnegative().nullable(),
}).strict() as unknown as z.ZodType<ObservationalMemoryState>

/** Empty branch-local observational-memory ledger projection. */
export const EMPTY_MEMORY_STATE: ObservationalMemoryState = {
  observations: [],
  reflections: [],
  droppedObservationIds: [],
  reflectedObservationIds: [],
  dropperCursorObservationId: null,
  observationCoverageSeq: null,
  reflectionCoverageSeq: null,
  dropperCoverageSeq: null,
}

/** Host-only fold of observations, reflections, and drop tombstones. */
export const observationalMemoryProjection: ProjectionDefinition<'observationalMemory', ObservationalMemoryState> = {
  key: 'observationalMemory',
  stateSchema,
  init: () => EMPTY_MEMORY_STATE,
  apply(state, event) {
    if (event.type === 'observational-memory/observations-recorded') {
      return {
        ...state,
        observations: [...state.observations, ...event.data.observations],
        observationCoverageSeq: event.data.coversUpToSeq,
      }
    }
    if (event.type === 'observational-memory/reflections-recorded') {
      return {
        ...state,
        reflections: [...state.reflections, ...event.data.reflections],
        reflectedObservationIds: [...state.reflectedObservationIds, ...event.data.processedObservationIds],
        reflectionCoverageSeq: event.data.coversUpToSeq,
      }
    }
    if (event.type === 'observational-memory/observations-dropped') {
      return {
        ...state,
        droppedObservationIds: [...state.droppedObservationIds, ...event.data.observationIds],
        dropperCursorObservationId: event.data.nextCursorObservationId,
        dropperCoverageSeq: event.data.coversUpToSeq,
      }
    }
    return state
  },
  stateVersion: 2,
}

/**
 * Return active observations in durable ledger order.
 * @param state - Folded observational-memory state.
 * @returns Recorded observations not named by a drop tombstone.
 */
export function activeObservations(state: ObservationalMemoryState): readonly Observation[] {
  const dropped = new Set(state.droppedObservationIds)
  return state.observations.filter(observation => !dropped.has(observation.id))
}

/**
 * Return reflections whose complete support set exists in the selected observations.
 * @param state - Folded observational-memory state.
 * @param observations - Observation subset eligible for one memory rendering.
 * @returns Reflections fully supported by the eligible subset.
 */
export function supportedReflections(
  state: ObservationalMemoryState,
  observations: readonly Observation[],
): readonly Reflection[] {
  const ids = new Set(observations.map(observation => observation.id))
  return state.reflections.filter(reflection => reflection.supportingObservationIds.every(id => ids.has(id)))
}
