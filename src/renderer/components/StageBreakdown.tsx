import { JobDiagnostics } from './JobDiagnostics'
import { parseRunDiagnostics, type RunDiagnostics } from '../../shared/run-diagnostics'
import { useEffect, useState } from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import { parseStages, STAGE_NAMES, type PipelineStage } from '../../shared/job-progress'
import { parseJobOutput } from '../../shared/job-output'
import { getApi } from '../lib/ipc'
import { formatTimecode } from '../lib/utils'

const bytes = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`
export function StageBreakdown({ stages, updatedAt, running = false }: { stages: PipelineStage[]; updatedAt?: number; running?: boolean }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return <ol aria-label="Stage progress" className="space-y-3">
    {stages.map(stage => {
      const active = running && stage.state === 'running'
      const elapsed = stage.elapsed_ms + (active && updatedAt ? Math.max(0, now - updatedAt) : 0)
      const count = stage.completed == null ? null : stage.unit === 'bytes'
        ? `${bytes(stage.completed)}${stage.total ? ` of ${bytes(stage.total)}` : ' downloaded'}`
        : `${stage.completed}${stage.total ? ` of ${stage.total}` : ''} ${stage.unit ?? ''}`
      return <li key={stage.id} className="flex items-start gap-3 text-xs">
        {stage.state === 'completed' ? <Check aria-hidden className="mt-0.5 h-4 w-4 text-success" /> : active ? <Loader2 aria-hidden className="mt-0.5 h-4 w-4 animate-spin text-accent" /> : <Circle aria-hidden className="mt-0.5 h-4 w-4 text-ink-subtle" />}
        <div className="min-w-0 flex-1">
          <div className="flex justify-between gap-3"><span className={active ? 'font-medium text-ink' : 'text-ink-muted'}>{STAGE_NAMES[stage.id]}</span>
            <span className="shrink-0 font-mono text-ink-subtle">{stage.state === 'pending' ? 'Waiting' : stage.state === 'skipped' ? 'Not needed' : formatTimecode(elapsed)}</span></div>
          {active && <><progress aria-label={`${STAGE_NAMES[stage.id]} progress`} className="stage-progress mt-2 h-1.5 w-full" max={100} {...(stage.percent !== null ? { value: stage.percent } : {})} />
            <div className="mt-1 flex justify-between text-2xs text-ink-subtle"><span>{count ?? 'Working…'}</span><span>{stage.percent == null ? 'In progress' : `${Math.floor(stage.percent)}%`}</span></div></>}
          {!running && stage.state === 'running' && <span className="text-ink-subtle">Stopped before completion</span>}
          {['failed', 'cancelled'].includes(stage.state) && <span className="text-danger">{stage.state === 'failed' ? 'Failed' : 'Cancelled'}</span>}
        </div>
      </li>
    })}
  </ol>
}

export function SavedStageTimings({ outputDir, stages: provided, diagnostics: providedDiagnostics }: { outputDir?: string; stages?: unknown; diagnostics?: unknown }): React.JSX.Element | null {
  const [loaded, setLoaded] = useState<PipelineStage[]>()
  const [diagnostics, setDiagnostics] = useState<RunDiagnostics>()
  useEffect(() => {
    let active = true
    setLoaded(undefined)
    setDiagnostics(undefined)
    if (provided === undefined && outputDir) void getApi().history.getJob(outputDir).then(output => {
      if (active) {
        const metrics = parseJobOutput(output)?.metrics
        setLoaded(parseStages(metrics?.pipeline_stages))
        setDiagnostics(parseRunDiagnostics(metrics?.diagnostics))
      }
    }).catch(() => {})
    return () => { active = false }
  }, [outputDir, provided])
  const stages = provided === undefined ? loaded : parseStages(provided)
  if (!stages?.length) return null
  return <details className="glass-well my-3 rounded-xl px-4 py-3"><summary className="cursor-pointer text-xs text-ink-muted">Processing time by stage</summary>
    <div className="mt-3"><StageBreakdown stages={stages} />{Boolean(diagnostics || providedDiagnostics) && <JobDiagnostics diagnostics={parseRunDiagnostics(providedDiagnostics) ?? diagnostics} saved />}</div>
  </details>
}
