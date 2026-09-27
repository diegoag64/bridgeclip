import { useEffect, useState } from 'react'
import { ArrowRight, Check, Clapperboard, Download, FileCheck2, ScanLine, Sparkles, Text, Wand2 } from 'lucide-react'
import { STAGE_NAMES, type PipelineStage } from '../../shared/job-progress'
import type { Job } from '../store/use-job-store'
import { formatTimecode } from '../lib/utils'
import './job-timeline.css'

const REVIEW: PipelineStage['id'][] = ['download', 'source_context', 'transcription', 'planning', 'preparing', 'saving', 'preview']
const AUTOMATIC: PipelineStage['id'][] = ['download', 'source_context', 'transcription', 'planning', 'reviewing', 'rendering', 'saving', 'preview']
const LABELS = { ...STAGE_NAMES, download: 'Download / read video', source_context: 'Understand source', transcription: 'Transcribe',
  preparing: 'Frame & review', reviewing: 'Review moments', rendering: 'Frame & render', saving: 'Save files', preview: 'Build preview' }
const ICONS = { download: Download, source_context: Sparkles, transcription: Text, planning: Wand2,
  preparing: ScanLine, reviewing: ScanLine, rendering: Clapperboard, saving: FileCheck2, preview: Clapperboard }
const HINTS: Record<PipelineStage['id'], string> = {
  download: 'Getting your source video ready.', source_context: 'Reading the source to understand the story.',
  transcription: 'Turning speech into timed words.', planning: 'Looking for moments that work as clips.',
  preparing: 'Each candidate gets its own framing and editorial checks.', reviewing: 'Checking that each moment tells a complete story.',
  rendering: 'Following the action and building each clip.', saving: 'Keeping the results in your output folder.',
  preview: 'Preparing smooth playback for your review.'
}
const bytes = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`

/** Older workers report only coarse status; never invent completed stages or timings. */
function pendingStages(job: Job): PipelineStage[] {
  // In older workers "planning" can also mean framing, saving or preview
  // preparation. Only map statuses that identify a single stage reliably.
  const active: Partial<Record<Job['status'], PipelineStage['id']>> = { downloading: 'download', contextualizing: 'source_context',
    transcribing: 'transcription', rendering: job.request.workflow === 'review' ? 'preparing' : 'rendering' }
  return (job.request.workflow === 'review' ? REVIEW : AUTOMATIC).map(id => ({ id,
    state: active[job.status] === id ? 'running' : 'pending', percent: null, elapsed_ms: 0 }))
}

export function JobTimeline({ job }: { job: Job }): React.JSX.Element {
  const [now, setNow] = useState(Date.now)
  const queued = job.status === 'queued'
  useEffect(() => {
    if (queued) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [queued])
  const measured = !!job.stages?.length
  const stages = measured ? job.stages! : pendingStages(job)
  const elapsed = (stage: PipelineStage): number => stage.elapsed_ms +
    (stage.state === 'running' && !queued && job.progressAt ? Math.max(0, now - job.progressAt) : 0)
  const total = measured ? stages.reduce((sum, stage) => sum + elapsed(stage), 0) : 0
  const completed = stages.filter(stage => stage.state === 'completed').length
  const skipped = stages.filter(stage => stage.state === 'skipped').length
  const pct = Math.round(Math.max(0, Math.min(job.percent, 100)))

  return <div className="job-timeline">
    <div className="studio-overall">
      <div><span className="text-xs text-ink-muted">Overall estimate</span><p className="mt-1 text-2xs text-ink-subtle">
        {queued ? `${stages.length} stages ahead` : measured ? `${completed} of ${stages.length} stages complete${skipped ? ` · ${skipped} not needed` : ''}` : 'Stage measurements unavailable for this run'}
      </p></div>
      <progress className="studio-progress studio-overall-bar" aria-label="Overall estimated progress" max={100} value={queued ? 0 : pct} />
      <span className="font-mono text-xl tabular text-ink">{queued ? '—' : `${pct}%`}</span>
    </div>
    {!measured && !queued && <p className="mb-3 text-xs text-ink-muted" role="status">{job.step || 'Starting the clipping engine…'}<span className="mt-1 block text-2xs text-ink-subtle">Detailed bars and timings appear on runs started with the updated engine.</span></p>}
    <ol aria-label="Stage progress" className="studio-stages">
      {stages.map((stage, index) => {
        const active = stage.state === 'running' && !queued
        const done = stage.state === 'completed'
        const Icon = ICONS[stage.id]
        const count = stage.completed == null ? null : stage.unit === 'bytes'
          ? `${bytes(stage.completed)}${stage.total ? ` of ${bytes(stage.total)}` : ' downloaded'}`
          : `${stage.completed}${stage.total ? ` of ${stage.total}` : ''} ${stage.unit ?? ''}`.trim()
        const stateLabel = active ? 'Working' : done ? 'Done' : stage.state === 'skipped' ? 'Not needed'
          : stage.state === 'failed' ? 'Failed' : stage.state === 'cancelled' ? 'Cancelled' : measured || queued ? 'Queued' : 'Not reported'
        return <li key={stage.id} className="studio-stage" data-state={active ? 'running' : stage.state} aria-current={active ? 'step' : undefined}>
          <span className="studio-node" aria-hidden="true">{done ? <Check size={13} /> : active ? <span /> : index + 1}</span>
          <span className="studio-stage-name">{LABELS[stage.id]}</span>
          <div className="studio-stage-meter"><div className="studio-meter-track"><progress className="studio-progress" aria-label={`${STAGE_NAMES[stage.id]} progress`} max={100}
            {...(active && stage.percent === null ? {} : { value: done ? 100 : stage.percent ?? 0 })} />
            {active && stage.percent === null && <span className="studio-indeterminate" aria-hidden="true" />}</div>
            {active && stage.percent !== null && <span className="font-mono tabular">{Math.floor(stage.percent)}%</span>}
          </div>
          <span className="studio-state">{stateLabel}</span>
          <span className="studio-duration">{measured && (active || elapsed(stage) > 0 || done) ? formatTimecode(elapsed(stage)) : '—'}</span>
          {active && <div className="studio-detail" key={`${stage.id}-detail`}>
            <Icon size={23} aria-hidden="true" className="shrink-0 text-accent" />
            <div className="min-w-0"><p className="text-xs text-ink" aria-live="polite">{measured ? job.step || count || HINTS[stage.id] : 'Detailed progress is unavailable for this run.'}</p>
              <p className="mt-1 text-2xs text-ink-muted">{measured && count && job.step ? count : HINTS[stage.id]}</p></div>
          </div>}
        </li>
      })}
    </ol>
    {total > 0 && <section className="studio-timing" aria-label="Time by stage">
      <div className="mb-3 flex justify-between text-xs"><span className="text-ink-muted">Job Breakdown</span><span className="font-mono tabular text-ink-subtle">{formatTimecode(total)} tracked</span></div>
      <div className="studio-time-strip" aria-hidden="true">{stages.filter(stage => elapsed(stage) > 0).map(stage => <div key={stage.id}
        data-state={stage.state} style={{ flexGrow: elapsed(stage) }} title={`${LABELS[stage.id]} · ${formatTimecode(elapsed(stage))}`} />)}</div>
      <div className="studio-time-legend">{stages.filter(stage => elapsed(stage) > 0).map(stage => <span key={stage.id} data-state={stage.state}>
        <i aria-hidden="true" /><span>{LABELS[stage.id]}</span><span className="font-mono tabular">{formatTimecode(elapsed(stage))}</span>
      </span>)}</div>
    </section>}
    <div className="studio-outcome"><ArrowRight size={17} aria-hidden="true" /><div><p className="text-xs font-medium text-ink">{job.request.workflow === 'review' ? 'Up next: your editor' : 'Up next: your clips'}</p>
      <p className="mt-1 text-2xs text-ink-muted">{job.request.workflow === 'review' ? 'Review your moments, refine the framing, then bake.' : 'Your finished clips will be ready in the library.'}</p></div></div>
  </div>
}
