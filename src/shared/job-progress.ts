export const STAGE_NAMES = {
  download: 'Download / read video', source_context: 'Understand source', transcription: 'Transcribe audio',
  planning: 'Find moments', reviewing: 'Review candidates', preparing: 'Prepare editor clips',
  rendering: 'Frame and render clips', saving: 'Save files', preview: 'Prepare source preview'
} as const
export interface PipelineStage {
  id: keyof typeof STAGE_NAMES
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  percent: number | null
  elapsed_ms: number
  completed?: number
  total?: number
  unit?: 'bytes' | 'clips' | 'chunks'
}
/** Only bounded numbers and fixed identifiers can cross the bridge or saved-file boundary. */
export function parseStages(value: unknown): PipelineStage[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined
  const seen = new Set<string>(), result: PipelineStage[] = []
  const number = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const v = raw as Record<string, unknown>
    if (typeof v.id !== 'string' || !Object.hasOwn(STAGE_NAMES, v.id) || seen.has(v.id) ||
        !['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'].includes(v.state as string) ||
        !number(v.elapsed_ms, 7 * 86400000) || (v.percent !== null && !number(v.percent, 100))) return undefined
    seen.add(v.id)
    const row: PipelineStage = { id: v.id as PipelineStage['id'], state: v.state as PipelineStage['state'], percent: v.percent as number | null, elapsed_ms: v.elapsed_ms }
    if (number(v.completed, 1e12)) row.completed = v.completed
    if (number(v.total, 1e12) && v.total > 0) row.total = v.total
    if (['bytes', 'clips', 'chunks'].includes(v.unit as string)) row.unit = v.unit as PipelineStage['unit']
    result.push(row)
  }
  return result
}
