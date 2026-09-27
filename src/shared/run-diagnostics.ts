import { STAGE_NAMES, type PipelineStage } from './job-progress'

export const PREPARATION_PHASES = { sampling: 'Sample faces', camera_scan: 'Scan camera changes', face_tracking: 'Refine face tracking', vision: 'Check shot layouts', jev: 'Jev editorial review' } as const
export interface ModelUsage {
  stage: PipelineStage['id']; model: string; requests: number; active: number; failed: number
  input_tokens: number; output_tokens: number; cost_usd: number; elapsed_ms: number
  unknown_usage: number; unknown_cost: number
}
export interface RunDiagnostics {
  models: ModelUsage[]
  preparation?: { candidate: number; total: number; source_duration_ms: number; phase: keyof typeof PREPARATION_PHASES | null
    percent: number | null; phase_elapsed_ms: number; timings: Record<keyof typeof PREPARATION_PHASES, number> }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown, max = 1e12): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
/** Reject unbounded payloads; whitelist fields so prompts and provider errors cannot cross IPC. */
export function parseRunDiagnostics(value: unknown): RunDiagnostics | undefined {
  if (!object(value) || !Array.isArray(value.models) || value.models.length > 64) return undefined
  const models: ModelUsage[] = [], seen = new Set<string>()
  for (const row of value.models) {
    if (!object(row) || typeof row.model !== 'string' || !/^[\w./:@+-]{1,160}$/.test(row.model) ||
      typeof row.stage !== 'string' || !Object.hasOwn(STAGE_NAMES, row.stage)) return undefined
    const fields = ['requests', 'active', 'failed', 'input_tokens', 'output_tokens', 'cost_usd', 'elapsed_ms', 'unknown_usage', 'unknown_cost'] as const
    if (fields.some(key => !number(row[key]))) return undefined
    if (['requests', 'active', 'failed', 'unknown_usage', 'unknown_cost'].some(key => !Number.isInteger(row[key]) || (row[key] as number) > 100000)) return undefined
    if ((row.active as number) + (row.failed as number) > (row.requests as number) || (row.unknown_usage as number) > (row.requests as number) || (row.unknown_cost as number) > (row.requests as number)) return undefined
    const key = `${row.stage}:${row.model}`
    if (seen.has(key)) return undefined
    seen.add(key)
    const clean = { model: row.model, stage: row.stage } as ModelUsage
    for (const field of fields) clean[field] = row[field] as number
    models.push(clean)
  }
  const result: RunDiagnostics = { models }, p = value.preparation
  if (p !== undefined) {
    if (!object(p) || !number(p.candidate, 100) || !number(p.total, 100) || p.candidate < 1 || p.candidate > p.total || !Number.isInteger(p.candidate) || !Number.isInteger(p.total) ||
      !number(p.source_duration_ms) || !number(p.phase_elapsed_ms, 7 * 86400000) || (p.percent !== null && !number(p.percent, 100)) ||
      (p.phase !== null && (typeof p.phase !== 'string' || !Object.hasOwn(PREPARATION_PHASES, p.phase))) || !object(p.timings)) return undefined
    const timings = {} as NonNullable<RunDiagnostics['preparation']>['timings']
    for (const phase of Object.keys(PREPARATION_PHASES) as (keyof typeof PREPARATION_PHASES)[]) {
      if (!number(p.timings[phase], 7 * 86400000)) return undefined
      timings[phase] = p.timings[phase]
    }
    result.preparation = { candidate: p.candidate, total: p.total, source_duration_ms: p.source_duration_ms,
      phase: p.phase as NonNullable<RunDiagnostics['preparation']>['phase'], percent: p.percent as number | null, phase_elapsed_ms: p.phase_elapsed_ms, timings }
  }
  return result
}
